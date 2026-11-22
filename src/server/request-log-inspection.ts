import { existsSync, readFileSync } from "node:fs";
import type { ResponsesTerminalStatus } from "../bridge";
import { readCodexCatalogPath } from "../codex/catalog";
import { CODEX_CONFIG_PATH, readRootTomlString } from "../codex/paths";
import {
  httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError,
  responsesCompletionError,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import type { EpxUsage } from "../types";
import { isUsageDebugEnabled, truncateForDebug, USAGE_DEBUG_BODY_SAMPLE_BYTES } from "../usage/debug";
import { boundedServiceTier } from "../usage/error-detail";
import { recordObservedServedModel } from "../usage/log";
import { sealedCredentialRefusals } from "./request-log-attempt-recovery";
import { recordKeyWireAttemptUsage } from "./request-log-attempts";
import { incompleteReasonDetail } from "./request-log-failure-detail";
import { recordGenerationEvent } from "./request-log-generation-window";
import { captureUpstreamTerminalDiagnostics, guardedRowCopy, type UpstreamErrorPayload } from "./request-log-terminal-status";
import type { RequestLogContext } from "./request-log-types";

export function requestLogSpeedLabel(serviceTier: string | undefined): string | undefined {
  const normalized = serviceTier?.trim().toLowerCase();
  if (normalized === "priority" || normalized === "fast") return "fast";
  // Ultra Fast is labelled even though nothing in the shipped catalog advertises it: the
  // reporter on #3429 reached it by hand-editing their own catalog, the request completed,
  // and the Logs column stayed empty because this returned undefined. A tier the proxy
  // forwarded but refuses to name is an observability hole, not a feature gate — the flag
  // decides whether the tier survives, not whether we admit to carrying it.
  if (normalized === "ultrafast") return "ultrafast";
  return undefined;
}

export function readConfiguredCodexServiceTier(): string | undefined {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) return undefined;
    return readRootTomlString(readFileSync(CODEX_CONFIG_PATH, "utf-8"), "service_tier") ?? undefined;
  } catch {
    return undefined;
  }
}

export function catalogModelSupportsServiceTier(modelId: string, serviceTier: string | undefined): boolean | undefined {
  if (!serviceTier) return undefined;
  const requestTier = serviceTier.trim().toLowerCase() === "fast" ? "priority" : serviceTier.trim();
  try {
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return undefined;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as { models?: unknown };
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const entry = models.find(model => {
      if (!model || typeof model !== "object") return false;
      return (model as { slug?: unknown; id?: unknown }).slug === modelId
        || (model as { slug?: unknown; id?: unknown }).id === modelId;
    });
    if (!entry || typeof entry !== "object") return undefined;
    const tiers = (entry as { service_tiers?: unknown }).service_tiers;
    return Array.isArray(tiers) && tiers.some(tier => (
      tier && typeof tier === "object" && (tier as { id?: unknown }).id === requestTier
    ));
  } catch {
    return undefined;
  }
}

export function applyResponseLogMetadata(logCtx: RequestLogContext, payload: unknown, collectUsage = true): void {
  if (!payload || typeof payload !== "object") return;
  if (logCtx.observedTerminalStatus === undefined) {
    const eventType = (payload as { type?: unknown }).type;
    const response = (payload as { response?: unknown }).response;
    const responseStatus = response && typeof response === "object"
      ? (response as { status?: unknown }).status
      : (payload as { status?: unknown }).status;
    if (eventType === "response.completed") {
      logCtx.observedTerminalStatus = responsesCompletionError(payload) == null ? "completed" : "failed";
    } else if (eventType === "response.failed") {
      logCtx.observedTerminalStatus = "failed";
    } else if (eventType === "response.incomplete") {
      logCtx.observedTerminalStatus = "incomplete";
    } else if (responseStatus === "completed" || responseStatus === "failed" || responseStatus === "incomplete") {
      logCtx.observedTerminalStatus = responseStatus;
    }
  }
  const source = "response" in payload && typeof (payload as { response?: unknown }).response === "object"
    ? (payload as { response?: unknown }).response
    : payload;
  if (!source || typeof source !== "object") return;
  recordObservedServedModel(logCtx, (source as { model?: unknown }).model);
  const serviceTier = (source as { service_tier?: unknown }).service_tier;
  if (typeof serviceTier === "string" && serviceTier.trim()) {
    const sanitized = boundedServiceTier(serviceTier);
    if (sanitized) logCtx.responseServiceTier = sanitized;
    logCtx.activeTierMetadata?.observeResponseServiceTier(serviceTier);
  } else if (Object.prototype.hasOwnProperty.call(source, "service_tier")) {
    logCtx.activeTierMetadata?.observeResponseServiceTier(serviceTier);
  }
  const usage = collectUsage && !logCtx.usageFromBridge && !logCtx.clientResponseUsage
    ? usageFromResponsesPayload((source as { usage?: unknown }).usage) : undefined;
  if (usage) {
    if (!recordKeyWireAttemptUsage(logCtx, usage)) {
      logCtx.usage = usage;
      if (logCtx.activeAttempt && !sealedCredentialRefusals.has(logCtx.activeAttempt)) logCtx.activeAttempt.usage = usage;
    }
    // Counts taken off a wire, not reported raw. The zero-default token-detail objects strict
    // clients require are indistinguishable here from a measured zero, so the cache detail these
    // counts carry is recorded as synthesized rather than as an observed miss.
    logCtx.usageWireParsed = true;
  }
}

export function usageFromResponsesPayload(usage: unknown): EpxUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown; cache_write_1h_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
    return {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.input_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.input_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.input_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.input_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_1h_tokens === "number"
        ? { cacheCreation1hInputTokens: raw.input_tokens_details.cache_write_1h_tokens }
        : {}),
      ...(typeof raw.output_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.output_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
    return {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.prompt_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.prompt_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.prompt_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.prompt_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.prompt_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.completion_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.completion_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  return undefined;
}

/**
 * Mark a refusal this proxy synthesized locally. Sets origin to `synthetic` and a
 * distinct local reason so the request log cannot be read as an upstream overload.
 */
// Typed by the two fields it writes rather than by the whole context: the durable-spend tracker
// has to mark a row from a narrow view of it, and widening that view to the full context there
// would pull the entire log shape into a module that touches two of its fields.
export function markLocalRequestLogRefusal(
  logCtx: Pick<RequestLogContext, "localTerminalReason" | "terminalSource">,
  reason: string,
): void {
  logCtx.localTerminalReason = reason;
  logCtx.terminalSource = "synthetic";
}

export function inspectResponseLogJson(logCtx: RequestLogContext, text: string): void {
  try {
    applyResponseLogMetadata(logCtx, JSON.parse(text));
  } catch {
    logCtx.activeTierMetadata?.markResponseUnparseable();
    /* body may not be JSON; request log metadata is best-effort only */
  }
  captureUpstreamError(logCtx, text);
  if (isUsageDebugEnabled() && logCtx.usageDebugBodyKind === undefined) {
    logCtx.usageDebugBodyKind = "json";
    logCtx.usageDebugBodySample = truncateForDebug(text);
  }
}

export function inspectResponseLogSsePayload(logCtx: RequestLogContext, payload: string | null): void {
  if (!payload || payload.trim() === "[DONE]") return;
  let parsed: unknown | undefined;
  try {
    parsed = JSON.parse(payload);
  } catch {
    /* SSE block payload may not be JSON; metadata inspection is best-effort */
  }
  inspectResponseLogSsePayloadParsed(logCtx, payload, parsed);
}

/** Inspect an SSE payload using the caller's single best-effort JSON parse. */
export function inspectResponseLogSsePayloadParsed(
  logCtx: RequestLogContext,
  payload: string | null,
  parsed: unknown | undefined,
  collectUsage = true,
): void {
  if (!payload || payload.trim() === "[DONE]") return;
  const debugEnabled = isUsageDebugEnabled();
  const sseAlreadyMarked = logCtx.usageDebugBodyKind === "sse";
  if (parsed !== undefined) recordGenerationEvent(logCtx, (parsed as { type?: unknown } | null)?.type);
  if (parsed !== undefined) applyResponseLogMetadata(logCtx, parsed, collectUsage);
  else logCtx.activeTierMetadata?.markResponseUnparseable();
  captureUpstreamErrorParsed(logCtx, payload, parsed, true);
  if (debugEnabled) {
    if (!sseAlreadyMarked) {
      logCtx.usageDebugBodyKind = "sse";
      logCtx.usageDebugBodySample = truncateForDebug(payload);
    } else if (typeof logCtx.usageDebugBodySample === "string"
      && logCtx.usageDebugBodySample.length < USAGE_DEBUG_BODY_SAMPLE_BYTES) {
      const combined = `${logCtx.usageDebugBodySample}\n${payload}`;
      logCtx.usageDebugBodySample = truncateForDebug(combined);
    }
  }
}

/**
 * Capture the upstream error reason into the request log context. Codex/consumer surfaces only
 * see an HTTP-mapped error code (502 → upstream_server_error); the granular reason lives inside
 * a `response.failed` SSE payload's `error.message` (the adapter's redacted upstream message) or
 * a non-streaming JSON error body. We keep the FIRST non-empty reason (the original failure) and
 * run it through redactSecretString so secrets never reach /api/logs. Pure; safe on any text.
 */
function captureUpstreamError(logCtx: RequestLogContext, text: string | null): void {
  if (!text) return;
  let parsed: unknown | undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* retain the raw malformed payload for the bounded fallback below */
  }
  captureUpstreamErrorParsed(logCtx, text, parsed);
}

function captureUpstreamErrorParsed(
  logCtx: RequestLogContext,
  text: string,
  parsed: unknown | undefined, untypedSse = false,
): void {
  if (parsed !== undefined && parsed !== null) {
    const json = parsed as UpstreamErrorPayload;
    if (!captureUpstreamTerminalDiagnostics(logCtx, json, untypedSse)) return;
    const reason = json?.response?.incomplete_details?.reason;
    if (json.type === "response.incomplete"
      && logCtx.terminalIncompleteReason === undefined
      && typeof reason === "string"
      && reason.trim()) {
      logCtx.terminalIncompleteReason = reason.trim();
    }
    if (logCtx.upstreamError) return;
    const message = upstreamErrorMessageFromPayload(parsed);
    if (typeof message === "string" && message.trim()) {
      logCtx.upstreamError = guardedRowCopy(logCtx, message);
      return;
    }
    // No human-readable error message: fall back to the structured incomplete reason emitted by
    // the bridge on a stall-timeout or adapter EOF (response.incomplete). Maps the raw reason to a
    // reader-facing label so a generic 502 in /api/logs explains WHY the turn ended, not just the
    // mapped HTTP code.
    if (typeof reason === "string" && reason.trim()) {
      const incomplete = incompleteReasonDetail(reason.trim()); // A known reason also gets a closed row detail.
      logCtx.upstreamError = guardedRowCopy(logCtx, incomplete.text);
      if (incomplete.detail) logCtx.failureDetail = incomplete.detail;
    }
    return;
  }
  if (logCtx.upstreamError) return;
  const trimmed = text.trim();
  if (trimmed) {
    logCtx.upstreamError = guardedRowCopy(logCtx, trimmed);
  }
}

/** Map a terminal Responses error object to the HTTP status we record in /api/logs. */
export function httpStatusFromTerminalError(error: {
  type?: string;
  code?: string | null;
  message?: string;
} | undefined): number {
  return httpStatusFromClassifiedTerminalError(error);
}

export function httpStatusForTerminalStatus(status: ResponsesTerminalStatus): number {
  return status === "completed" ? 200 : 502;
}

export function httpStatusForRequestLogTerminal(
  status: ResponsesTerminalStatus,
  logCtx?: RequestLogContext,
): number {
  if (status === "incomplete" && (logCtx?.terminalHttpStatus === 429 || logCtx?.terminalHttpStatus === 402)) {
    return logCtx.terminalHttpStatus;
  }
  /**
   * [Decision Log]
   * - 목적과 의도: Keep request logs aligned with the successful HTTP/SSE contract.
   * - 기존 구현 및 제약 조건: All incomplete terminals were recorded as 502 even when the
   *   client-requested output limit was reached normally.
   * - 검토한 주요 대안: Treat every incomplete as success, or infer the reason from display text.
   * - 선택한 방식: Only structured max_output_tokens incompletes map to 200.
   * - 다른 대안 대신 이 방식을 선택한 이유: Stall, EOF, and unknown incompletes must remain
   *   visible failures, and display text is not a stable classification contract.
   * - 장점, 단점 및 영향: Logs stop reporting false upstream errors while retaining the
   *   incomplete terminal detail; native callers without a structured reason keep old behavior.
   */
  if (status === "incomplete" && logCtx?.terminalIncompleteReason === "max_output_tokens") {
    return 200;
  }
  if (status === "failed" && logCtx?.terminalHttpStatus !== undefined) {
    return logCtx.terminalHttpStatus;
  }
  return httpStatusForTerminalStatus(status);
}
