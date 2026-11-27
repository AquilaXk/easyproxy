import type { AttemptRecoveryKind } from "../../usage/log";
import { SendBudgetExhaustedError, isNonReplayableResponse } from "../../lib/upstream-retry";
import { rotateCreditOrBudgetKeyOnResponse } from "../../providers/anthropic-billing-recovery";
import {
  hasKeyPoolFailover,
  readQuotaResetAt,
  rotateProviderTransportOn401,
  rotateProviderTransportOn429,
} from "../../providers/key-failover";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { clientCancelledResponse } from "./core-errors";
import { retainAdapterFailureResponse } from "./image-context-recovery";
import type { ResponsesRequestContext } from "./core-options";
import { bindRouteReasoningReplayScope } from "./core-replay";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { ResponsesTransport } from "./request-transport";

export type KeyPoolRecoveryOutcome =
  | { kind: "continue"; response: Response }
  | { kind: "return"; response: Response }
  | { kind: "fallthrough"; response: Response };

export interface KeyPoolRecoveryContext {
  requestContext: Pick<ResponsesRequestContext, "options" | "config">;
  requestState: Pick<PreparedResponsesRequest, "parsed" | "route" | "inboundWire">;
  transportState: Pick<ResponsesTransport, "activeAdapter" | "invalidateSameTargetRequest" | "resolveSelectionAdapter">;
  sendBudgetState: Pick<ResponsesSendBudget, "reserveCredentialHop" | "pendingHopPermit">;
  upstream: AbortController;
  cleanupUpstreamAbort: () => void;
  billingPoolRequest: boolean;
  recoveryFlags: { billingRecoveryActive: boolean };
  resolveRotatedCopilotSelection: () => Promise<Response | undefined>;
  rebuildAndRefetch: (
    recovery: AttemptRecoveryKind,
    onDispatch?: () => void,
    preserveFailureResponse?: Response,
  ) => Promise<Response | { failed: Response }>;
}

interface KeyPoolRotationDispatchParams {
  ctx: KeyPoolRecoveryContext;
  upstreamResponse: Response;
  rotated: PreparedResponsesRequest["route"]["provider"];
  recovery: "key-401" | "key-429";
  hop: ReturnType<ResponsesSendBudget["reserveCredentialHop"]> | undefined;
  retainFailure: boolean;
  resolveCopilot: boolean;
}

async function dispatchRotatedKeyProvider({
  ctx,
  upstreamResponse,
  rotated,
  recovery,
  hop,
  retainFailure,
  resolveCopilot,
}: KeyPoolRotationDispatchParams): Promise<
  | { status: "ok"; response: Response }
  | { status: "break"; response: Response }
  | { status: "return"; response: Response }
> {
  const { requestContext, requestState, transportState, sendBudgetState, upstream, resolveRotatedCopilotSelection, rebuildAndRefetch } = ctx;
  const { config } = requestContext;
  const { parsed, route, inboundWire } = requestState;

  const failedResponse = retainFailure
    ? (await retainAdapterFailureResponse(upstreamResponse, upstream.signal)).response
    : undefined;
  const preservedResponse = failedResponse ?? upstreamResponse;
  try {
    // Release the failed response's socket before retrying; unread bodies otherwise linger
    // until runtime cleanup (one per rotated key).
    if (!failedResponse) {
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
    }
    route.provider = rotated;
    if (resolveCopilot) {
      const selectionFailure = await resolveRotatedCopilotSelection();
      if (selectionFailure) return { status: "return", response: selectionFailure };
    }
    transportState.invalidateSameTargetRequest();
    transportState.activeAdapter = transportState.resolveSelectionAdapter(
      resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
      config.cacheRetention,
    );
    bindRouteReasoningReplayScope({
      parsed,
      providerName: route.providerName,
      provider: route.provider,
      adapterName: transportState.activeAdapter.name,
    });
    if (hop) sendBudgetState.pendingHopPermit = hop.permit;
    const result = await rebuildAndRefetch(
      recovery,
      hop ? () => { if (hop.permit?.use() === false) throw new SendBudgetExhaustedError(); } : undefined,
      failedResponse,
    );
    if ("failed" in result) {
      if (result.failed !== failedResponse) return { status: "return", response: result.failed };
      return { status: "break", response: preservedResponse };
    }
    if (failedResponse) {
      try { void failedResponse.body?.cancel().catch(() => {}); } catch { /* closed */ }
    }
    return { status: "ok", response: result };
  } finally {
    if (hop) {
      sendBudgetState.pendingHopPermit = undefined;
      hop.permit?.release();
    }
  }
}

/** Rotate static API-key pools across credential-scoped 401 refusals. */
export async function recoverApiKeyPool401(
  ctx: KeyPoolRecoveryContext,
  initialResponse: Response,
): Promise<KeyPoolRecoveryOutcome> {
  const { requestContext, requestState, transportState, sendBudgetState, upstream, cleanupUpstreamAbort, billingPoolRequest, recoveryFlags } = ctx;
  const { options, config } = requestContext;
  const { parsed, route } = requestState;
  let upstreamResponse = initialResponse;

  // Static API-key pools can recover a credential-scoped 401 without abandoning the
  // provider: one revoked or mistyped key says nothing about its siblings. OAuth providers
  // refresh above and never enter here — `hasKeyPoolFailover` rejects oauth/forward modes.
  // Runs after the OAuth replay so a refreshable token is never treated as a dead key.
  while (upstreamResponse.status === 401 && hasKeyPoolFailover(route.provider)) {
    const rotated = rotateProviderTransportOn401(config, route.providerName, route.provider, {
      now: Date.now(),
      attemptedKey: route.provider.apiKey,
      promptCacheKey: parsed.options.promptCacheKey,
    });
    if (!rotated) break;
    if (recoveryFlags.billingRecoveryActive && (options.abortSignal?.aborted || upstream.signal.aborted)) {
      cleanupUpstreamAbort();
      upstream.abort();
      return { kind: "return", response: clientCancelledResponse() };
    }
    const billingHop = (billingPoolRequest || recoveryFlags.billingRecoveryActive)
      ? sendBudgetState.reserveCredentialHop(
        "auth-recovery",
        `${route.providerName}|${route.modelId}|key-401`,
        transportState.activeAdapter.fetchResponse === undefined,
      )
      : undefined;
    if (billingHop && !billingHop.allowed) break;

    const outcome = await dispatchRotatedKeyProvider({
      ctx,
      upstreamResponse,
      rotated,
      recovery: "key-401",
      hop: billingHop,
      retainFailure: billingPoolRequest || recoveryFlags.billingRecoveryActive,
      resolveCopilot: true,
    });
    if (outcome.status === "return") return { kind: "return", response: outcome.response };
    if (outcome.status === "break") return { kind: "fallthrough", response: outcome.response };
    upstreamResponse = outcome.response;
    // A recovery refetch can itself die on an ambiguous pre-header reset, and the refusal
    // that answers it is a 429. Every arm below keys on 429, so letting it fall through
    // hands the marked refusal to the next waiting arm and replays the send it exists to
    // stop. Re-enter the loop guard instead, which returns it unchanged.
    if (isNonReplayableResponse(upstreamResponse)) return { kind: "continue", response: upstreamResponse };
  }

  return { kind: "fallthrough", response: upstreamResponse };
}

/** Rotate Anthropic API-key pools across billing 400/402 refusals. */
export async function recoverAnthropicBillingKeyPool(
  ctx: KeyPoolRecoveryContext,
  initialResponse: Response,
): Promise<KeyPoolRecoveryOutcome> {
  const { requestContext, requestState, transportState, sendBudgetState, upstream, cleanupUpstreamAbort, recoveryFlags } = ctx;
  const { options, config } = requestContext;
  const { parsed, route } = requestState;
  let upstreamResponse = initialResponse;

  while ((upstreamResponse.status === 400 || upstreamResponse.status === 402 || upstreamResponse.status === 403 || upstreamResponse.status === 422) && hasKeyPoolFailover(route.provider)) {
    const rotated = await rotateCreditOrBudgetKeyOnResponse(upstreamResponse, config, route.providerName, route.provider, {
      signal: upstream.signal,
      promptCacheKey: parsed.options.promptCacheKey,
    });
    if (upstream.signal.aborted || options.abortSignal?.aborted) {
      cleanupUpstreamAbort();
      upstream.abort();
      return { kind: "return", response: clientCancelledResponse() };
    }
    if (!rotated) break;
    recoveryFlags.billingRecoveryActive = true;
    const hop = sendBudgetState.reserveCredentialHop(
      "auth-recovery",
      `${route.providerName}|${route.modelId}|key-401`,
      transportState.activeAdapter.fetchResponse === undefined,
    );
    if (!hop.allowed) break;

    const outcome = await dispatchRotatedKeyProvider({
      ctx,
      upstreamResponse,
      rotated,
      recovery: "key-401",
      hop,
      retainFailure: true,
      resolveCopilot: false,
    });
    if (outcome.status === "return") return { kind: "return", response: outcome.response };
    if (outcome.status === "break") return { kind: "fallthrough", response: outcome.response };
    return { kind: "continue", response: outcome.response };
  }

  return { kind: "fallthrough", response: upstreamResponse };
}

/** Rotate static API-key pools across rate-limit 429 refusals. */
export async function recoverApiKeyPool429(
  ctx: KeyPoolRecoveryContext,
  initialResponse: Response,
): Promise<KeyPoolRecoveryOutcome> {
  const { requestContext, requestState, transportState, sendBudgetState, upstream, cleanupUpstreamAbort, billingPoolRequest, recoveryFlags } = ctx;
  const { options, config } = requestContext;
  const { parsed, route } = requestState;
  let upstreamResponse = initialResponse;

  // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the
  // SAME request once per remaining key. OAuth/forward providers and single-key pools
  // return null immediately, so this stays a no-op for them (src/providers/key-failover.ts).
  while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
    // A quota exhaustion is dated in the BODY, not in `Retry-After` — OpenRouter
    // sends no header for it (#4024). Read a bounded prefix before the socket is
    // released below; a failed or slow read just leaves the header path in charge.
    // Peeks a bounded prefix and hands back a Response still carrying the whole
    // body, so the cancel below still releases the socket.
    let peeked: Awaited<ReturnType<typeof readQuotaResetAt>>;
    try {
      peeked = await readQuotaResetAt(upstreamResponse, { signal: options.abortSignal });
    } catch {
      cleanupUpstreamAbort();
      upstream.abort();
      return { kind: "return", response: clientCancelledResponse() };
    }
    if (options.abortSignal?.aborted) {
      cleanupUpstreamAbort();
      upstream.abort();
      return { kind: "return", response: clientCancelledResponse() };
    }
    upstreamResponse = peeked.response;
    const quotaResetAt = peeked.at;
    const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
      retryAfter: upstreamResponse.headers.get("retry-after"),
      now: Date.now(),
      attemptedKey: route.provider.apiKey,
      promptCacheKey: parsed.options.promptCacheKey,
      quotaResetAt,
    });
    if (!rotated) break;
    if (recoveryFlags.billingRecoveryActive && (options.abortSignal?.aborted || upstream.signal.aborted)) {
      cleanupUpstreamAbort();
      upstream.abort();
      return { kind: "return", response: clientCancelledResponse() };
    }
    const billingHop = (billingPoolRequest || recoveryFlags.billingRecoveryActive)
      ? sendBudgetState.reserveCredentialHop(
        "auth-recovery",
        `${route.providerName}|${route.modelId}|key-429`,
        transportState.activeAdapter.fetchResponse === undefined,
      )
      : undefined;
    if (billingHop && !billingHop.allowed) break;

    const outcome = await dispatchRotatedKeyProvider({
      ctx,
      upstreamResponse,
      rotated,
      recovery: "key-429",
      hop: billingHop,
      retainFailure: billingPoolRequest || recoveryFlags.billingRecoveryActive,
      resolveCopilot: true,
    });
    if (outcome.status === "return") return { kind: "return", response: outcome.response };
    if (outcome.status === "break") return { kind: "fallthrough", response: outcome.response };
    upstreamResponse = outcome.response;
    // Rotating on the refusal would also write a cooldown against a key that rate-limited
    // nothing, which outlives the request.
    if (isNonReplayableResponse(upstreamResponse)
      || (recoveryFlags.billingRecoveryActive && upstreamResponse.status === 401)
      || [400, 402, 403, 422].includes(upstreamResponse.status)) {
      return { kind: "continue", response: upstreamResponse };
    }
  }

  return { kind: "fallthrough", response: upstreamResponse };
}
