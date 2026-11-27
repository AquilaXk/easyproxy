import { inspectAndApplyOutboundSecretGuard } from "../lib/outbound-secret-guard";
import { injectPromptCacheBreakpointsInPlace } from "../lib/prompt-cache-injection";
import { compressResponsesToolOutputsInPlace } from "../lib/tool-output-compression";
import type { EpxConfig } from "../types";
import { markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";
import { redactHostedImageDisplayPaths } from "./responses-hosted-image-display";

export const OUTBOUND_SECRET_BLOCKED_MESSAGE = "Outbound request blocked by secret guard policy";

export interface OutboundPayloadHygieneOutcome {
  blocked: boolean;
  redactions: number;
  compressedItems: number;
  injectedCacheBreakpoints?: number;
  normalizedSystemTimestamps?: number;
  body: unknown;
}

export interface OutboundPayloadHygieneStats {
  scannedRequests: number;
  secretDetections: number;
  secretBlocks: number;
  compressedToolOutputs: number;
  compactedJsonOutputs: number;
  foldedLogOutputs: number;
  deduplicatedToolOutputs: number;
  injectedCacheBreakpoints: number;
  normalizedSystemTimestamps: number;
  savedChars: number;
  estimatedSavedTokens: number;
}

const hygieneStats: OutboundPayloadHygieneStats = {
  scannedRequests: 0,
  secretDetections: 0,
  secretBlocks: 0,
  compressedToolOutputs: 0,
  compactedJsonOutputs: 0,
  foldedLogOutputs: 0,
  deduplicatedToolOutputs: 0,
  injectedCacheBreakpoints: 0,
  normalizedSystemTimestamps: 0,
  savedChars: 0,
  estimatedSavedTokens: 0,
};

export function getOutboundHygieneStats(): OutboundPayloadHygieneStats {
  return { ...hygieneStats };
}

export function resetOutboundHygieneStatsForTests(): void {
  hygieneStats.scannedRequests = 0;
  hygieneStats.secretDetections = 0;
  hygieneStats.secretBlocks = 0;
  hygieneStats.compressedToolOutputs = 0;
  hygieneStats.compactedJsonOutputs = 0;
  hygieneStats.foldedLogOutputs = 0;
  hygieneStats.deduplicatedToolOutputs = 0;
  hygieneStats.injectedCacheBreakpoints = 0;
  hygieneStats.normalizedSystemTimestamps = 0;
  hygieneStats.savedChars = 0;
  hygieneStats.estimatedSavedTokens = 0;
}

export function recordOutboundSecretOutcome(matches: number, blocked: boolean): void {
  hygieneStats.scannedRequests += 1;
  if (matches > 0) hygieneStats.secretDetections += matches;
  if (blocked) hygieneStats.secretBlocks += 1;
}

export interface OutboundPayloadHygieneEvaluation {
  secretGuard: ReturnType<typeof inspectAndApplyOutboundSecretGuard>;
  compression: ReturnType<typeof compressResponsesToolOutputsInPlace>;
  cachePass: ReturnType<typeof injectPromptCacheBreakpointsInPlace>;
  body: unknown;
}

export interface OutboundPayloadHygieneOptions {
  skipCacheBreakpoints?: boolean;
  skipScannedCounter?: boolean;
}

/**
 * Evaluates and applies configured outbound secret guarding, tool-output compression,
 * and prompt-cache injection to `body` without mutating process hygiene counters.
 */
export function evaluateOutboundPayloadHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression" | "promptCacheInjection">,
  options?: OutboundPayloadHygieneOptions,
): OutboundPayloadHygieneEvaluation {
  const secretGuard = inspectAndApplyOutboundSecretGuard(body, config.outboundSecretGuard);
  const afterSecretBody = secretGuard.body !== undefined ? secretGuard.body : body;
  if (secretGuard.blocked) {
    return {
      secretGuard,
      compression: { compressedItems: 0, savedChars: 0, body: afterSecretBody },
      cachePass: { existingBreakpoints: 0, injectedBreakpoints: 0, normalizedTimestamps: 0, body: afterSecretBody },
      body: afterSecretBody,
    };
  }
  const compression = compressResponsesToolOutputsInPlace(afterSecretBody, config.toolOutputCompression);
  const afterCompressionBody = compression.body !== undefined ? compression.body : afterSecretBody;
  const cacheConfig = options?.skipCacheBreakpoints && config.promptCacheInjection
    ? { ...config.promptCacheInjection, enabled: false }
    : config.promptCacheInjection;
  const cachePass = injectPromptCacheBreakpointsInPlace(afterCompressionBody, cacheConfig);
  const finalBody = cachePass.body !== undefined ? cachePass.body : afterCompressionBody;
  return { secretGuard, compression, cachePass, body: finalBody };
}

/**
 * Commits process-wide hygiene telemetry counters and request log refusal markers
 * for an evaluated outbound payload hygiene pass.
 */
export function commitOutboundPayloadHygiene(
  evaluation: OutboundPayloadHygieneEvaluation,
  config: Pick<EpxConfig, "outboundSecretGuard">,
  logCtx?: RequestLogContext,
  options?: OutboundPayloadHygieneOptions,
): OutboundPayloadHygieneOutcome {
  if ((config.outboundSecretGuard?.mode ?? "off") !== "off" && options?.skipScannedCounter !== true) {
    hygieneStats.scannedRequests += 1;
  }
  const { secretGuard, compression, cachePass } = evaluation;
  if (secretGuard.matches > 0) hygieneStats.secretDetections += secretGuard.matches;
  if (secretGuard.blocked) {
    hygieneStats.secretBlocks += 1;
    if (logCtx) {
      markLocalRequestLogRefusal(logCtx, "outbound_secret_guard");
      logCtx.errorCode = "outbound_secret_guard";
    }
    return {
      blocked: true,
      redactions: 0,
      compressedItems: 0,
      injectedCacheBreakpoints: 0,
      normalizedSystemTimestamps: 0,
      body: evaluation.body,
    };
  }
  if (compression.compressedItems > 0) hygieneStats.compressedToolOutputs += compression.compressedItems;
  if ((compression.compactedJsonItems ?? 0) > 0) hygieneStats.compactedJsonOutputs += compression.compactedJsonItems!;
  if ((compression.foldedLogItems ?? 0) > 0) hygieneStats.foldedLogOutputs += compression.foldedLogItems!;
  if ((compression.deduplicatedItems ?? 0) > 0) hygieneStats.deduplicatedToolOutputs += compression.deduplicatedItems!;
  if (compression.savedChars > 0) {
    hygieneStats.savedChars += compression.savedChars;
    hygieneStats.estimatedSavedTokens = Math.floor(hygieneStats.savedChars / 4);
  }
  if (cachePass.injectedBreakpoints > 0) hygieneStats.injectedCacheBreakpoints += cachePass.injectedBreakpoints;
  if (cachePass.normalizedTimestamps > 0) hygieneStats.normalizedSystemTimestamps += cachePass.normalizedTimestamps;
  return {
    blocked: false,
    redactions: secretGuard.redactions,
    compressedItems: compression.compressedItems,
    injectedCacheBreakpoints: cachePass.injectedBreakpoints,
    normalizedSystemTimestamps: cachePass.normalizedTimestamps,
    body: evaluation.body,
  };
}

/**
 * Applies configured outbound secret guarding, tool-output compression, and opt-in
 * prompt-cache breakpoint / prefix hygiene across translated and native passthrough
 * request payloads before upstream dispatch.
 */
export function applyOutboundPayloadHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression" | "promptCacheInjection">,
  logCtx?: RequestLogContext,
  options?: OutboundPayloadHygieneOptions,
): OutboundPayloadHygieneOutcome {
  return commitOutboundPayloadHygiene(
    evaluateOutboundPayloadHygiene(body, config, options),
    config,
    logCtx,
    options,
  );
}

/**
 * Injects Anthropic prompt-cache breakpoints on native Anthropic wire bodies only,
 * updating breakpoint telemetry without re-running secret guard or incrementing scannedRequests.
 */
export function applyPromptCacheBreakpointsOnly(
  body: unknown,
  config: Pick<EpxConfig, "promptCacheInjection">,
  targetModelId?: string,
): { injectedBreakpoints: number; body: unknown } {
  if (config.promptCacheInjection?.enabled !== true) {
    return { injectedBreakpoints: 0, body };
  }
  const hasModelOverride = typeof targetModelId === "string"
    && targetModelId.length > 0
    && body !== null
    && typeof body === "object"
    && !Array.isArray(body);
  const originalModel = hasModelOverride ? (body as Record<string, unknown>).model : undefined;
  const inputBody = hasModelOverride && originalModel !== targetModelId
    ? { ...(body as Record<string, unknown>), model: targetModelId }
    : body;
  const pass = injectPromptCacheBreakpointsInPlace(inputBody, {
    ...config.promptCacheInjection,
    // Timestamps were already stripped on inbound; keep delta counters exact.
    stripVolatileSystemTimestamps: false,
  });
  if (pass.injectedBreakpoints > 0) hygieneStats.injectedCacheBreakpoints += pass.injectedBreakpoints;
  let resultBody = pass.body !== undefined ? pass.body : inputBody;
  if (hasModelOverride && originalModel !== targetModelId) {
    if (pass.injectedBreakpoints === 0 && pass.normalizedTimestamps === 0 && resultBody === inputBody) {
      return { injectedBreakpoints: 0, body };
    }
    if (resultBody !== null && typeof resultBody === "object" && !Array.isArray(resultBody)) {
      const rest = { ...(resultBody as Record<string, unknown>) };
      if (originalModel === undefined) delete rest.model;
      else rest.model = originalModel;
      resultBody = rest;
    }
  }
  return {
    injectedBreakpoints: pass.injectedBreakpoints,
    body: resultBody,
  };
}

/**
 * Sanitizes compaction payloads by redacting hosted image paths first and then
 * running the shared outbound secret guard and tool-output compression pass.
 * Callers must refuse the request with 400 when `blocked` is true and forward `body`.
 */
export function prepareCompactionBodyHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression" | "promptCacheInjection">,
  logCtx?: RequestLogContext,
): OutboundPayloadHygieneOutcome {
  const redacted = redactHostedImageDisplayPaths(body);
  return applyOutboundPayloadHygiene(redacted, config, logCtx);
}

/**
 * Sanitizes restored `previous_response_id` prefix items after continuation expansion so
 * historical turns carry no missed secrets or uncompressed tool outputs before upstream dispatch.
 */
export function sanitizeExpandedPreviousResponsePrefix(
  expandedBody: unknown,
  originalBody: unknown,
  expandedPrefixLen: number,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression" | "promptCacheInjection">,
  logCtx?: RequestLogContext,
  skipScannedCounter = false,
): { blocked: boolean; body: unknown } {
  if (expandedBody === originalBody) return { blocked: false, body: expandedBody };
  if (expandedPrefixLen > 0 && Array.isArray((expandedBody as { input?: unknown }).input)) {
    const bodyRec = expandedBody as Record<string, unknown>;
    const currentInput = bodyRec.input as unknown[];
    const prefixSlice = currentInput.slice(0, expandedPrefixLen);
    const expandedHygiene = applyOutboundPayloadHygiene(
      { input: prefixSlice },
      config,
      logCtx,
      { skipCacheBreakpoints: true, skipScannedCounter },
    );
    if (expandedHygiene.blocked) return { blocked: true, body: expandedBody };
    const cleanedSlice = (expandedHygiene.body as { input?: unknown[] } | undefined)?.input;
    if (cleanedSlice && cleanedSlice !== prefixSlice) {
      bodyRec.input = [...cleanedSlice, ...currentInput.slice(expandedPrefixLen)];
    }
    return { blocked: false, body: expandedBody };
  }
  const expandedHygiene = applyOutboundPayloadHygiene(
    expandedBody,
    config,
    logCtx,
    { skipCacheBreakpoints: true, skipScannedCounter },
  );
  return {
    blocked: expandedHygiene.blocked,
    body: expandedHygiene.blocked ? expandedBody : expandedHygiene.body,
  };
}
