import { randomBytes } from "node:crypto";
import type { EpxConfig, EpxOtlpConfig } from "../types";
import { otlpEndpointConfigError } from "../config/schema/otlp";
import { signalWithTimeout } from "../lib/abort";
import { assessUrlDestination, resolvePublicAddresses } from "../lib/destination-policy";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { RequestLogEntry } from "../server/request-log-types";

const W3C_TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

const DEFAULT_SERVICE_NAME = "easyproxy";
const DEFAULT_SAMPLE_RATE = 1;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 512;
const DEFAULT_BATCH_SIZE = 64;
const FLUSH_DEBOUNCE_MS = 250;
const MAX_EXPORT_ATTR_STR_LEN = 256;

export interface ParsedW3cTraceparent {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string } | { boolValue: boolean };
}

export interface OtlpSpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

export interface OtlpRequestSpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceparent: string;
  readonly sampled: boolean;
  finish(outcome: {
    status: number;
    finalEntry?: Partial<Pick<
      RequestLogEntry,
      "model" | "requestedModel" | "provider" | "inboundProtocol" | "firstOutputMs" | "usage" | "errorCode" | "apiKeyId"
    >>;
    errorCode?: string;
  }): void;
}

interface QueuedOtlpSpan {
  endpoint: string;
  allowPrivateNetwork: boolean;
  headers: Record<string, string>;
  serviceName: string;
  timeoutMs: number;
  batchSize: number;
  span: OtlpSpanPayload;
}

const validatedEndpoints = new Map<string, boolean>();
let spanQueue: QueuedOtlpSpan[] = [];
let maxQueueCapacity = DEFAULT_MAX_QUEUE_SIZE;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let activeFlush: Promise<void> | null = null;
let shutdownHookRegistered = false;
let fetchOverride: typeof globalThis.fetch | null = null;

let stats = {
  enqueuedSpans: 0,
  exportedSpans: 0,
  droppedSpans: 0,
  exportFailures: 0,
};

export function setOtlpExporterFetchForTests(fn: typeof globalThis.fetch | null): void {
  fetchOverride = fn;
}

export function getOtlpTracingStatsForTests() {
  return {
    ...stats,
    queuedSpans: spanQueue.length,
    shutdownHookRegistered,
  };
}

export function resetOtlpTracingForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  spanQueue = [];
  activeFlush = null;
  fetchOverride = null;
  validatedEndpoints.clear();
  maxQueueCapacity = DEFAULT_MAX_QUEUE_SIZE;
  stats = { enqueuedSpans: 0, exportedSpans: 0, droppedSpans: 0, exportFailures: 0 };
}

export function parseW3cTraceparent(header: string | null | undefined): ParsedW3cTraceparent | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.length !== 55) return null;
  const match = W3C_TRACEPARENT_RE.exec(trimmed);
  if (!match) return null;
  const [, traceId, parentSpanId, flags] = match;
  if (!traceId || !parentSpanId || !flags) return null;
  if (traceId === ZERO_TRACE_ID || parentSpanId === ZERO_SPAN_ID) return null;
  const flagsByte = Number.parseInt(flags, 16);
  return {
    traceId,
    parentSpanId,
    sampled: (flagsByte & 1) === 1,
  };
}

function isValidEndpointCached(endpoint: string, allowPrivateNetwork: boolean): boolean {
  const key = `${allowPrivateNetwork ? "1" : "0"}:${endpoint}`;
  const cached = validatedEndpoints.get(key);
  if (cached !== undefined) return cached;
  const valid = otlpEndpointConfigError(endpoint, allowPrivateNetwork) === null;
  if (validatedEndpoints.size >= 64) validatedEndpoints.clear();
  validatedEndpoints.set(key, valid);
  return valid;
}

/** O(1) runtime gate: zero allocations, timers, or crypto work when tracing is disabled. */
export function isOtlpTracingEnabled(config: Pick<EpxConfig, "otlp"> | null | undefined): boolean {
  const otlp = config?.otlp;
  if (!otlp || otlp.enabled !== true || typeof otlp.endpoint !== "string") return false;
  const trimmed = otlp.endpoint.trim();
  if (!trimmed) return false;
  return isValidEndpointCached(trimmed, otlp.allowPrivateNetwork === true);
}

function sanitizeAttrValue(value: string): string {
  return value.replace(/[\r\n\u0000]/g, " ").slice(0, MAX_EXPORT_ATTR_STR_LEN);
}

function clampConfigNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function ensureShutdownHookRegistered(): void {
  if (shutdownHookRegistered) return;
  shutdownHookRegistered = true;
  registerOptionalShutdownHook("otlp-tracing", async () => {
    await flushOtlpSpans(1_500);
  });
}

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS): void {
  if (flushTimer || spanQueue.length === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushOtlpSpans();
  }, delayMs);
  flushTimer.unref?.();
}

function buildOtlpExportBody(serviceName: string, spans: OtlpSpanPayload[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: sanitizeAttrValue(serviceName) } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "easyproxy" },
            spans,
          },
        ],
      },
    ],
  });
}

function otlpHeadersEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

async function exportBatch(items: QueuedOtlpSpan[]): Promise<void> {
  if (items.length === 0) return;
  const head = items[0]!;
  if (!isValidEndpointCached(head.endpoint, head.allowPrivateNetwork)) {
    stats.exportFailures += 1;
    return;
  }
  if (!fetchOverride) {
    try {
      const assessment = assessUrlDestination(head.endpoint);
      const isLoopback = assessment?.kind === "loopback" || assessment?.kind === "localhost";
      await resolvePublicAddresses(head.endpoint, {
        context: "OTLP endpoint",
        allowPrivateNetwork: isLoopback || head.allowPrivateNetwork,
      });
    } catch {
      stats.exportFailures += 1;
      return;
    }
  }
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  const deadline = signalWithTimeout(head.timeoutMs);
  try {
    const response = await fetchImpl(head.endpoint, {
      method: "POST",
      headers: {
        ...head.headers,
        "content-type": "application/json",
      },
      body: buildOtlpExportBody(head.serviceName, items.map((entry) => entry.span)),
      redirect: "error",
      signal: deadline.signal,
    });
    if (!response.ok) {
      stats.exportFailures += 1;
    } else {
      stats.exportedSpans += items.length;
    }
    try {
      await response.body?.cancel();
    } catch {
      // Ignore collector response drain failures.
    }
  } catch {
    stats.exportFailures += 1;
  } finally {
    deadline.cleanup();
  }
}

export async function flushOtlpSpans(maxWaitMs = 5_000): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (activeFlush) {
    await activeFlush;
  }
  if (spanQueue.length === 0) return;

  const work = (async () => {
    const deadlineAt = Date.now() + maxWaitMs;
    while (spanQueue.length > 0 && Date.now() < deadlineAt) {
      const first = spanQueue[0]!;
      const batch: QueuedOtlpSpan[] = [];
      const remaining: QueuedOtlpSpan[] = [];
      for (const item of spanQueue) {
        if (
          batch.length < first.batchSize
          && item.endpoint === first.endpoint
          && item.allowPrivateNetwork === first.allowPrivateNetwork
          && item.serviceName === first.serviceName
          && otlpHeadersEqual(item.headers, first.headers)
        ) {
          batch.push(item);
        } else {
          remaining.push(item);
        }
      }
      spanQueue = remaining;
      await exportBatch(batch);
    }
  })();

  activeFlush = work;
  try {
    await work;
  } finally {
    if (activeFlush === work) activeFlush = null;
  }
}

function enqueueSpan(item: QueuedOtlpSpan): void {
  ensureShutdownHookRegistered();
  if (spanQueue.length >= maxQueueCapacity) {
    const excess = spanQueue.length - maxQueueCapacity + 1;
    spanQueue.splice(0, excess);
    stats.droppedSpans += excess;
  }
  spanQueue.push(item);
  stats.enqueuedSpans += 1;
  if (spanQueue.length >= item.batchSize) {
    scheduleFlush(0);
  } else {
    scheduleFlush(FLUSH_DEBOUNCE_MS);
  }
}

export function startOtlpRequestSpan(
  req: Request,
  config: Pick<EpxConfig, "otlp"> | null | undefined,
  context: {
    method: string;
    pathname: string;
    protocol: "responses" | "chat" | "messages" | "embeddings";
  },
): OtlpRequestSpanHandle | undefined {
  if (!isOtlpTracingEnabled(config)) return undefined;
  const otlp = config!.otlp!;
  const endpoint = otlp.endpoint!.trim();
  const sampleRate = clampConfigNumber(otlp.sampleRate, DEFAULT_SAMPLE_RATE, 0, 1);
  const timeoutMs = Math.trunc(clampConfigNumber(otlp.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 30_000));
  const queueCap = Math.trunc(clampConfigNumber(otlp.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 16, 4096));
  const batchSize = Math.trunc(clampConfigNumber(otlp.batchSize, DEFAULT_BATCH_SIZE, 1, 256));
  maxQueueCapacity = queueCap;

  const incoming = parseW3cTraceparent(req.headers.get("traceparent"));
  const traceId = incoming?.traceId ?? randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const sampled = sampleRate <= 0
    ? false
    : sampleRate >= 1
      ? true
      : incoming ? incoming.sampled : Math.random() < sampleRate;
  const traceparent = `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;

  const startEpochNs = BigInt(Date.now()) * 1_000_000n;
  const startHrNs = process.hrtime.bigint();
  let finished = false;
  const safePath = sanitizeAttrValue(context.pathname || "/");
  const safeMethod = sanitizeAttrValue(context.method || "POST");

  return {
    traceId,
    spanId,
    traceparent,
    sampled,
    finish(outcome) {
      if (finished) return;
      finished = true;
      if (!sampled) return;
      const elapsedNs = process.hrtime.bigint() - startHrNs;
      const endEpochNs = startEpochNs + (elapsedNs > 0n ? elapsedNs : 1_000n);
      const entry = outcome.finalEntry;
      const attrs: OtlpAttribute[] = [
        { key: "http.request.method", value: { stringValue: safeMethod } },
        { key: "url.path", value: { stringValue: safePath } },
        { key: "http.response.status_code", value: { intValue: String(Math.trunc(outcome.status)) } },
        { key: "epx.protocol", value: { stringValue: entry?.inboundProtocol ?? context.protocol } },
      ];
      if (entry?.provider && entry.provider !== "unknown") {
        attrs.push({ key: "epx.provider", value: { stringValue: sanitizeAttrValue(entry.provider) } });
      }
      if (entry?.requestedModel && entry.requestedModel !== "unknown") {
        attrs.push({ key: "gen_ai.request.model", value: { stringValue: sanitizeAttrValue(entry.requestedModel) } });
      } else if (entry?.model && entry.model !== "unknown") {
        attrs.push({ key: "gen_ai.request.model", value: { stringValue: sanitizeAttrValue(entry.model) } });
      }
      if (entry?.model && entry.model !== "unknown") {
        attrs.push({ key: "gen_ai.response.model", value: { stringValue: sanitizeAttrValue(entry.model) } });
      }
      if (typeof entry?.usage?.inputTokens === "number" && Number.isFinite(entry.usage.inputTokens)) {
        attrs.push({ key: "gen_ai.usage.input_tokens", value: { intValue: String(Math.trunc(entry.usage.inputTokens)) } });
      }
      if (typeof entry?.usage?.outputTokens === "number" && Number.isFinite(entry.usage.outputTokens)) {
        attrs.push({ key: "gen_ai.usage.output_tokens", value: { intValue: String(Math.trunc(entry.usage.outputTokens)) } });
      }
      if (typeof entry?.firstOutputMs === "number" && Number.isFinite(entry.firstOutputMs) && entry.firstOutputMs >= 0) {
        attrs.push({ key: "epx.ttft_ms", value: { intValue: String(Math.trunc(entry.firstOutputMs)) } });
      }
      if (entry?.apiKeyId) {
        attrs.push({ key: "epx.api_key_id", value: { stringValue: sanitizeAttrValue(entry.apiKeyId) } });
      }
      const errCode = outcome.errorCode ?? entry?.errorCode;
      if (errCode) {
        attrs.push({ key: "epx.error_code", value: { stringValue: sanitizeAttrValue(errCode) } });
      }

      const headers: Record<string, string> = {};
      if (otlp.headers) {
        for (const [k, v] of Object.entries(otlp.headers)) {
          if (k.toLowerCase() !== "content-type") headers[k] = v;
        }
      }

      enqueueSpan({
        endpoint,
        allowPrivateNetwork: otlp.allowPrivateNetwork === true,
        headers,
        serviceName: otlp.serviceName?.trim() || DEFAULT_SERVICE_NAME,
        timeoutMs,
        batchSize,
        span: {
          traceId,
          spanId,
          ...(incoming ? { parentSpanId: incoming.parentSpanId } : {}),
          name: `${safeMethod} ${safePath}`.slice(0, 128),
          kind: 2, // SPAN_KIND_SERVER
          startTimeUnixNano: startEpochNs.toString(),
          endTimeUnixNano: endEpochNs.toString(),
          attributes: attrs,
          status: { code: outcome.status >= 500 ? 2 : 1 },
        },
      });
    },
  };
}

export { injectOtlpTraceparent } from "../lib/trace-context";

export function projectMaskedOtlpConfig(otlp: EpxOtlpConfig | undefined): {
  enabled: boolean;
  endpoint?: string;
  headerKeys?: string[];
  headersConfigured?: boolean;
  serviceName?: string;
  sampleRate?: number;
  timeoutMs?: number;
  maxQueueSize?: number;
  batchSize?: number;
  allowPrivateNetwork?: boolean;
} {
  if (!otlp) return { enabled: false };
  const headerKeys = otlp.headers ? Object.keys(otlp.headers) : undefined;
  return {
    enabled: otlp.enabled === true,
    ...(otlp.endpoint ? { endpoint: otlp.endpoint } : {}),
    ...(headerKeys && headerKeys.length > 0 ? { headerKeys, headersConfigured: true } : {}),
    ...(otlp.serviceName ? { serviceName: otlp.serviceName } : {}),
    ...(otlp.sampleRate !== undefined ? { sampleRate: otlp.sampleRate } : {}),
    ...(otlp.timeoutMs !== undefined ? { timeoutMs: otlp.timeoutMs } : {}),
    ...(otlp.maxQueueSize !== undefined ? { maxQueueSize: otlp.maxQueueSize } : {}),
    ...(otlp.batchSize !== undefined ? { batchSize: otlp.batchSize } : {}),
    ...(otlp.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
  };
}
