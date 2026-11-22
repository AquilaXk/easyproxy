import { inspectAndApplyOutboundSecretGuard } from "../lib/outbound-secret-guard";
import { compressResponsesToolOutputsInPlace } from "../lib/tool-output-compression";
import type { EpxConfig } from "../types";
import { markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";
import { redactHostedImageDisplayPaths } from "./responses-hosted-image-display";

export const OUTBOUND_SECRET_BLOCKED_MESSAGE = "Outbound request blocked by secret guard policy";

export interface OutboundPayloadHygieneOutcome {
  blocked: boolean;
  redactions: number;
  compressedItems: number;
}

export interface OutboundPayloadHygieneStats {
  scannedRequests: number;
  secretDetections: number;
  secretBlocks: number;
  compressedToolOutputs: number;
  savedChars: number;
}

const hygieneStats: OutboundPayloadHygieneStats = {
  scannedRequests: 0,
  secretDetections: 0,
  secretBlocks: 0,
  compressedToolOutputs: 0,
  savedChars: 0,
};

export function getOutboundHygieneStats(): OutboundPayloadHygieneStats {
  return { ...hygieneStats };
}

export function resetOutboundHygieneStatsForTests(): void {
  hygieneStats.scannedRequests = 0;
  hygieneStats.secretDetections = 0;
  hygieneStats.secretBlocks = 0;
  hygieneStats.compressedToolOutputs = 0;
  hygieneStats.savedChars = 0;
}

export function recordOutboundSecretOutcome(matches: number, blocked: boolean): void {
  hygieneStats.scannedRequests += 1;
  if (matches > 0) hygieneStats.secretDetections += matches;
  if (blocked) hygieneStats.secretBlocks += 1;
}

/**
 * Applies configured outbound secret guarding and tool-output compression across both
 * translated and native passthrough request payloads before upstream dispatch.
 */
export function applyOutboundPayloadHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression">,
  logCtx?: RequestLogContext,
): OutboundPayloadHygieneOutcome {
  if ((config.outboundSecretGuard?.mode ?? "off") !== "off") hygieneStats.scannedRequests += 1;
  const secretGuard = inspectAndApplyOutboundSecretGuard(body, config.outboundSecretGuard);
  if (secretGuard.matches > 0) hygieneStats.secretDetections += secretGuard.matches;
  if (secretGuard.blocked) {
    hygieneStats.secretBlocks += 1;
    if (logCtx) {
      markLocalRequestLogRefusal(logCtx, "outbound_secret_guard");
      logCtx.errorCode = "outbound_secret_guard";
    }
    return { blocked: true, redactions: 0, compressedItems: 0 };
  }
  const compression = compressResponsesToolOutputsInPlace(body, config.toolOutputCompression);
  if (compression.compressedItems > 0) hygieneStats.compressedToolOutputs += compression.compressedItems;
  if (compression.savedChars > 0) hygieneStats.savedChars += compression.savedChars;
  return {
    blocked: false,
    redactions: secretGuard.redactions,
    compressedItems: compression.compressedItems,
  };
}

/**
 * Sanitizes compaction payloads in place by redacting hosted image paths first and
 * then running the shared outbound secret guard and tool-output compression pass.
 * Returns true when the caller must refuse the request with 400.
 */
export function prepareCompactionBodyHygiene(
  body: unknown,
  config: Pick<EpxConfig, "outboundSecretGuard" | "toolOutputCompression">,
  logCtx?: RequestLogContext,
): boolean {
  redactHostedImageDisplayPaths(body);
  return applyOutboundPayloadHygiene(body, config, logCtx).blocked;
}
