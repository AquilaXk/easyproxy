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

/**
 * Evaluates and applies configured outbound secret guarding, tool-output compression,
 * and prompt-cache injection to `body` without mutating process hygiene counters.
 */
export function evaluateOutboundPayloadHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression" | "promptCacheInjection">,
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
  const cachePass = injectPromptCacheBreakpointsInPlace(afterCompressionBody, config.promptCacheInjection);
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
): OutboundPayloadHygieneOutcome {
  if ((config.outboundSecretGuard?.mode ?? "off") !== "off") hygieneStats.scannedRequests += 1;
  const { secretGuard, compression, cachePass } = evaluation;
  if (secretGuard.matches > 0) hygieneStats.secretDetections += secretGuard.matches;
  if (secretGuard.blocked) {
    hygieneStats.secretBlocks += 1;
    if (logCtx) {
      markLocalRequestLogRefusal(logCtx, "outbound_secret_guard");
      logCtx.errorCode = "outbound_secret_guard";
    }
    return { blocked: true, redactions: 0, compressedItems: 0, injectedCacheBreakpoints: 0, body: evaluation.body };
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
): OutboundPayloadHygieneOutcome {
  return commitOutboundPayloadHygiene(
    evaluateOutboundPayloadHygiene(body, config),
    config,
    logCtx,
  );
}

/**
 * Sanitizes compaction payloads in place by redacting hosted image paths first and
 * then running the shared outbound secret guard and tool-output compression pass.
 * Returns true when the caller must refuse the request with 400.
 */
export function prepareCompactionBodyHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression" | "promptCacheInjection">,
  logCtx?: RequestLogContext,
): boolean {
  const redacted = redactHostedImageDisplayPaths(body);
  return applyOutboundPayloadHygiene(redacted, config, logCtx).blocked;
}
