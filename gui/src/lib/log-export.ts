import { parseProtocolTraceV1 } from "../../../src/protocols/dto";
import {
  buildPlaygroundPayload,
  type PlaygroundEffort,
  type PlaygroundEndpoint,
  type PlaygroundSeed,
} from "./playground-client";

const MAX_EXPORT_ROWS = 10_000;
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const VALID_EFFORTS = new Set<PlaygroundEffort>(["low", "medium", "high", "xhigh"]);

export interface LogExportRecord {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  client?: unknown;
  inboundProtocol?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  requestedServiceTier?: string;
  resolvedModel?: string;
  servedModel?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  totalTokens?: number;
  firstOutputMs?: number;
  protocolTrace?: unknown;
}

function normalizeEffort(raw: string | undefined): PlaygroundEffort | undefined {
  const candidate = raw?.trim().toLowerCase() as PlaygroundEffort | undefined;
  return candidate && VALID_EFFORTS.has(candidate) ? candidate : undefined;
}

export function playgroundEndpointForLog(
  detail: Pick<LogExportRecord, "protocolTrace" | "inboundProtocol">,
): PlaygroundEndpoint {
  const inbound = parseProtocolTraceV1(detail.protocolTrace)?.inbound;
  const proto = detail.inboundProtocol;
  if (inbound === "messages" || proto === "anthropic-messages" || proto === "messages") {
    return "/v1/messages";
  }
  if (inbound === "responses" || proto === "openai-responses" || proto === "responses") {
    return "/v1/responses";
  }
  return "/v1/chat/completions";
}

export function playgroundSeedFromLog(detail: LogExportRecord): PlaygroundSeed {
  const effort = normalizeEffort(detail.requestedEffort ?? detail.effectiveEffort);
  const serviceTier = detail.requestedServiceTier?.trim() || undefined;
  return {
    endpoint: playgroundEndpointForLog(detail),
    model: detail.model || detail.resolvedModel || detail.servedModel || "",
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildLogReplayCurl(detail: LogExportRecord, apiBase: string): string {
  const seed = playgroundSeedFromLog(detail);
  const endpoint = seed.endpoint ?? "/v1/chat/completions";
  const model = seed.model || "gpt-5.3-codex";
  const payload = buildPlaygroundPayload(
    endpoint,
    model,
    "",
    "Hello",
    true,
    undefined,
    {
      effort: seed.effort,
      serviceTier: seed.serviceTier,
    },
  );
  const cleanBase = (apiBase || (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:10100"))
    .replace(/\/+$/, "");
  return [
    "curl -sS -N",
    `-X POST ${shellSingleQuote(`${cleanBase}${endpoint}`)}`,
    `-H ${shellSingleQuote("Content-Type: application/json")}`,
    '-H "Authorization: Bearer $EASYPROXY_API_KEY"',
    `-d ${shellSingleQuote(JSON.stringify(payload))}`,
  ].join(" \\\n  ");
}

/**
 * Single-pass NDJSON serializer capped at `maxEntries`.
 */
export function serializeLogsJsonl(
  entries: readonly LogExportRecord[],
  maxEntries = MAX_EXPORT_ROWS,
): string {
  const limit = Math.min(entries.length, Math.max(0, maxEntries));
  if (limit === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < limit; i++) {
    lines.push(JSON.stringify(entries[i]));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Escapes a single CSV field per RFC 4180 and neutralizes spreadsheet formula injection.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  const raw = String(value);
  const safe = CSV_FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  if (safe !== raw || /[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

const CSV_HEADER = [
  "timestamp_iso",
  "request_id",
  "client",
  "provider",
  "model",
  "resolved_model",
  "status",
  "duration_ms",
  "ttft_ms",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "total_tokens",
  "error_code",
  "inbound_protocol",
].join(",");

/**
 * Single-pass RFC 4180 CSV serializer capped at `maxEntries` with formula injection protection.
 */
export function serializeLogsCsv(
  entries: readonly LogExportRecord[],
  maxEntries = MAX_EXPORT_ROWS,
): string {
  const limit = Math.min(entries.length, Math.max(0, maxEntries));
  const lines: string[] = [CSV_HEADER];
  for (let i = 0; i < limit; i++) {
    const entry = entries[i]!;
    const cached = entry.usage?.cacheReadInputTokens ?? entry.usage?.cachedInputTokens;
    const total = entry.usage?.totalTokens ?? entry.totalTokens;
    const iso = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toISOString() : "";
    const client = typeof entry.client === "string" ? entry.client : "";
    lines.push([
      sanitizeCsvCell(iso),
      sanitizeCsvCell(entry.requestId ?? ""),
      sanitizeCsvCell(client),
      sanitizeCsvCell(entry.provider),
      sanitizeCsvCell(entry.model),
      sanitizeCsvCell(entry.resolvedModel ?? entry.servedModel ?? ""),
      sanitizeCsvCell(entry.status),
      sanitizeCsvCell(entry.durationMs),
      sanitizeCsvCell(entry.firstOutputMs),
      sanitizeCsvCell(entry.usage?.inputTokens),
      sanitizeCsvCell(entry.usage?.outputTokens),
      sanitizeCsvCell(cached),
      sanitizeCsvCell(total),
      sanitizeCsvCell(entry.errorCode ?? ""),
      sanitizeCsvCell(entry.inboundProtocol ?? ""),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function triggerTextDownload(filename: string, mimeType: string, content: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    const timer = setTimeout(() => URL.revokeObjectURL(href), 1_000);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }
}
