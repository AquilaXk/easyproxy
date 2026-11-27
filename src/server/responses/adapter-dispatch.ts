import { projectLocalModelRefusalLog, recordUpstreamProviderErrorDetail } from "../request-log-failure-detail";
import { providerAffinityGenerationIsCurrent } from "../../providers/api-key-selection";
import { clientFacingModelText } from "../../lib/error-destination";
import { createAnthropicImageRecovery, recoverAdapterImageContext, retainAdapterFailureResponse } from "./image-context-recovery";
import { responsesSpendTarget } from "./request-spend-target";
import { bindAdapterResponseSpend } from "./request-spend";
import { markProxyError, isProxyError } from "../../lib/client-error-body";
import { adapterBuildRefusal } from "./passthrough-build-error";
import { createAutoPauseRefreshErrorMapper, recoverAutoPausedAccount } from "./account-auto-pause-recovery";
import { wasAccountAutoPaused, wasPermanentAccountRefusal } from "../../oauth/account-auto-pause";
import { effectiveAccountAutoPause } from "../../config/account-auto-pause-revisions";
import { bindAnthropicRejectionResponse } from "../../adapters/anthropic-rejection-memo";
import { hostedAdvisorCredentials } from "../../adapters/anthropic/advisor-tool";
import { deferPhysicalSendReporter } from "./deferred-send-reporter";
import { usesApiKeyAccount } from "../../providers/label";
import { spendLedgerStorageErrorResponse } from "./spend-storage-error";
import { classifyAnthropic429 } from "../../oauth/anthropic-rate-limit-policy";
import { authorizeResendForRecovery } from "../../lib/request-resend-gate";
import { ambiguousResendAllowanceFor, selfContainedResponsesBody } from "./reset-replay";
import { transientSendCapFor, type ResponsesSendBudget } from "./request-send-budget";
import { CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../lib/request-execution-budget";
import { sanitizeNonReplayableUpstreamError } from "./non-replayable-error";
import { isLocalUpstream } from "../../lib/local-upstream";
import { providerConnectTimeoutMs, providerStallTimeoutSec, resolveConnectTimeoutMs, resolveStallTimeoutMs } from "../../stall-timeout";
import { responsesTimeoutProvider, type ResponsesRequestContext, type ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesEffects } from "./response-effects";
import { linkAbortSignal } from "./core-lifetime";
import type { AdapterRequest } from "../../adapters/base";
import { formatErrorResponse } from "../../bridge";
import {
  recordAdapterReasoning,
  recordAdapterTier,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
} from "../request-log";
import { credentialRecoveryStatus } from "../request-log-attempt-recovery";
import { anthropicPoolCooldownResponse, clientCancelledResponse, readDisplaySafeErrorText } from "./core-errors";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import { redactSecretString } from "../../lib/redact";
import { readCreditOrBudgetExhaustedResponse } from "../../lib/credit-budget-refusal";
import { rewriteUpstreamPolicyRefusal } from "./policy-refusal";
import { HostedAdvisorSpendRefusal } from "./policy-request-scope";
import { withProviderRequestSlot } from "../../providers/request-pacing";
import { providerFetch, fetchWithHeaderTimeout, safeHostLabel } from "./fetch-helpers";
import { isAnthropicBillingKeyPool } from "../../providers/anthropic-billing-recovery";
import {
  transientRetryPolicyFor,
  resetReplayPolicyFor,
  rateLimitRetryPolicyFor,
  rateLimitRetryDelayMs,
} from "../../providers/key-failover";
import {
  fetchWithTransientRetry,
  fetchWithResetRetry,
  isNonReplayableResponse, isSameTargetRetryHold,
  applyUpstreamRecoveryInit,
  SendBudgetExhaustedError, errorDestinationLabel,
  UpstreamRetryEvidenceError,
  prepareSameTarget429Wait,
  sleepWithAbort, RESET_RETRY_MAX_ATTEMPTS,
} from "../../lib/upstream-retry";
import { describeUpstreamConnectFailure } from "./upstream-error";
import { createProviderOfflineResendWait } from "../../lib/offline-resend";
import type { OpaqueBlobRecoveryGuard } from "./core-opaque-recovery";
import type { AttemptRecoveryKind } from "../../usage/log";
import { publicOAuthErrorPresentation, OAuthAccountPausedError, OAuthLoginRequiredError, publicOAuthAuthenticationErrorMessage } from "../../oauth";
import { markAccountNeedsReauthIfGeneration } from "../../oauth/store";
import { classifyKiroRefusal } from "../../adapters/kiro-refusal";
import { normalizeFinalKiroHttpError } from "../../adapters/kiro-retry";
import { noteKiroMonthlyRefusal } from "../../providers/kiro-usage";
import { persistKiroAccountState } from "../../providers/kiro-account-state-disk";
import { isXaiGrokOAuth, isXaiLegacyPrivacyError, xaiPrivacyModeRefusal } from "../../providers/xai-privacy-mode";
import { isXaiResponsesDestination, resolveProviderTransport } from "../../providers/xai-transport";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { bindRouteReasoningReplayScope } from "./core-replay";
import { AnthropicAccountCooldownError } from "../../oauth/anthropic-routing";
import {
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  rotateGenericOAuthAccountOnRefusal,
  quarantineKiroSuspendedAccount,
  failoverAccountSnapshot,
  rotateAntigravityAccountOnAuthRefusal,
  rotateAntigravityAccountOnUpstreamFault,
} from "../../oauth/generic-account-failover";
import {
  attemptOpaqueBlobRecovery,
  anthropicFastRefused,
} from "./core-opaque-recovery";
import { createAnthropicThinkingRecovery } from "./anthropic-thinking-recovery";
import { consumeComboFailure } from "./core-combo-failure";
import { streamingContextOverflowResponse, jsonContextOverflowResponse, lateAttributionLimitResponse } from "./context-overflow";
import { OllamaLateAttributionBudgetError } from "../../adapters/ollama-native";
import { cancelBodyOnAbort } from "../../lib/abort";
import { createCodexAuthDispatchGuard, releaseCodexAuthContextProbeLease, unwrapUpstreamRetryEvidenceError } from "../../codex/auth-context";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { mapCodexAuthContextErrorToResponse } from "./codex-auth-error";
import { chargeWorkflowSends } from "../../lib/workflow-budget";
import { hasWorkflowSendObserver } from "../../lib/request-execution-budget";
import { captureAntigravityQuarantineTrust, classifyAntigravityQuarantine, isAntigravityAccessDeniedRefusal, isAntigravityValidationRefusal } from "./antigravity-validation-refusal";
import { createAntigravityModelDenialRecovery, recoverAntigravityAccount } from "./antigravity-model-denial-recovery";
import { isAntigravityFaultRotatable } from "./antigravity-fault-rotation";
import { adapterSendBudgetRefusal } from "../workflow-refusal";
import { AdmissionModelDeniedError, admissionModelDeniedResponse, projectAdmissionModelDeniedLog } from "../admission-model-scope";
import { rejectAnthropicPerMessageEffort } from "../../adapters/anthropic/per-message-effort";
import {
  recoverAnthropicBillingKeyPool,
  recoverApiKeyPool401,
  recoverApiKeyPool429,
  type KeyPoolRecoveryContext,
} from "./adapter-key-pool-recovery";
import {
  recoverAnthropicOAuthPool,
  recoverOAuth401Replay,
  type OAuthRecoveryContext,
} from "./adapter-oauth-recovery";
import {
  buildAdapterLocalTerminalResponse,
  formatAdapterTerminalUpstreamErrorResponse,
  hasOutboundFlexServiceTier,
  isFlexUnavailableRefusal,
  retryAdapterImageTier,
  retryConsoleGoUploadRejection,
  retryReasoningEffortDowngrade,
  stripFlexServiceTierForStandardRetry,
} from "./adapter-terminal-recovery";
/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function prepareAdapterExchange(
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "logCtx" | "req">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "toolBridgeMaps"
    | "translatorBudget" | "completedToolBlocks"
    | "selectedForwardHeaders"
    | "route"
    | "inboundWire"
    | "clientRequestedStream"
    | "subagentQuotaFailureModel"
    | "subagentFallbackAccountId"
  >,
  transportState: Pick<
    ResponsesTransport,
    | "activeAdapter"
    | "adapter"
    | "pinAnthropicImageRecovery"
    | "sameTargetRequest"
    | "sameTargetParsed"
    | "sameTargetToken"
    | "transportToken"
    | "oauthDispatch"
    | "recoverAutoPausedSelection"
    | "imageTierBias"
    | "oauth401ReplayAttempted"
    | "isOAuth401ReplayProvider"
    | "sentOAuthSnapshot"
    | "refreshResolvedOAuthSelection"
    | "replayOAuthCredentialSnapshot"
    | "invalidateSameTargetRequest"
    | "resolveSelectionAdapter"
    | "resolveCopilotSelection"
    | "copilotRefusalResponse"
    | "anthropicInstance"
    | "currentAnthropicRouteDecision"
    | "anthropicRouteDecision"
    | "anthropicPoolAccountId"
    | "anthropicPoolFailovers"
    | "anthropicSessionKey"
    | "commitResolvedOAuthSelection"
    | "genericFailoverAccountId"
    | "genericFailovers"
    | "genericFailoverLimit" | "anthropicFailoverLimit"
    | "applyFailoverSnapshot"
    | "noteRoutedAttemptSend" | "attemptSendDeferred" | "deferPhysicalAttribution" | "commitAdapterAttemptSend"
    | "createCredentialReplayAttempt" | "credentialReplayHandoff"
  >,
  responseEffects: Pick<ResponsesEffects, "cancelResponseCompletion" | "notifyResponseComplete" | "refreshRequestToolAliases">,
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "adapterSendBudget"
    | "adapterDispatchBudget"
    | "noteAdapterPhysicalSend"
    | "noteAdapterRecoveryWithheld"
    | "imageRecoverySendReporter"
    | "remainingTransientSendBudget"
    | "transientSendReporter"
    | "recoverySendAllowance"
    | "recoveryClassFor"
    | "sendBudgetExhausted"
    | "reserveCredentialHop"
    | "pendingHopPermit"
    | "workflowRootId"
    | "claimAmbiguousResend"
    | "sendsUsed"
    | "targetSendsUsed"
    | "compactHandoffSendCeiling"
    | "initialSendAllowance"
    | "noteInitialDispatch"
  >,
) {
  const { options, config, logCtx, req } = requestContext;
  const {
    oauthDispatch,
    isOAuth401ReplayProvider,
    refreshResolvedOAuthSelection,
    invalidateSameTargetRequest,
    resolveSelectionAdapter,
    resolveCopilotSelection,
    copilotRefusalResponse,
    anthropicInstance,
    currentAnthropicRouteDecision,
    anthropicSessionKey,
    commitResolvedOAuthSelection,
    applyFailoverSnapshot,
  } = transportState;
  const {
    parsed,
    toolBridgeMaps,
    translatorBudget,
    route,
    inboundWire,
    clientRequestedStream,
    subagentQuotaFailureModel,
  } = requestState;
  const { cancelResponseCompletion, notifyResponseComplete, refreshRequestToolAliases } = responseEffects;
  const {
    adapterSendBudget,
    adapterDispatchBudget,
    noteAdapterPhysicalSend,
    noteAdapterRecoveryWithheld,
    remainingTransientSendBudget,
    transientSendReporter,
    recoverySendAllowance,
    recoveryClassFor,
    sendBudgetExhausted,
    reserveCredentialHop,
    claimAmbiguousResend,
  } = sendBudgetState;
  let selfContainedJudgment: boolean | undefined;
  // On the Antigravity direct lane the raw body carries only settings; judge the body the bridge
  // would have sent, built only if an ambiguous reset actually asks.
  const directRequest = options.directRequest;
  const requestIsSelfContained = (): boolean =>
    selfContainedJudgment ??= selfContainedResponsesBody(directRequest
      ? { ...(parsed._rawBody as Record<string, unknown>), ...directRequest.bridgeConversation() }
      : parsed._rawBody);
  const claimPreHeaderResend = (): boolean => authorizeResendForRecovery(
    "pre-header", "connection-reset",
    ambiguousResendAllowanceFor(route.provider, requestIsSelfContained, claimAmbiguousResend),
  ).allowed;
  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  /** Contain replacement negotiation before adapter admission and release its upstream abort link. */
  const resolveRotatedCopilotSelection = async (provider = route.provider): Promise<Response | undefined> => {
    try { await resolveCopilotSelection(parsed, false, provider); }
    catch (error) {
      cleanupUpstreamAbort();
      upstream.abort();
      if ((options.abortSignal ?? req.signal).aborted) return clientCancelledResponse();
      return copilotRefusalResponse(error)
        ?? formatErrorResponse(502, "upstream_error", "GitHub Copilot Auto negotiation failed.");
    }
  };
  // Trusted local upstreams default to no stall timeout.
  const localUpstream = isLocalUpstream(route.provider.baseUrl);
  // Header arrival and body silence are separate clocks (structure/transports/timeouts.md).
  const connectTimeoutMs = () => providerConnectTimeoutMs(config, responsesTimeoutProvider(options, route.provider));
  const connectMs = resolveConnectTimeoutMs(connectTimeoutMs(), { localUpstream });
  const sendConnectMs = () => route.provider.authMode === "forward" ? resolveConnectTimeoutMs(connectTimeoutMs(), { localUpstream: isLocalUpstream(route.provider.baseUrl) }) : 0;
  transportState.activeAdapter = transportState.adapter;
  const antigravityPoolActivated = route.providerName === "google-antigravity"
    && isGenericOAuthFailoverEnabled(config, route.providerName);
  const antigravityDenial = createAntigravityModelDenialRecovery();
  const antigravityQuarantineTrust = captureAntigravityQuarantineTrust(route.providerName);
  // One immutable, body-safe outbound request per same-target sequence (URL, serialized body,
  // Reuse the cached body while the parsed request, credential, wire and tier are unchanged.
  const handoffReplay = transportState.credentialReplayHandoff;
  transportState.credentialReplayHandoff = undefined;
  let initialRequest: AdapterRequest | undefined;
  let inputTokenEstimate: number | undefined;
  // An adapter may know the turn needs no inference at all — Kiro's replayed history ending in a
  // delivered final answer. Answer it locally: no build (so no token estimate), no send (so
  // sendCount stays 0), and crucially no empty-completion guard, which treats an outputless
  // terminal as a failed turn and re-invokes the identical request. Routing this through the
  // ordinary event path would therefore reinstate the loop it exists to end.
  const localTerminal = transportState.activeAdapter.localTerminal?.(parsed);
  if (localTerminal) {
    return buildAdapterLocalTerminalResponse(localTerminal.reason, requestContext, requestState, responseEffects, upstream, cleanupUpstreamAbort);
  }
  try {
    initialRequest = await transportState.activeAdapter.buildRequest(parsed, {
      headers: requestState.selectedForwardHeaders, completedToolBlocks: requestState.completedToolBlocks,
      providerName: route.providerName,
      translatorBudget,
      abortSignal: upstream.signal,
      ...(logCtx.otlpSpan?.traceparent ? { otlpTraceparent: logCtx.otlpSpan.traceparent } : {}),
    });
    refreshRequestToolAliases(initialRequest);
    if (!handoffReplay && !transportState.activeAdapter.fetchResponse) {
      recordAdapterReasoning(logCtx, initialRequest); recordAdapterTier(logCtx, initialRequest);
    }
    inputTokenEstimate = typeof initialRequest.usageLog?.inputTokens === "number"
      ? initialRequest.usageLog.inputTokens
      : undefined;
    if (!handoffReplay && inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;
  } catch (err) {
    // A throwing buildRequest never returned a request; if a post-build step threw, release
    // the serialized-body observation (idempotent) so the translator budget is not leaked.
    // The build runs after linkAbortSignal, so a failure must also tear the link down and
    // abort the upstream controller instead of escaping handleResponses unmapped.
    initialRequest?.releaseBodyObservation?.();
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    if (err instanceof OllamaLateAttributionBudgetError) return lateAttributionLimitResponse();
    // An adapter can also throw the shared translator budget while sizing generated
    // request content (e.g. Ollama late-tool attribution); keep its established 413.
    if (isTranslatorBudgetExceededError(err)) {
      return formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
        code: "translation_buffer_limit",
      });
    }
    const buildRefusal = adapterBuildRefusal(err, admissionState.authCtx, route.codexAccountNamespace);
    if (buildRefusal) return buildRefusal;
    const msg = err instanceof Error ? err.message : String(err);
    return formatErrorResponse(400, "invalid_request_error", redactSecretString(msg));
  }
  // The catch path above always returns, so the request is definitely assigned here.
  // Capture it in a const so the fetch callbacks read a narrowed, immutable value
  // (TypeScript drops narrowing for a `let` captured by a nested function).
  const builtInitialRequest = initialRequest;
  type CredentialReplay = ReturnType<typeof transportState.createCredentialReplayAttempt>;
  transportState.sameTargetRequest = builtInitialRequest;
  transportState.sameTargetParsed = parsed;
  transportState.sameTargetToken = transportState.transportToken;

  const initialRecovery = route.providerName === "github-copilot"
    ? sendBudgetState.pendingHopPermit?.sendClass === "auth-recovery" ? "oauth-account-429"
      : transportState.oauth401ReplayAttempted ? "oauth-401" : undefined
    : undefined;
  let upstreamResponse: Response;
  const retainFailureResponse = async () => upstreamResponse = (await retainAdapterFailureResponse(upstreamResponse, upstream.signal)).response;
  const imageRecovery = route.provider.anthropicImageContextRecovery === true && transportState.activeAdapter.name === "anthropic"
    ? createAnthropicImageRecovery(requestContext, requestState, transportState, sendBudgetState, connectMs)
    : undefined;
  const autoPauseEnabled = effectiveAccountAutoPause(config.providers[route.providerName]) !== undefined;
  const billingPoolRequest = isAnthropicBillingKeyPool(route.provider);
  // Hosted Advisor revalidates the credential after the upstream rewrite, before the receipt.
  const shouldDeferGenericSend = (request: AdapterRequest) => billingPoolRequest
    || (route.providerName === "github-copilot" && route.provider.authMode !== "forward")
    || hostedAdvisorCredentials.has(request);
  const recoveryFlags = {
    billingRecoveryActive: false,
    oauth401ReplayAttempted: transportState.oauth401ReplayAttempted,
    antigravityAuthRotationAttempted: false,
  };
  const reserveCompactRetrySpend = () => sendBudgetState.compactHandoffSendCeiling !== undefined
    && sendBudgetState.adapterSendBudget?.spendEnforced === true;
  const callerBoundedBudget = sendBudgetState.adapterSendBudget !== undefined && (
    sendBudgetState.adapterSendBudget.explicitSendCeiling !== undefined
    || sendBudgetState.adapterSendBudget.policy.maxTotalModelSends < CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTotalModelSends
  );
  const genericRefetchCountsSends = () => !!sendBudgetState.workflowRootId || options.comboAttempt === true || callerBoundedBudget || sendBudgetState.adapterSendBudget?.spendEnforced === true
    || transientRetryPolicyFor(route.provider) !== null || resetReplayPolicyFor(route.provider) !== null
    || !!anthropicInstance || billingPoolRequest || recoveryFlags.billingRecoveryActive || autoPauseEnabled || imageRecovery !== undefined;
  let handoffPermit: ResponsesSendBudget["pendingHopPermit"];
  try {
    if (transportState.activeAdapter.fetchResponse) {
      let published = false;
      const publish = (): void => {
        if (published) return;
        if (handoffReplay) handoffReplay(builtInitialRequest, transportState.activeAdapter.name);
        else transportState.commitAdapterAttemptSend(builtInitialRequest, transportState.activeAdapter.name, initialRecovery);
        published = true;
      };
      const producer = adapterDispatchBudget?.beginSpendProducer?.();
      try {
      upstreamResponse = await withProviderRequestSlot(route.providerName, route.provider, route.modelId, upstream.signal, pacingSlot =>
        transportState.activeAdapter.fetchResponse!(builtInitialRequest, {
          kiroPreferAccountFailover: route.providerName === "kiro" && isGenericOAuthFailoverEnabled(config, "kiro"),
          abortSignal: upstream.signal,
          timeoutMs: sendConnectMs(),
          sendBudget: adapterDispatchBudget,
          onPhysicalSend: send => {
            if (transportState.activeAdapter.reportsPhysicalSends) publish();
            antigravityDenial.beforeSend(); noteAdapterPhysicalSend(inputTokenEstimate, send);
          },
          onRecoveryWithheld: noteAdapterRecoveryWithheld,
          stream: parsed.stream,
          executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
            pacingSlotAcquired: true,
            pacingSlot,
            dispatchOverride: oauthDispatch(builtInitialRequest, parsed, "adapter", true),
            onPhysicalDispatch: publish,
            providerName: route.providerName,
            modelId: route.modelId,
            beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
              ? createCodexAuthDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
          }),
        }));
      } finally { producer?.close(); }
    } else {
      // #1851 scope guard: transient-5xx retry on this generic adapter path is opt-in for
      // direct Google AI Studio only (Vertex/Antigravity use fetchResponse above). Other
      // adapters keep reset-only retry so combo failover still hops on the first 5xx
      // instead of burning ~1.2s of same-target retries per hop.
      // #2643: an opted-in key-auth openai-chat provider also gets transient-5xx retry. The
      // legacy direct-Google exception is preserved exactly; every other adapter still keeps
      // reset-only semantics so combo failover hops on the first 5xx.
      const transientPolicy = transientRetryPolicyFor(route.provider);
      const resetPolicy = resetReplayPolicyFor(route.provider);
      // Rebook a native Copilot hop against the negotiated destination before dispatch.
      // Raw externally counted permits settle through the retry helper's send reporter.
      if (route.providerName === "github-copilot" && adapterSendBudget && sendBudgetState.pendingHopPermit
        && sendBudgetState.pendingHopPermit.sendClass === "auth-recovery") {
        const original = sendBudgetState.pendingHopPermit;
        sendBudgetState.pendingHopPermit = undefined;
        original.release();
        const decision = adapterSendBudget.reserveDispatch({
          sendClass: original.sendClass,
          targetKey: `${route.providerName}|${builtInitialRequest.url}|${route.modelId}`,
          countedExternally: true,
        });
        if (!decision.allowed) throw new SendBudgetExhaustedError(errorDestinationLabel(builtInitialRequest.url));
        handoffPermit = decision.permit;
      }
      const compactPrepaid = handoffPermit ?? (options.compactionRecoveryAttempted ? sendBudgetState.pendingHopPermit : undefined);
      if (compactPrepaid) sendBudgetState.pendingHopPermit = undefined;
      let compactPrepaidUsed = false;
      // A combo-owned or compaction-prepaid send is settled by the physical-dispatch receipt
      // when spend enforcement is off. Enforced spend and direct requests keep the shared
      // physical-send reporter, which already owns the permit lifecycle there.
      // Stable per request: a Combo or compaction permit comes from `reserveDispatch`, which starts
      // (and freezes) the spend policy first, so `spendEnforced` cannot change before dispatch.
      const receiptMode = !sendBudgetState.adapterSendBudget?.spendEnforced
        && Boolean(options.comboInitialSend || compactPrepaid);
      // Combo and emergency compaction admission already book this target's first send.
      // Its configured initial ceiling is target-local; the shared remainder below still
      // accounts for earlier targets without deducting their sends from this target twice.
      const initialSendCap = transientPolicy || resetPolicy
        || (options.comboAttempt && route.provider.adapter === "google")
        ? transientSendCapFor(transientPolicy?.attempts,
          (options.comboAttempt || compactPrepaid) ? 0 : sendBudgetState.sendsUsed)
        // Anthropic sends are counted for the funded roster, not narrowed: keep the reset ladder.
        : anthropicInstance && !options.comboAttempt && !compactPrepaid && !autoPauseEnabled ? RESET_RETRY_MAX_ATTEMPTS : 1;
      const fetchWithRetryPolicy = (route.provider.adapter === "google" || transientPolicy)
        ? fetchWithTransientRetry
        : fetchWithResetRetry;
      const initialReporter = transientSendReporter(compactPrepaid ?? options.comboDispatchPermit);
      const deferredInitial = !receiptMode && shouldDeferGenericSend(builtInitialRequest) ? deferPhysicalSendReporter(initialReporter) : undefined;
      try { upstreamResponse = await fetchWithRetryPolicy(
        recovery => {
          // Unconfigured generic sends may omit the counting reporter. Capture policy
          // independently so a later recovery still belongs to this request's start.
          sendBudgetState.adapterSendBudget?.startRequest?.(responsesSpendTarget(logCtx, route.providerName));
          // Receipt mode books the physical send at executor admission instead of here.
          if (!deferredInitial && !receiptMode && compactPrepaid && !compactPrepaidUsed) {
            if (!compactPrepaid.use()) throw new SendBudgetExhaustedError(errorDestinationLabel(builtInitialRequest.url));
            compactPrepaidUsed = true;
          }
          // Key transport keeps this metadata pending until it binds the actual selection.
          if (!handoffReplay) transportState.noteRoutedAttemptSend(inputTokenEstimate, recovery ?? initialRecovery);
          return fetchWithHeaderTimeout(builtInitialRequest.url, applyUpstreamRecoveryInit({
            method: builtInitialRequest.method,
            headers: builtInitialRequest.headers,
            body: builtInitialRequest.body,
          }, recovery), upstream.signal, sendConnectMs(), parsed.stream,
            providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              dispatchOverride: oauthDispatch(builtInitialRequest, parsed, "adapter", Boolean(handoffReplay)),
              providerName: route.providerName,
              modelId: route.modelId,
              onPhysicalDispatch: () => {
                if (deferredInitial) {
                  if (!deferredInitial.beforeDispatch()) throw new SendBudgetExhaustedError(errorDestinationLabel(builtInitialRequest.url));
                  if (compactPrepaid && !compactPrepaidUsed) {
                    if (!compactPrepaid.use()) throw new SendBudgetExhaustedError(errorDestinationLabel(builtInitialRequest.url));
                    compactPrepaidUsed = true;
                  }
                }
                // Preserve the unconfigured direct-adapter accounting contract; Combo admission
                // and explicit retry/compaction budgets require a receipt for their booked send.
                if (receiptMode) {
                  sendBudgetState.noteInitialDispatch(compactPrepaid && !compactPrepaidUsed ? compactPrepaid : undefined);
                  compactPrepaidUsed = true;
                }
                handoffReplay?.(builtInitialRequest, transportState.activeAdapter.name, recovery);
              },
              beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                ? createCodexAuthDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
            }));
        },
        {
          abortSignal: upstream.signal,
          label: safeHostLabel(builtInitialRequest.url), destination: errorDestinationLabel(builtInitialRequest.url),
          claimAmbiguousResend: claimPreHeaderResend,
          reserveRetrySpend: reserveCompactRetrySpend,
          flexTierSent: hasOutboundFlexServiceTier(builtInitialRequest.body, parsed),
          offlineWait: options.comboAttempt ? undefined : createProviderOfflineResendWait(route.providerName, route.provider, builtInitialRequest.url, config.offlineResendWaitSec),
          ...(sendBudgetState.workflowRootId || sendBudgetState.adapterSendBudget?.spendEnforced || options.comboDispatchPermit || callerBoundedBudget || transientPolicy || resetPolicy || compactPrepaid || options.comboAttempt
            || anthropicInstance || billingPoolRequest || autoPauseEnabled || imageRecovery
            ? {
              // A pending compaction permit already booked this leg's first physical send.
              ...(transientPolicy || resetPolicy || compactPrepaid || options.comboAttempt || callerBoundedBudget || anthropicInstance || autoPauseEnabled
                ? {
                  attempts: Math.min(initialSendCap,
                    sendBudgetState.initialSendAllowance(initialSendCap) + (compactPrepaid ? 1 : 0)),
                }
                : {}),
              // Reporter path: direct requests and enforced spend. Receipt-mode sends are
              // settled by `onPhysicalDispatch`, so a reporter here would count them twice.
              ...(receiptMode
                ? {}
                : { onSendsConsumed: deferredInitial?.report ?? initialReporter }),
            }
            : {}),
        },
      ); } finally { compactPrepaid?.release(); }
    }
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const storageRefusal = spendLedgerStorageErrorResponse(err, logCtx);
    if (storageRefusal) {
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
      return storageRefusal;
    }
    const refusal = err instanceof UpstreamRetryEvidenceError ? err.cause : err;
    if (refusal instanceof HostedAdvisorSpendRefusal) return refusal.response();
    if (refusal instanceof AdmissionModelDeniedError) {
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
      return admissionModelDeniedResponse(projectAdmissionModelDeniedLog(refusal, logCtx));
    }
    const codexRefusal = mapCodexAuthContextErrorToResponse(unwrapUpstreamRetryEvidenceError(err), {
      now: Date.now(), accountSelector: route.codexAccountNamespace,
    });
    if (codexRefusal) {
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
      return codexRefusal;
    }
    // A pause committed during pacing is local admission policy, not a failed upstream.
    if (refusal instanceof OAuthAccountPausedError) {
      return markProxyError(formatErrorResponse(403, "permission_error", publicOAuthAuthenticationErrorMessage(refusal)), publicOAuthErrorPresentation(refusal));
    }
    if (refusal instanceof OAuthLoginRequiredError) {
      return markProxyError(formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(refusal)), publicOAuthErrorPresentation(refusal));
    }
    if (refusal instanceof AnthropicAccountCooldownError) {
      return anthropicPoolCooldownResponse(refusal, { comboAttempt: options.comboAttempt, logCtx });
    }
    // A budget refusal is a decision this process made, not an upstream fault. Reporting it as
    // 502 does more than mislabel it: the Codex client retries 5xx and does not retry a 429, so
    // blaming the provider makes the caller send the whole turn again -- the amplification this
    // budget exists to stop. The passthrough path has answered 429 here since #4546.
    if (err instanceof SendBudgetExhaustedError) {
      return adapterSendBudgetRefusal(logCtx, sendBudgetState.workflowRootId, err.message);
    }
    const msg = describeUpstreamConnectFailure(err, connectMs);
    return formatErrorResponse(502, "upstream_error", msg);
  } finally {
    handoffPermit?.release();
    builtInitialRequest.releaseBodyObservation?.();
  }

  // Same-target 429 retry budget is per REQUEST: it lives OUTSIDE the recovery loop (so a 413/401
  // replay that comes back 429 cannot silently re-arm a fresh budget) and is SHARED with the
  // terminal-guard continuation below, so the main loop + one continuation can never exceed
  // `attempts` same-key replays in total (bounded per request).
  const rateLimitPolicy = rateLimitRetryPolicyFor(route.provider);
  let rateLimitRetries = 0;
  // Shared with the terminal-guard continuation below: an image-tier reduction that let the
  // main request clear a 413 must not be forgotten on the very next continuation build.
  // Recovery helpers also serve initial HTTP-200 adapter errors during delivery.
    // Recovery loop: multi-key 429 failover + at most ONE opaque-state rebuild and ONE
    // anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    const imageRetryState = { imageRetryAttempted: false };
    const opaqueBlobRecoveryGuard: OpaqueBlobRecoveryGuard = { attempted: false };
    const thinkingSignatureRecovery = createAnthropicThinkingRecovery(
      parsed, upstream.signal, opaqueBlobRecoveryGuard, () => !sendBudgetExhausted(), logCtx,
    );
    // Console Go answers a transient 400 "Invalid upload request." for bodies it accepts
    // moments later; at most one byte-identical replay is allowed per request.
    const consoleGoUploadRetryGuard: { attempted: boolean } = { attempted: false };
    let antigravityFaultRotationAttempted = false;
    const antigravityFaultRotatable = (response: Response) => isAntigravityFaultRotatable(route.providerName, response,
      transportState, antigravityPoolActivated, antigravityFaultRotationAttempted);
    // Direct requests get one reasoning-effort downgrade. Combo candidates may walk down the
    // published ladder one refused rung at a time; the request send budget bounds those retries.
    const reasoningEffortDowngradeGuard: { attempted: boolean } = { attempted: false };
    // At most one pre-output per-message-effort repair resend per request (#6895 fallback).
    const perMessageEffortRepairGuard: { attempted: boolean } = { attempted: false };
    // At most one Anthropic fast-mode downgrade per request, for the same reason.
    const anthropicFastDowngradeGuard: { attempted: boolean } = { attempted: false };
    // At most one pre-output flex->standard tier downgrade resend per request.
    const flexTierDowngradeGuard: { attempted: boolean } = { attempted: false };
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
      // A caller holding a reserved hop confirms it after the rebuilt send is admitted.
      onDispatch?: () => void,
      preserveFailureResponse?: Response,
      staged?: CredentialReplay,
    ): Promise<Response | { failed: Response }> => {
      const replay = staged ?? (!logCtx.activeAttempt?.sendCount || credentialRecoveryStatus(recovery) === undefined ? undefined
        : transportState.createCredentialReplayAttempt(upstreamResponse.status, recovery));
      let replacementAdmitted = false, dispatchConfirmed = false;
      // Only budgets without a physical observer need this legacy workflow report.
      let fastDowngradeWorkflowCharged = false;
      const chargeFastDowngradeWorkflowSend = (): void => {
        if ((recovery !== "anthropic-fast-downgrade" && recovery !== "flex-tier-downgrade") || fastDowngradeWorkflowCharged) return;
        fastDowngradeWorkflowCharged = true;
        if (!sendBudgetState.adapterSendBudget || !hasWorkflowSendObserver(sendBudgetState.adapterSendBudget))
          chargeWorkflowSends(sendBudgetState.workflowRootId, 1);
      };
      let retryRequest: AdapterRequest;
      if (transportState.sameTargetRequest !== undefined && transportState.sameTargetParsed === parsed && transportState.sameTargetToken === transportState.transportToken) {
        // Same target (key/adapter/parsed/tier unchanged): replay the exact cached request.
        retryRequest = transportState.sameTargetRequest;
      } else {
        try {
          retryRequest = await transportState.activeAdapter.buildRequest(parsed, {
            headers: requestState.selectedForwardHeaders, completedToolBlocks: requestState.completedToolBlocks,
            providerName: route.providerName,
            translatorBudget,
            abortSignal: upstream.signal,
            ...(logCtx.otlpSpan?.traceparent ? { otlpTraceparent: logCtx.otlpSpan.traceparent } : {}),
            ...(transportState.imageTierBias > 0 ? { imageTierBias: transportState.imageTierBias } : {}),
          });
          if (!replay && !transportState.activeAdapter.fetchResponse) {
            recordAdapterReasoning(logCtx, retryRequest); recordAdapterTier(logCtx, retryRequest);
          }
        } catch (err) {
          const buildRefusal = options.abortSignal?.aborted ? undefined : adapterBuildRefusal(err, admissionState.authCtx, route.codexAccountNamespace, () => { cleanupUpstreamAbort(); upstream.abort(); });
          if (buildRefusal) return { failed: buildRefusal };
          // A rotated credential that cannot be shaped keeps the refusal it was meant to
          // replace. The image-tier and reasoning-effort rebuilds are different: the request itself
          // failed to shape, and their established build-error contracts stay authoritative.
          if (preserveFailureResponse && recovery !== "image-413" && recovery !== "reasoning-effort-downgrade" && !options.abortSignal?.aborted) {
            return { failed: preserveFailureResponse };
          }
          // A rotated/rebuilt adapter build failure is a request-shaping error, not an
          // upstream connect failure: tear the abort link down and map it as 400.
          cleanupUpstreamAbort();
          upstream.abort();
          if (options.abortSignal?.aborted) return { failed: clientCancelledResponse() };
          if (err instanceof OllamaLateAttributionBudgetError) {
            return { failed: lateAttributionLimitResponse() };
          }
          if (isTranslatorBudgetExceededError(err)) {
            return { failed: formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
              code: "translation_buffer_limit",
            }) };
          }
          const msg = err instanceof Error ? err.message : String(err);
          return { failed: formatErrorResponse(400, "invalid_request_error", redactSecretString(msg)) };
        }
        transportState.sameTargetRequest = retryRequest;
        transportState.sameTargetParsed = parsed;
        transportState.sameTargetToken = transportState.transportToken;
      }
      refreshRequestToolAliases(retryRequest);
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (!replay) {
        if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
        if (!transportState.deferPhysicalAttribution) {
          logCtx.providerAdapter = transportState.activeAdapter.name;
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, transportState.activeAdapter.name, logCtx.accountLogLabel);
        }
        recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, transportState.activeAdapter.name);
      }
      try {
        try {
          if (transportState.activeAdapter.fetchResponse) {
            const publish = () => {
              if (dispatchConfirmed) return;
              upstream.signal.throwIfAborted();
              onDispatch?.();
              dispatchConfirmed = true;
              if (replay) replay(retryRequest, transportState.activeAdapter.name);
              else transportState.commitAdapterAttemptSend(retryRequest, transportState.activeAdapter.name, recovery);
              replacementAdmitted = true;
            };
            const producer = adapterDispatchBudget?.beginSpendProducer?.();
            try {
            return await withProviderRequestSlot(route.providerName, route.provider, route.modelId, upstream.signal, pacingSlot => {
              return transportState.activeAdapter.fetchResponse!(retryRequest, {
                kiroPreferAccountFailover: route.providerName === "kiro" && isGenericOAuthFailoverEnabled(config, "kiro"),
                abortSignal: upstream.signal,
                timeoutMs: sendConnectMs(),
                sendBudget: adapterDispatchBudget,
                onPhysicalSend: send => {
                  antigravityDenial.beforeSend();
                  // An adapter that supplies its own guarded receipt can bypass providerFetch.
                  if (transportState.activeAdapter.reportsPhysicalSends) publish();
                  noteAdapterPhysicalSend(retryEstimate, send);
                  chargeFastDowngradeWorkflowSend();
                },
                onRecoveryWithheld: noteAdapterRecoveryWithheld,
                stream: parsed.stream,
                executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                  pacingSlotAcquired: true,
                  pacingSlot,
                  dispatchOverride: oauthDispatch(retryRequest, parsed, "adapter", true),
                  onPhysicalDispatch: publish,
                  providerName: route.providerName,
                  modelId: route.modelId,
                  beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                    ? createCodexAuthDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
                }),
              });
            });
            } finally { producer?.close(); }
          }
          // An opted-in 5xx ladder spends only the remainder of this request's budget.
          const refetchTransientPolicy = transientRetryPolicyFor(route.provider);
          const refetchWithPolicy = (route.provider.adapter === "google" || refetchTransientPolicy)
            ? fetchWithTransientRetry
            : fetchWithResetRetry;
          const helperCountsSends = genericRefetchCountsSends();
          const prepaid = sendBudgetState.pendingHopPermit;
          const configuredTotal = refetchTransientPolicy?.attempts;
          const refetchCap = transientSendCapFor(configuredTotal, sendBudgetState.targetSendsUsed);
          // An exact total includes a booked hop, even when it consumed the last base slot.
          // Keep that funded send while forbidding the final reserve from widening the total.
          const prepaidLastSlot = helperCountsSends && configuredTotal !== undefined && prepaid
            && refetchCap > 0 && remainingTransientSendBudget(refetchCap) === 0;
          if (prepaidLastSlot) sendBudgetState.pendingHopPermit = undefined;
          const refetchAllowance = helperCountsSends
            ? prepaidLastSlot ? { attempts: 1, permit: prepaid } : recoverySendAllowance(
              refetchCap, recoveryClassFor(recovery),
              `${route.providerName}|${route.modelId}|${recovery}`,
              { allowFinalRecoveryReserve: configuredTotal === undefined },
            )
            : undefined;
          let refetchPermitUsed = false;
          const refetchReporter = refetchAllowance ? transientSendReporter(refetchAllowance.permit) : undefined;
          const deferredRefetch = refetchReporter && (shouldDeferGenericSend(retryRequest) || options.comboAttempt) ? deferPhysicalSendReporter(refetchReporter) : undefined;
          const pendingKeyMetadata = !replay && deferredRefetch && transportState.attemptSendDeferred();
          try {
            const response = await refetchWithPolicy(
              recoveryKind => {
                sendBudgetState.adapterSendBudget?.startRequest?.(responsesSpendTarget(logCtx, route.providerName));
                if (pendingKeyMetadata) transportState.noteRoutedAttemptSend(retryEstimate, recoveryKind ?? recovery);
                const confirmDispatch = () => {
                  if (refetchAllowance?.permit && !refetchPermitUsed && (!onDispatch || refetchAllowance.permit !== prepaid)) {
                    if (!refetchAllowance.permit.use()) throw new SendBudgetExhaustedError(errorDestinationLabel(retryRequest.url));
                    refetchPermitUsed = true;
                  }
                  if (!replay && !pendingKeyMetadata) transportState.noteRoutedAttemptSend(retryEstimate, recoveryKind ?? recovery);
                  if (!dispatchConfirmed) { onDispatch?.(); dispatchConfirmed = true; }
                  if (preserveFailureResponse) replacementAdmitted = true;
                  if (!refetchAllowance) chargeFastDowngradeWorkflowSend();
                };
                if (!deferredRefetch && !replay) confirmDispatch();
                return fetchWithHeaderTimeout(retryRequest.url,
                  applyUpstreamRecoveryInit({
                    method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
                  }, recoveryKind), upstream.signal, sendConnectMs(), parsed.stream,
                  providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                    dispatchOverride: oauthDispatch(retryRequest, parsed, "adapter", Boolean(replay)),
                    onPhysicalDispatch: () => {
                      if (replay) upstream.signal.throwIfAborted();
                      if (deferredRefetch && !deferredRefetch.beforeDispatch()) throw new SendBudgetExhaustedError(errorDestinationLabel(retryRequest.url));
                      if (deferredRefetch || replay) confirmDispatch();
                      replay?.(retryRequest, transportState.activeAdapter.name, recoveryKind);
                    },
                    providerName: route.providerName,
                    modelId: route.modelId,
                    beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                      ? createCodexAuthDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
                  }));
              },
              {
                abortSignal: upstream.signal,
                label: safeHostLabel(retryRequest.url), destination: errorDestinationLabel(retryRequest.url),
                claimAmbiguousResend: claimPreHeaderResend,
                reserveRetrySpend: reserveCompactRetrySpend,
                flexTierSent: hasOutboundFlexServiceTier(retryRequest.body, parsed),
                ...(refetchAllowance
                  ? {
                    attempts: refetchAllowance.attempts,
                    onSendsConsumed: deferredRefetch?.report ?? refetchReporter,
                  }
                  : {}),
              },
            );
            if (parsed._anthropicImageOwner && sendBudgetState.adapterSendBudget?.spendEnforced) {
              bindAdapterResponseSpend(response, refetchReporter?.recordUsage);
            }
            return response;
          } finally {
            // Refund only a reservation whose send never reached its admission boundary.
            // A used or externally settled permit ignores this.
            refetchAllowance?.permit?.release();
          }
        } finally {
          retryRequest.releaseBodyObservation?.();
        }
      } catch (err) {
        const storageRefusal = !options.abortSignal?.aborted && spendLedgerStorageErrorResponse(err, logCtx);
        if (storageRefusal) {
          cleanupUpstreamAbort();
          upstream.abort();
          releaseCodexAuthContextProbeLease(admissionState.authCtx);
          return { failed: storageRefusal };
        }
        const scopeRefusal = unwrapUpstreamRetryEvidenceError(err);
        if (!options.abortSignal?.aborted && (scopeRefusal instanceof AdmissionModelDeniedError || scopeRefusal instanceof HostedAdvisorSpendRefusal)) {
          cleanupUpstreamAbort();
          upstream.abort();
          releaseCodexAuthContextProbeLease(admissionState.authCtx);
          return { failed: scopeRefusal instanceof HostedAdvisorSpendRefusal ? scopeRefusal.response()
            : admissionModelDeniedResponse(projectAdmissionModelDeniedLog(scopeRefusal, logCtx)) };
        }
        const codexRefusal = !options.abortSignal?.aborted && mapCodexAuthContextErrorToResponse(unwrapUpstreamRetryEvidenceError(err), {
          now: Date.now(), accountSelector: route.codexAccountNamespace,
        });
        if (codexRefusal) {
          cleanupUpstreamAbort();
          upstream.abort();
          releaseCodexAuthContextProbeLease(admissionState.authCtx);
          return { failed: codexRefusal };
        }
        if (preserveFailureResponse && (recovery !== "reasoning-effort-downgrade" || err instanceof SendBudgetExhaustedError) && !replacementAdmitted && !options.abortSignal?.aborted)
          return { failed: preserveFailureResponse };
        cleanupUpstreamAbort();
        upstream.abort();
        if (options.abortSignal?.aborted) {
          return { failed: clientCancelledResponse() };
        }
        const refusal = err instanceof UpstreamRetryEvidenceError ? err.cause : err;
        if (refusal instanceof OAuthAccountPausedError) {
          return { failed: markProxyError(formatErrorResponse(403, "permission_error", publicOAuthAuthenticationErrorMessage(refusal)), publicOAuthErrorPresentation(refusal)) };
        }
        if (refusal instanceof OAuthLoginRequiredError) {
          return { failed: markProxyError(formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(refusal)), publicOAuthErrorPresentation(refusal)) };
        }
        if (refusal instanceof AnthropicAccountCooldownError) {
          return { failed: anthropicPoolCooldownResponse(refusal, { comboAttempt: options.comboAttempt, logCtx }) };
        }
        // Same rule on the recovery leg: the ladder refused to send again, so the answer names
        // this proxy rather than the provider it never reached.
        if (err instanceof SendBudgetExhaustedError) {
          return { failed: adapterSendBudgetRefusal(logCtx, sendBudgetState.workflowRootId, err.message) };
        }
        const msg = describeUpstreamConnectFailure(err, connectMs);
        return { failed: formatErrorResponse(502, "upstream_error", msg) };
      }
    };
    const refetchThinkingSignature = () => {
      invalidateSameTargetRequest();
      return rebuildAndRefetch("opaque-blob-rejection");
    };
  if (!upstreamResponse.ok) {
    const rotateAntigravityAuth = async (
      failedResponse: Response,
      recovery: AttemptRecoveryKind,
      // An account id (model-404 recovery already chose it) or a selector; the 403 refusal default.
      pick: string | ((sent: { accountId: string; generation: string }) => string | null) = sent =>
        rotateAntigravityAccountOnAuthRefusal(antigravityPoolActivated, sent.accountId, sent.generation, route.modelId),
    ): Promise<Response | null> => {
      const sent = transportState.replayOAuthCredentialSnapshot ?? transportState.sentOAuthSnapshot;
      if (!antigravityPoolActivated || !sent
        || transportState.genericFailovers >= transportState.genericFailoverLimit) return null;
      const nextId = typeof pick === "string" ? pick : pick(sent);
      if (!nextId) return null;
      const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
      return recoverAntigravityAccount({ nextId, failedResponse, adapterOwnsDispatch,
        reserve: () => reserveCredentialHop("auth-recovery", `${route.providerName}|${route.modelId}|antigravity-auth`,
          !adapterOwnsDispatch && genericRefetchCountsSends()),
        applyFailoverSnapshot, setPermit: permit => { sendBudgetState.pendingHopPermit = permit; },
        complete: () => { transportState.genericFailovers += 1; },
        refetch: onDispatch => rebuildAndRefetch(recovery, onDispatch, failedResponse,
          transportState.createCredentialReplayAttempt(failedResponse.status, recovery)),
        prepare: () => {
        invalidateSameTargetRequest();
        transportState.activeAdapter = resolveSelectionAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
          config.cacheRetention);
        bindRouteReasoningReplayScope({
          parsed, providerName: route.providerName, provider: route.provider,
          adapterName: transportState.activeAdapter.name,
          oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
        });
        },
      });
    };
    const keyPoolRecoveryCtx: KeyPoolRecoveryContext = {
      requestContext,
      requestState,
      transportState,
      sendBudgetState,
      upstream,
      cleanupUpstreamAbort,
      billingPoolRequest,
      recoveryFlags,
      resolveRotatedCopilotSelection,
      rebuildAndRefetch,
    };
    const oauthRecoveryCtx: OAuthRecoveryContext = {
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
    };
   // Keep recovery kinds in sync with the native Responses `passthroughRecovery:` loop above.
   recovery: for (;;) {
      const modelRotation = await antigravityDenial.recover(upstreamResponse,
        transportState.replayOAuthCredentialSnapshot ?? transportState.sentOAuthSnapshot, {
          config, model: route.modelId, enabled: antigravityPoolActivated && transportState.activeAdapter.name === "google",
          remaining: transportState.genericFailovers < transportState.genericFailoverLimit, signal: options.abortSignal,
          rotate: id => rotateAntigravityAuth(upstreamResponse, "oauth-account-403", id),
        });
      if (modelRotation) { upstreamResponse = modelRotation; continue recovery; }
      if (wasAccountAutoPaused(upstreamResponse) && route.provider.authMode !== "forward") {
        const recovered = await recoverAutoPausedAccount({ requestKey: transportState, reserve: reserveCredentialHop,
          remaining: transientSendCapFor(transientRetryPolicyFor(route.provider)?.attempts, sendBudgetState.targetSendsUsed),
          mapRefreshError: createAutoPauseRefreshErrorMapper(upstreamResponse, upstream, cleanupUpstreamAbort, copilotRefusalResponse, () => (options.abortSignal ?? req.signal).aborted, clientCancelledResponse),
          refresh: () => transportState.recoverAutoPausedSelection(parsed), refetch: () => rebuildAndRefetch("oauth-account-429"), setPermit: permit => { sendBudgetState.pendingHopPermit = permit; } });
        if (!recovered) break;
        if ("failed" in recovered) return recovered.failed;
        upstreamResponse = recovered; continue recovery;
      }

      // Preserve the terminal verdict through adapter and combo error formatting.
      // This also covers a reset reached by a 401/429/413 recovery refetch.
      const perMessageEffortRejection = await rejectAnthropicPerMessageEffort(parsed, upstreamResponse, upstream.signal);
      if (perMessageEffortRejection.unsupported
        && !perMessageEffortRepairGuard.attempted
        && !isNonReplayableResponse(upstreamResponse)) {
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "repair",
          `${route.providerName}|${route.modelId}|reasoning-effort-downgrade`,
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (hop.allowed) {
          perMessageEffortRepairGuard.attempted = true;
          const refusal = (options.comboAttempt || reserveCompactRetrySpend() || callerBoundedBudget || sendBudgetState.workflowRootId !== undefined)
            ? await retainFailureResponse()
            : undefined;
          invalidateSameTargetRequest();
          if (!refusal) {
            try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          }
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            result = await rebuildAndRefetch("reasoning-effort-downgrade", () => {
              if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
            }, refusal);
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            hop.permit?.release();
            return result.failed;
          }
          if (refusal && refusal !== result) {
            try { void refusal.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          }
          upstreamResponse = result;
          continue recovery;
        }
      }
      if (isNonReplayableResponse(upstreamResponse)) {
        try {
          return await sanitizeNonReplayableUpstreamError(upstreamResponse, upstream.signal,
            isXaiGrokOAuth(route.providerName, route.provider) ? logCtx : undefined);
        } finally { cleanupUpstreamAbort(); }
      }
      bindAnthropicRejectionResponse(transportState.sameTargetRequest, upstreamResponse);
      if (await thinkingSignatureRecovery.prepareHttp(
        upstreamResponse, transportState.activeAdapter.name,
      )) {
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* closed */ }
        invalidateSameTargetRequest();
        const result = await rebuildAndRefetch("opaque-blob-rejection");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }
      const oauth401Outcome = await recoverOAuth401Replay(oauthRecoveryCtx, upstreamResponse);
      if (oauth401Outcome.kind === "return") return oauth401Outcome.response;
      upstreamResponse = oauth401Outcome.response;
      if (oauth401Outcome.kind === "continue") continue recovery;

      if (route.providerName === "google-antigravity" && upstreamResponse.status === 401 && !wasPermanentAccountRefusal(upstreamResponse)
        && recoveryFlags.oauth401ReplayAttempted && !recoveryFlags.antigravityAuthRotationAttempted
        && !isNonReplayableResponse(upstreamResponse)) {
        recoveryFlags.antigravityAuthRotationAttempted = true;
        const rotated = await rotateAntigravityAuth(upstreamResponse, "oauth-401");
        if (rotated) { upstreamResponse = rotated; continue recovery; }
      }

      if (route.providerName === "google-antigravity" && upstreamResponse.status === 403
        && transportState.activeAdapter.name === "google"
        && antigravityPoolActivated
        && !isNonReplayableResponse(upstreamResponse)
        && transportState.genericFailovers < transportState.genericFailoverLimit
        && (!recoveryFlags.antigravityAuthRotationAttempted && await isAntigravityValidationRefusal(upstreamResponse, options.abortSignal)
          // A plain access-denied 403 keeps rotating while siblings remain: each refused account is
          // cooled before the hop, so the ring advances and `genericFailoverLimit` bounds the sends.
          || await isAntigravityAccessDeniedRefusal(upstreamResponse, options.abortSignal))) {
        recoveryFlags.antigravityAuthRotationAttempted = true;
        const rotated = await rotateAntigravityAuth(upstreamResponse, "oauth-account-403");
        if (rotated) { upstreamResponse = rotated; continue recovery; }
      }

      // A 502/503/504 that outlived the same-account ladder replays once on a live sibling.
      if (antigravityFaultRotatable(upstreamResponse)) {
        antigravityFaultRotationAttempted = true;
        const rotated = await rotateAntigravityAuth(upstreamResponse, "transient-5xx", sent =>
          rotateAntigravityAccountOnUpstreamFault(antigravityPoolActivated, sent.accountId, sent.generation, route.modelId));
        if (rotated) { upstreamResponse = rotated; continue recovery; }
      }

      const key401Outcome = await recoverApiKeyPool401(keyPoolRecoveryCtx, upstreamResponse);
      if (key401Outcome.kind === "return") return key401Outcome.response;
      upstreamResponse = key401Outcome.response;
      if (key401Outcome.kind === "continue") continue recovery;

      const billingKeyOutcome = await recoverAnthropicBillingKeyPool(keyPoolRecoveryCtx, upstreamResponse);
      if (billingKeyOutcome.kind === "return") return billingKeyOutcome.response;
      upstreamResponse = billingKeyOutcome.response;
      if (billingKeyOutcome.kind === "continue") continue recovery;

      // Anthropic fast mode refused (no usage credits, organization not enabled, model outside
      // the lane, fast pool empty): resend once at standard speed, as Claude Code does. This
      // sits before every 429 arm because the refusal says nothing about the account's standard
      // lane; waiting, cooling, or rotating on it would punish a healthy credential. The
      // resend is reserved and confirmed exactly like the generic OAuth hop below, and the
      // decision lives on this request, so every later rebuild of it stays standard.
      if (await anthropicFastRefused(
        upstreamResponse,
        transportState.sameTargetRequest,
        transportState.activeAdapter.name,
        anthropicFastDowngradeGuard.attempted,
        upstream.signal,
      )) {
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "repair",
          `${route.providerName}|${route.modelId}|anthropic-fast-downgrade`,
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (hop.allowed) {
          anthropicFastDowngradeGuard.attempted = true;
          parsed.options.tierDecision = { kind: "drop" };
          parsed.options.serviceTier = undefined;
          if (parsed.options.tierObservation) {
            parsed.options.tierObservation = { ...parsed.options.tierObservation, upstreamDeclinedFast: true };
          }
          invalidateSameTargetRequest();
          try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            result = await rebuildAndRefetch("anthropic-fast-downgrade", () => {
              if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
            });
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            hop.permit?.release();
            return result.failed;
          }
          upstreamResponse = result;
          continue recovery;
        }
      }

      const flexConfiguredPolicy = transientRetryPolicyFor(route.provider);
      const flexConfiguredExhausted = flexConfiguredPolicy !== null
        && transientSendCapFor(flexConfiguredPolicy.attempts, sendBudgetState.targetSendsUsed) === 0;
      if (
        !flexTierDowngradeGuard.attempted
        && !flexConfiguredExhausted
        && !isNonReplayableResponse(upstreamResponse)
        && await isFlexUnavailableRefusal(
          upstreamResponse,
          transportState.sameTargetRequest?.body,
          parsed,
          flexTierDowngradeGuard.attempted,
          upstream.signal,
        )
      ) {
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "transient",
          `${route.providerName}|${route.modelId}|flex-tier-downgrade`,
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (hop.allowed) {
          flexTierDowngradeGuard.attempted = true;
          const prevTierDecision = parsed.options.tierDecision;
          const prevServiceTier = parsed.options.serviceTier;
          const prevRawBody = parsed._rawBody;
          const refusal = (
            options.comboAttempt
            || reserveCompactRetrySpend()
            || callerBoundedBudget
            || sendBudgetState.workflowRootId !== undefined
          )
            ? await retainFailureResponse()
            : undefined;
          stripFlexServiceTierForStandardRetry(parsed);
          invalidateSameTargetRequest();
          if (!refusal) {
            try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          }
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            result = await rebuildAndRefetch("flex-tier-downgrade", () => {
              if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
            }, refusal);
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            parsed.options.tierDecision = prevTierDecision;
            parsed.options.serviceTier = prevServiceTier;
            parsed._rawBody = prevRawBody;
            hop.permit?.release();
            return result.failed;
          }
          if (refusal && refusal !== result) {
            try { void refusal.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          }
          upstreamResponse = result;
          continue recovery;
        }
      }

      // Honor retryOn429 on the same key before rotating it (#487).
      while (
        upstreamResponse.status === 429 && !isSameTargetRetryHold(upstreamResponse)
        && rateLimitPolicy !== null && providerAffinityGenerationIsCurrent(config, route.providerName, route.provider)
        && rateLimitRetries < rateLimitPolicy.attempts
        && !sendBudgetExhausted()
      ) {
        rateLimitRetries += 1;
        const retryAfterHeader = upstreamResponse.headers.get("retry-after");
        const preceding = reserveCompactRetrySpend() ? await retainFailureResponse() : undefined;
        try {
          for await (const _ of prepareSameTarget429Wait({
            body: preceding ? null : upstreamResponse.body,
            signal: options.abortSignal,
            delayMs: rateLimitRetryDelayMs(rateLimitPolicy, retryAfterHeader, Date.now()),
          })) {
            // pre-stream: no stall watchdog to feed
          }
        } catch {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
        // Recheck cancellation after the wait.
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
       const result = await rebuildAndRefetch("rate-limit-429", undefined, preceding);
       if ("failed" in result) return result.failed;
       void preceding?.body?.cancel().catch(() => undefined);
       upstreamResponse = result;
        // The refusal is a 429 too: without this the while condition is still true and the
        // next configured attempt replays it on the same target.
        if (isNonReplayableResponse(upstreamResponse)
          || ([400, 402, 403, 422].includes(upstreamResponse.status) && !sendBudgetExhausted())) continue recovery;
     }

      const key429Outcome = await recoverApiKeyPool429(keyPoolRecoveryCtx, upstreamResponse);
      if (key429Outcome.kind === "return") return key429Outcome.response;
      upstreamResponse = key429Outcome.response;
      if (key429Outcome.kind === "continue") continue recovery;

      const anthropicPoolOutcome = await recoverAnthropicOAuthPool(oauthRecoveryCtx, upstreamResponse);
      if (anthropicPoolOutcome.kind === "return") return anthropicPoolOutcome.response;
      upstreamResponse = anthropicPoolOutcome.response;
      if (anthropicPoolOutcome.kind === "continue") continue recovery;

      // Generic OAuth account failover (#2568) rotates reactively after a refusal when
      // two accounts are stored. Kiro additionally classifies bounded 400/403 refusals;
      // all other providers retain the original 429 loop below.
      if (route.providerName === "kiro") {
      while (
        (upstreamResponse.status === 429 || upstreamResponse.status === 400 || upstreamResponse.status === 403)
        && transportState.genericFailoverAccountId
      ) {
        const refusal = classifyKiroRefusal(upstreamResponse.status,
          await readDisplaySafeErrorText(upstreamResponse.clone(), upstream.signal, ""));
        if (refusal.kind === "other") break;
        const sent = transportState.sentOAuthSnapshot;
        const monthlyCooldownMs = refusal.kind === "monthly_quota" && sent
          ? noteKiroMonthlyRefusal(sent.accountId, sent.generation, Date.now()) : undefined;
        if (monthlyCooldownMs !== undefined) persistKiroAccountState();
        if (refusal.kind === "suspended")
          quarantineKiroSuspendedAccount(transportState.genericFailoverAccountId, sent?.generation);
        if (transportState.genericFailovers >= transportState.genericFailoverLimit
          || !isGenericOAuthFailoverEnabled(config, "kiro")) break;
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "auth-recovery",
          `${route.providerName}|${route.modelId}|adapter-recovery-oauth-429`,
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (!hop.allowed) break;
        const nextAccountId = rotateGenericOAuthAccountOnRefusal(
          config,
          route.providerName,
          transportState.genericFailoverAccountId,
          refusal.kind,
          upstreamResponse.headers.get("retry-after"),
          Date.now(),
          route.modelId,
          monthlyCooldownMs,
        );
        if (!nextAccountId) {
          hop.permit?.release();
          break;
        }
        const replay = transportState.createCredentialReplayAttempt(upstreamResponse.status, "oauth-account-429");
        try {
          const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
          if (!await applyFailoverSnapshot(snapshot)) {
            hop.permit?.release();
            break;
          }
          transportState.genericFailovers += 1;
          invalidateSameTargetRequest();
          transportState.activeAdapter = resolveSelectionAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
            config.cacheRetention,
          );
          bindRouteReasoningReplayScope({
            parsed, providerName: route.providerName, provider: route.provider,
            adapterName: transportState.activeAdapter.name,
            oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
          });
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            result = await rebuildAndRefetch("oauth-account-429", () => {
              if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
            }, upstreamResponse, replay);
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            hop.permit?.release();
            if (result.failed !== upstreamResponse) return result.failed;
            break;
          }
          try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          upstreamResponse = result;
          if (isNonReplayableResponse(upstreamResponse)) continue recovery;
        } catch {
          hop.permit?.release();
          break;
        }
      }
      } else {
      while (
        (upstreamResponse.status === 429
          || ((upstreamResponse.status === 400 || upstreamResponse.status === 402 || upstreamResponse.status === 403 || upstreamResponse.status === 422)
            && await readCreditOrBudgetExhaustedResponse(upstreamResponse, upstream.signal)))
        && transportState.genericFailoverAccountId
        && transportState.genericFailovers < transportState.genericFailoverLimit
        && isGenericOAuthFailoverEnabled(config, route.providerName)
      ) {
        // Intersection with the shared request budget. This arm re-sends through
        // rebuildAndRefetch, so the roster cap alone would let one request walk the roster on
        // an allowance the rest of the request cannot see. A refusal ends the ladder with the
        // real 429 already in hand, which is the decided exhaustion contract.
        //
        // Who settles this reservation depends on who dispatches the replay (#4709). An
        // adapter that owns its ladder -- Kiro's reset loop, Cursor's transport loop --
        // reserves once per physical send and would charge the same replay again; the helper
        // path reports it again through `onSendsConsumed`. Both turned one physical send into
        // two charges, and once the allowance was spent, into a synthetic error in place of
        // the 429 this hop was recovering from. The wire protocol is resolved from the
        // provider and model, not from the account, so an account rotation cannot move the
        // replay between these two shapes.
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const recoveryKind = upstreamResponse.status === 429 ? "oauth-account-429" : "oauth-account-403";
        const refusalKind = upstreamResponse.status === 429 ? "rate" : "billing";
        const hop = reserveCredentialHop(
          "auth-recovery",
          `${route.providerName}|${route.modelId}|adapter-recovery-${recoveryKind}`,
          // Counted generic helpers report physical sends; an adapter-owned
          // ladder settles its own booking.
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (!hop.allowed) break;
        const nextAccountId = refusalKind === "billing"
          ? rotateGenericOAuthAccountOnRefusal(
            config,
            route.providerName,
            transportState.genericFailoverAccountId,
            "billing",
            upstreamResponse.headers.get("retry-after"),
            Date.now(),
            route.modelId,
          )
          : rotateGenericOAuthAccountOn429(
            config,
            route.providerName,
            transportState.genericFailoverAccountId,
            upstreamResponse.headers.get("retry-after"),
            Date.now(),
            route.modelId,
          );
        if (!nextAccountId) {
          hop.permit?.release();
          break;
        }
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        try {
          // The FULL snapshot, not just the bearer: Antigravity pairs an account-matched
          // projectId with its token and Kiro carries routing metadata, so a token-only swap
          // would mix one account's credential with another's routing data.
          const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
            transportState.genericFailovers += 1;
          if (!await applyFailoverSnapshot(snapshot)) {
            hop.permit?.release();
            break;
          }
          invalidateSameTargetRequest();
          transportState.activeAdapter = resolveSelectionAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
            config.cacheRetention,
          );
          // Same contract as the Kiro refusal arm: the replay must carry the replacement
          // account's continuation owner and reasoning scope, never the account that just 429'd.
          bindRouteReasoningReplayScope({
            parsed, providerName: route.providerName, provider: route.provider,
            adapterName: transportState.activeAdapter.name,
            oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
          });
          // The replay IS this hop's send, so hand the reservation down and let the layer that
          // dispatches settle it: `adapterDispatchBudget` spends it on the adapter's first
          // reservation, and the retry helper's reporter settles the external booking.
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            // Confirm at the dispatch boundary, not here: a rebuild can fail while shaping the
            // request and return `{ failed }` without reaching the wire, and a permit confirmed
            // before that would hold the charge for a send that never happened. An
            // adapter-owned ladder is the exception -- its own reservation is the confirmation,
            // and settling here first would hand it a dead permit, which it reads as an
            // exhausted request and stops sending on.
            result = await rebuildAndRefetch(recoveryKind, () => {
              if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
            });
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            // A no-op if the boundary was reached; a refund if the rebuild died before it.
            hop.permit?.release();
            return result.failed;
          }
         upstreamResponse = result;
          // The hop's permit is already settled by the dispatch boundary above; continuing
          // only skips the remaining arms, it does not abandon a reservation. A replacement's
          // surviving 502/503/504 re-enters recovery so the one-hop fault rotation can run.
          if (isNonReplayableResponse(upstreamResponse) || antigravityFaultRotatable(upstreamResponse)) continue recovery;
       } catch (err) {
          // A local admission denial is terminal for the whole request: rotating to another
          // account cannot re-scope the key, so the refusal answers in place of the 429.
          const scopeRefusal = unwrapUpstreamRetryEvidenceError(err);
          if (!options.abortSignal?.aborted && scopeRefusal instanceof AdmissionModelDeniedError) {
            hop.permit?.release();
            cleanupUpstreamAbort();
            upstream.abort();
            releaseCodexAuthContextProbeLease(admissionState.authCtx);
            return admissionModelDeniedResponse(projectAdmissionModelDeniedLog(scopeRefusal, logCtx));
          }
         // A throw before the send — snapshot fetch, credential application, adapter
          // resolution — must hand the reservation back. Without this the ladder charges the
          // request for a send it never made, and a later recovery in the same request is
          // refused on an allowance nothing spent. release() is idempotent and a no-op once
          // used, so a throw from the rebuild keeps its charge.
          hop.permit?.release();
          break;
        }
      }
      // Antigravity verify-account quarantine: a 403 demanding account verification
      // is terminal for THAT account — its grant still refreshes, so only a manual
      // Antigravity verify-account quarantine: a 403 demanding account verification
      // is terminal for THAT account — its grant still refreshes, so only a manual
      // verification followed by a re-login clears it. Mark it needsReauth (durable,
      // shown as `needs-reauth(verify)` in `epx account list` with a `verify_account`
      // health reason in the management API, excluded from the pool until re-login)
      // and replay the same request on the next eligible account so the pool keeps
      // serving.
      while (
        upstreamResponse.status === 403
        && route.providerName === "google-antigravity"
        && transportState.genericFailoverAccountId
      ) {
        const refusal = await classifyAntigravityQuarantine(upstreamResponse, route.provider, antigravityQuarantineTrust, upstream.signal);
        if (refusal.kind === "other") break;
        const sent = transportState.sentOAuthSnapshot;
        const failedAccountId = transportState.genericFailoverAccountId;
        // Fenced write: a 403 arriving after the credential rotated (refresh or
        // re-login) must not quarantine the new login. Without the matching sent
        // snapshot there is no owner for this write, so skip marking.
        if (!sent || sent.accountId !== failedAccountId) break;
        try {
          await markAccountNeedsReauthIfGeneration(route.providerName, failedAccountId, sent.generation, undefined, refusal.kind);
        } catch {
          // A failed quarantine write must preserve the refusal, not authorize another send.
          break recovery;
        }
        if (!antigravityPoolActivated || transportState.genericFailovers >= transportState.genericFailoverLimit) break;
        const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
        const hop = reserveCredentialHop(
          "auth-recovery",
          `${route.providerName}|${route.modelId}|adapter-recovery-oauth-verify`,
          !adapterOwnsDispatch && genericRefetchCountsSends(),
        );
        if (!hop.allowed) break;
        // Auth-refusal rotation, not the rate-limit one: a verification refusal
        // must not record rate-limit cooldown semantics against the account.
        const nextAccountId = rotateAntigravityAccountOnAuthRefusal(
          antigravityPoolActivated,
          failedAccountId,
          sent.generation,
          route.modelId,
        );
        if (!nextAccountId) {
          hop.permit?.release();
          break;
        }
        // The refusal body stays alive until the replacement owns the outcome: it
        // is also the preserveFailureResponse below, so cancelling it early would
        // hand back a 403 with a destroyed body when the rebuild is refused.
        const failedResponse = upstreamResponse;
        try {
          // The FULL snapshot, not just the bearer: Antigravity pairs an
          // account-matched projectId with its token, so a token-only swap would mix
          // one account's credential with another's routing data.
          const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
          if (!await applyFailoverSnapshot(snapshot)) {
            hop.permit?.release();
            break;
          }
          invalidateSameTargetRequest();
          transportState.activeAdapter = resolveSelectionAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
            config.cacheRetention,
          );
          bindRouteReasoningReplayScope({
            parsed,
            providerName: route.providerName,
            provider: route.provider,
            adapterName: transportState.activeAdapter.name,
            oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
          });
          sendBudgetState.pendingHopPermit = hop.permit;
          let result: Response | { failed: Response };
          try {
            result = await rebuildAndRefetch("oauth-account-403", () => {
              if (!adapterOwnsDispatch && hop.permit?.use() === false) throw new SendBudgetExhaustedError();
            }, failedResponse);
          } finally {
            sendBudgetState.pendingHopPermit = undefined;
          }
          if ("failed" in result) {
            hop.permit?.release();
            if (result.failed !== failedResponse) return result.failed;
            // Preserve common redaction and combo consumption without another recovery send.
            break recovery;
          }
          transportState.genericFailovers += 1;
          try { void failedResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
          upstreamResponse = result;
          if (isNonReplayableResponse(upstreamResponse) || antigravityFaultRotatable(upstreamResponse)) continue recovery;
        } catch {
          hop.permit?.release();
          break;
        }
      }
      }
      // Unknown provenance is deliberately fail-soft in pre-flight: after a restart, TTL expiry,
      // or LRU eviction, a valid same-backend blob must survive. A decoder's own 4xx identity is
      // the missing authoritative signal. Rebuild once through the same sanitation path used by a
      // known route switch; invalidating is mandatory because `parsed` mutates in place and the
      // same-target cache would otherwise replay the rejected bytes verbatim.
      const opaqueBlobRecovery = await attemptOpaqueBlobRecovery({
        response: upstreamResponse,
        outboundBody: transportState.sameTargetRequest?.body,
        adapterName: transportState.activeAdapter.name,
        parsed,
        guard: opaqueBlobRecoveryGuard,
        signal: upstream.signal,
      }, recovery => {
        invalidateSameTargetRequest();
        return rebuildAndRefetch(recovery);
      });
      if (opaqueBlobRecovery.kind === "failed") return opaqueBlobRecovery.response;
      if (opaqueBlobRecovery.kind === "recovered") {
        upstreamResponse = opaqueBlobRecovery.response;
        continue recovery;
      }
      if (imageRecovery && upstreamResponse.status === 413) {
        const recovered = await recoverAdapterImageContext(imageRecovery, upstreamResponse, parsed, transportState, upstream.signal, refreshRequestToolAliases);
        if (!recovered) { cleanupUpstreamAbort(); return clientCancelledResponse(); }
        upstreamResponse = recovered;
        break recovery;
      }
      const imageTierOutcome = await retryAdapterImageTier(
        upstreamResponse,
        parsed,
        transportState,
        imageRetryState,
        retainFailureResponse,
        rebuildAndRefetch,
      );
      if (imageTierOutcome.kind === "return") return imageTierOutcome.response;
      upstreamResponse = imageTierOutcome.response;
      if (imageTierOutcome.kind === "break") break recovery;
      if (imageTierOutcome.kind === "continue") continue recovery;

      const consoleGoOutcome = await retryConsoleGoUploadRejection(
        upstreamResponse,
        transportState,
        upstream,
        cleanupUpstreamAbort,
        consoleGoUploadRetryGuard,
        rebuildAndRefetch,
      );
      if (consoleGoOutcome.kind === "return") return consoleGoOutcome.response;
      if (consoleGoOutcome.kind === "continue") {
        upstreamResponse = consoleGoOutcome.response;
        continue recovery;
      }

      const effortDowngradeOutcome = await retryReasoningEffortDowngrade(
        upstreamResponse,
        requestContext,
        requestState,
        transportState,
        upstream,
        reasoningEffortDowngradeGuard,
        retainFailureResponse,
        rebuildAndRefetch,
      );
      if (effortDowngradeOutcome.kind === "return") return effortDowngradeOutcome.response;
      upstreamResponse = effortDowngradeOutcome.response;
      if (effortDowngradeOutcome.kind === "break") break recovery;
      if (effortDowngradeOutcome.kind === "continue") continue recovery;
      break;
    }
    if (!upstreamResponse.ok) {
      if (route.providerName === "kiro")
        upstreamResponse = await normalizeFinalKiroHttpError(upstreamResponse, upstream.signal);
      const grokOAuth = isXaiGrokOAuth(route.providerName, route.provider);
      if (options.comboAttempt) {
        // No pre-read guard: `consumeComboFailure` -> `readBoundedResponseBody` reads
        // `response.body` itself with the abort signal threaded through, and the combo
        // contract is that this body's getter is touched exactly once. A guard here would be
        // a second `.body` access for no gain, since the bounded reader owns settlement.
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal, Date.now(), logCtx, !isProxyError(upstreamResponse), grokOAuth)
          .finally(cleanupUpstreamAbort);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      let errorText: string;
      try {
        errorText = await readDisplaySafeErrorText(
          upstreamResponse,
          upstream.signal,
          "unknown error",
        );
      } finally {
        cleanupUpstreamAbort();
      }
      if (grokOAuth && isXaiLegacyPrivacyError(upstreamResponse.status, errorText)) return xaiPrivacyModeRefusal(logCtx);
      // The provider's own body (not a proxy-normalized one) may name its closed error class (#8446).
      if (!isProxyError(upstreamResponse)) recordUpstreamProviderErrorDetail(logCtx, upstreamResponse.status, errorText, upstreamResponse);
      if (upstreamResponse.status === 413) {
        if (options.clientModelLabel) projectLocalModelRefusalLog(logCtx, options.clientModelLabel);
        return clientRequestedStream
          ? streamingContextOverflowResponse(clientFacingModelText(options.clientModelLabel), translatorBudget)
          : jsonContextOverflowResponse();
      }
      const policyRefusal = rewriteUpstreamPolicyRefusal({
        status: upstreamResponse.status,
        errorText,
        stream: clientRequestedStream,
        modelId: clientFacingModelText(options.clientModelLabel),
        // The same host check covers the openai-chat wire: both xAI hosts serve Chat too.
        destinationIsXai: isXaiResponsesDestination(route.provider),
        translatorBudget,
        turnAdmissionLease: options.turnAdmissionLease,
      });
      if (policyRefusal) {
        // Codex-facing incomplete/content_filter. openai-responses passthrough
        // uses the same helper after its 413 block.
        return policyRefusal;
      }
      return formatAdapterTerminalUpstreamErrorResponse(
        upstreamResponse,
        errorText,
        requestContext,
        admissionState,
        requestState,
        transportState,
        fallback => antigravityDenial.message(route.modelId, fallback),
      );
    }
  }

  bindAnthropicRejectionResponse(transportState.sameTargetRequest, upstreamResponse);
  cancelBodyOnAbort(upstreamResponse.body, upstream.signal);

  return {
    upstream,
    cleanupUpstreamAbort,
    get connectMs() { return resolveConnectTimeoutMs(connectTimeoutMs(), { localUpstream: this.localUpstream }); },
    get stallTimeoutMs() { return resolveStallTimeoutMs(providerStallTimeoutSec(config, responsesTimeoutProvider(options, route.provider)), { localUpstream: this.localUpstream }); },
    get localUpstream() { return isLocalUpstream(transportState.sameTargetRequest?.url ?? route.provider.baseUrl); },
    upstreamResponse,
    thinkingSignatureRecovery,
    refetchThinkingSignature,
    rateLimitPolicy,
    get rateLimitRetries(): typeof rateLimitRetries {
      return rateLimitRetries;
    },
    set rateLimitRetries(value: typeof rateLimitRetries) {
      rateLimitRetries = value;
    },
  };
}

export type AdapterExchange = Exclude<Awaited<ReturnType<typeof prepareAdapterExchange>>, Response>;
