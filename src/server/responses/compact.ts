import { clientFacingModelLabel, type ClientFacingModelLabel } from "../../lib/error-destination";
import { conversationStateAccountId, releaseRequestOwnedMainOnOutcome, isKeyedRequestOwnedMain } from "../../codex/request-owned-affinity";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/account-id";
import { isolateCodexPoolClientMetadata } from "../../codex/forward-transport-headers";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused, wasPermanentAccountRefusal } from "../../oauth/account-auto-pause";
import { spendLedgerStorageErrorResponse } from "./spend-storage-error";
import { captureAdmissionPolicy } from "../capture-admission-policy";
import { createPhysicalSendReporter, rebindPhysicalSend } from "../../lib/request-execution-budget";
import { createInferenceSendBudget, fundChatGptRetryAttempts } from "../inference/context";
import { unboundPoolSpendRefusalResponse } from "../workflow-refusal";
import { previewXaiOauthWireModel } from "./core-normalize";
import {
  admissionModelDeniedResponse, projectAdmissionModelDeniedLog,
  AdmissionModelDeniedError,
  assertRouteAllowedByScope,
  resolveAdmissionModelScope,
} from "../admission-model-scope";
import { formatErrorResponse } from "../../bridge";
import { resolveProviderApiKey } from "../../providers/key-store";
import { parseRequest } from "../../responses/parser";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { repairUrlCitationAnnotations, stripProviderInputItemMetadata } from "../../adapters/openai-responses/request-strips";
import { repairLegacyDottedToolCallNames } from "../../responses/legacy-dotted-tool-name-repair";
import { NoEligiblePolicyCandidateError, routeCompactionModel } from "../../router";
import { evidenceFromBody } from "../../routing/request-evidence";
import { resolveComboId } from "../../combos";
import type { EpxConfig, EpxProviderConfig } from "../../types";
import {
  applyCodexAuthContextToProvider,
  callerCodexWorkspaceAccountId,
  createCodexAuthDispatchGuard,
  unwrapUpstreamRetryEvidenceError,
  materializeCodexUpstreamAuthAsync,
  resolveCodexAuthContext,
  codexPoolAffinityKey,
  codexProbeLeaseId,
  codexTransientProbeGrant,
  codexProbeQuotaScope,
  releaseCodexAuthContextProbeLease,
  type CodexAuthContext,
} from "../../codex/auth-context";
import type { NativeMainRefreshDependencies } from "../../codex/main-account";
import {
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { codexFailureWindowOutcomeMeta } from "../../codex/routing/failure-window";
import {
  applyAccountChangeConversationStateScrub,
  conversationStateBindingFromAuth,
  compactAlternateAffinityKey,
  accountChangeFileReferenceRefusal,
  rememberServingConversationStateIssuer,
  conversationCarriesUploadedFiles,
} from "./account-change-state";
import {
  fetchWithTransientRetry,
  applyUpstreamRecoveryInit,
  isNonReplayableResponse,
  retainPacedRetryResponse,
  SendBudgetExhaustedError, errorDestinationLabel,
  type UpstreamSendRecovery,
} from "../../lib/upstream-retry";
import {
  capRequestExecutionBudgetSends,
  type RequestExecutionBudget,
} from "../../lib/request-execution-budget";
import { classifyTransportFailureKind, transportErrorCode } from "../../lib/upstream-reachability";
import {
  acquireUpstreamHostAdmission,
  disableUpstreamHostCircuitForKey,
  normalizeUpstreamHostCircuitThreshold,
  recordUpstreamHostFailure,
  releaseUpstreamHostAdmission,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  type UpstreamHostAdmissionLease,
} from "../../codex/upstream-host-health";
import {
  ForwardAdmissionCredentialError,
  hasForwardableCodexBearer,
  resolveContextPrincipal,
  validateForwardAdmissionCredential,
} from "../auth-cors";
import type { DataPlaneAdmission } from "../auth-cors";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider, supportsNativeResponsesCompactEndpoint } from "../../providers/openai-tiers";
import { buildResponsesTransport } from "../../adapters/openai-responses/transport";
import { scrubEpxCompactionItems, stripCanonicalOnlyInputItems, stripCanonicalOnlyTopLevelFields, stripInternalChatMessageMetadataPassthrough } from "../../adapters/openai-responses/request-strips";
import { dropResponsesReasoningInputItems } from "../../adapters/openai-responses/reasoning";
import { requiresPlaintextReasoningReplay } from "../../adapters/openai-responses/passthrough";
import { destinationDecodesNativeCompactionBlob, isOpenAiOperatedResponsesDestination } from "../../providers/openai-tiers-destination";
import { bindRouteReasoningReplayScope } from "./core-replay";
import { commitReasoningReplayServingIdentity } from "../../responses/reasoning-replay-cache";
import { rewriteRoutedCustomToolsForUpstream, RoutedCustomToolCompatError, validateFinalCustomToolCompatibility } from "../../responses/custom-tool-compat";
import { findInvalidRetainedCompactionEnvelope, InvalidRetainedCompactionEnvelopeError } from "../../responses/retained-compaction";
import { nativeCompactResponseSchema } from "../../responses/schema";
import { NATIVE_RESERVE_MODEL } from "../../codex/catalog/native-models";
import {
  isCodexReserveOptInMissing,
  isCodexReserveRequestEligible,
  CODEX_RESERVE_OPT_IN_REQUIRED_MESSAGE,
} from "../../codex/loopback-target";
import { decideTier, tierValueAfterDecision } from "../../providers/fastwire";
import { fastPolicyForModel } from "../../providers/service-tier";
import { parseFastOnlyRowId } from "../fast-row";
import { captureOpenAiVirtualWirePolicy, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import {
  applyCompactionRoutingOverride,
  compactionRoutingKeepsProviderIdentity,
  type CompactionRoutingOverride,
} from "./compaction-routing";
import {
  readJsonRequestBody,
  resolveInboundBodyLimitBytes,
} from "../request-decompress";
import { projectCapturedCustomToolPolicy } from "../adapter-resolve";
import { rotateProviderTransportOn429, selectProactiveApiKeyTransport, transientRetryPolicyFor } from "../../providers/key-failover";
import { sendSingleCompactRecovery, transientSendCapFor } from "./request-send-budget";
import { distributedKeyPhysicalFetch, recordDistributedResponseFailure } from "../../providers/api-key-response-ownership";
import { passiveKeyPhysicalFetch } from "../../providers/passive-key-observation";
import { isProviderApiKeyPaused, ProviderApiKeyPausedError } from "../../providers/api-key-pause";
import { providerAffinityGenerationIsCurrent, providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../../providers/api-key-selection";
import { stampApiKeyAccountLabel } from "../../providers/label";
import { resolveProviderTransport } from "../../providers/xai-transport";
import { codexAccountSelectionForTurn } from "../lifecycle";
import type { AdmissionLease } from "../../lib/admission";
import { redactSecretString } from "../../lib/redact";
import { resolveConnectTimeoutMs } from "../../stall-timeout";
import { readCompactResponseBytes } from "./compact-response-body";
import { isLocalUpstream } from "../../lib/local-upstream";
import { isRateLimitOrQuotaFailureMessage } from "../../lib/errors";
import {
  inspectResponseLogJson,
  type RequestLogContext,
} from "../request-log";
import { noteCredentialAttemptSend, sealCredentialRefusal } from "../credential-recovery-attempt";
import type { AttemptRecoveryKind } from "../../usage/log";
import { codexAuthContextLogLabel } from "../../codex/account-label";
import { clientCancelledResponse } from "./core-errors";

import {
  codexAccountGatedCanonicalWireModel,
  decodeRequestErrorResponse,
  preAuthUpstreamHostCircuitKey,
  shouldRetryCodexScopedQuotaOnAlternate,
  upstreamHostCircuitOpenResponse,
  usesCodexForwardPoolAuth,
} from "./core";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel, safeOriginLabel, sendWithConnectionPolicy } from "./fetch-helpers";
import { requestPacingOverloadResponse } from "./pacing-overload";
import { shouldRetryCodexPoolAccountQuota, shouldRetryCodexPoolAccountTransient } from "./core-codex-account";
import { mapCodexAuthContextErrorToResponse } from "./codex-auth-error";
import { affinityLaneFromRequest, reasoningReplayConversationIdFromResponsesRequest, sessionIdHeaderFromRequest, sessionLaneIdFromRequest } from "../request-log-conversation";
import { recallComboForLane } from "./combo-session-recall";
import { OUTBOUND_SECRET_BLOCKED_MESSAGE, prepareCompactionBodyHygiene } from "../outbound-payload-hygiene";
import { warnEagerCodexToolCatalog } from "./codex-tool-catalog";
import { compactHandoffRoute, forgetCompactHandoffRoute } from "./compact-handoff-routes";
import {
  bufferCompactResponse,
  refreshNativeMainCompactContext,
  refreshPoolCompactContext,
  resolveAlternateCompactContext,
} from "./compact-context-recovery";
import { runRoutedCompactTurn } from "./compact-routed";

export { COMPACT_RESPONSE_MAX_BYTES } from "./compact-response-body";
export { clearCompactHandoffRoutesForTests } from "./compact-handoff-routes";
export { bufferCompactResponse, compactResponseTooLargeError } from "./compact-context-recovery";

export interface HandleResponsesCompactOptions {
  clientModelLabel?: ClientFacingModelLabel;
  advisorAdmissionPolicy?: import("../../types/admission-policy").CapturedAdmissionPolicy;
  compactionRoutingOverride?: CompactionRoutingOverride | null;
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  /** Release the listener's idle guard only after the complete request body is accepted. */
  onRequestBodyRead?: () => void;
  /**
   * The logical request's send budget (#4546). Compact used to hold its own: the normal send
   * took a fresh transient allowance of three, the 401 replay and the 429 alternate each added
   * one -- and the guard that was supposed to make those two mutually exclusive keys on
   * `kind === "pool"`, so a main-pool credential could spend all five. The recursive handoff
   * child then started over, so one compact could reach ten.
   */
  sendBudget?: RequestExecutionBudget;
}



/**
 * Route one `/v1/responses/compact` request: validate the body (rejecting malformed
 * proxy-owned retained envelopes before routing or credential resolution), select the
 * compact target, and dispatch through the adapter pipeline.
 */
export async function handleResponsesCompact(
  req: Request,
  config: EpxConfig,
  logCtx: RequestLogContext,
  turnAdmissionLease?: AdmissionLease,
  admission?: DataPlaneAdmission,
  options: HandleResponsesCompactOptions = {},
): Promise<Response> {
  options = { ...options, advisorAdmissionPolicy: options.advisorAdmissionPolicy ?? captureAdmissionPolicy(config, admission) };
  let body: unknown;
  try {
    body = await readJsonRequestBody(req, undefined, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses-compact");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Invalid compaction request body");
  }
  const clientModelLabel = options.clientModelLabel ?? clientFacingModelLabel(options.compactionRoutingOverride?.sourceModel ?? (body as { model?: unknown }).model);
  options = { ...options, clientModelLabel };
  // Compaction body `input` is forwarded history, so only the top-level catalog is counted.
  warnEagerCodexToolCatalog(body, req.headers, { surface: "compact", logicalRequest: logCtx });
  if (prepareCompactionBodyHygiene(body, config, logCtx)) return formatErrorResponse(400, "invalid_request_error", OUTBOUND_SECRET_BLOCKED_MESSAGE);
  if (!options.compactionRoutingOverride) {
    options = { ...options, compactionRoutingOverride: applyCompactionRoutingOverride(body, req.headers, config, { endpoint: "compact" }) };
  }
  const raw = body as { model?: unknown; input?: unknown };
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "compaction request requires a model");
  }
  // A malformed proxy-owned envelope is a caller error, so reject it before routing or
  // credential resolution can spend a token refresh on a request that cannot succeed.
  const invalidEnvelope = findInvalidRetainedCompactionEnvelope(raw.input);
  if (invalidEnvelope) return formatErrorResponse(400, "invalid_request_error", invalidEnvelope.message);
  options.onRequestBodyRead?.();
  // Correct the IDENTITY before routing, or the synthetic id does not route at all. Held in
  // a local rather than written back to `raw.model`: assigning to the property widens it out
  // of the `string` narrowing the guard above just established.
  const compactFastRow = parseFastOnlyRowId(config, () => raw.model as string);
  let compactModel = compactFastRow ? compactFastRow.baseId : raw.model;
  if (compactFastRow) (raw as Record<string, unknown>).model = compactModel;
  // The client's own selector, kept for the request log: `raw.model` is rewritten to the
  // base id above, and logCtx.requestedModel is assigned from it further down, so without
  // this the log would lose which id the client actually asked for.
  const compactRequestedModel = options.compactionRoutingOverride?.sourceModel
    ?? (compactFastRow ? compactFastRow.baseId + "--fast" : raw.model);

  // Recall the last completed client-visible bare model after a combo switch (#3891).
  // Configured selectors take precedence over this implicit session hint.
  if (!options.compactionRoutingOverride && typeof compactModel === "string" && !compactModel.includes("/") && !compactFastRow
    && !resolveComboId(config, compactModel)) {
    const recalledComboId = recallComboForLane(config, sessionLaneIdFromRequest(req.headers), compactModel);
    if (recalledComboId) {
      (raw as Record<string, unknown>).model = `combo/${recalledComboId}`;
      // Keep the routed identity in sync: the bare model can 404 outright (no
      // canonical openai provider) or resolve straight onto a native-compact
      // provider, both bypassing combo failover. The combo selector resolves
      // through tryPickComboModel, whose route.combo skips the native compact
      // endpoint.
      compactModel = `combo/${recalledComboId}`;
    }
  }

  let route;
  try {
    // Compact requests route through the same policy evaluation as normal
    // turns, so body-derived evidence (tools/image) must reach the first
    // evaluation too - not only the later handleResponses dispatch.
    // Codex selects a bare native model for compaction even when the operator
    // routes ordinary turns elsewhere (#2901); the compaction-scoped router
    // may land that on the configured default provider instead of 404.
    route = routeCompactionModel(config, compactModel, evidenceFromBody(raw));
    // A compaction override picks the model, not the caller, so the key's scope
    // is applied to what the override resolved to rather than to the selector
    // the client sent.
    // Routed xAI OAuth compaction must preview its Fast wire model here;
    // native compact keeps checking the destination it dispatches directly.
    const callerTier = (raw as Record<string, unknown>).service_tier;
    assertRouteAllowedByScope(resolveAdmissionModelScope(config, admission), clientModelLabel, {
      providerName: route.providerName,
      modelId: previewXaiOauthWireModel({ options: {
        serviceTier: compactFastRow ? "priority" : typeof callerTier === "string" ? callerTier : undefined,
      } }, route, config, "responses"),
    });
  } catch (err) {
    if (err instanceof AdmissionModelDeniedError) return admissionModelDeniedResponse(projectAdmissionModelDeniedLog(err, logCtx));
    if (err instanceof NoEligiblePolicyCandidateError) {
      // Persist the evaluation trace (per-candidate exclusions + the
      // no-eligible reason) so a failed compact policy request stays
      // auditable, matching the other request handlers.
      logCtx.routeDecision = err.trace;
    }
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  const selectedModelId = route.modelId;
  // Derive from the RESOLVED route model, not the caller's raw string. An account-qualified
  // selector like `side/gpt-daybreak-blue-latest` does not match the gated map — `slugsEquivalent`
  // reads the account namespace as a routed provider prefix — so keying on `raw.model` sent
  // exactly the selector form back down the native compact endpoint this guard exists to avoid.
  // `route.modelId` is the same value `applyCodexAccountGatedWireNormalization` uses in core.ts.
  const accountGatedCompactWireModel = isCanonicalOpenAiForwardProvider(route.provider)
    ? codexAccountGatedCanonicalWireModel(selectedModelId) : undefined;
  logCtx.requestedModel = compactRequestedModel;
  logCtx.model = selectedModelId;
  logCtx.routeDecision = route.routeDecision;
  logCtx.policyEligibility = route.policyEligibility;
  logCtx.provider = route.codexAccountNamespace
    ? `${route.providerName}-${route.codexAccountNamespace}`
    : route.providerName;
  logCtx.spendPoolId = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  // #4940, and the same refusal the ordinary Responses path makes in request-prepare.ts. Compact has
  // to repeat it rather than inherit it: the native branch below dispatches straight to
  // `/responses/compact` and only the routed fallback replays through handleResponses, so relying on
  // that one seam would leave the native compact turn forwarding a Reserve model the opt-in has made
  // unservable. Composed from the same three facts, in the same order, as `customReserveForward`
  // further down, and placed before the virtual-model rewrite so it reads the model the caller
  // actually selected -- and before auth, host-circuit admission, or any upstream byte.
  //
  // No terminal-helper or inbound-wire qualifier is needed here the way it is on the ordinary path:
  // this endpoint is the native Codex compaction wire, and a vision/search helper never reaches it.
  if (isCodexReserveOptInMissing(config, selectedModelId, admission)
    && isCanonicalOpenAiForwardProvider(route.provider)) {
    return formatErrorResponse(400, "invalid_request_error", CODEX_RESERVE_OPT_IN_REQUIRED_MESSAGE);
  }
  const virtual = resolveOpenAiCompactModel(route.providerName, selectedModelId);
  if (virtual) {
    route.modelId = virtual.wireModelId;
    captureOpenAiVirtualWirePolicy(route, virtual);
    logCtx.model = virtual.selectedModelId;
    logCtx.resolvedModel = virtual.wireModelId;
    logCtx.wireModel = virtual.wireModelId;
  } else {
    logCtx.resolvedModel = route.modelId;
  }
  if (compactFastRow) {
    // Resolved AFTER the virtual-model rewrite above, and against `route.modelId`, which is
    // now the WIRE model: `resolveOpenAiCompactModel` maps an alias like `gpt-5.6-sol-pro`
    // onto a different wire id, and capability overrides are keyed by exact model id, so
    // deciding before the rewrite could set `priority` on a wire model that does not support
    // it. `capabilityProvider` is passed for the same reason core.ts:2103 passes it.
    const decision = decideTier(
      fastPolicyForModel(
        route.provider,
        route.modelId,
        route.providerName,
        "responses",
        config.providers[route.providerName],
      ),
      config.fastMode,
      "priority",
    );
    // The WHOLE decision: native compact spreads `raw` into the forwarded body, so on a drop
    // a caller's pre-existing service_tier must be REMOVED rather than left to ride along
    // past the suppression.
    const serviceTier = tierValueAfterDecision(decision, "priority");
    if (serviceTier === undefined) delete (raw as Record<string, unknown>).service_tier;
    else (raw as Record<string, unknown>).service_tier = serviceTier;
  }

  // #1686: a bearer-presented admission secret is one of ours, so the stored main credential
  // is substituted below instead of the caller bearer being forwarded.
  // #2132: and only when the route is a native Codex one, which is the only route that can
  // consume that credential. See the longer note in core.ts resolveResponsesCodexAuth.
  const customReserveForward = selectedModelId === NATIVE_RESERVE_MODEL
    && isCodexReserveRequestEligible(config, admission)
    && isCanonicalOpenAiForwardProvider(route.provider);
  const substituteMainCredential = admission?.source === "bearer"
    && (route.codexAccountMode !== undefined || customReserveForward);
  const requestScopedMainCredential = route.codexAccountMode !== undefined
    && !substituteMainCredential
    && hasForwardableCodexBearer(req.headers, config);
  if (route.codexAccountMode === "direct" && !substituteMainCredential) {
    try { validateForwardAdmissionCredential(req.headers, config); }
    catch (err) {
      if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
      throw err;
    }
  }

  // Native /responses/compact exists on the canonical ChatGPT backend and on the
  // official OpenAI API, or a gateway explicitly declaring the native endpoint. Other
  // Responses-shaped gateways still take the routed summarizer path (#422).
  // Combo-resolved targets skip native compact so failover can advance through the
  // combo target list when the picked model returns 429/5xx — the routed path below
  // dispatches through handleResponses → handleComboResponses with full failover.
  //
  // One holder for the WHOLE logical compact, declared above the native branch because the
  // routed fallback below is not a different request: a native attempt that 404s, or a quota
  // failure that hands off, continues here. The routed turn used to call handleResponses with
  // no budget at all, so `handleResponsesInner` minted a fresh four after the native attempt
  // had already spent some of the first one.
  let sendBudget: RequestExecutionBudget = options.sendBudget ?? createInferenceSendBudget(req, logCtx);
  const enteredWithConfiguredSend = sendBudget.explicitSendCeiling !== undefined && sendBudget.used > 0;
  let nativeNotFound: Response | undefined;
  // A manual override onto another backend must not mint ciphertext the conversation model cannot replay.
  const manualOverrideCrossesProvider = options.compactionRoutingOverride
    ? !compactionRoutingKeepsProviderIdentity(config, options.compactionRoutingOverride, route)
    : false;
  if (supportsNativeResponsesCompactEndpoint(route.providerName, route.provider) && !accountGatedCompactWireModel && !route.combo
    && !manualOverrideCrossesProvider) {
    const configuredAttempts = transientRetryPolicyFor(route.provider)?.attempts;
    if (configuredAttempts !== undefined && isCanonicalOpenAiForwardProvider(route.provider)) {
      fundChatGptRetryAttempts(sendBudget, configuredAttempts);
    }
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (configuredAttempts !== undefined) {
      const cappedBudget = capRequestExecutionBudgetSends(sendBudget, configuredAttempts);
      if (!cappedBudget) return formatErrorResponse(429, "request_send_budget_exhausted", new SendBudgetExhaustedError().message);
      sendBudget = cappedBudget;
    }
    const configuredSendBudgetExhausted = () => sendBudget.used >= (sendBudget.explicitSendCeiling ?? Infinity);
    // The enclosing native-compact guard already restricts this path to
    // supported backends, so compact intentionally does not require the
    // regular Responses adapter check here.
    const preAuthCompactHostKey = preAuthUpstreamHostCircuitKey(route, config, {
      requireResponsesAdapter: false,
    });
    let compactHostAdmissionLease: UpstreamHostAdmissionLease | null = null;
    let authCtx: CodexAuthContext = { kind: "main", accountId: null };
    if (preAuthCompactHostKey) {
      const admission = acquireUpstreamHostAdmission(
        preAuthCompactHostKey,
        config.upstreamHostCircuitThreshold,
      );
      if (admission.kind === "blocked") {
        return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
      }
      compactHostAdmissionLease = admission.lease;
    }
    try {
    // Native-capable destination: forward the compact request to its configured backend.
    // Resolve the SAME pool/thread auth context as /v1/responses — forwarding the caller's raw
    // headers would run compaction on the wrong account (or 401) whenever a pool account is
    // active for this thread while normal turns succeed.
    let compactProvider = route.provider;
    let headers = new Headers({ "content-type": "application/json" });
    try {
      if (route.codexAccountMode || customReserveForward) {
        if (route.codexAccountMode) authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
          admission,
          accountId: route.codexAccountId,
          modelId: selectedModelId,
          substituteMainCredentialForDirect: substituteMainCredential,
          requestScopedMainCredential,
          beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
          signal: req.signal,
          nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
          // #4778: the same retention the regular Responses path passes at its final auth. The
          // post-429 guard below only declines to move AFTER this resolution has already bound
          // an account, so without the bit here a quota-driven rebind could have carried the
          // conversation off its issuing account before that guard is ever consulted -- and an
          // uploaded file is readable only by the account that received it. Answered from `raw`,
          // the same object and the same predicate the guard below uses, so the two can never
          // disagree about which conversations are in scope.
          retainAccountForUploadedFiles: conversationCarriesUploadedFiles(raw),
        });
        logCtx.accountLogLabel = codexAuthContextLogLabel(authCtx, config);
        const selected = await materializeCodexUpstreamAuthAsync(req.headers, authCtx, {
          admission,
          config: isCanonicalOpenAiForwardProvider(route.provider) ? config : undefined,
          modelId: selectedModelId,
          beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
          substituteMainCredential,
          signal: req.signal,
          nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
        });
        compactProvider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
        for (const name of FORWARD_HEADERS) {
          const value = selected.get(name);
          if (value !== null) headers.set(name, value);
        }
        const override = (compactProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
        if (override) {
          headers.set("authorization", `Bearer ${override.accessToken}`);
          headers.set("chatgpt-account-id", override.chatgptAccountId);
        }
      }
    } catch (err) {
      if (req.signal.aborted) {
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const response = mapCodexAuthContextErrorToResponse(err, {
        accountSelector: route.codexAccountNamespace,
        now: Date.now(),
      });
      if (response) return response;
      throw err;
    }
    const base = isCanonicalOpenAiForwardProvider(compactProvider)
      ? CODEX_FORWARD_BASE_URL
      : (compactProvider.baseUrl ?? "").replace(/\/+$/, "");
    if (compactProvider.authMode !== "forward" && (compactProvider.apiKey || compactProvider.apiKeyPool?.length)) {
      // Native compact never enters handleResponses, so it needs its own pre-dispatch key
      // pick. Kept inside this branch on purpose: the overlay above owns the forward and
      // codexAccountMode cases, and the picker returns null for them anyway.
      // Transport variant, for the same reason as the Responses core: the persisted row has no
      // registry backfills, and compactProvider is read for its transport fields below.
      let warmKeyProvider;
      const affinityLane = affinityLaneFromRequest(req, logCtx, config, admission);
      if (affinityLane) logCtx.affinityLane = affinityLane;
      try { warmKeyProvider = selectProactiveApiKeyTransport(config, route.providerName, compactProvider, undefined, Date.now(), { lane: affinityLane, model: route.modelId, log: logCtx }); }
      catch (error) {
        const refusal = requestPacingOverloadResponse(error);
        if (refusal) { logCtx.terminalSource = "synthetic"; return refusal; }
        if (error instanceof ProviderApiKeyPausedError) {
          logCtx.terminalSource = "synthetic";
          return formatErrorResponse(403, "permission_error", error.message);
        }
        throw error;
      }
      if (warmKeyProvider?.apiKey) compactProvider = warmKeyProvider;
      if (compactProvider.apiKey) {
        headers.set("authorization", `Bearer ${resolveProviderApiKey(compactProvider.apiKey)}`);
        stampApiKeyAccountLabel(logCtx, route.providerName, compactProvider);
      }
    }
    if (compactProvider.authMode !== "forward" && isProviderApiKeyPaused(compactProvider)) {
      return formatErrorResponse(403, "permission_error", new ProviderApiKeyPausedError().message);
    }
    const { reasoning: _reasoning, ...compactBodyRaw } = raw as typeof raw & { reasoning?: unknown };
    const requireCompactPlaintextReasoning = !isOpenAiOperatedResponsesDestination(compactProvider)
      && requiresPlaintextReasoningReplay(compactProvider);
    // The regular /v1/responses path applies sanitizeReasoningInputContent via the adapter's
    // buildRequest, but the compact endpoint forwards directly. Apply the same sanitizer here
    // so canonical reasoning stays blank and custom gateways honor their explicit plaintext policy.
    // #5095: the compact endpoint forwards `raw` directly, so it needs the same legacy dotted
    // call-name repair the adapter applies. A damaged item here refuses the compaction itself,
    // which is the request a long task depends on to keep going.
    // Direct compact bypasses the adapter's Google replay projection (#7111).
    const compactBody = repairLegacyDottedToolCallNames(
      stripProviderInputItemMetadata(sanitizeReasoningInputContent(compactBodyRaw, {
        preserveRawReasoningContent: !isOpenAiOperatedResponsesDestination(compactProvider)
          && compactProvider.preserveResponsesReasoningContent === true,
        dropNullContentChannel: !isOpenAiOperatedResponsesDestination(compactProvider),
        stripEncryptedContent: requireCompactPlaintextReasoning,
        requirePlaintextReasoning: requireCompactPlaintextReasoning,
      })),
    ) as typeof compactBodyRaw;
    {
      const binding = conversationStateBindingFromAuth(authCtx, codexPoolAffinityKey(req.headers));
      if (binding) {
        // Refused rather than scrubbed: an uploaded file is content the caller attached, not
        // continuation state the turn can do without.
        const refusal = accountChangeFileReferenceRefusal({
          body: raw,
          bindingKey: binding.bindingKey,
          servingAccountId: binding.accountId,
        });
        if (refusal) return refusal;
        applyAccountChangeConversationStateScrub({
          body: raw,
          headers,
          bindingKey: binding.bindingKey,
          servingAccountId: binding.accountId,
          logCtx,
        });
        applyAccountChangeConversationStateScrub({
          body: compactBody,
          bindingKey: binding.bindingKey,
          servingAccountId: binding.accountId,
          logCtx,
        });
      }
    }
    // Gateway protocol capability never grants official credential authority. Reuse the normal
    // Responses transport for custom paths, static auth and explicitly forwarded client metadata.
    const gatewayTransport = !isCanonicalOpenAiForwardProvider(compactProvider)
      && compactProvider.supportsNativeCompactEndpoint === true
      ? buildResponsesTransport({ ...compactProvider, apiKey: compactProvider.apiKey ? resolveProviderApiKey(compactProvider.apiKey) : undefined }, { headers: req.headers })
      : undefined;
    if (gatewayTransport) {
      headers = new Headers(gatewayTransport.headers);
      const binding = conversationStateBindingFromAuth(authCtx, codexPoolAffinityKey(req.headers));
      if (binding) applyAccountChangeConversationStateScrub({ body: compactBody, headers, bindingKey: binding.bindingKey, servingAccountId: binding.accountId, logCtx });
    }
    // Native v1 bypasses the adapter serializer. Bind the same replay provenance as ordinary
    // turns, but leave canonical compact's established account-state handling unchanged.
    const gatewayReplayParsed = gatewayTransport ? parseRequest(raw) : undefined;
    if (gatewayReplayParsed) {
      gatewayReplayParsed.modelId = route.modelId;
      gatewayReplayParsed._clientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
      const clientThreadId = reasoningReplayConversationIdFromResponsesRequest({
        clientThreadId: gatewayReplayParsed._clientThreadId,
        threadIdHeader: req.headers.get("thread-id"),
        cursorConversationId: gatewayReplayParsed._cursorConversationId,
        sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
      });
      if (clientThreadId) {
        gatewayReplayParsed._reasoningReplayScope = {
          clientThreadId,
          clientPrincipalId: resolveContextPrincipal(req, config, admission),
        };
      }
    }
    let compactUrl = gatewayTransport ? `${gatewayTransport.url.replace(/\/+$/, "")}/compact` : `${base}/responses/compact`;
    const compactTargetKey = `${route.providerName}|${route.modelId}|compact`;
    let actualCompactHostKey = upstreamHostHealthKey(
      route.providerName,
      safeOriginLabel(compactUrl),
    );
    const compactHostKey = compactProvider.authMode === "forward"
      ? actualCompactHostKey
      : null;
    const compactHostCircuitEnabled = compactHostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (compactHostKey !== null && !compactHostCircuitEnabled) {
      disableUpstreamHostCircuitForKey(actualCompactHostKey);
    }
    if (compactHostAdmissionLease && compactHostAdmissionLease.key !== compactHostKey) {
      releaseCodexAuthContextProbeLease(authCtx);
      return formatErrorResponse(502, "upstream_error", "Provider host changed after circuit admission");
    }
    if (req.signal.aborted) {
      releaseCodexAuthContextProbeLease(authCtx);
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (!compactHostAdmissionLease && compactHostCircuitEnabled) {
      const admission = acquireUpstreamHostAdmission(
        compactHostKey!,
        config.upstreamHostCircuitThreshold,
      );
      if (admission.kind === "blocked") {
        releaseCodexAuthContextProbeLease(authCtx);
        return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
      }
      compactHostAdmissionLease = admission.lease;
    }
    const settleObservedCompactHostResponse = (): void => {
      if (compactHostCircuitEnabled) {
        resetUpstreamHostHealth(actualCompactHostKey, compactHostAdmissionLease);
      } else {
        resetUpstreamHostHealth(actualCompactHostKey);
      }
      compactHostAdmissionLease = null;
    };
    const connectMs = () => resolveConnectTimeoutMs(config.connectTimeoutMs, { localUpstream: isLocalUpstream(compactUrl) });
    const applyCompactPoolQuotaHeaders = async (ctx: CodexAuthContext, response: Response) => {
      if (ctx.kind !== "pool" && ctx.kind !== "main-pool") return;
      const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/quota");
      applyAccountQuotaFromUpstreamHeaders(ctx.accountId, response.headers, ctx.writerGeneration,
        ctx.kind === "main-pool" ? ctx.mainQuotaWriter : undefined,
        { modelId: route.modelId, poolWriter: ctx.kind === "pool" ? ctx.poolQuotaWriter : undefined,
          poolResponse: ctx.kind === "pool" });
    };
    // Takes its context explicitly: the alternate-account flow below records a rejection
    // against A while promoting B, then records B's own outcome. A closure over a single
    // `authCtx` cannot express either.
    const recordCompactPoolOutcome = (
      ctx: CodexAuthContext,
      outcome: CodexUpstreamOutcome,
      meta: {
        retryAfter?: string | null;
        resetAt?: unknown | unknown[];
        promoteAccountId?: string;
      } = {},
    ) => {
      // A gateway response is not evidence about any Codex account.
      if (gatewayTransport) return;
      if ((outcome === 401 || outcome === 403) && upstream && wasPermanentAccountRefusal(upstream)) return;
      if (!usesCodexForwardPoolAuth(ctx, route.provider)) {
        if (isKeyedRequestOwnedMain(ctx) && typeof outcome === "number" && (!upstream || !isNonReplayableResponse(upstream)) && isCanonicalOpenAiForwardProvider(route.provider)) releaseRequestOwnedMainOnOutcome(ctx, outcome, selectedModelId);
        return;
      }
      recordCodexUpstreamOutcome(config, ctx.accountId, outcome, {
        ...meta,
        ...codexFailureWindowOutcomeMeta(ctx),
        threadId: ctx.kind === "pool" || ctx.kind === "main-pool" ? ctx.affinityKey : undefined,
        fixedAccount: ctx.fixedAccount,
        modelId: selectedModelId,
        probeLeaseId: codexProbeLeaseId(ctx),
        // Fence a stored pool account's outcome on the credential the request was
        // holding, so a 401 that lost a race with re-authentication cannot retire the
        // replacement (#2887). Also covers the replay's own second 401.
        ...(ctx.kind === "pool" ? { credentialGeneration: ctx.generation } : {}),
        probeQuotaScope: codexProbeQuotaScope(ctx),
        transientProbe: codexTransientProbeGrant(ctx),
        writerGeneration: ctx.kind === "pool" || ctx.kind === "main-pool"
          ? ctx.writerGeneration
          : undefined,
      });
    };
    // Two recovery modes, mirroring retryCodexPoolOnAlternateAccount() on the regular
    // path (core.ts:396). The first account keeps the full ladder — transient-5xx retry
    // wrapping reset retry — because those retries happen before any alternate is even
    // considered. The alternate is one bounded send: a second ladder would multiply the
    // work an already-rejecting pool is doing.
    //
    // Both modes now draw one shared budget. The comment below used to say the 401 replay
    // spends the account budget so the 429 alternate is skipped, but that guard is keyed on
    // `kind === "pool"` and a main-pool credential left it false -- so 401 then 429 really did
    // reach five. The single sends spend the base allowance first and then the one shared
    // final-recovery reserve, which is the same rule the Responses path follows.
    const spendTarget = () => ({ poolId: logCtx.spendPoolId ?? route.providerName, identityId: logCtx.accountLogLabel });
    const readCompactRetryBody = (upstream: Response, signal?: AbortSignal) =>
      readCompactResponseBytes(upstream, signal, config.stallTimeoutSec);
    const retainCompactRetryResponse = (response: Response) =>
      retainPacedRetryResponse(response, req.signal, readCompactRetryBody);
    const sendCompactAttempt = (
      sendProvider: EpxProviderConfig,
      sendHeaders: Headers,
      recovery: "normal" | "single",
      sendAuthCtx: CodexAuthContext,
      receipt?: { recovery?: AttemptRecoveryKind; onDispatch?: () => void },
    ): Promise<Response> => {
      // Only the captured custom-tool contract: native compact keeps the provider's own wire.
      sendProvider = projectCapturedCustomToolPolicy(sendProvider, route.staticPolicy);
      // A gateway send carries only its own transport headers, whatever recovery handed in.
      // An account-change scrub that removed the turn state from the send headers still applies.
      let wireHeaders = gatewayTransport ? new Headers(gatewayTransport.headers) : sendHeaders;
      if (gatewayTransport && !sendHeaders.has("x-codex-turn-state")) wireHeaders.delete("x-codex-turn-state");
      sendHeaders = wireHeaders;
      const buildCompactSendBody = () => {
        if (gatewayReplayParsed) bindRouteReasoningReplayScope({
          parsed: gatewayReplayParsed, providerName: route.providerName, provider: sendProvider,
          adapterName: sendProvider.adapter, codexAuthContext: sendAuthCtx, forwardHeaders: wireHeaders,
        });
        const requireSendPlaintextReasoning = !isOpenAiOperatedResponsesDestination(sendProvider)
          && requiresPlaintextReasoningReplay(sendProvider);
        // #8042: `epx1:`/`epx2:` are EasyProxy's own transparent envelopes, which no upstream can
        // decode, so canonical and official sends must lower them like ordinary turns do. `false`
        // leaves native blobs to the account-change scrub that already owns them on this path.
        let replayBody = gatewayReplayParsed ? sanitizeReasoningInputContent(scrubEpxCompactionItems(
          compactBody, destinationDecodesNativeCompactionBlob(sendProvider),
          gatewayReplayParsed._stripReasoningEncryptedContent === true,
        ), {
          preserveRawReasoningContent: !isOpenAiOperatedResponsesDestination(sendProvider)
            && sendProvider.preserveResponsesReasoningContent === true,
          dropNullContentChannel: !isOpenAiOperatedResponsesDestination(sendProvider),
          stripEncryptedContent: gatewayReplayParsed._stripReasoningEncryptedContent === true || requireSendPlaintextReasoning,
          dropForeignItemId: gatewayReplayParsed._dropForeignReasoningItemIds === true,
          requirePlaintextReasoning: requireSendPlaintextReasoning,
        }) : scrubEpxCompactionItems(compactBody, destinationDecodesNativeCompactionBlob(sendProvider), false) as typeof compactBody;
        if (!isOpenAiOperatedResponsesDestination(sendProvider) && sendProvider.dropResponsesReasoningItems === true) {
          replayBody = dropResponsesReasoningInputItems(replayBody) as typeof replayBody;
        }
        if (!isOpenAiOperatedResponsesDestination(sendProvider) && sendProvider.preserveResponsesMessageMetadata !== true) {
          replayBody = stripInternalChatMessageMetadataPassthrough(replayBody) as typeof replayBody;
        }
        if (sendAuthCtx.kind === "pool" && isCanonicalOpenAiForwardProvider(sendProvider)) {
          replayBody = isolateCodexPoolClientMetadata(replayBody, sendAuthCtx.chatgptAccountId) as typeof replayBody;
        }
        // A queued key selection can refresh the destination; project only for this send.
        replayBody = isOpenAiOperatedResponsesDestination(sendProvider)
          ? repairUrlCitationAnnotations(replayBody) : stripCanonicalOnlyInputItems(stripCanonicalOnlyTopLevelFields(replayBody));
        // Only an explicit `false` lowers custom tools here; with no declaration, native compact
        // forwards every custom tool and its history exactly as before this capability existed.
        if (sendProvider.supportsResponsesCustomTools === false && !isCanonicalOpenAiForwardProvider(sendProvider)) {
          replayBody = rewriteRoutedCustomToolsForUpstream(
            replayBody, sendProvider.supportsResponsesCustomTools,
          ).body as typeof replayBody;
          validateFinalCustomToolCompatibility(replayBody, sendProvider.supportsResponsesCustomTools);
        }
        return replayBody;
      };
      const doFetch = (upstreamRecovery?: UpstreamSendRecovery) => fetchWithHeaderTimeout(
        compactUrl,
        applyUpstreamRecoveryInit({
          method: "POST",
          headers: wireHeaders,
          body: JSON.stringify({ ...buildCompactSendBody() as typeof compactBody, model: route.modelId }),
        }, upstreamRecovery),
        req.signal,
        // Keyed sends can refresh their destination after pacing. Their physical send below
        // owns the header clock; the outer wrapper owns pacing and client cancellation only.
        sendProvider.authMode !== "forward" && sendProvider.apiKey ? 0 : connectMs(),
        false,
        providerFetch(sendProvider, undefined, {
          providerName: route.providerName,
          modelId: route.modelId,
          accountAutoPause: (name, provider, headers) => captureAccountAutoPauseAttempt(name, provider, { config, codex: sendAuthCtx }, headers),
          beforeDispatch: isCanonicalOpenAiForwardProvider(sendProvider)
            ? createCodexAuthDispatchGuard(sendAuthCtx, config, selectedModelId, admission) : undefined,
          dispatchOverride: sendProvider.authMode !== "forward" && sendProvider.apiKey
            ? async (_input, init, execute, reacquirePacing) => {
              for (let attempt = 0; !providerApiKeySelectionIsCurrent(config, route.providerName, sendProvider); attempt++) {
                if (!providerAffinityGenerationIsCurrent(config, route.providerName, sendProvider)) throw new Error("Provider affinity selection is no longer available");
                if (attempt >= 3) throw new Error("Provider key selection changed repeatedly before compact dispatch");
                let current = resolveCurrentProviderApiKeyTransport(config, route.providerName, sendProvider);
                if (!current && sendProvider.requestPacing?.enabled
                  && (sendProvider.requestPacing.keys || sendProvider.requestPacing.keySelection === "round-robin")) {
                  const fresh = resolveCurrentProviderApiKeyTransport(config, route.providerName, { ...sendProvider, _apiKeyAttempt: undefined });
                  if (fresh) current = selectProactiveApiKeyTransport(config, route.providerName, fresh) ?? fresh;
                }
                if (!current?.apiKey || !supportsNativeResponsesCompactEndpoint(route.providerName, current)) {
                  if (!current?.apiKey && isProviderApiKeyPaused(config.providers[route.providerName])) throw new ProviderApiKeyPausedError();
                  throw new Error("Provider key selection is no longer available for compact");
                }
                current = projectCapturedCustomToolPolicy(current, route.staticPolicy);
                const rebuilt = new Headers(sendHeaders);
                for (const name of Object.keys(sendProvider.headers ?? {})) rebuilt.delete(name);
                for (const [name, value] of Object.entries(current.headers ?? {})) rebuilt.set(name, value);
                rebuilt.set("authorization", `Bearer ${resolveProviderApiKey(current.apiKey)}`);
                const currentGateway = gatewayTransport
                  ? buildResponsesTransport({ ...current, apiKey: resolveProviderApiKey(current.apiKey) }, { headers: req.headers })
                  : undefined;
                sendHeaders = wireHeaders = headers = currentGateway ? new Headers(currentGateway.headers) : rebuilt;
                sendProvider = compactProvider = current;
                compactUrl = currentGateway ? `${currentGateway.url.replace(/\/+$/, "")}/compact`
                  : `${(current.baseUrl ?? "").replace(/\/+$/, "")}/responses/compact`;
                actualCompactHostKey = upstreamHostHealthKey(route.providerName, safeOriginLabel(compactUrl));
                if (current.requestPacing?.enabled
                  && (current.requestPacing.keys || current.requestPacing.keySelection === "round-robin")) {
                  if (!reacquirePacing) throw new Error("Refreshed compact dispatch requires pacing readmission");
                  await reacquirePacing(current, route.modelId);
                }
              }
              if (req.signal.aborted) throw req.signal.reason;
              stampApiKeyAccountLabel(logCtx, route.providerName, sendProvider);
              if (!rebindPhysicalSend(sendBudget, { poolId: logCtx.spendPoolId ?? route.providerName,
                identityId: logCtx.accountLogLabel })) throw new SendBudgetExhaustedError(errorDestinationLabel(compactUrl));
              const physicalFetch = ((input, physicalInit) => sendWithConnectionPolicy(
                passiveKeyPhysicalFetch(distributedKeyPhysicalFetch((sendProvider as { fetch?: typeof fetch }).fetch ?? execute, route.providerName, sendProvider, compactUrl), config, route.providerName, sendProvider), String(input),
                physicalInit, { providerName: route.providerName, provider: sendProvider })) as typeof fetch;
              return fetchWithHeaderTimeout(compactUrl,
                { ...init, headers: sendHeaders, body: JSON.stringify({ ...buildCompactSendBody() as typeof compactBody, model: route.modelId }) },
                init.signal ?? req.signal, connectMs(), false, physicalFetch);
            } : undefined,
          onPhysicalDispatch: () => { noteCredentialAttemptSend(logCtx, route, sendProvider, receipt?.recovery ?? upstreamRecovery); receipt?.onDispatch?.(); },
        }),
        // Every credential-bearing forward send gets manual redirects, not only
        // pool sends: direct mode carries the caller's credential too (#914).
        sendProvider.authMode === "forward",
      ).then(res => {
        // Every real attempt response — including an intermediate 5xx the retry
        // wrapper replaces — proves the host was reached (#914 review).
        settleObservedCompactHostResponse();
        return res;
      });
      if (recovery === "single") return sendSingleCompactRecovery(sendBudget, spendTarget, compactTargetKey, errorDestinationLabel(compactUrl), doFetch);
      const reporter = createPhysicalSendReporter(sendBudget, spendTarget);
      const beforeSend = reporter.beforeSend;
      if (enteredWithConfiguredSend && beforeSend) reporter.beforeSend = () => beforeSend(true);
      return fetchWithTransientRetry(doFetch, {
          abortSignal: req.signal,
          label: safeHostLabel(compactUrl), destination: errorDestinationLabel(compactUrl),
          // Key auth and opted-in canonical ChatGPT use the configured logical-request total,
          // intersected with the shared base remainder as in ordinary Responses.
          attempts: sendBudget.remainingBaseSends(transientSendCapFor(
            transientRetryPolicyFor(sendProvider)?.attempts, sendBudget.used,
          )),
          reserveRetrySpend: () => sendBudget.explicitSendCeiling !== undefined && sendBudget.spendEnforced === true,
          readRetryResponseBody: readCompactRetryBody,
          onSendsConsumed: reporter,
        });
    };

    // The account each outcome belongs to. Reassigned only when the alternate send below
    // actually happens, so every recorder call names the context that produced it.
    let outcomeCtx = authCtx;
    const localDispatchRefusal = (error: unknown): Response | undefined => {
      const cause = unwrapUpstreamRetryEvidenceError(error);
      const response = (cause instanceof RoutedCustomToolCompatError
        ? formatErrorResponse(400, "invalid_request_error", redactSecretString(cause.message))
        : cause instanceof InvalidRetainedCompactionEnvelopeError
        ? formatErrorResponse(400, "invalid_request_error", cause.message)
        : cause instanceof ProviderApiKeyPausedError ? formatErrorResponse(403, "permission_error", cause.message) : undefined)
        ?? requestPacingOverloadResponse(cause) ?? spendLedgerStorageErrorResponse(error, logCtx) ?? (cause instanceof SendBudgetExhaustedError
        ? unboundPoolSpendRefusalResponse(logCtx) ?? formatErrorResponse(429, "request_send_budget_exhausted", cause.message)
        : mapCodexAuthContextErrorToResponse(cause, {
          now: Date.now(), accountSelector: route.codexAccountNamespace,
        }));
      if (response) {
        logCtx.terminalSource = "synthetic";
        releaseUpstreamHostAdmission(compactHostAdmissionLease);
        compactHostAdmissionLease = null;
        releaseCodexAuthContextProbeLease(outcomeCtx);
      }
      return response;
    };
    let upstream: Response;
    let storedPool401ReplayAttempted = false;
    try {
      // Same connect timeout + keep-alive reset + transient-5xx recovery as /v1/responses —
      // compact hits the same ChatGPT host and must soft-avoid / clear affinity (#186).
      upstream = await sendCompactAttempt(compactProvider, headers, "normal", authCtx);
    } catch (err) {
      if (req.signal.aborted) {
        recordCompactPoolOutcome(outcomeCtx, 499);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const localRefusal = localDispatchRefusal(err);
      if (localRefusal) return localRefusal;
      const outcome = classifyTransportFailureKind(err);
      // Host-level evidence stands regardless of pool membership (#914 review).
      if (outcome === "connect_neutral") {
        if (compactHostCircuitEnabled) {
          recordUpstreamHostFailure(actualCompactHostKey, {
            code: transportErrorCode(err),
            threshold: config.upstreamHostCircuitThreshold,
            lease: compactHostAdmissionLease,
          });
        } else {
          recordUpstreamHostFailure(actualCompactHostKey, { code: transportErrorCode(err) });
        }
      } else {
        releaseUpstreamHostAdmission(compactHostAdmissionLease);
      }
      compactHostAdmissionLease = null;
      recordCompactPoolOutcome(outcomeCtx, outcome);
      return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
    }

    recordDistributedResponseFailure(upstream, config, route.providerName, req.signal);
    const preserveConfiguredRefusal = sendBudget.explicitSendCeiling !== undefined && sendBudget.spendEnforced === true;
    let pool401OutcomeSettled = false;
    if (
      upstream.status === 401 && !wasPermanentAccountRefusal(upstream)
      && (authCtx.kind === "main-pool" || authCtx.kind === "pool")
      && !gatewayTransport
      && usesCodexForwardPoolAuth(authCtx, compactProvider)
      && !req.signal.aborted
    ) {
      const canReplay = !configuredSendBudgetExhausted();
      if (canReplay) sealCredentialRefusal(logCtx, upstream.status, "oauth-401"); // An unaffordable replay keeps the 401 final.
      if (canReplay && !preserveConfiguredRefusal) await upstream.body?.cancel().catch(() => undefined);
      if (canReplay && preserveConfiguredRefusal) upstream = await retainCompactRetryResponse(upstream);
      const poolAuthCtx = authCtx.kind === "pool" ? authCtx : undefined;
      storedPool401ReplayAttempted = poolAuthCtx !== undefined;
      const poolReplay = poolAuthCtx
        ? await refreshPoolCompactContext({
          req,
          admission,
          config,
          modelId: selectedModelId,
          authCtx: poolAuthCtx,
          provider: compactProvider,
          codexAccountMode: route.codexAccountMode,
          codexAccountNamespace: route.codexAccountNamespace,
          substituteMainCredential,
          options,
        })
        : undefined;
      const replay = poolReplay
        ?? await refreshNativeMainCompactContext({
          req,
          admission,
          config,
          modelId: selectedModelId,
          authCtx,
          provider: compactProvider,
          codexAccountMode: route.codexAccountMode,
          substituteMainCredential,
          options,
        });
      if (poolAuthCtx && poolReplay && !poolReplay.ok && poolReplay.quarantine) {
        // A transient refresh failure must not retire the account; only a dead grant
        // does, and only while the rejected credential is still the stored one (#2887).
        recordCodexUpstreamOutcome(config, poolAuthCtx.accountId, 401, {
          threadId: poolAuthCtx.affinityKey,
          fixedAccount: poolAuthCtx.fixedAccount,
          modelId: selectedModelId,
          writerGeneration: poolAuthCtx.writerGeneration,
          credentialGeneration: poolReplay.quarantineGeneration ?? poolAuthCtx.generation,
        });
      }
      if (!canReplay) {
        if (!replay.ok) await replay.response.body?.cancel().catch(() => undefined);
        if (req.signal.aborted) {
          await upstream.body?.cancel().catch(() => undefined);
          return clientCancelledResponse();
        }
        pool401OutcomeSettled = true;
      } else if (!replay.ok) {
        if (preserveConfiguredRefusal) await upstream.body?.cancel().catch(() => undefined);
        if (!poolAuthCtx) recordCompactPoolOutcome(outcomeCtx, replay.response.status === 401 ? 401 : "connect_neutral");
        return replay.response;
      } else {
        const rejectedAuthCtx = authCtx;
        const rejectedLabel = logCtx.accountLogLabel;
        const rejected = upstream;
        authCtx = replay.authCtx;
        outcomeCtx = replay.authCtx;
        compactProvider = replay.provider;
        headers = replay.headers;
        const replayBinding = conversationStateBindingFromAuth(replay.authCtx, codexPoolAffinityKey(req.headers));
        if (replayBinding) applyAccountChangeConversationStateScrub({ body: compactBody, headers, bindingKey: replayBinding.bindingKey, servingAccountId: replayBinding.accountId, logCtx });
        logCtx.accountLogLabel = codexAuthContextLogLabel(replay.authCtx, config);
        try {
          upstream = await sendCompactAttempt(compactProvider, headers, "single", authCtx, { recovery: "oauth-401" });
          if (preserveConfiguredRefusal) await rejected.body?.cancel().catch(() => undefined);
        } catch (err) {
          if (req.signal.aborted) {
            recordCompactPoolOutcome(outcomeCtx, 499);
            return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
          }
          if (preserveConfiguredRefusal && err instanceof SendBudgetExhaustedError) {
            releaseCodexAuthContextProbeLease(authCtx);
            authCtx = outcomeCtx = rejectedAuthCtx;
            logCtx.accountLogLabel = rejectedLabel;
            pool401OutcomeSettled = true;
          } else {
            if (preserveConfiguredRefusal) await rejected.body?.cancel().catch(() => undefined);
            const localRefusal = localDispatchRefusal(err);
            if (localRefusal) return localRefusal;
            recordCompactPoolOutcome(outcomeCtx, classifyTransportFailureKind(err));
            return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
          }
        }
      }
    }

    // The settle for an alternate send that threw, shared by the quota and transient moves. By the
    // time it runs the request already names the alternate (outcomeCtx), so health goes to it.
    const failedAlternateCompactSend = (err: unknown): Response => {
      if (req.signal.aborted) {
        recordCompactPoolOutcome(outcomeCtx, 499);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const localRefusal = localDispatchRefusal(err);
      if (localRefusal) return localRefusal;
      const outcome = classifyTransportFailureKind(err);
      // Host-level evidence stands regardless of pool membership (#914 review).
      if (outcome === "connect_neutral") {
        if (compactHostCircuitEnabled) {
          recordUpstreamHostFailure(actualCompactHostKey, {
            code: transportErrorCode(err),
            threshold: config.upstreamHostCircuitThreshold,
            lease: compactHostAdmissionLease,
          });
        } else {
          recordUpstreamHostFailure(actualCompactHostKey, { code: transportErrorCode(err) });
        }
      } else {
        releaseUpstreamHostAdmission(compactHostAdmissionLease);
      }
      compactHostAdmissionLease = null;
      recordCompactPoolOutcome(outcomeCtx, outcome);
      return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
    };
    const scrubCompactStateForAlternate = (alternateAuthCtx: CodexAuthContext, alternateHeaders: Headers): void => {
      const affinityKey = compactAlternateAffinityKey(authCtx, () => codexPoolAffinityKey(req.headers))
        ?? codexPoolAffinityKey(req.headers);
      const priorAccountId = conversationStateAccountId(authCtx);
      // An unkeyed caller-owned main alternate has no binding of its own, but moving off the issuing
      // account still makes the carried state foreign. Scrub for this request only; nothing persists.
      const binding = conversationStateBindingFromAuth(alternateAuthCtx, affinityKey)
        ?? (alternateAuthCtx.kind === "main" && priorAccountId && affinityKey
          ? { bindingKey: affinityKey, accountId: priorAccountId === MAIN_CODEX_ACCOUNT_ID ? "__caller_main__" : MAIN_CODEX_ACCOUNT_ID }
          : null);
      if (!binding) return;
      for (const body of [raw, compactBody]) {
        applyAccountChangeConversationStateScrub({
          body,
          headers: alternateHeaders,
          bindingKey: binding.bindingKey,
          servingAccountId: binding.accountId,
          priorAccountId: conversationStateAccountId(authCtx),
          logCtx,
        });
      }
    };

    // Bounded same-request alternate: the regular /v1/responses path already does this
    // (core.ts:319-423) and recognizes exactly 429/402. Without it a pool rejection
    // surfaces to the client, which retries the compact task OUTSIDE the logical request
    // — reporting exhausted retries while another pool account sat idle (#913).
    if (
      (upstream.status === 429 || upstream.status === 402 || wasAccountAutoPaused(upstream))
      && !configuredSendBudgetExhausted()
      // A replay refusal this proxy synthesized carries 429 for the client's benefit only.
      // It is not pool quota evidence, and the alternate account below is another send of a
      // compact turn that may already have been processed.
      && !isNonReplayableResponse(upstream)
      && (!storedPool401ReplayAttempted || wasAccountAutoPaused(upstream))
      && !gatewayTransport
      && usesCodexForwardPoolAuth(authCtx, route.provider)
      && !authCtx.fixedAccount
      && route.codexAccountMode
      && !req.signal.aborted
    ) {
      const recovery = upstream.status === 402 ? "oauth-account-402" : upstream.status === 403 ? "oauth-account-403" : "oauth-account-429";
      sealCredentialRefusal(logCtx, upstream.status, recovery);
      const firstRetryAfter = upstream.headers.get("retry-after");
      const firstResetAt = [
        upstream.headers.get("x-codex-primary-reset-at"),
        upstream.headers.get("x-codex-secondary-reset-at"),
        upstream.headers.get("x-codex-tertiary-reset-at"),
      ].filter(Boolean);
      // Build the alternate COMPLETELY before cancelling the first body: if construction
      // throws, the first rejection is still intact and can be returned to the client.
      // The same reasoning refuses an uploaded-file move here: no alternate can read a file the
      // issuing account received, so which one is chosen is irrelevant and asking before the
      // resolution costs nothing. It also reuses the guarantee the comment above depends on --
      // the first body is still uncancelled -- so the client gets the original rejection rather
      // than an inaccessible-file error from account B (#4710).
      const alternate = conversationCarriesUploadedFiles(raw)
        ? undefined
        : await resolveAlternateCompactContext({
          req,
          admission,
          config,
          route,
          selectedModelId,
          excludeAccountId: authCtx.accountId,
          turnAdmissionLease,
        });
      if (alternate && "failure" in alternate) {
        await applyCompactPoolQuotaHeaders(authCtx, upstream);
        recordCompactPoolOutcome(authCtx, upstream.status, { retryAfter: firstRetryAfter, resetAt: firstResetAt });
        await upstream.body?.cancel().catch(() => undefined);
        return alternate.failure;
      }
      // Resolution can await a credential refresh, so the client may have gone away
      // while we were choosing B. Re-check before spending anything: recording A,
      // cancelling its body, and sending B are all observable side effects, and B's
      // quota is not ours to spend on a request nobody is waiting for.
      if (alternate && req.signal.aborted) {
        releaseCodexAuthContextProbeLease(alternate.authCtx);
        recordCompactPoolOutcome(outcomeCtx, 499);
        void upstream.body?.cancel(req.signal.reason).catch(() => undefined);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      // The same scope binding the regular path applies: an organization-scoped
      // exhaustion refuses every credential in that workspace, so a proven
      // same-workspace alternate pays a cold prompt prefix for no new capacity.
      // Suppression is not silence — the buffered recorder below still attributes
      // the 429/402 to the account that produced it.
      const sharedWorkspaceScope = alternate != null
        && !await shouldRetryCodexScopedQuotaOnAlternate(
          upstream,
          authCtx.chatgptAccountId,
          alternate.authCtx.kind === "pool" || alternate.authCtx.kind === "main-pool"
            ? alternate.authCtx.chatgptAccountId
            : callerCodexWorkspaceAccountId(req.headers),
          req.signal,
        );
      // The scope check reads the rejection body asynchronously — the same window the
      // comment above covers. Re-check before the branch below records A, cancels its
      // body, and sends B for a caller that is gone.
      if (alternate && req.signal.aborted) {
        releaseCodexAuthContextProbeLease(alternate.authCtx);
        recordCompactPoolOutcome(outcomeCtx, 499);
        void upstream.body?.cancel(req.signal.reason).catch(() => undefined);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      if (alternate && sharedWorkspaceScope) {
        releaseCodexAuthContextProbeLease(alternate.authCtx);
      }
      if (alternate && !sharedWorkspaceScope) {
        // Same order the regular path uses (core.ts:349-357): a 429/402 carries the
        // quota snapshot that produced it, so refresh A's cache before recording its
        // rejection. Skipping this leaves quota-strategy routing and the dashboard
        // reading numbers from before the account ran out.
        if (preserveConfiguredRefusal) upstream = await retainCompactRetryResponse(upstream);
        const rejected = upstream;
        const rejectedLabel = logCtx.accountLogLabel;
        const recordMove = async () => {
          await applyCompactPoolQuotaHeaders(authCtx, rejected);
          recordCompactPoolOutcome(authCtx, rejected.status, {
            retryAfter: firstRetryAfter,
            resetAt: firstResetAt,
            ...(alternate.authCtx.accountId ? { promoteAccountId: alternate.authCtx.accountId } : {}),
          });
          await rejected.body?.cancel().catch(() => undefined);
          outcomeCtx = alternate.authCtx;
        };
        if (!preserveConfiguredRefusal) await recordMove();
        logCtx.accountLogLabel = codexAuthContextLogLabel(alternate.authCtx, config);
        scrubCompactStateForAlternate(alternate.authCtx, alternate.headers);
        try {
          upstream = await sendCompactAttempt(alternate.provider, alternate.headers, "single", alternate.authCtx, { recovery });
        } catch (err) {
          if (!preserveConfiguredRefusal || !(err instanceof SendBudgetExhaustedError) || req.signal.aborted) {
            if (preserveConfiguredRefusal) await recordMove();
            return failedAlternateCompactSend(err);
          }
          logCtx.accountLogLabel = rejectedLabel;
          releaseCodexAuthContextProbeLease(alternate.authCtx);
        }
        if (preserveConfiguredRefusal && upstream !== rejected) await recordMove();
      }
    }
    // A transient 5xx that survived the same-account ladder above (#6969). The regular path moves
    // it to another Pool account; compact used to move only on 429/402, so the client retried the
    // compact task outside this request while another account sat idle. One bounded alternate send,
    // the same guards as the quota move, and a 5xx whose body confirms quota keeps today's path.
    if (
      shouldRetryCodexPoolAccountTransient(upstream)
      && !configuredSendBudgetExhausted()
      && (!storedPool401ReplayAttempted || wasAccountAutoPaused(upstream))
      && !gatewayTransport
      && usesCodexForwardPoolAuth(authCtx, route.provider)
      && !authCtx.fixedAccount
      && route.codexAccountMode
      && outcomeCtx === authCtx
      && !req.signal.aborted
      && !conversationCarriesUploadedFiles(raw)
      && !await shouldRetryCodexPoolAccountQuota(upstream, req.signal)
    ) {
      const firstStatus = upstream.status;
      sealCredentialRefusal(logCtx, firstStatus);
      const firstRetryAfter = upstream.headers.get("retry-after");
      const firstResetAt = [
        upstream.headers.get("x-codex-primary-reset-at"),
        upstream.headers.get("x-codex-secondary-reset-at"),
        upstream.headers.get("x-codex-tertiary-reset-at"),
      ].filter(Boolean);
      const alternate = await resolveAlternateCompactContext({
        req,
        admission,
        config,
        route,
        selectedModelId,
        excludeAccountId: authCtx.accountId,
        turnAdmissionLease,
      });
      if (alternate && "failure" in alternate) {
        await applyCompactPoolQuotaHeaders(authCtx, upstream);
        recordCompactPoolOutcome(authCtx, firstStatus, { retryAfter: firstRetryAfter, resetAt: firstResetAt });
        await upstream.body?.cancel().catch(() => undefined);
        return alternate.failure;
      }
      if (alternate && req.signal.aborted) {
        releaseCodexAuthContextProbeLease(alternate.authCtx);
        recordCompactPoolOutcome(outcomeCtx, 499);
        void upstream.body?.cancel(req.signal.reason).catch(() => undefined);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      if (alternate) {
        if (preserveConfiguredRefusal) upstream = await retainCompactRetryResponse(upstream);
        const firstLabel = logCtx.accountLogLabel;
        // B's identity before B's admission, so every budget and spend check runs against B. A's
        // response stays intact until B is actually sent.
        logCtx.accountLogLabel = codexAuthContextLogLabel(alternate.authCtx, config);
        scrubCompactStateForAlternate(alternate.authCtx, alternate.headers);
        const recordFirstMove = () => {
          recordCompactPoolOutcome(authCtx, firstStatus, { retryAfter: firstRetryAfter, resetAt: firstResetAt });
          void upstream.body?.cancel().catch(() => undefined);
          outcomeCtx = alternate.authCtx;
        };
        let alternateResponse: Response | undefined;
        // Whether B's send actually left this process. Every local refusal before that point -- a
        // spent budget, a dispatch guard such as disabled credits, a pacing refusal -- keeps A.
        let alternateDispatched = false;
        try {
          alternateResponse = await sendCompactAttempt(alternate.provider, alternate.headers, "single", alternate.authCtx,
            { onDispatch: () => { alternateDispatched = true; } });
        } catch (err) {
          if (alternateDispatched) {
            recordFirstMove();
            return failedAlternateCompactSend(err);
          }
          // Refused before anything left: A's answer and identity stand, recorded once below.
          logCtx.accountLogLabel = firstLabel;
          releaseCodexAuthContextProbeLease(alternate.authCtx);
        }
        if (alternateResponse) {
          recordFirstMove();
          upstream = alternateResponse;
        }
      }
    }
    // Capture the final serving account as well as an earlier rejected account, once per response.
    if (outcomeCtx.kind === "pool") {
      const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/quota");
      applyAccountQuotaFromUpstreamHeaders(outcomeCtx.accountId, upstream.headers, outcomeCtx.writerGeneration,
        undefined, { modelId: route.modelId, poolWriter: outcomeCtx.poolQuotaWriter, poolResponse: true });
    }
    const retryAfter = upstream.headers.get("retry-after");
    const resetAt = [
      upstream.headers.get("x-codex-primary-reset-at"),
      upstream.headers.get("x-codex-secondary-reset-at"),
      upstream.headers.get("x-codex-tertiary-reset-at"),
    ].filter(Boolean);
    const buffered = await bufferCompactResponse(upstream, req.signal, config.stallTimeoutSec, isLocalUpstream(compactUrl));
    const bufferedErrorText = buffered.ok
      ? ""
      : await buffered.clone().text().catch(() => "");
    // The client-facing 429 of a synthesized replay refusal says nothing about this
    // account's quota. Pool accounting keeps reading it as the transport failure it is,
    // which is also what it recorded before the status was corrected for the client.
    const replayRefused = isNonReplayableResponse(upstream);
    const explicitQuotaStatus = !replayRefused
      && (buffered.status === 429 || buffered.status === 402);
    const bodyInferredQuota = !replayRefused
      && !buffered.ok
      && !explicitQuotaStatus
      && isRateLimitOrQuotaFailureMessage(bufferedErrorText);
    const quotaFailure = explicitQuotaStatus || bodyInferredQuota;
    // Record pool health only after the body is fully delivered (or definitively failed).
    // A premature 200 would clear soft-avoid while the client still sees a buffer 502.
    if (buffered.status === 499) {
      recordCompactPoolOutcome(outcomeCtx, 499);
      return buffered;
    }
    // A body-confirmed quota failure can arrive behind a generic 5xx. Record it as
    // quota evidence; otherwise preserve the real upstream status so a local buffering
    // failure after a 200 cannot soft-avoid a healthy account or rotate a thread.
    if (!pool401OutcomeSettled) {
      recordCompactPoolOutcome(
        outcomeCtx,
        bodyInferredQuota ? 429 : replayRefused ? 502 : upstream.status,
        { retryAfter, resetAt },
      );
    }
    // Lift usage and response metadata from the buffered upstream JSON into the
    // request log; the routed branch gets the same through handleResponses. The
    // synthetic buffer errors are not upstream bodies and stay uninspected.
    if (buffered.ok) {
      const compactText = await buffered.clone().text();
      if (gatewayReplayParsed) {
        try {
          if (nativeCompactResponseSchema.safeParse(JSON.parse(compactText)).success) {
            commitReasoningReplayServingIdentity(gatewayReplayParsed._reasoningReplayScope);
          }
        } catch { /* A malformed body cannot establish serving provenance. */ }
      }
      inspectResponseLogJson(logCtx, compactText);
      if (!options.compactionRoutingOverride) forgetCompactHandoffRoute(req, admission);
      rememberServingConversationStateIssuer(outcomeCtx, codexPoolAffinityKey(req.headers));
    } else if (!options.compactionRoutingOverride && quotaFailure && !configuredSendBudgetExhausted()
      && (!storedPool401ReplayAttempted || wasAccountAutoPaused(upstream))) {
      const fallbackModel = compactHandoffRoute(req, admission, raw.model);
      if (fallbackModel && !req.signal.aborted) {
        const fallbackReq = new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify({ ...raw, model: fallbackModel }),
          signal: req.signal,
        });
        try {
          // The same logical request carries the original ceiling and spend observer.
          const fallback = await handleResponsesCompact(
            fallbackReq,
            config,
            logCtx,
            turnAdmissionLease,
            admission,
            { ...options, sendBudget },
          );
          if (fallback.ok || fallback.status === 499) return fallback;
          await fallback.body?.cancel().catch(() => undefined);
        } catch {
          // The previous-model rejection is the authoritative failure when the
          // remembered handoff route can no longer compact this thread.
        }
      }
    }
    // A native compact 404 falls back to a regular Responses compaction turn.
    if (buffered.status !== 404 || configuredSendBudgetExhausted()) return buffered;
    if (preserveConfiguredRefusal) nativeNotFound = buffered;
    } finally {
      releaseUpstreamHostAdmission(compactHostAdmissionLease);
      releaseCodexAuthContextProbeLease(authCtx);
    }
  }

  return runRoutedCompactTurn({
    req,
    raw: raw as { model: string; input?: unknown },
    config,
    route,
    logCtx,
    turnAdmissionLease,
    admission,
    sendBudget,
    accountGatedCompactWireModel,
    nativeNotFound,
    options,
  });
}
