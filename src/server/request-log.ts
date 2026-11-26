import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { normalizeRecordedClient, type UsageClient } from "../usage/client";
import { anthropicAccountTagField, stampApiKeyAccountLabel, usesApiKeyAccount } from "../providers/label";
import { finalizeProviderCacheAffinity } from "./request-log-cache-affinity";
import { settleApiKeyRequestBudget, type ApiKeyBudgetLease } from "./api-key-budget";
import { aggregateAttemptUsage } from "./request-log-attempt-usage";
export { aggregateAttemptUsage } from "./request-log-attempt-usage";

import { attemptAccountChanged, sealRequestAttemptIdentity } from "./request-log-account-rotation";
export { sealRequestAttemptIdentity };
import { credentialRecoveryStatus, retainRefusedAccount, sealedCredentialRefusals } from "./request-log-attempt-recovery";
export { noteAttemptRecoveryWithheld } from "./request-log-attempt-recovery";
import { bareVerdictRowErrorCode, captureUpstreamTerminalDiagnostics, guardedRowCopy, linkLogField, notifyLinkTurnFinal, upstreamDiagnosticLogFields, type LinkRequestLogCarrier, type UpstreamErrorDiagnostics, type UpstreamErrorPayload } from "./request-log-terminal-status";
export { noteUpstreamRequestId } from "./request-log-terminal-status";
import type { ResponsesTerminalStatus } from "../bridge";
import {
  classifyError,
  CYBER_POLICY_ERROR_CODE,
  httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError,
  isClientClosedMessage,
  isCyberPolicyCode,
  isUpstreamResetReplayRefusedMessage,
  responsesCompletionError,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import { CODEX_CONFIG_PATH, readRootTomlString } from "../codex/paths";
import type { CodexAffinityMove, CodexAffinityReason } from "../codex/routing";
import type { CodexAuthContext } from "../codex/auth-context";
import { readCodexCatalogPath } from "../codex/catalog";
import type { AttemptTierOutcome, CacheAffinityLogReason, CacheAffinityOutcome, EpxProviderConfig, EpxUsage } from "../types";
import { normalizeRouteDecisionTrace, type RouteDecisionTraceV1 } from "../routing/trace";
import { parseProtocolTraceV1, type ProtocolTraceV1 } from "../protocols/dto";
import { protocolTraceForRequest } from "../protocols/trace";
import type { AdapterRequest } from "../adapters/base";
import type { RequestSpendSettlement } from "./responses/request-spend";
import type { AdapterTierMetadata } from "../providers/fastwire";
import { UPSTREAM_RESET_REPLAY_REFUSED_CODE } from "../lib/upstream-retry";
import { redactSecretString, sanitizeLogMetadataString } from "../lib/redact";
export { registerCommittedTerminalCooldownHandler } from "./request-log-committed-terminal";
import { reportCommittedTerminalCooldown, type CommittedComboLogFields } from "./request-log-committed-terminal";
import type { UpstreamCondition } from "../lib/upstream-condition";
import { boundedServiceTier, errorDetailFor, projectErrorDetail } from "../usage/error-detail";
import { incompleteReasonDetail, upstreamErrorIsLocal, type FailureDetail } from "./request-log-failure-detail";
import {
  appendUsageEntry,
  classifyCacheTelemetryProvenance,
  isKnownAdmissionKind,
  isKnownAffinityMove,
  isKnownAffinityReason,
  isKnownCacheAffinity,
  isKnownCacheAffinityReason,
  isKnownCacheTelemetryProvenance,
  isKnownInboundProtocol,
  isKnownTerminalSource,
  isKnownTransportPhase,
  isKnownUsageSurface,
  isCodexUsageAccountLogLabel,
  isAnthropicAccountTag,
  isLogicalRequestId,
  isValidReasoningWireValue,
  normalizeClaudeCompatibilityUsageLog,
  normalizeRequestFailureAttribution,
  normalizeRequestSpend,
  normalizedAttempts,
  readRecentUsageEntries,
  modelIdentityLogFields, recordObservedServedModel,
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type AttemptRecoveryKind,
  type CacheTelemetryProvenance,
  type PersistedRequestSpend,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
  type PersistedClaudeCompatibilityLog,
  type RequestFailureCause,
  type RequestFailureStage,
  type UsageStatus,
} from "../usage/log";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import type { WorkflowSpendDenialDetail } from "../lib/workflow-budget";
import { attributeFinalRequest, attributePhysicalAttempt, attributeSealedAttempt } from "./request-log-failure-attribution";
import { debugAttemptDeliverySummary } from "../lib/debug";
import {
  appendUsageDebug,
  isUsageDebugEnabled,
  truncateForDebug,
  USAGE_DEBUG_BODY_SAMPLE_BYTES,
  type UsageDebugBodyKind,
} from "../usage/debug";
import { MAX_LOG_SIZE } from "./request-log-filter";
import { serializedJsonByteLength } from "./json-serialized-bytes";
export { filterRequestLogs, filteredRequestLogCount, queryRequestLogs } from "./request-log-filter";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import { capEstimateAtContextWindow } from "../lib/token-estimate";
import { inferCursorContextWindow } from "../adapters/cursor/discovery";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { kiroObservedContextWindow } from "../providers/kiro-model-catalog";
import { DEVIN_MODEL_CONTEXT_WINDOWS } from "../adapters/devin/live-models";
import { modelRecordValue } from "../reasoning-effort";
import {
  normalizePersistedJevDecision,
  type PersistedJevDecisionV1,
} from "../usage/jev-stats";
import { generationWindowFields, recordGenerationEvent } from "./request-log-generation-window";
import type { RequestMetricsRecorder } from "./request-metrics";
import { requestBodyField, requestBodyLogField, type RequestBodyEntryField, type RequestBodyLogContext } from "./request-body-facts";
import type {
  CacheDiagnosticDraft,
  CacheDiagnosticFinalFacts,
  ContextTokenBreakdown,
  PromptCacheKeySource,
} from "../usage/cache-diagnostic";

const CACHE_DIAGNOSTIC_HOOK = Symbol.for("easyproxy.cache-diagnostic.v1");
interface CacheDiagnosticHooks {
  /** Whether inbound bodies are actually recorded; the hook is registered at import either way. */
  enabled(): boolean;
  observeInbound(body: unknown, headers: Headers, source: PromptCacheKeySource, admissionPrincipal?: string): CacheDiagnosticDraft;
  rebind(body: unknown, draft: CacheDiagnosticDraft | undefined): void;
  observeContextTokens?(draft: CacheDiagnosticDraft | undefined, contextTokens: ContextTokenBreakdown): void;
  finalize(facts: CacheDiagnosticFinalFacts): void;
}
function cacheDiagnosticHooks(): CacheDiagnosticHooks | undefined {
  return (globalThis as Record<symbol, CacheDiagnosticHooks | undefined>)[CACHE_DIAGNOSTIC_HOOK];
}

import type { RequestLogContext, RequestLogEntry } from "./request-log-types";
export type { RequestLogContext, RequestLogEntry } from "./request-log-types";
import {
  beginRequestAttempt,
  contextWindowForModel,
  finalizedUsage,
  finishRequestAttempt,
  keyUsageOwners,
  noteAttemptSend,
  noteProviderAttemptSend,
  recordAttemptCredentialSource,
  recordKeyAttemptUsage,
  recordKeyWireAttemptUsage,
  requestLogErrorCode,
} from "./request-log-attempts";
export {
  beginRequestAttempt,
  finishRequestAttempt,
  noteAttemptSend,
  noteProviderAttemptSend,
  recordAttemptCredentialSource,
  recordKeyAttemptUsage,
  recordKeyWireAttemptUsage,
  requestLogErrorCode,
} from "./request-log-attempts";
import { httpStatusForTerminalStatus } from "./request-log-inspection";
export {
  applyResponseLogMetadata,
  catalogModelSupportsServiceTier,
  httpStatusForRequestLogTerminal,
  httpStatusForTerminalStatus,
  httpStatusFromTerminalError,
  inspectResponseLogJson,
  inspectResponseLogSsePayload,
  inspectResponseLogSsePayloadParsed,
  markLocalRequestLogRefusal,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  usageFromResponsesPayload,
} from "./request-log-inspection";

/** Whether the cache diagnostic recorder will record inbound bodies (`EASYPROXY_CACHE_DEBUG=1`). */
export function cacheDiagnosticsObserving(): boolean {
  return cacheDiagnosticHooks()?.enabled() === true;
}

export function observeCacheDiagnosticInbound(
  logCtx: RequestLogContext,
  body: unknown,
  headers: Headers,
  source: PromptCacheKeySource,
  admissionPrincipal?: string,
): void {
  const draft = cacheDiagnosticHooks()?.observeInbound(body, headers, source, admissionPrincipal);
  if (draft) logCtx.cacheDiagnosticDraft = draft;
}

/** Alias a rebuilt form of the request body to the request's diagnostic draft. */
export function rebindCacheDiagnosticBody(
  body: unknown,
  draft: CacheDiagnosticDraft | undefined,
): void {
  cacheDiagnosticHooks()?.rebind(body, draft);
}

/** Record content-free per-category input token scalars on the active diagnostic draft. */
export function observeCacheDiagnosticContextTokens(
  logCtx: RequestLogContext,
  contextTokens: ContextTokenBreakdown,
): void {
  if (!cacheDiagnosticsObserving() || !logCtx.cacheDiagnosticDraft) return;
  const hooks = cacheDiagnosticHooks();
  if (hooks?.observeContextTokens) {
    hooks.observeContextTokens(logCtx.cacheDiagnosticDraft, contextTokens);
  }
}

const requestLogRing = new Array<RequestLogEntry | undefined>(MAX_LOG_SIZE);
const requestLogRingBytes = new Float64Array(MAX_LOG_SIZE);
let requestLogHead = 0;
let requestLogCount = 0;
const requestLogObserversForTests = new Set<(entry: RequestLogEntry) => void>();
let requestLogBytes = 0;
/** True after hydrateRequestLogsFromDisk ran once in this process. */
let requestLogsHydratedFromDisk = false;

function retainedRequestLogBytes(entry: RequestLogEntry): number {
  return serializedJsonByteLength(entry);
}

function clearRequestLogRing(): void {
  requestLogRing.fill(undefined);
  requestLogRingBytes.fill(0);
  requestLogHead = 0;
  requestLogCount = 0;
  requestLogBytes = 0;
}

function removeOldestRequestLogEntry(): number {
  if (requestLogCount === 0) return 0;
  const entry = requestLogRing[requestLogHead];
  const bytes = requestLogRingBytes[requestLogHead]!;
  requestLogRing[requestLogHead] = undefined;
  requestLogRingBytes[requestLogHead] = 0;
  requestLogHead = (requestLogHead + 1) % MAX_LOG_SIZE;
  requestLogCount -= 1;
  requestLogBytes = Math.max(0, requestLogBytes - bytes);
  return entry ? bytes : 0;
}

function retainRequestLogEntry(entry: RequestLogEntry): void {
  const bytes = retainedRequestLogBytes(entry);
  if (requestLogCount === MAX_LOG_SIZE) {
    removeOldestRequestLogEntry();
  }
  const tail = (requestLogHead + requestLogCount) % MAX_LOG_SIZE;
  requestLogRing[tail] = entry;
  requestLogRingBytes[tail] = bytes;
  requestLogCount += 1;
  requestLogBytes += bytes;
  enforceAppOwnedMemoryBudget();
}

export function requestLogRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: requestLogCount,
    bytes: requestLogBytes,
    evictableBytes: requestLogBytes,
    pinnedBytes: 0,
    oldestAt: requestLogCount > 0 ? (requestLogRing[requestLogHead]?.timestamp ?? null) : null,
  };
}

export function evictOldestRequestLogForBudget(): number {
  return removeOldestRequestLogEntry();
}

function asTerminalStatus(value: string | undefined): ResponsesTerminalStatus | undefined {
  if (value === "completed" || value === "failed" || value === "incomplete") return value;
  return undefined;
}

function asCloseReason(value: string | undefined): RequestLogEntry["closeReason"] | undefined {
  switch (value) {
    case "terminal":
    case "client_cancel":
    case "non_stream":
    case "body_stall":
    case "body_overflow":
      return value;
    default:
      return undefined;
  }
}

/** Project a persisted usage.jsonl row back into the in-memory /api/logs shape. */
export function requestLogEntryFromPersistedUsage(entry: PersistedUsageEntry): RequestLogEntry {
  const terminalStatus = asTerminalStatus(entry.terminalStatus);
  const closeReason = asCloseReason(entry.closeReason);
  const routeDecision = normalizeRouteDecisionTraceForLog(entry.routeDecision);
  const jevDecision = normalizePersistedJevDecision(entry.jevDecision);
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(entry.claudeCompatibility);
  const spend = normalizeRequestSpend(entry.spend);
  const protocolTrace = parseProtocolTraceV1(entry.protocolTrace);
  // projectErrorDetail bounds the tier fields (top-level and per attempt) itself, so this stays safe
  // for a row that did not come through the disk reader; attempts are copied before it edits them.
  const attempts = Array.isArray(entry.attempts) ? entry.attempts.map(({ accountTag, ...attempt }) => ({ ...attempt,
    ...(isAnthropicAccountTag(accountTag) ? { accountTag } : {}) })) : entry.attempts;
  return projectErrorDetail({
    requestId: entry.requestId,
    ...(isLogicalRequestId(entry.logicalRequestId) ? { logicalRequestId: entry.logicalRequestId } : {}),
    timestamp: entry.timestamp,
    model: entry.model,
    provider: entry.provider,
    ...(Object.hasOwn(entry, "client") ? { client: normalizeRecordedClient(entry.client) ?? "unknown" } : {}),
    ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
    ...(entry.genStartMs !== undefined ? { genStartMs: entry.genStartMs } : {}),
    ...(entry.lastOutputMs !== undefined ? { lastOutputMs: entry.lastOutputMs } : {}),
    ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}), ...linkLogField(entry.link), ...requestBodyField(entry.requestBody),
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    ...(isCodexUsageAccountLogLabel(entry.accountLogLabel)
      ? { accountLogLabel: entry.accountLogLabel }
      : {}),
    ...(isAnthropicAccountTag(entry.accountTag) ? { accountTag: entry.accountTag } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(entry.requestedAlias ? { requestedAlias: entry.requestedAlias } : {}),
    ...(entry.shadowCallRewrittenFrom
      ? { shadowCallRewrittenFrom: entry.shadowCallRewrittenFrom }
      : {}),
    ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
    ...(entry.effectiveEffort ? { effectiveEffort: entry.effectiveEffort } : {}),
    ...(entry.reasoningWireField ? { reasoningWireField: entry.reasoningWireField } : {}),
    ...(entry.reasoningWireValue !== undefined ? { reasoningWireValue: entry.reasoningWireValue } : {}),
    ...(entry.callerServiceTier ? { callerServiceTier: entry.callerServiceTier } : {}),
    ...(entry.requestedServiceTier ? { requestedServiceTier: entry.requestedServiceTier } : {}),
    ...(entry.requestedSpeedLabel ? { requestedSpeedLabel: entry.requestedSpeedLabel } : {}),
    ...(entry.configuredServiceTier ? { configuredServiceTier: entry.configuredServiceTier } : {}),
    ...(entry.configuredSpeedLabel ? { configuredSpeedLabel: entry.configuredSpeedLabel } : {}),
    ...(entry.modelSupportsServiceTier !== undefined
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(entry.responseServiceTier ? { responseServiceTier: entry.responseServiceTier } : {}),
    ...(entry.tierOutcome ? { tierOutcome: entry.tierOutcome } : {}),
    ...modelIdentityLogFields(entry),
    status: entry.status,
    durationMs: entry.durationMs,
    // Closed code, condition, failure detail and quota reset; legacy upstream text is read once and dropped.
    ...errorDetailFor(entry),
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(closeReason ? { closeReason } : {}),
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(entry.attemptNormalizationDropped === true
      ? { attemptNormalizationDropped: true } : {}),
    ...(spend ? { spend } : {}),
    ...(isKnownCacheTelemetryProvenance(entry.cacheProvenance)
      ? { cacheProvenance: entry.cacheProvenance }
      : {}),
    ...persistedAffinityFields(entry),
    ...persistedCacheAffinityFields(entry),
    ...(isKnownTransportPhase(entry.transportPhase) ? { transportPhase: entry.transportPhase } : {}),
    ...(isKnownTerminalSource(entry.terminalSource) ? { terminalSource: entry.terminalSource } : {}),
    ...(routeDecision ? { routeDecision } : {}),
    ...(jevDecision ? { jevDecision } : {}),
    ...(claudeCompatibility ? { claudeCompatibility } : {}),
    ...(entry.conversationStateScrub === "account-change"
      ? { conversationStateScrub: "account-change" }
      : {}),
    ...normalizeRequestFailureAttribution(entry),
    ...(protocolTrace ? { protocolTrace } : {}),
  });
}

/**
 * Affinity survived only in memory before this: `addFinalRequestLog` set it on the row and the
 * field-by-field disk projection never named it, so the move that discarded a warm prefix was
 * gone at the next restart — the same whitelist trap #4592 hit one layer up.
 */
function persistedAffinityFields(
  entry: Pick<RequestLogEntry, "affinity" | "affinityReason">,
): Pick<PersistedUsageEntry, "affinity" | "affinityReason"> {
  if (!isKnownAffinityMove(entry.affinity)) return {};
  return {
    affinity: entry.affinity,
    ...(isKnownAffinityReason(entry.affinityReason) ? { affinityReason: entry.affinityReason } : {}),
  };
}

function persistedCacheAffinityFields(
  entry: Pick<RequestLogEntry, "cacheAffinity" | "cacheAffinityReason">,
): Pick<PersistedUsageEntry, "cacheAffinity" | "cacheAffinityReason"> {
  if (!isKnownCacheAffinity(entry.cacheAffinity)) return {};
  return {
    cacheAffinity: entry.cacheAffinity,
    ...(isKnownCacheAffinityReason(entry.cacheAffinityReason) ? { cacheAffinityReason: entry.cacheAffinityReason } : {}),
  };
}

/**
 * Hydration guard: persisted traces are re-normalized before they enter the
 * in-memory ring buffer so a hand-edited or corrupt row cannot poison the DTO.
 * A row that fails validation is dropped, never forwarded unvalidated.
 */
function normalizeRouteDecisionTraceForLog(
  entry: RouteDecisionTraceV1 | undefined,
): RouteDecisionTraceV1 | null {
  return entry ? normalizeRouteDecisionTrace(entry) : null;
}

/**
 * Seed the in-memory Logs ring buffer from usage.jsonl so GUI /api/logs survives
 * `epx stop` / `epx start` (process restart). Idempotent per process; no-ops when
 * the buffer already has live entries. Read failures are non-fatal (same as /api/usage).
 */
export function hydrateRequestLogsFromDisk(
  reader: () => PersistedUsageEntry[] = () => readRecentUsageEntries(MAX_LOG_SIZE),
): number {
  if (requestLogsHydratedFromDisk) return 0;
  if (requestLogCount > 0) {
    requestLogsHydratedFromDisk = true;
    return 0;
  }
  try {
    const persisted = reader();
    requestLogsHydratedFromDisk = true;
    if (persisted.length === 0) return 0;
    const slice = persisted.length > MAX_LOG_SIZE
      ? persisted.slice(persisted.length - MAX_LOG_SIZE)
      : persisted;
    for (const entry of slice) retainRequestLogEntry(requestLogEntryFromPersistedUsage(entry));
    return slice.length;
  } catch (err) {
    requestLogsHydratedFromDisk = true;
    console.warn(
      `[request-log] failed to hydrate from usage.jsonl: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Rebuild the Logs ring after retention deleted rows from the ledger.
 *
 * Without this a compaction is invisible where an operator actually looks: the ring holds up to
 * 2,000 entries independently of the file, so rows deleted from disk keep serving through
 * /api/logs until eviction or a restart -- the dashboard showing history the ledger no longer
 * has. Observers are deliberately not replayed; they exist to watch NEW rows arrive, and
 * replaying a rehydration through them would announce two thousand arrivals that did not happen.
 */
export function rehydrateRequestLogsAfterLedgerReplacement(
  reader: () => PersistedUsageEntry[] = () => readRecentUsageEntries(MAX_LOG_SIZE),
): number {
  clearRequestLogRing();
  requestLogsHydratedFromDisk = false;
  return hydrateRequestLogsFromDisk(reader);
}

export function addRequestLog(entry: RequestLogEntry) {
  // Rows keep proxy-owned error facts only; upstream error text and tokens stop here (both the
  // retained ring row and the usage.jsonl projection below read the projected entry).
  const attemptNormalizationDropped = entry.attemptNormalizationDropped === true, client = normalizeRecordedClient(entry.client) ?? "unknown";
  const clientDescriptor = Object.getOwnPropertyDescriptor(entry, "client");
  if (!Object.isFrozen(entry) || !clientDescriptor?.enumerable || !("value" in clientDescriptor) || clientDescriptor.value !== client || Object.values(Object.getOwnPropertyDescriptors(entry)).some(descriptor => !("value" in descriptor))) {
    entry = { ...entry, ...errorDetailFor(entry), client, ...(attemptNormalizationDropped ? { attemptNormalizationDropped: true } : {}) };
  }
  entry = projectErrorDetail(entry);
  if (attemptNormalizationDropped && entry.attemptNormalizationDropped !== true) entry = { ...entry, attemptNormalizationDropped: true };
  // Sanitize ONCE, at the ingress, and use that one value for both destinations.
  //
  // `addFinalRequestLog` is not the only way in: `addRequestLog` is exported and callable
  // directly, and it retained the caller's entry verbatim in the in-memory ring while only the
  // field-by-field disk projection below saw a sanitized value. That split let `/api/logs`
  // serve a raw upstream-supplied marker — a newline in it can forge a record boundary in a
  // line-oriented viewer — while `usage.jsonl` looked clean, which is the worst shape for a
  // sanitization bug because the safe surface is the one you check.
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(entry.shadowCallRewrittenFrom);
  const identity = modelIdentityLogFields(entry), servedModel = identity.servedModel;
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(entry.claudeCompatibility);
  const jevDecision = normalizePersistedJevDecision(entry.jevDecision);
  const attempts = normalizedAttempts(entry.attempts);
  const attemptsDropped = Array.isArray(entry.attempts) && attempts.length < entry.attempts.length;
  const retained: RequestLogEntry = shadowCallRewrittenFrom === entry.shadowCallRewrittenFrom
    && servedModel === entry.servedModel && identity.resolvedModel === entry.resolvedModel
    && entry.claudeCompatibility === undefined
    && entry.jevDecision === undefined
    && !attemptsDropped
    ? entry
    : { ...entry, ...(entry.attemptNormalizationDropped === true || attemptsDropped ? { attemptNormalizationDropped: true } : {}),
      ...(shadowCallRewrittenFrom ? { shadowCallRewrittenFrom } : {}) };
  if (!shadowCallRewrittenFrom && retained !== entry) delete retained.shadowCallRewrittenFrom;
  if (retained !== entry) { if (!servedModel) delete retained.servedModel; if (!identity.resolvedModel) delete retained.resolvedModel; }
  if (claudeCompatibility) retained.claudeCompatibility = claudeCompatibility;
  else if (retained !== entry) delete retained.claudeCompatibility;
  if (jevDecision) retained.jevDecision = jevDecision;
  else if (retained !== entry) delete retained.jevDecision;
  entry = retained;
  retainRequestLogEntry(entry);
  for (const observer of requestLogObserversForTests) {
    try { observer(entry); } catch { /* test observation must never fail request logging */ }
  }
  try {
    // Failure diagnostics survive the 200-entry ring buffer by riding the persisted
    // usage entry (devlog/_plan/260716_claudecode_hardening/030). Success rows stay
    // in their existing shape; the >=400 gate deliberately includes 499 client-cancels.
    const failureDiagnostics = entry.status >= 400 || (entry.terminalStatus && entry.terminalStatus !== "completed")
      ? {
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
        ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
        ...(entry.upstreamCondition ? { upstreamCondition: entry.upstreamCondition } : {}), ...(entry.failureDetail ? { failureDetail: entry.failureDetail } : {}),
        ...(entry.rateLimitResetAt !== undefined ? { rateLimitResetAt: entry.rateLimitResetAt } : {}),
      }
      : {};
    appendUsageEntry({
      requestId: entry.requestId,
      ...(isLogicalRequestId(entry.logicalRequestId) ? { logicalRequestId: entry.logicalRequestId } : {}),
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      client: entry.client ?? "unknown",
      ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}),
      // This function REBUILDS the persisted row field by field rather than
      // spreading it, so a field missing here reaches /api/logs and never
      // reaches usage.jsonl — which is where the per-key rollup reads from.
      ...(entry.apiKeyId ? { apiKeyId: entry.apiKeyId } : {}),
      ...(isKnownAdmissionKind(entry.admissionKind) ? { admissionKind: entry.admissionKind } : {}),
      ...(isKnownInboundProtocol(entry.inboundProtocol) ? { inboundProtocol: entry.inboundProtocol } : {}), ...linkLogField(entry.link), ...requestBodyField(entry.requestBody),
      ...(isCodexUsageAccountLogLabel(entry.accountLogLabel)
        ? { accountLogLabel: entry.accountLogLabel }
        : {}),
      ...(isAnthropicAccountTag(entry.accountTag) ? { accountTag: entry.accountTag } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
      ...(entry.servedModel ? { servedModel: entry.servedModel } : {}),
      ...(entry.wireModel ? { wireModel: entry.wireModel } : {}),
      ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
      ...(entry.requestedAlias ? { requestedAlias: entry.requestedAlias } : {}),
      ...(entry.shadowCallRewrittenFrom
        ? { shadowCallRewrittenFrom: entry.shadowCallRewrittenFrom }
        : {}),
      ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
      ...(entry.effectiveEffort ? { effectiveEffort: entry.effectiveEffort } : {}),
      ...(entry.reasoningWireField ? { reasoningWireField: entry.reasoningWireField } : {}),
      ...(entry.reasoningWireValue !== undefined ? { reasoningWireValue: entry.reasoningWireValue } : {}),
      ...(entry.callerServiceTier ? { callerServiceTier: entry.callerServiceTier } : {}),
      ...(entry.requestedServiceTier ? { requestedServiceTier: entry.requestedServiceTier } : {}),
      ...(entry.requestedSpeedLabel ? { requestedSpeedLabel: entry.requestedSpeedLabel } : {}),
      ...(entry.configuredServiceTier ? { configuredServiceTier: entry.configuredServiceTier } : {}),
      ...(entry.configuredSpeedLabel ? { configuredSpeedLabel: entry.configuredSpeedLabel } : {}),
      ...(entry.modelSupportsServiceTier !== undefined
        ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
        : {}),
      ...(entry.responseServiceTier ? { responseServiceTier: entry.responseServiceTier } : {}),
      ...(entry.tierOutcome ? { tierOutcome: entry.tierOutcome } : {}),
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
      ...(entry.genStartMs !== undefined ? { genStartMs: entry.genStartMs } : {}),
      ...(entry.lastOutputMs !== undefined ? { lastOutputMs: entry.lastOutputMs } : {}),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
      ...(entry.attempts !== undefined ? { attempts: entry.attempts } : {}),
    ...(entry.attemptNormalizationDropped === true
      ? { attemptNormalizationDropped: true } : {}),
      ...(entry.spend ? { spend: entry.spend } : {}),
      ...(isKnownCacheTelemetryProvenance(entry.cacheProvenance)
        ? { cacheProvenance: entry.cacheProvenance }
        : {}),
      ...persistedAffinityFields(entry),
      ...persistedCacheAffinityFields(entry),
      ...(isKnownTransportPhase(entry.transportPhase) ? { transportPhase: entry.transportPhase } : {}),
      ...(isKnownTerminalSource(entry.terminalSource) ? { terminalSource: entry.terminalSource } : {}),
      ...failureDiagnostics,
      // Rebuilt explicitly, like every other field here: this function does not spread the
      // entry, so a pair omitted at this line would reach /api/logs and never reach
      // usage.jsonl, which is the surface the derived failure projection reads.
      ...normalizeRequestFailureAttribution(entry),
      ...(entry.routeDecision ? { routeDecision: entry.routeDecision } : {}),
      ...(entry.jevDecision ? { jevDecision: entry.jevDecision } : {}),
      ...(entry.claudeCompatibility ? { claudeCompatibility: entry.claudeCompatibility } : {}),
      ...(entry.protocolTrace ? { protocolTrace: entry.protocolTrace } : {}),
      ...(entry.conversationStateScrub === "account-change"
        ? { conversationStateScrub: "account-change" }
        : {}),
    });
  } catch {
    /* request logging must never fail a user request */
  }
}

/** Test-only finalized-row observation without polling the management projection. */
export function observeRequestLogsForTests(observer: (entry: RequestLogEntry) => void): () => void {
  requestLogObserversForTests.add(observer);
  return () => { requestLogObserversForTests.delete(observer); };
}

export function nextRequestLogId(_timestamp = Date.now()): string {
  return `epx-${randomBytes(16).toString("hex")}`;
}

/**
 * One-shot TTFT recorder (WP4). Records the first non-empty model output moment
 * relative to the request start, and — when a combo attempt is in flight —
 * relative to that attempt's start as well. Later calls are no-ops, so both the
 * bridge callback and the deferred SSE tap may fire without double-recording.
 */
export function recordFirstOutput(
  logCtx: RequestLogContext,
  requestStartedAt: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(requestStartedAt) || !Number.isFinite(now)) return;
  const requestElapsed = Math.max(0, now - requestStartedAt);
  if (logCtx.firstOutputMs === undefined) logCtx.firstOutputMs = requestElapsed;
  if (logCtx.activeAttempt && !sealedCredentialRefusals.has(logCtx.activeAttempt) && logCtx.activeAttempt.firstOutputMs === undefined) {
    const attemptStartedAt = logCtx.activeAttemptStartedAt ?? requestStartedAt;
    logCtx.activeAttempt.firstOutputMs = Math.max(0, now - attemptStartedAt);
  }
}

/** Snapshot target-specific requested effort even for runTurn adapters with no AdapterRequest. */
export function recordAttemptRequestedEffort(logCtx: RequestLogContext): void {
  const attempt = logCtx.activeAttempt;
  if (!attempt || sealedCredentialRefusals.has(attempt)) return;
  delete attempt.requestedEffort;
  try {
    if (typeof logCtx.requestedEffort === "string" && logCtx.requestedEffort) {
      attempt.requestedEffort = redactSecretString(logCtx.requestedEffort).slice(0, 64);
    }
  } catch {
    // Request logging is best-effort and must not affect request delivery.
  }
}

/** Copy the adapter's exact outbound reasoning parameter into the durable request log. */
export function recordAdapterReasoning(
  logCtx: RequestLogContext,
  request: AdapterRequest,
): void {
  if (logCtx.activeAttempt && sealedCredentialRefusals.has(logCtx.activeAttempt)) return;
  delete logCtx.effectiveEffort;
  delete logCtx.reasoningWireField;
  delete logCtx.reasoningWireValue;
  const attempt = logCtx.activeAttempt;
  if (attempt) {
    delete attempt.effectiveEffort;
    delete attempt.reasoningWireField;
    delete attempt.reasoningWireValue;
  }
  recordAttemptRequestedEffort(logCtx);

  // Diagnostics must never make an otherwise valid upstream request fail. Config files
  // written by older versions (or edited by hand) can contain values that violate the
  // current TypeScript shape, so validate the runtime object before redacting strings.
  try {
    const raw: unknown = request.reasoningLog;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const reasoning = raw as Record<string, unknown>;
    if (typeof reasoning.effectiveEffort !== "string" || !reasoning.effectiveEffort
      || (reasoning.wireField !== "reasoning_effort"
        && reasoning.wireField !== "reasoning.enabled"
        && reasoning.wireField !== "reasoning.effort"
        && reasoning.wireField !== "thinking_budget"
        && reasoning.wireField !== "thinking.type")
      || !isValidReasoningWireValue(reasoning.wireField, reasoning.wireValue)) {
      return;
    }

    const effectiveEffort = redactSecretString(reasoning.effectiveEffort).slice(0, 64);
    const wireValue = typeof reasoning.wireValue === "string"
      ? redactSecretString(reasoning.wireValue).slice(0, 64)
      : reasoning.wireValue;
    logCtx.effectiveEffort = effectiveEffort;
    logCtx.reasoningWireField = reasoning.wireField;
    logCtx.reasoningWireValue = wireValue;
    if (attempt) {
      attempt.effectiveEffort = effectiveEffort;
      attempt.reasoningWireField = reasoning.wireField;
      attempt.reasoningWireValue = wireValue;
    }
  } catch {
    // Request logging is best-effort and must not affect request delivery.
  }
}

/** Attach the serializing adapter's tier observation to the active durable attempt. */
export function recordAdapterTier(
  logCtx: RequestLogContext,
  request: AdapterRequest,
): void {
  recordAdapterTierMetadata(logCtx, request.tierLog);
}

/** Attach adapter-owned metadata for transports that expose no AdapterRequest (runTurn). */
export function recordAdapterTierMetadata(
  logCtx: RequestLogContext,
  metadata: AdapterTierMetadata | undefined,
): void {
  if (logCtx.activeAttempt && sealedCredentialRefusals.has(logCtx.activeAttempt)) return;
  delete logCtx.tierOutcome;
  delete logCtx.activeTierMetadata;
  const attempt = logCtx.activeAttempt;
  if (attempt) delete attempt.tierOutcome;

  try {
    const outcome = metadata?.outcome;
    if (!metadata || !outcome) return;
    logCtx.tierOutcome = outcome;
    logCtx.activeTierMetadata = metadata;
    if (attempt) attempt.tierOutcome = outcome;
  } catch {
    // Request logging is best-effort and must not affect request delivery.
  }
}

/**
 * Aggregate one logical request's upstream spend from the rows that recorded it.
 *
 * Attempts are the accounting source and combo children are attempts of the same context, so a
 * sum over `logCtx.attempts` is the send count for one user turn — the number the amplification
 * in #4546 is measured in. A terminal status is what makes a send explainable, so the split is
 * drawn there rather than at success: a 502 is settled spend, an attempt abandoned in flight is
 * not. The budget's own counter is folded in as `reserved` because a leg that re-sent without
 * opening an attempt row is charged and unobserved, and that difference belongs in
 * `unresolved` rather than quietly inflating `settled`.
 */
export function requestSpendRecord(
  logCtx: Pick<RequestLogContext, "executionBudget" | "affinityMoveReasons" | "affinityReason" | "affinity">,
  attempts: readonly PersistedUsageAttempt[] | undefined,
): PersistedRequestSpend | undefined {
  const rows = attempts ?? [];
  const budget = logCtx.executionBudget;
  const reasons = [...new Set(
    (logCtx.affinityMoveReasons ?? (logCtx.affinity !== "unbound" && logCtx.affinityReason ? [logCtx.affinityReason] : []))
      .filter(isKnownAffinityReason),
  )];
  if (rows.length === 0 && !budget && reasons.length === 0) return undefined;
  const sends = rows.reduce((total, attempt) => total + attempt.sendCount, 0);
  const settled = rows.reduce(
    (total, attempt) => attempt.status >= 100 ? total + attempt.sendCount : total,
    0,
  );
  const charged = Math.max(sends, budget?.used ?? 0);
  return {
    sends,
    settled,
    unresolved: Math.max(0, charged - settled),
    ...(budget ? { reserved: budget.used, policyVersion: budget.policyVersion } : {}),
    ...(reasons.length > 0 ? { moveReasons: reasons } : {}),
  };
}

/**
 * Record an affinity decision so both the row's final answer and the sequence survive. A request
 * that moved for `quota_refusal` and then again for `transient` paid for two discarded prefixes,
 * and the single-valued field can only report the second.
 */
export function noteAffinityMove(
  logCtx: RequestLogContext,
  move: CodexAffinityMove,
  reason: CodexAffinityReason,
): void {
  logCtx.affinity = move;
  logCtx.affinityReason = reason;
  (logCtx.affinityMoveReasons ??= []).push(reason);
}

/**
 * Copy the selection's own affinity decision onto the request log. Both Pool-served kinds carry
 * one: a stored Pool account and the main login rotating as `main-pool` (#4546, #7799). A keyed
 * caller-owned main can also carry one. A move reads as an event with its cause.
 */
export function noteCodexSelectionAffinity(logCtx: RequestLogContext, authCtx: CodexAuthContext): void {
  const decision = authCtx.affinityDecision;
  if (!decision) return;
  logCtx.affinity = decision.move;
  logCtx.affinityReason = decision.reason;
}

/**
 * The affinity scope a released binding belonged to: one thread, one model lane.
 *
 * Both halves are part of the key. A thread holds a separate binding per model lane, so a
 * quota refusal on one lane and a transient streak on another are two releases; keyed by thread
 * alone the second overwrites the first and one of the two rows reports a cause that never
 * happened on it.
 */
export interface AffinityModelLane {
  model: string;
  /** Thread/conversation that owns the binding; omitted when the caller has no thread identity. */
  conversationId?: string;
}

/**
 * Release reasons waiting for the request that can report them (#4546, #4598).
 *
 * Bounded like the routing-side map it mirrors: this is a diagnostic, and an unbounded map keyed
 * by conversation is a leak.
 */
const pendingNoAccountReasons = new Map<string, CodexAffinityReason>();
const MAX_PENDING_NO_ACCOUNT_REASONS = 1024;

function affinityLaneKey(lane: AffinityModelLane): string {
  return `${lane.conversationId ?? ""}\u0000${lane.model}`;
}

export function noteNoAccountAffinityReason(lane: AffinityModelLane, reason: CodexAffinityReason): void {
  if (!isKnownAffinityReason(reason)) return;
  const key = affinityLaneKey(lane);
  if (!pendingNoAccountReasons.has(key) && pendingNoAccountReasons.size >= MAX_PENDING_NO_ACCOUNT_REASONS) {
    const oldest = pendingNoAccountReasons.keys().next();
    if (!oldest.done) pendingNoAccountReasons.delete(oldest.value);
  }
  pendingNoAccountReasons.set(key, reason);
}

/** Read and forget one lane's reason. Other lanes on the same thread keep theirs. */
export function takeNoAccountAffinityReason(lane: AffinityModelLane): CodexAffinityReason | undefined {
  const key = affinityLaneKey(lane);
  const reason = pendingNoAccountReasons.get(key);
  if (reason !== undefined) pendingNoAccountReasons.delete(key);
  return reason;
}

/** Test-only process-state reset for isolated harnesses. */
export function clearNoAccountAffinityReasonsForTests(): void {
  pendingNoAccountReasons.clear();
}

/**
 * Report a selection that produced no account, on the request that failed because of it.
 *
 * A no-account resolve reaches no auth context, so until now its cause was handed to whichever
 * later resolve happened to succeed — and a pool that stays exhausted never produces one, leaving
 * the failure permanently unexplained. Attaching the reason to THIS request's own record is what
 * makes the failure self-describing: the row is written, persisted and hydrated like any other,
 * and it survives a restart.
 *
 * Deliberately not a separate synthetic row. `/api/usage` counts one row as one request, so an
 * extra event row would report a request that never existed and skew the very cost totals this
 * work exists to make trustworthy.
 */
export function recordNoAccountAffinityFailure(
  logCtx: RequestLogContext,
  lane: AffinityModelLane,
  reason?: CodexAffinityReason,
): CodexAffinityReason | undefined {
  const resolved = isKnownAffinityReason(reason) ? reason : takeNoAccountAffinityReason(lane);
  if (resolved === undefined) return undefined;
  noteAffinityMove(logCtx, "cleared", resolved);
  logCtx.errorCode ??= "codex_no_account";
  return resolved;
}
type FinalRequestLogMetaArg = Pick<RequestLogEntry, "terminalStatus" | "closeReason">;
const finalRequestLogInterceptors = new WeakMap<RequestLogContext, (status: number, meta?: FinalRequestLogMetaArg) => void>();

/** Route inner final-log requests to an outer owner (native ingress) instead of writing them. */
export function interceptFinalRequestLog(logCtx: RequestLogContext, onRequest: (status: number, meta?: FinalRequestLogMetaArg) => void): void {
  finalRequestLogInterceptors.set(logCtx, onRequest);
}

/** The outer owner's write: request-level status from the outer outcome, the physical attempt's from the inner one. */
export function commitInterceptedFinalRequestLog(
  requestId: string, start: number, logCtx: RequestLogContext, status: number, meta: FinalRequestLogMetaArg | undefined,
  attemptStatus: number, addLog: (entry: RequestLogEntry) => void = addRequestLog,
): void {
  writeFinalRequestLog(requestId, start, logCtx, status, meta, addLog, attemptStatus);
}

export function addFinalRequestLog(
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  status: number,
  meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
): void {
  const intercept = finalRequestLogInterceptors.get(logCtx);
  if (intercept) { intercept(status, meta); return; }
  writeFinalRequestLog(requestId, start, logCtx, status, meta, addLog); notifyLinkTurnFinal(logCtx, meta?.terminalStatus);
}

function writeFinalRequestLog(
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  status: number,
  meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
  attemptStatus?: number,
): void {
  // Mid-stream web-search aborts used to emit response.failed and land as 502/upstream_server_error.
  // Prefer the client-close classification whenever the captured reason says so.
  // A coordinated (attemptStatus) write carries an authoritative outer outcome; skip the heuristic.
  const effectiveStatus = attemptStatus === undefined && status >= 500 && logCtx.upstreamError && isClientClosedMessage(logCtx.upstreamError)
    ? 499
    : status;
  // Locally assigned codes name proxy refusals that status and upstream text cannot reconstruct.
  const errorCode = logCtx.errorCode ?? bareVerdictRowErrorCode(logCtx) ?? requestLogErrorCode(
    effectiveStatus,
    logCtx.upstreamError,
    logCtx.terminalErrorCode,
    logCtx.causeHint === "transport-ambiguous" && logCtx.terminalSource === "synthetic",
  );
  // A response.failed whose classified status is 499 is still a client cancel, not an upstream
  // terminal failure — keep /api/logs closeReason aligned with that.
  const closeReason = effectiveStatus === 499
    ? "client_cancel"
    : meta?.closeReason;
  const sealedRefusal = retainRefusedAccount(logCtx);
  if (logCtx.activeAttempt && !sealedRefusal) {
    finishRequestAttempt(
      logCtx.activeAttempt,
      attemptStatus ?? effectiveStatus,
      Date.now() - (logCtx.activeAttemptStartedAt ?? start),
      keyUsageOwners.has(logCtx.activeAttempt)
        ? logCtx.activeAttempt.usage
        : logCtx.usage,
    );
    // The final row and its active physical attempt describe the same terminal. Preserve the
    // semantic code on both so detailed attempt telemetry cannot regress to a generic status code.
    const attemptErrorCode = attemptStatus === undefined ? errorCode : attemptStatus < 400 ? undefined
      : logCtx.errorCode ?? bareVerdictRowErrorCode(logCtx) ?? requestLogErrorCode(attemptStatus, logCtx.upstreamError, logCtx.terminalErrorCode, false);
    if (attemptErrorCode) logCtx.activeAttempt.errorCode = attemptErrorCode;
    else delete logCtx.activeAttempt.errorCode;
  }
  // Derived and stamped in a sibling module, before the attempt snapshot below. Every input is
  // a closed value; the open error strings are deliberately not among them.
  const attribution = attributeFinalRequest({
    status: effectiveStatus,
    ...(meta?.terminalStatus ? { terminalStatus: meta.terminalStatus } : {}),
    ...(closeReason ? { closeReason } : {}),
    ...(logCtx.transportPhase ? { transportPhase: logCtx.transportPhase } : {}),
    ...(logCtx.terminalSource ? { terminalSource: logCtx.terminalSource } : {}),
    outputObserved: logCtx.firstOutputMs !== undefined,
    ...(logCtx.causeHint ? { causeHint: logCtx.causeHint } : {}),
    locallyAnswered: logCtx.localTerminalReason !== undefined,
    // A coordinated write derives the request pair from a copy and re-derives the attempt's own.
    ...(logCtx.activeAttempt ? { attempt: attemptStatus === undefined ? logCtx.activeAttempt : { ...logCtx.activeAttempt } } : {}),
  });
  if (attemptStatus !== undefined && logCtx.activeAttempt && !sealedRefusal) attributePhysicalAttempt(logCtx.activeAttempt);
  // The one seam every request passes exactly once, whatever transport served it and however
  // it ended. The ledger gives per-send usage precedence over terminal usage and keeps unknown
  // physical spend unresolved.
  logCtx.spendTracker?.settle(logCtx.usage);
  const existing = finalizedUsage(
    logCtx.providerAdapter ?? logCtx.provider,
    logCtx.usage,
    logCtx.usageLogInputTokens,
    contextWindowForModel(logCtx.providerAdapter ?? logCtx.provider, logCtx.model),
    logCtx.localTerminalReason !== undefined,
  );
  const attempts = logCtx.attempts?.map(attempt => ({
    ...attempt,
    recoveryKinds: [...attempt.recoveryKinds],
    ...(attempt.recoveryWithheld?.length ? { recoveryWithheld: [...attempt.recoveryWithheld] } : {}),
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
    ...(attempt.tierOutcome ? { tierOutcome: { ...attempt.tierOutcome } } : {}),
    // Detached, like every mutable field beside it: the live summary keeps counting if the
    // stream is still draining, and a shared reference would let a finalized row change after
    // it was written.
    ...(attempt.deliverySummary ? { deliverySummary: { ...attempt.deliverySummary } } : {}),
  }));
  const isCombo = logCtx.comboId !== undefined && (attempts?.length ?? 0) > 0;
  // Rotations split usage across attempts. A detached recovery can be the only send, with no
  // active attempt or request-level usage. An ordinary single attempt keeps the row's usage.
  const aggregate = attempts?.length && (isCombo || (logCtx.localTerminalReason === undefined
    && (attempts.length > 1 || (!logCtx.activeAttempt && attempts[0]?.usage))))
    ? aggregateAttemptUsage(attempts)
    : null;
  const loggedUsage = aggregate?.usage ?? existing.usage;
  const usageStatus = aggregate?.status ?? existing.status;
  const totalTokens = aggregate?.totalTokens ?? existing.totalTokens;
  const spend = requestSpendRecord(logCtx, attempts);
  const durationMs = Date.now() - start;
  logCtx.requestMetricsRecorder?.recordFinalRequest({
    ...(logCtx.inboundProtocol ? { protocol: logCtx.inboundProtocol } : {}),
    status: effectiveStatus,
    durationMs,
    ...(logCtx.firstOutputMs !== undefined ? { firstOutputMs: logCtx.firstOutputMs } : {}),
    ...(meta?.terminalStatus ? { terminalStatus: meta.terminalStatus } : {}),
    ...(closeReason ? { closeReason } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(spend ? { spendSends: spend.sends } : {}),
    ...(attribution.failureCause ? { failureCause: attribution.failureCause } : {}),
  });
  const cacheProvenance = classifyCacheTelemetryProvenance(loggedUsage, {
    wireParsed: logCtx.usageWireParsed === true,
  });
  const logicalRequestId = logCtx.logicalRequestId ?? logCtx.executionBudget?.logicalRequestId;
  const normalizedCacheValue = loggedUsage?.cacheReadInputTokens ?? loggedUsage?.cachedInputTokens;
  cacheDiagnosticHooks()?.finalize({
    requestId,
    ...(isLogicalRequestId(logicalRequestId) ? { logicalRequestId } : {}),
    protocol: logCtx.inboundProtocol ?? "responses",
    provider: logCtx.provider,
    model: logCtx.model,
    ...(isCodexUsageAccountLogLabel(logCtx.accountLogLabel) ? { accountLogLabel: logCtx.accountLogLabel } : {}),
    ...(logCtx.affinity ? { affinityMove: logCtx.affinity } : {}),
    ...(logCtx.affinityReason ? { affinityReason: logCtx.affinityReason } : {}),
    // loggedUsage carries the upstream cache counter by reference all the way from the
    // adapter extraction for the native Responses route, so an undefined read here is a
    // genuinely absent counter rather than a defaulted one.
    ...(normalizedCacheValue !== undefined ? { rawCacheCounterValue: normalizedCacheValue } : {}),
    ...(normalizedCacheValue !== undefined ? { normalizedCacheValue } : {}),
    cacheProvenance,
    ...(logCtx.cacheDiagnosticDraft ? { draft: logCtx.cacheDiagnosticDraft } : {}),
  });
  // Provider cache affinity: this is the one seam every request passes exactly
  // once with its terminal status, the credential that ultimately served (the
  // entry id captured beside the account label at each stamp, rotations
  // included), and cache usage already normalized from whichever adapter
  // answered. A success binds or refreshes the conversation on that
  // credential; a quota/auth terminal releases it so the next request is
  // placed fresh instead of re-offered a credential that just refused.
  finalizeProviderCacheAffinity(logCtx, effectiveStatus, logCtx.usage ?? loggedUsage);
  // Sanitize at the logging layer, not only at the one call site that populates this today.
  // The value originates in an upstream-supplied model id, so an unsanitized newline would
  // let a single field forge a record boundary in any line-oriented log viewer. Doing it here
  // means a future caller cannot reintroduce the hole by forgetting to sanitize first, and
  // the in-memory /api/logs row matches what usage.jsonl already stores.
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(logCtx.shadowCallRewrittenFrom);
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(logCtx.claudeCompatibility);
  const jevDecision = normalizePersistedJevDecision(logCtx.jevDecision);
  // Keyed by the live attempt objects, not the detached copies above.
  const protocolTrace = protocolTraceForRequest(logCtx, logCtx.attempts);
  // Projected before any writer (an injected one too): the row keeps only proxy-owned error facts.
  reportCommittedTerminalCooldown(logCtx, meta, attempts, effectiveStatus);
  const finalEntry = projectErrorDetail<RequestLogEntry>({
    requestId,
    ...(isLogicalRequestId(logicalRequestId) ? { logicalRequestId } : {}),
    timestamp: start,
    model: isCombo ? logCtx.requestedModel! : logCtx.model,
    provider: isCombo ? "combo" : logCtx.provider,
    client: normalizeRecordedClient(logCtx.client) ?? "unknown",
    ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    ...(logCtx.apiKeyId ? { apiKeyId: logCtx.apiKeyId } : {}),
    ...(logCtx.admissionKind ? { admissionKind: logCtx.admissionKind } : {}),
    ...(logCtx.inboundProtocol ? { inboundProtocol: logCtx.inboundProtocol } : {}), ...linkLogField(logCtx.link), ...requestBodyLogField(logCtx),
    ...(logCtx.localTerminalReason
      ? { localTerminalReason: sanitizeLogMetadataString(logCtx.localTerminalReason) }
      : {}),
    ...(isCodexUsageAccountLogLabel(logCtx.accountLogLabel)
      ? { accountLogLabel: logCtx.accountLogLabel }
      : {}),
    ...anthropicAccountTagField(isCombo ? undefined : logCtx.provider),
    ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
    ...(logCtx.requestedModel ? { requestedModel: logCtx.requestedModel } : {}),
    ...(logCtx.requestedAlias ? { requestedAlias: logCtx.requestedAlias } : {}),
    ...(shadowCallRewrittenFrom ? { shadowCallRewrittenFrom } : {}),
    ...(logCtx.requestedEffort ? { requestedEffort: logCtx.requestedEffort } : {}),
    ...(logCtx.effectiveEffort ? { effectiveEffort: logCtx.effectiveEffort } : {}),
    ...(logCtx.reasoningWireField ? { reasoningWireField: logCtx.reasoningWireField } : {}),
    ...(logCtx.reasoningWireValue !== undefined ? { reasoningWireValue: logCtx.reasoningWireValue } : {}),
    ...(logCtx.callerServiceTier ? { callerServiceTier: logCtx.callerServiceTier } : {}),
    ...(logCtx.requestedServiceTier ? { requestedServiceTier: logCtx.requestedServiceTier } : {}),
    ...(logCtx.requestedSpeedLabel ? { requestedSpeedLabel: logCtx.requestedSpeedLabel } : {}),
    ...(logCtx.configuredServiceTier ? { configuredServiceTier: logCtx.configuredServiceTier } : {}),
    ...(logCtx.configuredSpeedLabel ? { configuredSpeedLabel: logCtx.configuredSpeedLabel } : {}),
    ...(logCtx.modelSupportsServiceTier !== undefined ? { modelSupportsServiceTier: logCtx.modelSupportsServiceTier } : {}),
    ...(logCtx.responseServiceTier ? { responseServiceTier: logCtx.responseServiceTier } : {}),
    ...((attempts?.at(-1)?.tierOutcome ?? logCtx.tierOutcome)
      ? { tierOutcome: attempts?.at(-1)?.tierOutcome ?? { ...logCtx.tierOutcome! } }
      : {}),
    ...modelIdentityLogFields(logCtx),
    status: effectiveStatus,
    durationMs,
    ...(logCtx.firstOutputMs !== undefined ? { firstOutputMs: logCtx.firstOutputMs } : {}),
    ...generationWindowFields(logCtx, start),
    ...(errorCode ? { errorCode } : {}),
    ...(meta?.terminalStatus ? { terminalStatus: meta.terminalStatus } : {}),
    ...(closeReason ? { closeReason } : {}),
    ...(logCtx.upstreamError && !upstreamErrorIsLocal(logCtx) ? { upstreamError: logCtx.upstreamError } : {}), ...(logCtx.failureDetail ? { failureDetail: logCtx.failureDetail } : {}),
    ...(logCtx.upstreamCondition && !upstreamErrorIsLocal(logCtx) ? { upstreamCondition: logCtx.upstreamCondition } : {}),
    // A local verdict's failed frame is proxy-authored; its code/type are not upstream diagnostics.
    ...(upstreamErrorIsLocal(logCtx) ? {} : upstreamDiagnosticLogFields(logCtx)), usageStatus,
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(spend ? { spend } : {}),
    // "unknown" is recorded rather than omitted whenever usage exists: a row that reported tokens
    // with no cache detail at all is a different fact from a row with no usage, and the summary
    // has to refuse both as a hit-rate denominator.
    ...(loggedUsage || cacheProvenance !== "unknown" ? { cacheProvenance } : {}),
    ...(logCtx.affinity ? { affinity: logCtx.affinity } : {}),
    ...(logCtx.affinityReason ? { affinityReason: logCtx.affinityReason } : {}),
    ...(logCtx.cacheAffinity ? { cacheAffinity: logCtx.cacheAffinity } : {}),
    ...(logCtx.cacheAffinityReason ? { cacheAffinityReason: logCtx.cacheAffinityReason } : {}),
    ...(logCtx.conversationStateScrub === "account-change"
      ? { conversationStateScrub: "account-change" }
      : {}),
    ...(logCtx.transportPhase ? { transportPhase: logCtx.transportPhase } : {}),
    ...(logCtx.terminalSource ? { terminalSource: logCtx.terminalSource } : {}),
    ...(logCtx.routeDecision ? { routeDecision: logCtx.routeDecision } : {}),
    ...(jevDecision ? { jevDecision } : {}),
    ...(claudeCompatibility ? { claudeCompatibility } : {}),
    ...(protocolTrace ? { protocolTrace } : {}),
    ...attribution,
  });
  addLog(finalEntry);
  settleApiKeyRequestBudget(logCtx, finalEntry, totalTokens, start);
  logCtx.otlpSpan?.finish({ status: effectiveStatus, finalEntry });
  // Formatted from the finalized snapshot, so the ring shows exactly what the ledger holds.
  for (const attempt of attempts ?? []) debugAttemptDeliverySummary(requestId, attempt);
  if (isUsageDebugEnabled()) {
    appendUsageDebug({
      ts: Date.now(),
      requestId,
      provider: logCtx.provider,
      model: logCtx.model,
      upstreamContentType: logCtx.usageDebugContentType ?? null,
      upstreamStatus: effectiveStatus,
      bodyKind: logCtx.usageDebugBodyKind ?? "none",
      bodySample: logCtx.usageDebugBodySample ?? "",
      extractedUsage: loggedUsage ?? null,
    });
  }
}

export function getRequestLogEntries(): RequestLogEntry[] {
  if (requestLogCount === 0) return [];
  const entries = new Array<RequestLogEntry>(requestLogCount);
  for (let i = 0; i < requestLogCount; i += 1) {
    entries[i] = requestLogRing[(requestLogHead + i) % MAX_LOG_SIZE]!;
  }
  return entries;
}

/** Test-only process-state reset for isolated integration harnesses. */
export function clearRequestLogsForTests(): void {
  clearRequestLogRing();
  requestLogsHydratedFromDisk = false;
  requestLogObserversForTests.clear();
}
