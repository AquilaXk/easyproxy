import { statSync } from "node:fs";
import {
  boundEntryIdForLane,
  recordProviderCacheAffinity,
  releaseProviderCacheAffinity,
} from "../providers/cache-affinity";
import { isAnthropicBillingFailure } from "../providers/anthropic-billing-refusal";
import type { EpxConfig, EpxUsage } from "../types";
import type { RequestLogContext } from "./request-log";
import { getConfigDir, getConfigPath, loadConfig } from "../config";
import { capturedCacheAffinityIdentity, currentCacheAffinityIdentity } from "../providers/cache-affinity-identity";

let cachedProvidersState: {
  dir: string;
  path: string;
  mtimeMs: number;
  size: number;
  checkedAt: number;
  providers: EpxConfig["providers"];
} | null = null;

function readCachedProviders(): EpxConfig["providers"] {
  const dir = getConfigDir();
  const path = getConfigPath();
  const now = Date.now();
  if (cachedProvidersState && cachedProvidersState.dir === dir && cachedProvidersState.path === path && now - cachedProvidersState.checkedAt < 1_000) {
    return cachedProvidersState.providers;
  }
  try {
    const st = statSync(path);
    if (cachedProvidersState && cachedProvidersState.dir === dir && cachedProvidersState.path === path
      && cachedProvidersState.mtimeMs === st.mtimeMs && cachedProvidersState.size === st.size) {
      cachedProvidersState.checkedAt = now;
      return cachedProvidersState.providers;
    }
    const config = loadConfig();
    cachedProvidersState = { dir, path, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now, providers: config.providers };
    return config.providers;
  } catch {
    return loadConfig().providers;
  }
}

/** Finalize against the serving credential, never a logical combo's display label. */
export function finalizeProviderCacheAffinity(
  logCtx: RequestLogContext,
  status: number,
  usage: EpxUsage | undefined,
): void {
  const {
    affinityLane: lane,
    affinityKeyEntryId: entryId,
    affinityProviderName: providerName,
  } = logCtx;
  if (!lane || !entryId || !providerName || logCtx.cacheAffinityApplicable !== true) return;
  const identity = capturedCacheAffinityIdentity(logCtx);
  if (!identity || identity !== currentCacheAffinityIdentity(providerName, readCachedProviders()[providerName], entryId)) return;
  if (status >= 200 && status < 300 && logCtx.observedTerminalStatus !== "failed") {
    const previouslyBound = boundEntryIdForLane(lane);
    recordProviderCacheAffinity({
      lane,
      providerName,
      entryId,
      identity,
      model: logCtx.affinityModel ?? logCtx.model,
      cacheRead: usage?.cacheReadInputTokens ?? usage?.cachedInputTokens,
      cacheWrite: usage?.cacheCreationInputTokens,
      cacheWriteLong: usage?.cacheCreation1hInputTokens,
      inputTokens: usage?.inputTokens,
    });
    if (logCtx.cacheAffinity === "kept" && logCtx.affinityKeptEntryId !== entryId) {
      logCtx.cacheAffinity = "bound";
      logCtx.cacheAffinityReason = "new";
    } else if (!logCtx.cacheAffinity) {
      logCtx.cacheAffinity = previouslyBound === entryId ? "kept" : "bound";
      logCtx.cacheAffinityReason = previouslyBound === entryId ? "cache" : "new";
    }
  } else if (
    logCtx.terminalSource !== "synthetic" &&
    (status === 401 ||
      status === 402 ||
      status === 429 ||
      (logCtx.providerAdapter === "anthropic" &&
        isAnthropicBillingFailure(status, logCtx.upstreamError ?? "", logCtx.upstreamErrorType)))
  ) {
    // Only this request's refusal is evidence. A shared cooldown may have been
    // written by another conversation while this request was in flight.
    if (!releaseProviderCacheAffinity(lane, providerName, entryId, identity)) return;
    logCtx.cacheAffinity = "released";
    logCtx.cacheAffinityReason = status === 401 ? "auth" : "quota";
  }
}
