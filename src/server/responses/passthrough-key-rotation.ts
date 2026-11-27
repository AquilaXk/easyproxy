import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { readCreditOrBudgetExhaustedResponse } from "../../lib/credit-budget-refusal";
import { rotateGenericOAuthAccountOnRefusal } from "../../oauth/generic-account-failover";
import { hasKeyPoolFailover, rotateProviderTransportOn429, rotateProviderTransportOnCreditOrBudget } from "../../providers/key-failover";

export async function shouldAttemptPassthroughGenericFailover(
  response: Response,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 400 && response.status !== 402 && response.status !== 403 && response.status !== 422) return false;
  return await readCreditOrBudgetExhaustedResponse(response, abortSignal);
}

export function pickPassthroughGenericFailoverAccount(
  config: EpxConfig,
  providerName: string,
  accountId: string,
  response: Response,
  modelId: string,
): string | null {
  return rotateGenericOAuthAccountOnRefusal(
    config,
    providerName,
    accountId,
    "billing",
    response.headers.get("retry-after"),
    Date.now(),
    modelId,
  );
}
import type { RouteResult } from "../../router";
import type { EpxConfig, EpxParsedRequest } from "../../types";
import { bindRouteReasoningReplayScope } from "./core-replay";

// Passthrough's credential moves share one import site so passthrough-dispatch.ts stays under its line cap.
export { recoverAutoPausedAccount } from "./account-auto-pause-recovery";

/**
 * Key-pool failover for a native passthrough 429 (or credit/budget 400/402/403/422 refusal)
 * before any output. This wire returns before the adapter loop's key-429 arm, so without it a
 * pooled key's refusal reached the client while the same refusal rotates on the adapter and
 * chat-native wires.
 */
export async function rotatePassthroughKeyOn429<T>(options: {
  config: EpxConfig;
  route: Pick<RouteResult, "provider" | "providerName">;
  parsed: EpxParsedRequest;
  response: Response;
  adapterName: string;
  signal?: AbortSignal;
  budgetSpent: () => boolean;
  refetch: (recovery: "key-429" | "key-401") => Promise<T>;
}): Promise<T | undefined> {
  const { config, route, parsed, response, adapterName, refetch } = options;
  if (options.signal?.aborted || isNonReplayableResponse(response) || !hasKeyPoolFailover(route.provider)
    || route.provider._apiKeyAttempt?.distributed || options.budgetSpent()) return;
  if (response.status === 429) {
    const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
      retryAfter: response.headers.get("retry-after"),
      attemptedKey: route.provider.apiKey,
      promptCacheKey: parsed.options.promptCacheKey,
    });
    if (!rotated) return;
    try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
    route.provider = rotated;
    bindRouteReasoningReplayScope({ parsed, providerName: route.providerName, provider: rotated, adapterName });
    return refetch("key-429");
  }
  if (response.status !== 400 && response.status !== 402 && response.status !== 403 && response.status !== 422) return;
  if (!await readCreditOrBudgetExhaustedResponse(response, options.signal) || options.signal?.aborted) return;
  const rotated = rotateProviderTransportOnCreditOrBudget(config, route.providerName, route.provider, {
    attemptedKey: route.provider.apiKey,
    promptCacheKey: parsed.options.promptCacheKey,
  });
  if (!rotated) return;
  try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
  route.provider = rotated;
  bindRouteReasoningReplayScope({ parsed, providerName: route.providerName, provider: rotated, adapterName });
  return refetch("key-401");
}
