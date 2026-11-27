import { formatErrorResponse } from "../../bridge";
import { releaseCodexAuthContextProbeLease } from "../../codex/auth-context";
import { markProxyError } from "../../lib/client-error-body";
import { bindOAuthSnapshotToProvider } from "../../lib/provider-egress";
import { SendBudgetExhaustedError, isNonReplayableResponse } from "../../lib/upstream-retry";
import {
  OAuthAccountPausedError,
  OAuthLoginRequiredError,
  OAuthTokenRefreshBusyError,
  type OAuthAccessSnapshot,
  publicOAuthAuthenticationErrorMessage,
  publicOAuthErrorPresentation,
} from "../../oauth";
import { wasPermanentAccountRefusal } from "../../oauth/account-auto-pause";
import { anthropicRefusalCredentialChanged, rotateAnthropicAccountOnResponseForInstance } from "../../oauth/anthropic-account-refusal";
import { anthropicRoutingFor, formatAnthropicProviderForLog } from "../../oauth/anthropic-routing";
import { resolveCopilotApiBaseUrl } from "../../oauth/github-copilot";
import { tryKiroAlternateAfterTerminalRefresh } from "../../oauth/kiro-terminal-failover";
import { getAccountSet } from "../../oauth/store";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { EpxProviderConfig } from "../../types";
import type { AttemptRecoveryKind } from "../../usage/log";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { clientCancelledResponse } from "./core-errors";
import type { ResponsesAdmissionState, ResponsesRequestContext } from "./core-options";
import { bindRouteReasoningReplayScope } from "./core-replay";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { ResponsesTransport } from "./request-transport";

export type OAuthRecoveryOutcome =
  | { kind: "continue"; response: Response }
  | { kind: "return"; response: Response }
  | { kind: "fallthrough"; response: Response };

export type CredentialReplay = ReturnType<ResponsesTransport["createCredentialReplayAttempt"]>;

export interface OAuthRecoveryContext {
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "logCtx" | "req">;
  admissionState: ResponsesAdmissionState;
  requestState: Pick<PreparedResponsesRequest, "parsed" | "route" | "inboundWire">;
  transportState: Pick<
    ResponsesTransport,
    | "activeAdapter"
    | "isOAuth401ReplayProvider"
    | "sentOAuthSnapshot"
    | "refreshResolvedOAuthSelection"
    | "replayOAuthCredentialSnapshot"
    | "invalidateSameTargetRequest"
    | "resolveSelectionAdapter"
    | "oauth401ReplayAttempted"
    | "anthropicInstance"
    | "currentAnthropicRouteDecision"
    | "anthropicRouteDecision"
    | "anthropicPoolAccountId"
    | "anthropicPoolFailovers"
    | "anthropicFailoverLimit"
    | "anthropicSessionKey"
    | "commitResolvedOAuthSelection"
    | "genericFailovers"
    | "genericFailoverLimit"
    | "applyFailoverSnapshot"
    | "createCredentialReplayAttempt"
  >;
  sendBudgetState: Pick<ResponsesSendBudget, "reserveCredentialHop" | "pendingHopPermit" | "sendBudgetExhausted">;
  upstream: AbortController;
  cleanupUpstreamAbort: () => void;
  recoveryFlags: { oauth401ReplayAttempted: boolean; antigravityAuthRotationAttempted: boolean };
  genericRefetchCountsSends: () => boolean;
  rotateAntigravityAuth: (failedResponse: Response, recovery: AttemptRecoveryKind) => Promise<Response | null>;
  resolveRotatedCopilotSelection: (provider?: EpxProviderConfig) => Promise<Response | undefined>;
  rebuildAndRefetch: (
    recovery: AttemptRecoveryKind,
    onDispatch?: () => void,
    preserveFailureResponse?: Response,
    staged?: CredentialReplay,
  ) => Promise<Response | { failed: Response }>;
}

function rebindAdapterForProvider(ctx: OAuthRecoveryContext, provider: EpxProviderConfig): void {
  const { requestContext, requestState, transportState } = ctx;
  const { parsed, route, inboundWire } = requestState;
  transportState.invalidateSameTargetRequest();
  transportState.activeAdapter = transportState.resolveSelectionAdapter(
    resolveWireProtocolOverride(route.providerName, route.modelId, provider, inboundWire, route.staticPolicy),
    requestContext.config.cacheRetention,
  );
  bindRouteReasoningReplayScope({
    parsed,
    providerName: route.providerName,
    provider,
    adapterName: transportState.activeAdapter.name,
    oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
  });
}

/** Attempt bounded OAuth 401 refresh and terminal fallback failover on adapter dispatch. */
export async function recoverOAuth401Replay(
  ctx: OAuthRecoveryContext,
  upstreamResponse: Response,
): Promise<OAuthRecoveryOutcome> {
  const {
    requestContext,
    admissionState,
    requestState,
    transportState,
    sendBudgetState,
    upstream,
    cleanupUpstreamAbort,
    recoveryFlags,
    genericRefetchCountsSends,
    rotateAntigravityAuth,
    resolveRotatedCopilotSelection,
    rebuildAndRefetch,
  } = ctx;
  const { options, config, req } = requestContext;
  const { parsed, route } = requestState;

  if (
    upstreamResponse.status !== 401
    || wasPermanentAccountRefusal(upstreamResponse)
    || !transportState.isOAuth401ReplayProvider
    || !transportState.sentOAuthSnapshot
    || recoveryFlags.oauth401ReplayAttempted
    || sendBudgetState.sendBudgetExhausted()
  ) {
    return { kind: "fallthrough", response: upstreamResponse };
  }

  recoveryFlags.oauth401ReplayAttempted = transportState.oauth401ReplayAttempted = true;
  const replay = transportState.createCredentialReplayAttempt(upstreamResponse.status, "oauth-401");
  let refreshed: OAuthAccessSnapshot;
  try {
    refreshed = await transportState.refreshResolvedOAuthSelection(transportState.sentOAuthSnapshot);
  } catch (err) {
    const cancelled = options.abortSignal?.aborted || req.signal.aborted;
    if (cancelled || err instanceof OAuthTokenRefreshBusyError) {
      cleanupUpstreamAbort();
      upstream.abort();
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already closed */ }
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
      return {
        kind: "return",
        response: cancelled
          ? clientCancelledResponse()
          : markProxyError(formatErrorResponse(503, "server_error", publicOAuthAuthenticationErrorMessage(err), { retryAfter: "1" }), publicOAuthErrorPresentation(err)),
      };
    }
    const failed = transportState.sentOAuthSnapshot;
    if (route.providerName === "google-antigravity" && !recoveryFlags.antigravityAuthRotationAttempted
      && err instanceof OAuthLoginRequiredError && failed
      && getAccountSet(route.providerName)?.accounts.some(row =>
        row.id === failed.accountId && row.needsReauth === true)) {
      recoveryFlags.antigravityAuthRotationAttempted = true;
      const rotated = await rotateAntigravityAuth(upstreamResponse, "oauth-401");
      if (rotated) return { kind: "continue", response: rotated };
    }
    if (route.providerName === "kiro" && err instanceof OAuthLoginRequiredError && failed
      && transportState.genericFailovers < transportState.genericFailoverLimit) {
      const alternate = await tryKiroAlternateAfterTerminalRefresh(config, failed.accountId, failed.generation);
      if (alternate) {
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = sendBudgetState.reserveCredentialHop(
          "auth-recovery",
          `${route.providerName}|${route.modelId}|terminal-refresh-account`,
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (hop.allowed) {
          try {
            const admitted = await transportState.applyFailoverSnapshot(alternate);
            if (admitted?.accountId === alternate.accountId) {
              transportState.genericFailovers += 1;
              rebindAdapterForProvider(ctx, route.provider);
              sendBudgetState.pendingHopPermit = hop.permit;
              const result = await rebuildAndRefetch("oauth-account-429", () => {
                if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
              });
              if ("failed" in result) return { kind: "return", response: result.failed };
              return { kind: "continue", response: result };
            }
          } catch { /* Keep the original public authentication error. */ }
          finally {
            sendBudgetState.pendingHopPermit = undefined;
            hop.permit?.release();
          }
        }
      }
    }
    cleanupUpstreamAbort();
    if (err instanceof OAuthAccountPausedError) {
      return {
        kind: "return",
        response: markProxyError(formatErrorResponse(403, "permission_error", publicOAuthAuthenticationErrorMessage(err)), publicOAuthErrorPresentation(err)),
      };
    }
    return {
      kind: "return",
      response: markProxyError(formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err)), publicOAuthErrorPresentation(err)),
    };
  }
  if (route.provider.googleMode === "cloud-code-assist" && !refreshed.projectId) {
    cleanupUpstreamAbort();
    return {
      kind: "return",
      response: markProxyError(formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(new Error("Cloud Code Assist project is required")))),
    };
  }
  if (route.providerName === "kiro") {
    parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
  }
  const baseRouteProvider = route.provider;
  let refreshedProvider = bindOAuthSnapshotToProvider(
    resolveProviderTransport(
      route.providerName,
      bindOAuthSnapshotToProvider(baseRouteProvider, refreshed, { setApiKey: true }),
      parsed.options.promptCacheKey,
      route.providerName === "github-copilot"
        ? resolveCopilotApiBaseUrl(refreshed.apiBaseUrl)
        : undefined,
    ),
    refreshed,
    { baseProvider: baseRouteProvider },
  );
  const copilotRefusal = await resolveRotatedCopilotSelection(refreshedProvider);
  if (copilotRefusal) return { kind: "return", response: copilotRefusal };
  refreshedProvider = route.provider;
  if (route.providerName !== "github-copilot") {
    transportState.sentOAuthSnapshot = refreshed;
    transportState.replayOAuthCredentialSnapshot = { accountId: refreshed.accountId, generation: refreshed.generation };
  }
  rebindAdapterForProvider(ctx, refreshedProvider);
  const result = await rebuildAndRefetch("oauth-401", undefined, undefined, replay);
  if ("failed" in result) return { kind: "return", response: result.failed };
  return { kind: "continue", response: result };
}

/** Rotate Anthropic OAuth pool accounts across rate-limit or entitlement refusals. */
export async function recoverAnthropicOAuthPool(
  ctx: OAuthRecoveryContext,
  initialResponse: Response,
): Promise<OAuthRecoveryOutcome> {
  const { requestContext, requestState, transportState, sendBudgetState, upstream, genericRefetchCountsSends, rebuildAndRefetch } = ctx;
  const { config, logCtx } = requestContext;
  const { route } = requestState;
  const { anthropicInstance } = transportState;
  let upstreamResponse = initialResponse;

  // Anthropic OAuth: recover a rate limit or proven account entitlement refusal
  // before output, within the shared request and account rotation limits.
  while (
    (upstreamResponse.status === 429 || upstreamResponse.status === 403 || upstreamResponse.status === 402 || upstreamResponse.status === 400 || upstreamResponse.status === 401)
    && anthropicInstance
    && transportState.anthropicPoolAccountId
  ) {
    // Same admission as the other rotation ladders: the roster cap cannot see the shared
    // send budget. A canRetry term, not a break -- the call also records the refusal.
    const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
    const hop = sendBudgetState.reserveCredentialHop(
      "auth-recovery",
      `${route.providerName}|${route.modelId}|anthropic-pool-rotation`,
      !adapterOwnsDispatch && genericRefetchCountsSends(),
    );
    const sentSlow = route.provider._anthropicSlowMode === true;
    let nextAccountId: string | null;
    try {
      nextAccountId = await rotateAnthropicAccountOnResponseForInstance(anthropicInstance, upstreamResponse, {
        config,
        accountId: transportState.anthropicPoolAccountId,
        sessionKey: transportState.anthropicSessionKey,
        model: route.modelId,
        requestKey: transportState,
        decision: transportState.anthropicRouteDecision,
        currentDecision: transportState.currentAnthropicRouteDecision,
        sentSlow,
        signal: upstream.signal,
        // A denied reservation must not rotate on base headroom its bounds cannot see.
        canRetry: hop.allowed && (hop.permit !== undefined || !sendBudgetState.sendBudgetExhausted())
          && transportState.anthropicPoolFailovers < transportState.anthropicFailoverLimit,
      });
    } catch (rotationError) {
      hop.permit?.release();
      throw rotationError;
    }
    if (!nextAccountId) {
      hop.permit?.release();
      break;
    }
    try {
      const admitted = await transportState.commitResolvedOAuthSelection(
        await anthropicRoutingFor(anthropicInstance).getAnthropicPoolAccessSnapshot(nextAccountId),
      );
      if (!admitted) throw new Error("OAuth selection changed during recovery");
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
      transportState.anthropicPoolAccountId = admitted.accountId;
      transportState.anthropicPoolFailovers += 1;
      const slowFallbackOnly = !anthropicRoutingFor(anthropicInstance).getEligibleAnthropicAccounts(Date.now(), route.modelId).includes(admitted.accountId)
        && anthropicRoutingFor(anthropicInstance).getSlowFallbackEligibleAccounts(config, Date.now(), route.modelId).includes(admitted.accountId);
      route.provider = {
        ...route.provider,
        apiKey: admitted.accessToken,
        _anthropicSlowMode: slowFallbackOnly ? true : undefined,
      };
      logCtx.provider = formatAnthropicProviderForLog(anthropicInstance, admitted.accountId, config);
      rebindAdapterForProvider(ctx, route.provider);
      // The replay IS this hop's send; the dispatching layer settles the reservation.
      sendBudgetState.pendingHopPermit = hop.permit;
      let result: Response | { failed: Response };
      try {
        result = await rebuildAndRefetch(
          !anthropicRefusalCredentialChanged(upstreamResponse, admitted) ? "rate-limit-429"
            : upstreamResponse.status === 401 ? "oauth-401"
            : (upstreamResponse.status === 403 || upstreamResponse.status === 402 || upstreamResponse.status === 400) ? "oauth-account-403" : "anthropic-oauth-429",
          () => { if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError(); },
        );
      } finally {
        sendBudgetState.pendingHopPermit = undefined;
      }
      if ("failed" in result) {
        // A no-op once the boundary was reached; a refund when the rebuild died first.
        hop.permit?.release();
        return { kind: "return", response: result.failed };
      }
      upstreamResponse = result;
      if (isNonReplayableResponse(upstreamResponse)) return { kind: "continue", response: upstreamResponse };
    } catch {
      // release() refunds a pre-send hop and is a no-op once the send settled it.
      hop.permit?.release();
      break;
    }
  }

  return { kind: "fallthrough", response: upstreamResponse };
}
