import { bridgeToResponsesSSE, buildResponseJSON, formatUpstreamFailureResponse } from "../../bridge";
import { isFixedCodexAccount } from "./core-codex-account";
import { recordSubagentQuotaFailureForThreadSpawn } from "../../codex/subagent-model-fallback";
import { CYBER_POLICY_ERROR_CODE } from "../../lib/errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { redactSecretString } from "../../lib/redact";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import {
  isFlexUnavailableConditionEvidence,
  isFlexUnavailableErrorText,
  isShortOpenRouterInFlightBudget402,
  parseShortRetryAfterMs,
} from "../../lib/upstream-condition";
import type { RequestFailureCause } from "../../lib/request-failure-model";
import { isNonReplayableResponse, retainPacedRetryResponse, sleepWithAbort } from "../../lib/upstream-retry";
import { stripCanonicalOnlyInputItems } from "../../adapters/openai-responses/request-strips";
import type { EpxParsedRequest } from "../../types";
import { anthropicRoutingFor } from "../../oauth/anthropic-routing";
import { classifyAnthropic429 } from "../../oauth/anthropic-rate-limit-policy";
import { isTransientConsoleGoUploadRejection } from "../../providers/opencode-zen-rate-limit";
import type { AdapterEvent } from "../../types";
import type { AttemptRecoveryKind } from "../../usage/log";
import { trackStreamLifetime } from "../lifecycle";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { formatAdapterUpstreamFailure } from "./adapter-failure-message";
import { anthropicPoolCooldownResponse, clientCancelledResponse } from "./core-errors";
import {
  CONSOLE_GO_UPLOAD_RETRY_DELAY_MS,
  consoleGoUploadRejectionBody,
  refusedConfigurationUpdateStrip,
  refusedReasoningEffortDowngrade,
  withRawBodyReasoningEffort,
} from "./core-opaque-recovery";
import type { ResponsesAdmissionState, ResponsesRequestContext } from "./core-options";
import { carryPolicyCandidateRefusal } from "./policy-request-scope";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesEffects } from "./response-effects";

export type TerminalRetryOutcome =
  | { kind: "none"; response: Response }
  | { kind: "continue"; response: Response }
  | { kind: "break"; response: Response }
  | { kind: "return"; response: Response };

/** Encode and track an adapter-synthesized terminal response when no upstream send is needed. */
export function buildAdapterLocalTerminalResponse(
  reason: string,
  requestContext: Pick<ResponsesRequestContext, "options" | "logCtx">,
  requestState: Pick<PreparedResponsesRequest, "parsed" | "toolBridgeMaps" | "translatorBudget">,
  responseEffects: Pick<ResponsesEffects, "cancelResponseCompletion" | "notifyResponseComplete">,
  upstream: AbortController,
  cleanupUpstreamAbort: () => void,
): Response {
  const { options, logCtx } = requestContext;
  const { parsed, toolBridgeMaps, translatorBudget } = requestState;
  const { cancelResponseCompletion, notifyResponseComplete } = responseEffects;

  logCtx.localTerminalReason = reason;
  // Mark the physical attempt too, not just the parent row. `finishRequestAttempt` finalizes the
  // attempt through the same estimated-provider path, so without this the row reads exact while
  // its own attempt still claims an estimate — the detailed accounting a maintainer actually
  // reads for a zero-send turn.
  if (logCtx.activeAttempt) logCtx.activeAttempt.locallyAnswered = true;
  cleanupUpstreamAbort();
  upstream.abort();
  const terminalEvents: AdapterEvent[] = [{
    type: "done",
    endTurn: true,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }];
  if (parsed.stream) {
    const localSse = bridgeToResponsesSSE(
      (async function* () { yield* terminalEvents; })(),
      parsed._responseModelId ?? parsed.modelId,
      toolBridgeMaps.toolNsMap,
      toolBridgeMaps.freeformToolNames,
      toolBridgeMaps.toolSearchToolNames,
      cancelResponseCompletion,
      2_000,
      {
        translatorBudget,
        onCompletedResponse: notifyResponseComplete,
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      },
    );
    // Same lifetime tracking as every other streaming return in this function: the turn
    // admission lease is released when the body finishes or the client disconnects. Returning
    // the raw stream would hold a lease for a turn that already has all of its output.
    const localTurnAc = new AbortController();
    return new Response(
      trackStreamLifetime(localSse, localTurnAc, undefined, options.turnAdmissionLease),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  }
  const json = buildResponseJSON(terminalEvents, parsed._responseModelId ?? parsed.modelId, { translatorBudget });
  notifyResponseComplete(json);
  return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
}

/** Tighten oversized image fidelity once and replay on 413/payload rejections. */
export async function retryAdapterImageTier(
  upstreamResponse: Response,
  parsed: PreparedResponsesRequest["parsed"],
  transportState: Pick<ResponsesTransport, "activeAdapter" | "imageTierBias" | "invalidateSameTargetRequest">,
  state: { imageRetryAttempted: boolean },
  retainFailureResponse: () => Promise<Response>,
  rebuildAndRefetch: (
    recovery: AttemptRecoveryKind,
    onDispatch?: () => void,
    preserveFailureResponse?: Response,
  ) => Promise<Response | { failed: Response }>,
): Promise<TerminalRetryOutcome> {
  if (!shouldAttemptImageTierRetry({
    status: upstreamResponse.status,
    adapterName: transportState.activeAdapter.name,
    parsed,
    alreadyAttempted: state.imageRetryAttempted,
  })) {
    return { kind: "none", response: upstreamResponse };
  }
  state.imageRetryAttempted = true;
  transportState.imageTierBias = 1;
  transportState.invalidateSameTargetRequest();
  const failedResponse = await retainFailureResponse();
  const result = await rebuildAndRefetch("image-413", undefined, failedResponse);
  if ("failed" in result) {
    if (result.failed !== failedResponse) return { kind: "return", response: result.failed };
    return { kind: "break", response: failedResponse };
  }
  try { void failedResponse.body?.cancel().catch(() => {}); } catch { /* closed */ }
  return { kind: "continue", response: result };
}

/** Replay once when Console Go rejects an upload transiently with 400 "Invalid upload request.". */
export async function retryConsoleGoUploadRejection(
  upstreamResponse: Response,
  transportState: Pick<ResponsesTransport, "sameTargetRequest">,
  upstream: AbortController,
  cleanupUpstreamAbort: () => void,
  guard: { attempted: boolean },
  rebuildAndRefetch: (recovery: AttemptRecoveryKind) => Promise<Response | { failed: Response }>,
): Promise<TerminalRetryOutcome> {
  if (guard.attempted) return { kind: "none", response: upstreamResponse };
  const uploadRejectionBody = await consoleGoUploadRejectionBody(
    upstreamResponse,
    guard.attempted,
    upstream.signal,
  );
  if (uploadRejectionBody === undefined
    || !isTransientConsoleGoUploadRejection({
      status: upstreamResponse.status,
      errorBody: uploadRejectionBody,
      outboundUrl: transportState.sameTargetRequest?.url,
    })) {
    return { kind: "none", response: upstreamResponse };
  }
  guard.attempted = true;
  try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  if (!upstream.signal.aborted) {
    try {
      await sleepWithAbort(CONSOLE_GO_UPLOAD_RETRY_DELAY_MS, upstream.signal);
    } catch {
      cleanupUpstreamAbort();
      return { kind: "return", response: clientCancelledResponse() };
    }
  }
  if (upstream.signal.aborted) {
    cleanupUpstreamAbort();
    return { kind: "return", response: clientCancelledResponse() };
  }
  const result = await rebuildAndRefetch("console-go-upload-retry");
  if ("failed" in result) return { kind: "return", response: result.failed };
  return { kind: "continue", response: result };
}

/** Step down reasoning effort on upstream refusal and replay within the request budget. */
export async function retryReasoningEffortDowngrade(
  upstreamResponse: Response,
  requestContext: Pick<ResponsesRequestContext, "options">,
  requestState: Pick<PreparedResponsesRequest, "parsed" | "route">,
  transportState: Pick<ResponsesTransport, "invalidateSameTargetRequest">,
  upstream: AbortController,
  guard: { attempted: boolean },
  retainFailureResponse: () => Promise<Response>,
  rebuildAndRefetch: (
    recovery: AttemptRecoveryKind,
    onDispatch?: () => void,
    preserveFailureResponse?: Response,
  ) => Promise<Response | { failed: Response }>,
): Promise<TerminalRetryOutcome> {
  const { options } = requestContext;
  const { parsed, route } = requestState;
  const downgrade = await refusedReasoningEffortDowngrade(
    upstreamResponse,
    upstream.signal,
    guard,
    options.comboAttempt,
    { provider: route.provider, modelId: parsed.modelId, requested: parsed.options.reasoning },
  );
  if (!downgrade) return { kind: "none", response: upstreamResponse };

  guard.attempted = true;
  parsed.options.reasoning = downgrade.effort;
  // The same-target cache keys on parsed identity, so a mutated effort needs a token bump.
  transportState.invalidateSameTargetRequest();
  // A combo keeps the refusal, so an unfunded rung still reaches combo failover as the original 400.
  const refusal = options.comboAttempt ? await retainFailureResponse() : undefined;
  if (!refusal) {
    try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  }
  const result = await rebuildAndRefetch("reasoning-effort-downgrade", undefined, refusal);
  if ("failed" in result) {
    if (result.failed !== refusal) return { kind: "return", response: result.failed };
    return { kind: "break", response: refusal };
  }
  if (refusal) {
    try { void refusal.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  }
  return { kind: "continue", response: result };
}

/** Record subagent/pool quota failure telemetry and format the final client error response. */
export function formatAdapterTerminalUpstreamErrorResponse(
  upstreamResponse: Response,
  errorText: string,
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "logCtx" | "req">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<PreparedResponsesRequest, "route" | "subagentQuotaFailureModel" | "subagentFallbackAccountId">,
  transportState: Pick<ResponsesTransport, "anthropicInstance" | "anthropicRouteDecision" | "anthropicPoolAccountId">,
  denialMessage: (fallback: string) => string,
): Response {
  const { options, config, logCtx, req } = requestContext;
  const { route, subagentQuotaFailureModel, subagentFallbackAccountId } = requestState;
  const { anthropicInstance, anthropicRouteDecision, anthropicPoolAccountId } = transportState;

  if (!isFixedCodexAccount(admissionState.authCtx)) {
    recordSubagentQuotaFailureForThreadSpawn(
      req.headers,
      subagentQuotaFailureModel,
      upstreamResponse.status === 429 || upstreamResponse.status === 402
        ? upstreamResponse.status
        : `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`,
      config,
      subagentFallbackAccountId,
    );
  }
  // The last pool account just refused on spent quota and recovery found no replacement:
  // answer the usage limit now (#6991), so Codex stops instead of retrying into the local
  // refusal that every later attempt meets until the first window reopens.
  const poolUsageLimit = upstreamResponse.status === 429 && anthropicInstance && route.provider.authMode === "oauth"
    ? anthropicRoutingFor(anthropicInstance).anthropicPoolUsageLimitAfterRefusal(Date.now(), anthropicRouteDecision, route.modelId)
    : null;
  // Combo children returned above; the flag is passed anyway so this site states the same rule.
  if (poolUsageLimit) return anthropicPoolCooldownResponse(poolUsageLimit, { comboAttempt: options.comboAttempt, logCtx });
  // Upstreams occasionally echo request details in error bodies — scrub token-shaped
  // material before it reaches the client-facing error surface.
  const upstreamRetryAfter = upstreamResponse.headers.get("retry-after");
  const { normalized, message } = formatAdapterUpstreamFailure({
    status: upstreamResponse.status,
    errorText,
    route,
    upstreamRetryAfter,
    denialMessage,
    logCtx,
  });
  if (isShortOpenRouterInFlightBudget402({
    status: upstreamResponse.status,
    code: normalized.code,
    type: normalized.type,
    retryAfter: upstreamRetryAfter,
  })) {
    logCtx.causeHint = "rate-limit";
  }
  options.onCompactionRecoveryAdapterEvent?.({
    type: "error", status: upstreamResponse.status,
    errorType: normalized.type, code: normalized.code,
    message: "Structured upstream failure observed before client formatting",
  });
  const retryAfter = normalized.cyberPolicy
    ? undefined
    : resolveClientRetryAfter({
      status: upstreamResponse.status,
      message,
      upstreamRetryAfter,
      includeDefault: !(anthropicPoolAccountId && classifyAnthropic429(upstreamResponse.headers) === "request-scoped-unknown"),
    });
  return carryPolicyCandidateRefusal(upstreamResponse, formatUpstreamFailureResponse(
    upstreamResponse,
    normalized.code,
    upstreamResponse.status,
    normalized.cyberPolicy ? (normalized.type ?? CYBER_POLICY_ERROR_CODE) : "upstream_error",
    message,
    {
      ...(normalized.cyberPolicy ? { code: CYBER_POLICY_ERROR_CODE } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  ));
}

const MAX_FLEX_BODY_JSON_BYTES = 2_097_152;
const MAX_FLEX_BODY_EDGE_BYTES = 262_144;
const FLEX_SERVICE_TIER_FIELD_RE = /"service_tier"\s*:\s*"flex"/i;

function parsedHasFlexIntent(
  parsed: Pick<PreparedResponsesRequest["parsed"], "options" | "_rawBody">,
): boolean {
  if (parsed.options.tierDecision?.kind === "drop") return false;
  const optionTier = typeof parsed.options.serviceTier === "string"
    ? parsed.options.serviceTier.trim().toLowerCase()
    : undefined;
  const decisionTier = parsed.options.tierDecision?.kind === "set"
    ? parsed.options.tierDecision.value.trim().toLowerCase()
    : undefined;
  const rawBody = parsed._rawBody;
  const rawTier = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
    && typeof (rawBody as Record<string, unknown>).service_tier === "string"
    ? ((rawBody as Record<string, unknown>).service_tier as string).trim().toLowerCase()
    : undefined;
  if (decisionTier !== undefined && decisionTier !== "flex") return false;
  return optionTier === "flex" || decisionTier === "flex" || rawTier === "flex";
}

/** True when the physical outbound wire payload actually sent `service_tier: "flex"`. */
export function hasOutboundFlexServiceTier(
  outboundBodyText: string | undefined,
  parsed?: Pick<PreparedResponsesRequest["parsed"], "options" | "_rawBody">,
): boolean {
  if (parsed !== undefined && !parsedHasFlexIntent(parsed)) return false;
  if (typeof outboundBodyText !== "string" || outboundBodyText.length === 0) return false;
  if (!outboundBodyText.includes('"service_tier"')) return false;
  if (outboundBodyText.length <= MAX_FLEX_BODY_JSON_BYTES) {
    try {
      const root = JSON.parse(outboundBodyText) as unknown;
      if (!root || typeof root !== "object" || Array.isArray(root)) return false;
      const tier = (root as Record<string, unknown>).service_tier;
      return typeof tier === "string" && tier.trim().toLowerCase() === "flex";
    } catch {
      return false;
    }
  }
  if (parsed === undefined) return false;
  const head = outboundBodyText.slice(0, 16_384);
  const tail = outboundBodyText.slice(-MAX_FLEX_BODY_EDGE_BYTES);
  return FLEX_SERVICE_TIER_FIELD_RE.test(head) || FLEX_SERVICE_TIER_FIELD_RE.test(tail);
}

/** Mutate parsed state so standard-tier fallback omits `service_tier: "flex"` on all adapters. */
export function stripFlexServiceTierForStandardRetry(
  parsed: Pick<PreparedResponsesRequest["parsed"], "options" | "_rawBody">,
): void {
  parsed.options.tierDecision = { kind: "drop" };
  if (typeof parsed.options.serviceTier === "string" && parsed.options.serviceTier.trim().toLowerCase() === "flex") {
    parsed.options.serviceTier = undefined;
  }
  const rawBody = parsed._rawBody;
  if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
    const rawTier = (rawBody as Record<string, unknown>).service_tier;
    if (typeof rawTier === "string" && rawTier.trim().toLowerCase() === "flex") {
      const { service_tier: _dropped, ...rest } = rawBody as Record<string, unknown>;
      parsed._rawBody = rest;
    }
  }
}

function extractStructuredErrorEnvelope(rawText: string): { code?: string; type?: string; reason?: string; message?: string } {
  const trimmed = rawText.trim();
  const body = trimmed.replace(/^Provider error \d{3}:\s*/i, "");
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error)
        ? root.error as Record<string, unknown>
        : undefined;
      const detail = root.detail && typeof root.detail === "object" && !Array.isArray(root.detail)
        ? root.detail as Record<string, unknown>
        : undefined;
      const primary = nested ?? detail ?? root;
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      return {
        code: str(primary.code) ?? str(root.code),
        type: str(primary.type) ?? str(root.type),
        reason: str(primary.reason) ?? str(root.reason),
        message: str(primary.message) ?? str(root.message) ?? (typeof root.detail === "string" ? root.detail : undefined) ?? trimmed,
      };
    }
  } catch {
    // Plain-text error envelope falls through with raw message.
  }
  return { message: trimmed };
}

/**
 * Detect a pre-output HTTP 429/503 `flex_unavailable` refusal for a request that sent `service_tier: "flex"`.
 * Fail-closed on oversized/timed-out bodies or requests that did not actually send flex.
 */
export async function isFlexUnavailableRefusal(
  response: Response,
  outboundBodyText: string | undefined,
  parsed: Pick<PreparedResponsesRequest["parsed"], "options" | "_rawBody"> | undefined,
  alreadyAttempted: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (alreadyAttempted) return false;
  if (response.status !== 429 && response.status !== 503) return false;
  if (signal?.aborted || !hasOutboundFlexServiceTier(outboundBodyText, parsed)) return false;
  if (!response.body) return false;
  const bounded = await readBoundedResponseBody(response.clone(), { signal });
  if (bounded.oversized || bounded.timedOut || !bounded.text) return false;
  const env = extractStructuredErrorEnvelope(bounded.text);
  return isFlexUnavailableConditionEvidence({
    status: response.status,
    code: env.code,
    type: env.type,
    reason: env.reason,
    message: env.message,
  }) || isFlexUnavailableErrorText(bounded.text);
}

/** Bounded response check for transient OpenRouter `openrouter_in_flight_budget` HTTP 402 (`Retry-After <= 60s`). */
export async function isShortOpenRouterInFlightBudget402Response(
  response: Response,
  signal?: AbortSignal,
  retryAfterHeader?: string | null,
): Promise<boolean> {
  if (response.status !== 402 || signal?.aborted) return false;
  const retryAfter = retryAfterHeader ?? response.headers.get("retry-after");
  if (parseShortRetryAfterMs(retryAfter) === undefined) return false;
  if (!response.body) return false;
  const bounded = await readBoundedResponseBody(response.clone(), { signal });
  if (bounded.oversized || bounded.timedOut || !bounded.text) return false;
  const env = extractStructuredErrorEnvelope(bounded.text);
  return isShortOpenRouterInFlightBudget402({
    status: 402,
    code: env.code,
    type: env.type,
    message: env.message,
    retryAfter,
  });
}

/** Stamp `rate-limit` failure cause when a pre-read 402 error text confirms short `openrouter_in_flight_budget`. */
export function stampShortOpenRouterInFlightBudget402(
  logCtx: { causeHint?: RequestFailureCause } | undefined,
  status: number,
  errorText: string,
  retryAfter?: string | null,
): boolean {
  if (!logCtx || status !== 402) return false;
  if (parseShortRetryAfterMs(retryAfter) === undefined) return false;
  const env = extractStructuredErrorEnvelope(errorText);
  if (!isShortOpenRouterInFlightBudget402({
    status: 402,
    code: env.code,
    type: env.type,
    message: env.message,
    retryAfter,
  })) {
    return false;
  }
  logCtx.causeHint = "rate-limit";
  return true;
}

export async function recoverPassthroughFlexTierDowngrade<F>(params: {
  upstreamResponse: Response;
  outboundBody: string | undefined;
  parsed: PreparedResponsesRequest["parsed"];
  guard: { attempted: boolean };
  signal: AbortSignal;
  configuredBudgetExhausted: boolean;
  shouldRetainFailure: boolean;
  isComboAttempt: boolean;
  rebuildAndRefetch: (
    recovery: AttemptRecoveryKind,
    preserveFailureResponse?: Response,
  ) => Promise<Response | { failed: Response | F }>;
}): Promise<{ kind: "none" } | { kind: "continue"; response: Response } | { kind: "return"; response: Response | F }> {
  const {
    upstreamResponse,
    outboundBody,
    parsed,
    guard,
    signal,
    configuredBudgetExhausted,
    shouldRetainFailure,
    isComboAttempt,
    rebuildAndRefetch,
  } = params;
  if (
    guard.attempted
    || configuredBudgetExhausted
    || isNonReplayableResponse(upstreamResponse)
    || !(await isFlexUnavailableRefusal(upstreamResponse, outboundBody, parsed, guard.attempted, signal))
  ) {
    return { kind: "none" };
  }
  guard.attempted = true;
  const prevTierDecision = parsed.options.tierDecision;
  const prevServiceTier = parsed.options.serviceTier;
  const prevRawBody = parsed._rawBody;
  stripFlexServiceTierForStandardRetry(parsed);
  const refusal = shouldRetainFailure
    ? await retainPacedRetryResponse(upstreamResponse, signal)
    : isComboAttempt ? upstreamResponse : undefined;
  if (!refusal) {
    try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  }
  const result = await rebuildAndRefetch("flex-tier-downgrade", refusal);
  if (result && typeof result === "object" && "failed" in result) {
    parsed.options.tierDecision = prevTierDecision;
    parsed.options.serviceTier = prevServiceTier;
    parsed._rawBody = prevRawBody;
    return { kind: "return", response: result.failed };
  }
  if (refusal && refusal !== result) {
    try { void refusal.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  }
  return { kind: "continue", response: result };
}

export async function recoverPassthroughEffortAndConfigRepairs<F>(params: {
  upstreamResponse: Response;
  outboundBody: string | undefined;
  outboundUrl: string | undefined;
  parsed: PreparedResponsesRequest["parsed"];
  provider: ResponsesRequestContext["config"]["providers"][string];
  configRepairGuard: { attempted: boolean };
  effortDowngradeGuard: { attempted: boolean };
  signal: AbortSignal;
  configuredBudgetExhausted: boolean;
  reserveRetrySpend: boolean;
  comboAttempt?: ResponsesRequestContext["options"]["comboAttempt"];
  rebuildAndRefetch: (
    recovery: AttemptRecoveryKind,
    preserveFailureResponse?: Response,
  ) => Promise<Response | { failed: Response | F }>;
}): Promise<{ kind: "none" } | { kind: "continue"; response: Response } | { kind: "return"; response: Response | F }> {
  const {
    upstreamResponse,
    outboundBody,
    outboundUrl,
    parsed,
    provider,
    configRepairGuard,
    effortDowngradeGuard,
    signal,
    configuredBudgetExhausted,
    reserveRetrySpend,
    comboAttempt,
    rebuildAndRefetch,
  } = params;
  if (!configRepairGuard.attempted && !configuredBudgetExhausted
    && await refusedConfigurationUpdateStrip(upstreamResponse, signal, configRepairGuard, {
      outboundBody,
      outboundUrl,
      modelId: parsed.modelId,
    })) {
    configRepairGuard.attempted = true;
    parsed._stripConfigurationUpdateItems = true;
    parsed._rawBody = stripCanonicalOnlyInputItems(parsed._rawBody);
    const refusal = reserveRetrySpend ? await retainPacedRetryResponse(upstreamResponse, signal)
      : comboAttempt ? upstreamResponse : undefined;
    if (!refusal) try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
    const result = await rebuildAndRefetch("reasoning-effort-downgrade", refusal);
    if (result && typeof result === "object" && "failed" in result) return { kind: "return", response: result.failed };
    if (refusal && refusal !== result) try { void refusal.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
    return { kind: "continue", response: result };
  }
  const downgrade = await refusedReasoningEffortDowngrade(upstreamResponse, signal, effortDowngradeGuard,
    comboAttempt, { provider, modelId: parsed.modelId, requested: parsed.options.reasoning });
  if (downgrade && !configuredBudgetExhausted) {
    effortDowngradeGuard.attempted = true;
    parsed.options.reasoning = downgrade.effort;
    parsed._rawBody = withRawBodyReasoningEffort(parsed._rawBody, downgrade.effort);
    const refusal = reserveRetrySpend ? await retainPacedRetryResponse(upstreamResponse, signal)
      : comboAttempt ? upstreamResponse : undefined;
    if (!refusal) try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
    const result = await rebuildAndRefetch("reasoning-effort-downgrade", refusal);
    if (result && typeof result === "object" && "failed" in result) return { kind: "return", response: result.failed };
    if (refusal && refusal !== result) try { void refusal.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
    return { kind: "continue", response: result };
  }
  return { kind: "none" };
}
