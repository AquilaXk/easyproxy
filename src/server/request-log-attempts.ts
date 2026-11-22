import { inferCursorContextWindow } from "../adapters/cursor/discovery";
import { DEVIN_MODEL_CONTEXT_WINDOWS } from "../adapters/devin/live-models";
import { classifyError, CYBER_POLICY_ERROR_CODE, isCyberPolicyCode, isUpstreamResetReplayRefusedMessage } from "../lib/errors";
import { capEstimateAtContextWindow } from "../lib/token-estimate";
import { UPSTREAM_RESET_REPLAY_REFUSED_CODE } from "../lib/upstream-retry";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { kiroObservedContextWindow } from "../providers/kiro-model-catalog";
import { stampApiKeyAccountLabel, usesApiKeyAccount } from "../providers/label";
import { modelRecordValue } from "../reasoning-effort";
import type { EpxProviderConfig, EpxUsage } from "../types";
import {
  type AttemptRecoveryKind,
  type PersistedUsageAttempt,
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type UsageStatus,
} from "../usage/log";
import { attemptAccountChanged, sealRequestAttemptIdentity } from "./request-log-account-rotation";
import { credentialRecoveryStatus, sealedCredentialRefusals } from "./request-log-attempt-recovery";
import { aggregateAttemptUsage } from "./request-log-attempt-usage";
import { attributeSealedAttempt } from "./request-log-failure-attribution";
import type { RequestLogContext } from "./request-log-types";

export function requestLogErrorCode(
  status: number,
  upstreamError?: string,
  terminalErrorCode?: string,
  replayRefusal = false,
): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  // A structured terminal code is authoritative even when the provider message is localized,
  // generic, or absent. Only preserve the one narrowly recognized policy code here: broadly
  // forwarding arbitrary upstream codes would change unrelated request-log taxonomy.
  if (isCyberPolicyCode(terminalErrorCode)) return CYBER_POLICY_ERROR_CODE;
  const classifiedCode = upstreamError?.trim()
    ? classifyError(status, "upstream_error", upstreamError).code
    : undefined;
  // Defense in depth: mid-stream web-search aborts used to land as 502 with this message.
  if (status === 499 || classifiedCode === "client_closed_request") {
    return "client_closed_request";
  }
  // Keep the high-confidence message fallback for runtimes/providers that stripped the
  // structured code before emitting response.failed.
  if (classifiedCode === CYBER_POLICY_ERROR_CODE) return CYBER_POLICY_ERROR_CODE;
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401) return "invalid_api_key";
  if (status === 403) {
    // Prefer message-aware codes (e.g. Ollama Cloud subscription gates) over a blunt
    // invalid_api_key — 403 usually means authenticated but not allowed.
    if (upstreamError?.trim()) {
      const code = classifyError(403, "upstream_error", upstreamError).code;
      if (code) return code;
    }
    return "permission_denied";
  }
  if (status === 429) {
    // Prefer transport provenance; retain the legacy message fallback for older callers.
    if (replayRefusal || (upstreamError?.trim() && isUpstreamResetReplayRefusedMessage(upstreamError))) {
      return UPSTREAM_RESET_REPLAY_REFUSED_CODE;
    }
    return "rate_limit_exceeded";
  }
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}

// Attempt identity can change in place while a combo parent retains an older context copy.
// These objects own their usage even after a rotation to an unknown key identity.
export const keyUsageOwners = new WeakSet<PersistedUsageAttempt>();
const keyWireUsageBaselines = new WeakMap<PersistedUsageAttempt, EpxUsage | undefined>();

function cloneKeyUsage(usage: EpxUsage | undefined): EpxUsage | undefined {
  return usage ? { ...usage } : undefined;
}

/** Replace this physical send's wire snapshot against the pre-send baseline; repeats do not sum. */
export function recordKeyWireAttemptUsage(logCtx: RequestLogContext, usage: EpxUsage | undefined): boolean {
  if (!usage) return false;
  const attempt = logCtx.activeAttempt;
  if (!attempt || sealedCredentialRefusals.has(attempt) || !keyUsageOwners.has(attempt) || !keyWireUsageBaselines.has(attempt)) return false;
  const baseline = keyWireUsageBaselines.get(attempt);
  const current = { ...usage };
  attempt.usage = baseline
    ? aggregateAttemptUsage([
      { ...attempt, usage: baseline, usageStatus: baseline.estimated ? "estimated" : "reported" },
      { ...attempt, usage: current, usageStatus: current.estimated ? "estimated" : "reported" },
    ]).usage
    : current;
  logCtx.usage = attempt.usage;
  return true;
}

export interface FinalizedUsageResult {
  usage?: EpxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

/**
 * Context window for the routed model, used to cap the token estimate:
 * a request the provider answered cannot have exceeded the window, so the estimate must never
 * claim it did. The family is picked by the route ADAPTER, not the model id alone, because
 * claude-family ids are shared between Kiro and Cursor with different windows. Kiro "auto" is
 * a router with no fixed window and is never guessed; unknown adapters/models stay uncapped.
 */
export function contextWindowForModel(adapter: string, modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  if (adapter === "kiro" || adapter.startsWith("kiro-")) {
    const normalized = normalizeKiroModelId(modelId);
    if (normalized === "auto") return undefined;
    return kiroObservedContextWindow(modelId)
      ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
      ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalized);
  }
  if (adapter === "cursor" || adapter.startsWith("cursor-")) {
    return inferCursorContextWindow(modelId);
  }
  if (adapter === "devin") {
    return modelRecordValue(DEVIN_MODEL_CONTEXT_WINDOWS, modelId);
  }
  return undefined;
}

export function finalizedUsage(
  adapter: string,
  usage: EpxUsage | undefined,
  inputTokenEstimate: number | undefined,
  contextWindow: number | undefined,
  locallyAnswered = false,
): FinalizedUsageResult {
  // The ESTIMATE itself is capped at the model's context window. The
  // combined value below keeps its max(inputTokens, estimate) behavior — a provider-reported
  // positive count is never reduced by this cap, only the estimate that could substitute it.
  const estimate = typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0
    ? capEstimateAtContextWindow(inputTokenEstimate, contextWindow)
    : undefined;
  const finalUsage = usageForFinalLog(adapter, usage, locallyAnswered);
  const usageFallback = !finalUsage && estimate !== undefined
    ? { inputTokens: estimate, outputTokens: 0, estimated: true }
    : undefined;
  // The estimate is a floor under a count the adapter could only guess. A count the adapter read
  // off the upstream's own usage frame stays exact: max() against a larger local estimate would
  // replace it and mark it estimated.
  const combinedInputTokens = finalUsage && !finalUsage.upstreamReported && estimate !== undefined
    ? Math.max(finalUsage.inputTokens, estimate)
    : undefined;
  const loggedUsage = finalUsage && combinedInputTokens !== undefined
    ? {
        ...finalUsage,
        inputTokens: combinedInputTokens,
        totalTokens: combinedInputTokens + finalUsage.outputTokens,
        estimated: true,
      }
    : finalUsage
      // When the adapter alone produced an estimated count and no local estimate
      // exists, cap it at the context window — an adapter estimate above the window
      // misleads the usage dashboard.  The combined branch (above) already caps the
      // ESTIMATE via capEstimateAtContextWindow, and Math.max preserves a real
      // provider-reported count, so it needs no further reduction.
      ? (finalUsage.estimated && contextWindow !== undefined && finalUsage.inputTokens > contextWindow
          ? {
              ...finalUsage,
              inputTokens: contextWindow,
              totalTokens: contextWindow + finalUsage.outputTokens,
            }
          : finalUsage)
      : usageFallback;
  const totalTokens = usageTotalTokens(loggedUsage);
  return {
    status: usageStatusForFinalLog(loggedUsage),
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function beginRequestAttempt(
  ordinal: number,
  provider: string,
  model: string,
  adapter: string,
): PersistedUsageAttempt {
  return {
    ordinal,
    provider,
    model,
    adapter,
    status: 0,
    durationMs: 0,
    sendCount: 0,
    recoveryKinds: [],
    usageStatus: "unreported",
  };
}

/** Add raw per-response usage before a bridge combines multiple rounds for the client. */
export function recordKeyAttemptUsage(logCtx: RequestLogContext, usage: EpxUsage | undefined): void {
  const attempt = logCtx.activeAttempt;
  if (!attempt || sealedCredentialRefusals.has(attempt) || !usage) return;
  attempt.usage = attempt.usage
    ? aggregateAttemptUsage([{ ...attempt, usageStatus: attempt.usage.estimated ? "estimated" : "reported" },
      { ...attempt, usage, usageStatus: usage.estimated ? "estimated" : "reported" }]).usage
    : { ...usage };
  logCtx.usage = attempt.usage;
}

/** A stable active object lets combo/stream callbacks keep pointing at the final attempt.
 * Earlier key segments are immutable, flat snapshots inserted before that active object. */
export function noteProviderAttemptSend(
  logCtx: RequestLogContext,
  providerName: string,
  provider: EpxProviderConfig,
  inputTokenEstimate: number | undefined,
  recovery?: AttemptRecoveryKind,
  resolved?: { model: string; adapter: string },
): void {
  const attempt = logCtx.activeAttempt;
  const previous = attempt?.accountLogLabel;
  stampApiKeyAccountLabel(logCtx, providerName, provider);
  const next = logCtx.accountLogLabel;
  if (attempt && usesApiKeyAccount(provider)) keyUsageOwners.add(attempt);
  const recoveryStatus = credentialRecoveryStatus(recovery);
  if (attempt && attempt.sendCount > 0 && (sealedCredentialRefusals.has(attempt) || recoveryStatus !== undefined
    || attemptAccountChanged(previous, next, attempt.provider, logCtx.provider)
    || resolved && (attempt.model !== resolved.model || attempt.adapter !== resolved.adapter))) {
    if (!sealedCredentialRefusals.delete(attempt)) {
      delete attempt.inputTokenEstimate;
      finishRequestAttempt(attempt, attempt.status >= 100 ? attempt.status
        : recoveryStatus ?? (recovery === "rate-limit-429" ? 429 : 502),
      Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()), attempt.usage);
      // Finalization sees only the live segment, so attribute this refusal before snapshotting it.
      attributeSealedAttempt(attempt, recovery);
    }
    const completed = { ...attempt, recoveryKinds: [...attempt.recoveryKinds],
      ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
      ...(attempt.deliverySummary ? { deliverySummary: { ...attempt.deliverySummary } } : {}),
      ...(attempt.tierOutcome ? { tierOutcome: { ...attempt.tierOutcome } } : {}) };
    const attempts = logCtx.attempts ??= [attempt];
    const index = attempts.indexOf(attempt);
    if (index >= 0) attempts.splice(index, 0, completed);
    else attempts.push(completed, attempt);
    const fresh = beginRequestAttempt(completed.ordinal + 1, providerName, completed.model, completed.adapter);
    if (completed.labRouteSubjectId && completed.provider === logCtx.provider
      && (!resolved || (completed.model === resolved.model && completed.adapter === resolved.adapter))) {
      fresh.labRouteSubjectId = completed.labRouteSubjectId;
    }
    // Effort/tier metadata describes the request and is captured before the physical send.
    for (const key of ["requestedEffort", "effectiveEffort", "reasoningWireField", "reasoningWireValue"] as const) {
      if (completed[key] !== undefined) Object.assign(fresh, { [key]: completed[key] });
    }
    // The response observer owns this live object; the sealed row keeps its snapshot.
    if (attempt.tierOutcome) fresh.tierOutcome = attempt.tierOutcome;
    for (const key of Object.keys(attempt)) delete (attempt as unknown as Record<string, unknown>)[key];
    Object.assign(attempt, fresh);
    delete logCtx.usage;
    logCtx.activeAttemptStartedAt = Date.now();
  }
  if (attempt) {
    if (resolved) { attempt.model = resolved.model; attempt.adapter = resolved.adapter; }
    sealRequestAttemptIdentity(attempt, logCtx.provider, attempt.adapter, next);
    recordAttemptCredentialSource(attempt, providerName, provider, attempt.adapter);
  }
  noteAttemptSend(attempt, inputTokenEstimate, recovery);
  if (attempt && keyUsageOwners.has(attempt)) {
    keyWireUsageBaselines.set(attempt, cloneKeyUsage(attempt.usage));
  }
}

/** Capture only the resolved upstream route; inbound auth and today's config cannot label old usage. */
export function recordAttemptCredentialSource(
  attempt: PersistedUsageAttempt | undefined,
  providerName: string,
  provider: Pick<EpxProviderConfig, "authMode" | "baseUrl" | "adapter">,
  adapterName: string = provider.adapter,
): void {
  if (!attempt || sealedCredentialRefusals.has(attempt)) return;
  // Rebinding an attempt to an unrecognized route must not retain its previous attribution.
  delete attempt.credentialSource;
  if (providerName !== "xai"
    || !["openai-chat", "openai-responses"].includes(adapterName)) return;
  try {
    const url = new URL(provider.baseUrl ?? "");
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname)) return;
    if (provider.authMode === "oauth" && url.hostname === "cli-chat-proxy.grok.com") {
      attempt.credentialSource = "grok-oauth";
    } else if ((provider.authMode === "key" || provider.authMode === undefined)
      && url.hostname === "api.x.ai") {
      attempt.credentialSource = "xai-api-key";
    }
  } catch {
    // Invalid/custom destinations have no known subscription provenance.
  }
}

export function noteAttemptSend(
  attempt: PersistedUsageAttempt | undefined,
  inputTokenEstimate: number | undefined,
  recovery?: AttemptRecoveryKind,
): void {
  if (!attempt || sealedCredentialRefusals.has(attempt)) return;
  attempt.sendCount += 1;
  if (typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0) {
    // Store the ESTIMATE field already capped at the model's window:
    // what gets persisted, and later merged into usage, never claims a count above the window.
    attempt.inputTokenEstimate = capEstimateAtContextWindow(
      inputTokenEstimate,
      contextWindowForModel(attempt.adapter, attempt.model),
    );
  }
  if (recovery && !attempt.recoveryKinds.includes(recovery)) {
    attempt.recoveryKinds.push(recovery);
  }
}

export function finishRequestAttempt(
  attempt: PersistedUsageAttempt,
  status: number,
  durationMs: number,
  usage?: EpxUsage,
): PersistedUsageAttempt {
  if (sealedCredentialRefusals.has(attempt)) return attempt;
  const finalized = finalizedUsage(
    attempt.adapter,
    usage ?? attempt.usage,
    attempt.inputTokenEstimate,
    contextWindowForModel(attempt.adapter, attempt.model),
    attempt.locallyAnswered === true,
  );
  attempt.status = status;
  attempt.durationMs = Math.max(0, durationMs);
  attempt.usageStatus = finalized.status;
  if (finalized.usage) attempt.usage = finalized.usage;
  else delete attempt.usage;
  if (finalized.totalTokens !== undefined) attempt.totalTokens = finalized.totalTokens;
  else delete attempt.totalTokens;
  const errorCode = requestLogErrorCode(status);
  if (errorCode) attempt.errorCode = errorCode;
  else delete attempt.errorCode;
  return attempt;
}
