import { formatClientRetryAfter } from "../lib/client-retry-after";
import { requestOwnedAffinityKey, honestAffinityDecision, callerOwnedFallbackAffinityDecision, captureRequestOwnedAffinityBindings, type RequestOwnedBindingSnapshot } from "./request-owned-affinity";
import { requestOwnedMainPinState, mainCreditsHoldResetAt, callerMatchesObservedMain } from "./request-owned-main-pin";
export { requestOwnedMainPinState } from "./request-owned-main-pin";
import type { EpxRuntimeProviderConfig } from "./auth-context-provider";
export type { EpxRuntimeProviderConfig } from "./auth-context-provider";
export { stripCodexRuntimeProviderFields } from "./auth-context-provider";
import { bindPoolCreditPolicy, poolCreditHoldResetAt, poolContextCreditHoldResetAt, poolCreditRecoveryNeeded, poolContextCreditRecoveryNeeded, poolCreditRecoveryRetryAt } from "./pool-credit-policy";
import { nextQuotaQueryDelay } from "./quota-query-backoff";
import { noteMainAccountActivity } from "./main-account-external-usage";
import { codexAccountPriorityFailbackEnabled } from "./account-priority";
import type { PoolQuotaWriter } from "./quota-types";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshStaleError,
  getCodexAccountCredential,
  getValidCodexToken,
  capturePoolQuotaWriter,
  isCodexAccountGenerationLive,
  readCodexAccountRecord,
} from "./account-store";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { ConfigMutationLockError } from "../config";
import { NativeProfileError } from "./native-profile-types";
import { codexAccountUnusableReason, codexPoolOnlyExcludesMain, isCodexAccountUsable } from "./account-usability";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
  getMainAccountToken,
  getMainAccountCredentialStatus,
  getValidMainAccountToken,
  mainAccountTokenQuotaWriter,
  isMainAccountTokenLive,
  type NativeMainRefreshDependencies,
} from "./main-account";
import { isMainAccountPolicyBindingPending, isNativeMainTrafficBlocked, nativeMainStartupGateSnapshot } from "./native-profile-startup";
import type { NativeMainStartupBlockReason } from "./native-profile-startup";
import { waitForMainAccountPolicyBinding } from "./main-account-policy-wait";
import {
  codexQuotaScopeForModel,
  getCodexQuotaHealthSnapshot,
  releaseCodexQuotaProbeLease,
  releaseCodexQuotaScopeProbeLease,
  tryAcquireCodexQuotaProbeLease,
  tryAcquireCodexQuotaScopeProbeLease,
  pickAlternateCodexAccount,
  resolveCodexAccountForThreadDetailed,
  type CodexAffinityDecision,
  type CodexThreadResolution,
  type TransientProbeGrant,
} from "./routing";
// The half-open TRANSIENT-HOLD lease (#4701). Not the quota-cooldown probe lease imported from
// ./routing above -- different module, different domain, and a request never holds both.
import { releaseTransientProbe } from "../routing/probe-lease";
import { trackBackgroundWork } from "../lib/background-work";
import {
  codexConversationIdentity,
  recordCodexThreadLineage,
  resolveCodexThreadLineage,
  type CodexThreadLineage,
} from "./lineage";
import {
  cachedDeniedCodexAccountIdsForModel,
  entitledCodexAccountIdsForModel,
  isDirectCallerEntitledToCodexModel,
  resolveCodexModelEntitlements,
} from "./model-entitlements";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS, NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import type { CodexCooldownSource, CodexQuotaScope } from "./routing";
import { maskAccountId } from "../lib/privacy";
import { formatErrorResponse, formatUsageLimitReachedResponse } from "../bridge";
import { nextCodexPoolRecoveryAt } from "./routing/pool-recovery";
import { getAccountQuota, isValidWhamHistoryObservation, parseUsageQuota, parseMainPolicyUsageQuota, setAccountQuotaFromParsed } from "./quota";
import { codexAccountUsesCreditsAfterLimit } from "./account-credit-use";
import type { CodexAccountMode, EpxConfig, EpxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { isolateCodexPoolAccountHeaders } from "./forward-transport-headers";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { extractAccountId, extractEmail } from "../oauth/chatgpt";
import {
  resolveMainAccountHardLockThresholds,
  getMainAccountHardLockStatus,
  isMainAccountHardLockEnabled,
} from "./main-account-hard-lock";
import {
  captureMainAccountIdentityGeneration,
  captureMainQuotaWriter,
  captureMainQuotaDispatch,
  getObservedMainQuotaIdentityKey,
  isMainQuotaWriterLive,
  matchesMainQuotaCredential,
  observeMainQuotaCredential,
  type MainQuotaWriter,
  type MainQuotaDispatch,
} from "./main-account-cache";
import { CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE, isCodexReserveHelperUnsupported, isCodexReserveRequestEligible } from "./loopback-target";
import type { DataPlaneAdmission } from "../server/auth-cors";
import { getMainReserveAuthorization, isMainReserveAuthorizationLive, nativeUserIdClaims, type MainReserveAuthorization } from "./reserve-availability";
import { UpstreamRetryEvidenceError } from "../lib/upstream-retry";
import { CODEX_MAIN_DUPLICATE_ACTION, configuredCodexMainDuplicate } from "./collision-identity";
import { AgentAssertionUnsupportedError, authorizationCredential, hasAgentAssertionAuthorization } from "../lib/authorization-scheme";

import {
  assertCodexAccountValidationReady,
  assertMainAccountPolicy,
  assertPoolAccountCredits,
  authorizeReserveCredential,
  captureObservedMainWriter,
  CodexAccountCooldownError,
  type CodexAccountSelectionAdmission,
  type CodexAuthContext,
  CodexAuthContextError,
  type CodexAuthPolicyConfig,
  CodexDirectAuthenticationError,
  CodexMainAccountCreditsOffError,
  CodexMainAccountHardLockError,
  CodexMainProfileDrainingError,
  CodexModelAvailabilityError,
  CodexPoolAccountCreditsOffError,
  CodexPoolAuthenticationError,
  CodexRecoveryWithheldError,
  CodexReserveUnavailableError,
  CodexThreadAffinityExpiredError,
  cooldownAccountLabel,
  hasCallerCodexBearer,
  observeSelectedMainCredential,
  releaseCodexAuthContextProbeLease,
  requiresReserveAuthorization,
  selectedCodexToken,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
} from "./auth-context-errors";
import { materializeCodexUpstreamAuth } from "./auth-context-materialize";
export {
  __resetNativeMainFenceReasonLog,
  CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexMainAccountCreditsOffError,
  CodexMainAccountHardLockError,
  CodexMainProfileDrainingError,
  CodexMainSubstitutionUnavailableError,
  codexMainProfileDrainingResponse,
  CodexModelAvailabilityError,
  CodexPoolAccountCreditsOffError,
  CodexPoolAuthenticationError,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  CodexRecoveryWithheldError,
  CodexReserveHelperUnsupportedError,
  CodexReserveUnavailableError,
  CodexThreadAffinityExpiredError,
  codexTransientProbeGrant,
  cooldownAccountLabel,
  cooldownErrorMessage,
  cooldownErrorResponse,
  hasCallerCodexBearer,
  MAIN_HARD_LOCK_MIN_POOL_RETRY_MS,
  mainHardLockRetryAt,
  releaseCodexAuthContextProbeLease,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
  unwrapUpstreamRetryEvidenceError,
  type CodexAccountSelectionAdmission,
  type CodexAuthContext,
  type CodexAuthPolicyConfig,
  type CodexModelAvailabilityReason,
} from "./auth-context-errors";
export {
  applyCodexAuthContextToProvider,
  assertCodexAuthContextNotCooled,
  callerCodexWorkspaceAccountId,
  createCodexAuthDispatchGuard,
  createCodexReserveDispatchGuard,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  materializeCodexUpstreamAuth,
  materializeCodexUpstreamAuthAsync,
} from "./auth-context-materialize";

/**
 * One conversation tree keys as ONE cohort (#4780).
 *
 * session id, or `{source}:{parent_thread_id}` for an internal session -- and one `AgentControl`
 * whose `session_id` is the root thread's id is shared with every sub-agent. While the proxy
 * keyed per thread, two requests could carry an identical `prompt_cache_key` and be served by
 * different accounts, so the split member asserted a warm prefix that was deterministically cold
 * on its account. Nothing failed; the prompt was replayed in full and the tokens burned.
 *
 * THIS IS NOT A REVERT OF #4546 wp8. wp8 fixed a different defect -- a child bound under the RAW
 * parent id, an identity unrelated to the root's own binding, so siblings shared an entry the
 * root was not on and a grandchild landed on a key nobody had bound. A cohort key has no such
 * incoherence, because the root's own binding IS the cohort key. What wp8 additionally gave each
 * thread, a binding of its own, is what this deliberately gives up.
 *
 * Which requests produce no key at all is unchanged, through both units.
 *
 * The derivation itself lives in ./lineage so a lineage record's conversation key and the key
 * the thread actually binds under can never drift apart.
 */
export function codexPoolAffinityKey(headers: Headers, now = Date.now()): string | undefined {
  // `now` is threaded rather than read inside because a parent-only turn resolves its key
  // through the recorded lineage, and that record is TTL-bounded: a caller working against a
  // fixed clock would otherwise see a live record as expired and fall back to a key the parent
  // never bound under.
  return codexConversationIdentity(headers, now)?.conversationKey;
}

/** What a caller needs to know to answer the Pool-state question below before auth has run. */
export interface CodexPoolStateEligibility {
  /** An exact account selector from the route, i.e. `options.accountId` here. */
  readonly accountId?: string;
  readonly modelId?: string;
  readonly admission?: Pick<DataPlaneAdmission, "source">;
  /** The caller presented its own forwardable ChatGPT credential for this route. */
  readonly requestScopedMainCredential?: boolean;
}

/** The one expression both the resolution below and any preview must agree on. */
function poolStateEligible(
  fixedAccountId: string | undefined,
  requestScopedMainCredential: boolean,
): boolean {
  return fixedAccountId === undefined && !requestScopedMainCredential;
}

/**
 * Does main have a live credential for a request that carries main's own bearer?
 *
 * The one expression final authentication and every preview must agree on, for the same reason
 * `poolStateEligible` is: preview exists to predict the resolution, and a preview that scores main
 * differently hands subagent fallback a different account than the one that serves (#4850).
 *
 * A forwardable request-owned bearer IS main's live credential -- it is exactly what would be
 * sent if selection named main -- so the honest answer is yes, without reading the stored
 * credential. An effective manual pin answers yes as it always did. The answer is no while the
 * physical identity is fenced for a different reason, because retained recovery and a profile
 * drain must keep main out of routing even for a request holding its own bearer.
 */
export function requestOwnedMainCredentialIsLive(inputs: {
  preserveRequestOwnedMainPin: boolean;
  requestScopedMainCredential: boolean;
  nativeMainTrafficBlocked: boolean;
  mainProfileDraining: boolean;
  /**
   * The caller's own credential is one of the Pool subscriptions currently in cooldown.
   *
   * Final authentication only. Cooldown identity is not modelled by preview and never was --
   * `callerIsCooledPoolAccount` has no other caller -- because it decides a refusal rather than
   * which account serves, so a preview that scores main while the resolution refuses still hands
   * subagent fallback the right account. Passed explicitly at both preview sites so the asymmetry
   * is stated rather than inherited from a default.
   */
  callerOwnsCooledPoolSubscription: boolean;
}): boolean {
  return inputs.preserveRequestOwnedMainPin
    || (inputs.requestScopedMainCredential
      && !inputs.nativeMainTrafficBlocked
      && !inputs.mainProfileDraining
      && !inputs.callerOwnsCooledPoolSubscription);
}

/**
 * May this request use stored-credential Pool lineage?
 *
 * Two credentials authenticate outside stored Pool state: an exact account selector (including
 * Reserve) and a request-owned main bearer, which must never fold into durable account state.
 * Neither may read or write a stored-credential binding or lineage. The optional request-owned
 * affinity namespace is separate from this predicate.
 *
 * Exported so that a preview asks the question with the code that answers it, instead of a
 * restatement that can drift. It drifted once already: preview read a family relation from raw
 * request headers before this function had decided anything, so it could follow a Pool family
 * binding while the resolution below deliberately created no affinity -- and model fallback then
 * evaluated eligibility against an account the request would never be authenticated as.
 */
export function codexPoolStateEligible(
  headers: Headers,
  policy: CodexAuthPolicyConfig | undefined,
  options: CodexPoolStateEligibility = {},
): boolean {
  const reserve = requiresReserveAuthorization(policy, options.modelId, options.admission);
  return poolStateEligible(
    reserve ? MAIN_CODEX_ACCOUNT_ID : options.accountId,
    options.requestScopedMainCredential === true && hasCallerCodexBearer(headers),
  );
}

/** Shared affinity derivation for final authentication and both request previews. */
export function codexRequestAffinityKey(headers: Headers, config: EpxConfig, policy: CodexAuthPolicyConfig | undefined, options: CodexPoolStateEligibility = {}): string | undefined {
  if (options.accountId !== undefined || requiresReserveAuthorization(policy, options.modelId, options.admission)) return undefined;
  if (options.requestScopedMainCredential === true && hasCallerCodexBearer(headers)) {
    return config.codexPool?.requestOwnedAffinity === true ? requestOwnedAffinityKey(headers) : undefined;
  }
  return codexPoolAffinityKey(headers);
}

/**
 * The lineage a PREVIEW is allowed to see: read-only, and only for a request that may hold Pool
 * state. Recording is left to the resolution that actually binds, so a preview can never leave a
 * record behind for a request that turned out to own no Pool state at all.
 */
export function previewCodexPoolLineage(
  headers: Headers,
  policy: CodexAuthPolicyConfig | undefined,
  options: CodexPoolStateEligibility = {},
): CodexThreadLineage | undefined {
  return codexPoolStateEligible(headers, policy, options)
    ? resolveCodexThreadLineage(headers)
    : undefined;
}

/** Constant-time digest comparison so bearer bytes never drive branch timing. */
function sameCredentialMaterial(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * The early-cooldown caller-main fallback must not resurrect the subscription that is cooling
 * down. Fail closed on ambiguity: an unreadable caller identity cannot be distinguished from the
 * cooled account. A distinct workspace account id is always safe; an exact materialized
 * bearer + account tuple marks the same subscription. Beyond that, the stable native user id is
 * the strongest available evidence: it survives an email change and a token rotation, and it
 * separates members who share one workspace account id even when neither credential carries an
 * email. Email remains the fallback when no comparable user id exists on both sides. Coexisting
 * personal/business registrations with the same email and account id over-deny during the
 * cooldown — the safe direction.
 */
function callerIsCooledPoolAccount(headers: Headers, config: EpxConfig, accountId: string): boolean {
  const bearer = authorizationCredential(headers);
  if (!bearer) return true;
  const callerAccountId = headers.get("chatgpt-account-id") ?? extractAccountId(undefined, bearer);
  if (callerAccountId === undefined) return true;
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // No physical-main read to identify the caller: the observed-main equality tag suffices.
    return callerMatchesObservedMain(headers);
  }
  const stored = getCodexAccountCredential(accountId);
  const entry = config.codexAccounts?.find(account => account.id === accountId);
  const cooledAccountId = stored?.chatgptAccountId || entry?.chatgptAccountId;
  if (!cooledAccountId) return true;
  if (cooledAccountId !== callerAccountId) return false;
  if (stored?.accessToken && sameCredentialMaterial(bearer, stored.accessToken)) return true;
  // Same namespace on both sides, never `sub`: this is the ChatGPT per-user identity the reserve
  // path already trusts. A credential whose own two encodings of it disagree cannot identify
  // anyone, so it fails closed even when the disagreement is on the stored side.
  const callerUser = nativeUserIdClaims(bearer);
  const cooledUser = stored?.accessToken
    ? nativeUserIdClaims(stored.accessToken)
    : { userId: undefined, conflict: false };
  if (callerUser.conflict || cooledUser.conflict) return true;
  if (callerUser.userId !== undefined && cooledUser.userId !== undefined) {
    return callerUser.userId === cooledUser.userId;
  }
  const callerEmail = extractEmail(undefined, bearer)?.trim().toLowerCase() || undefined;
  const cooledEmail = entry?.email?.trim().toLowerCase() || undefined;
  if (callerEmail !== undefined && cooledEmail !== undefined) return callerEmail === cooledEmail;
  return true;
}

/**
 * Does the caller's own credential belong to a Pool subscription that is currently cooled?
 *
 * The cooldown fallback below asks this of the SELECTED account, which was sufficient while a
 * request-owned bearer could not make main a candidate: the cooled account was the selection, so
 * the question and the refusal sat at the same place. Once main takes part in ordering (#5019) the
 * cooled account is no longer selected, and serving its own credential as main would resurrect the
 * cooldown it is inside — so eligibility has to ask the same question of every cooled sibling.
 *
 * `callerIsCooledPoolAccount` fails closed on an unreadable caller identity, which is preserved
 * here: an opaque bearer counts as owning any cooled subscription rather than escaping it.
 */
function callerOwnsAnyCooledPoolSubscription(
  headers: Headers,
  config: EpxConfig,
  quotaScope: CodexQuotaScope | undefined,
): boolean {
  for (const account of config.codexAccounts ?? []) {
    if (account.id === MAIN_CODEX_ACCOUNT_ID) continue;
    if (!getCodexQuotaHealthSnapshot(account.id, quotaScope)?.cooldownUntil) continue;
    if (callerIsCooledPoolAccount(headers, config, account.id)) return true;
  }
  return false;
}

export interface ResolveCodexAuthContextOptions {
  admission?: Pick<DataPlaneAdmission, "source">;
  /** Live policy owner when the routing config is a caller-specific replay snapshot. */
  codexAuthPolicy?: CodexAuthPolicyConfig;
  excludeAccountId?: string;
  /** Resolve exactly this account without consulting or mutating Pool selection. */
  accountId?: string;
  /** Final native model selected for this request, used to select its quota group. */
  modelId?: string;
  /** Short reservation converted to turn ownership before native `__main__` token materialization. */
  beginCodexAccountSelection?: () => CodexAccountSelectionAdmission | undefined;
  /** Test-only native credential read seams. */
  isMainAccountTokenLive?: () => boolean;
  getMainAccountToken?: typeof getMainAccountToken;
  getValidMainAccountToken?: typeof getValidMainAccountToken;
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  signal?: AbortSignal;
  /** Test seam: overrides the bounded startup policy-binding wait before the hard-lock fence. */
  mainAccountPolicyBindingWaitMs?: number;
  primeCodexPoolQuotas?: (config: EpxConfig, reason: string) => Promise<void>;
  /** Test seam for account-gated native model discovery. */
  resolveCodexModelEntitlements?: typeof resolveCodexModelEntitlements;
  /** Direct requests admitted with a proxy bearer substitute the stored native-main credential. */
  substituteMainCredentialForDirect?: boolean;
  /** A validated native Codex bearer may serve this request without entering Pool state. */
  requestScopedMainCredential?: boolean;
  /** Test seam for a Direct request's own forwarded ChatGPT credential. */
  isDirectCallerEntitledToCodexModel?: (headers: Headers, modelId: string) => Promise<boolean>;
  /**
   * This request's conversation carries live uploaded-file references (#4778). Retains the bound
   * account across a VOLUNTARY quota move; involuntary release is untouched.
   */
  retainAccountForUploadedFiles?: boolean;
}

/**
 * Wait, bounded, for an owned startup's main-policy binding, then fail closed while it is still
 * in flight.
 *
 * #5694 turned `codexMainAccountHardLock` on by default, so this fence stopped being an opt-in
 * rarity and started intercepting ordinary requests: for the seconds a Windows startup spends
 * recovering, sweeping stages, and binding the pinned home, every caller-owned direct request
 * was answered with a 503 "native-main profile maintenance is active; retry". Waiting is the
 * right answer for a window that closes on its own -- the request resumes and the hard lock
 * below still decides on identity and quota, exactly as it does after startup. A gate still
 * pending at the deadline (retained recovery, a manual-recovery requirement) is a real refusal,
 * and that is the one case that keeps the draining error.
 *
 * Both reads are memory-only: neither this fence nor the wait probes a foreign home.
 */
async function awaitMainAccountPolicyBindingSettled(
  options: ResolveCodexAuthContextOptions,
): Promise<void> {
  if (!isMainAccountPolicyBindingPending()) return;
  const settled = await waitForMainAccountPolicyBinding({
    signal: options.signal,
    timeoutMs: options.mainAccountPolicyBindingWaitMs,
  });
  if (!settled) throw new CodexMainProfileDrainingError();
}

/** Memory-only ownership check shared by Direct admission and pre-auth hard-lock routing. */
export async function mainAccountHardLockAppliesToCaller(
  headers: Headers,
  policy: CodexAuthPolicyConfig,
  options: Pick<ResolveCodexAuthContextOptions,
    "substituteMainCredentialForDirect" | "signal" | "mainAccountPolicyBindingWaitMs"> = {},
): Promise<boolean> {
  if (options.substituteMainCredentialForDirect === true) return true;
  if (!hasCallerCodexBearer(headers)) return false;
  if (isMainAccountHardLockEnabled(policy)) await awaitMainAccountPolicyBindingSettled(options);
  return callerMatchesObservedMain(headers);
}

/**
 * Resolve ownership once, then hand back a synchronous proof. Main identity or its observed bearer
 * can change across the await; the hard-lock reroute rechecks the proof with no await between it
 * and the body rewrite, so a replacement main's lock never reroutes the original caller.
 */
export async function mainAccountHardLockCallerProof(
  headers: Headers,
  policy: CodexAuthPolicyConfig,
  options: Parameters<typeof mainAccountHardLockAppliesToCaller>[2] = {},
): Promise<(() => boolean) | null> {
  if (!await mainAccountHardLockAppliesToCaller(headers, policy, options)) return null;
  return options.substituteMainCredentialForDirect === true ? () => true : () => callerMatchesObservedMain(headers);
}

/**
 * Resolve the credential for one Codex turn. A main hard-lock reached through unpinned pool
 * selection is annotated with the earliest known pool recovery, so the refusal can name a retry
 * time that a sibling account may meet (#7046).
 */
export async function resolveCodexAuthContext(
  headers: Headers,
  config: EpxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
): Promise<CodexAuthContext> {
  try {
    return await resolveCodexAuthContextWithHint(headers, config, mode, options);
  } catch (error) {
    // #8113: a refusal resting on a reading older than 60 s first gets one fresh WHAM read, so a
    // reset redeemed outside EasyProxy lifts the lock now instead of at the next paced recovery.
    if (!(error instanceof CodexMainAccountHardLockError)) throw error;
    const { refreshMainHardLockBeforeRefusal } = await import("./auth-api/main-hard-lock-refusal-read");
    if (!await refreshMainHardLockBeforeRefusal(config, options.codexAuthPolicy ?? config, options.signal,
      callerOwnedMainRefusal(headers, mode, options))) throw error;
    return await resolveCodexAuthContextWithHint(headers, config, mode, options);
  }
}

/**
 * A refusal for a request that authenticates as the main login itself. That request may never
 * read the physical main credential, so its fresh read uses the caller's own bearer (#8113).
 * Any other refusal is about the proxy-owned main credential.
 */
function callerOwnedMainRefusal(
  headers: Headers, mode: CodexAccountMode, options: ResolveCodexAuthContextOptions,
): { bearer: string; accountId: string } | null | undefined {
  if (options.substituteMainCredentialForDirect === true || !hasCallerCodexBearer(headers)) return undefined;
  if (mode !== "direct" && options.requestScopedMainCredential !== true) return undefined;
  // An explicit stored-account selection resolves the proxy-owned credential, whatever bearer arrived.
  if (options.accountId !== undefined && options.requestScopedMainCredential !== true) return undefined;
  const bearer = authorizationCredential(headers);
  const accountId = headers.get("chatgpt-account-id") ?? (bearer ? extractAccountId(undefined, bearer) : undefined);
  // Caller-owned without a usable credential: no read at all, never the physical one.
  return bearer && accountId ? { bearer, accountId } : null;
}

async function resolveCodexAuthContextWithHint(
  headers: Headers,
  config: EpxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions,
): Promise<CodexAuthContext> {
  // Filled by the inner resolver with the request's own fenced model evidence, so the hint obeys it.
  const eligibility: RecoveryHintEligibility = {};
  try {
    return await resolveCodexAuthContextUnannotated(headers, config, mode, options, eligibility);
  } catch (error) {
    if (error instanceof CodexMainAccountHardLockError && mode === "pool" && options.accountId === undefined
      && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
      && !requiresReserveAuthorization(options.codexAuthPolicy ?? config, options.modelId, options.admission)
      // An account-gated model with no resolved roster has no known eligible sibling.
      && (!options.modelId || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)
        || eligibility.modelEligibleAccountIds !== undefined)) {
      try {
        const now = Date.now();
        error.poolRecoveryAt = nextCodexPoolRecoveryAt(config, now, codexQuotaScopeForModel(options.modelId), {
          deniedAccountIds: eligibility.deniedModelAccountIds,
          eligibleAccountIds: eligibility.modelEligibleAccountIds,
        });
      } catch { /* the hint is optional; the refusal stands without it */ }
    }
    throw error;
  }
}

interface RecoveryHintEligibility {
  modelEligibleAccountIds?: ReadonlySet<string>;
  deniedModelAccountIds?: ReadonlySet<string>;
}

async function resolveCodexAuthContextUnannotated(
  headers: Headers,
  config: EpxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
  eligibility: RecoveryHintEligibility = {},
): Promise<CodexAuthContext> {
  const writerGeneration = captureConfigGeneration();
  const policy = options.codexAuthPolicy ?? config;
  const requestScopedMainCredential = options.requestScopedMainCredential === true
    && hasCallerCodexBearer(headers);
  const reserve = requiresReserveAuthorization(policy, options.modelId, options.admission);
  if (reserve && (options.excludeAccountId !== undefined
    || (options.accountId !== undefined && options.accountId !== MAIN_CODEX_ACCOUNT_ID))) {
    throw new CodexReserveUnavailableError();
  }
  const fixedAccountId = reserve ? MAIN_CODEX_ACCOUNT_ID : options.accountId;
  // #7410: automatic Pool resolution under `codexPool.poolOnly` never serves native main. Explicit
  // selectors (fixed account, Reserve) and Direct mode are operator choices outside the policy.
  // Read from the routing config, the same object the shared usability decision reads.
  const poolOnlyApplies = mode === "pool" && fixedAccountId === undefined && codexPoolOnlyExcludesMain(config);
  const quotaScope = codexQuotaScopeForModel(options.modelId);
  // Pool pins and fallback must not resurrect an observed main credential that is cooling
  // down. Unrelated caller-owned credentials and explicit Direct keep their own policy.
  // The identity match and scoped health read are memory-only; never probe the auth file.
  const callerOwnedMainPoolCooldown = () => mode === "pool" && callerMatchesObservedMain(headers)
    ? getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, quotaScope)
    : null;
  const assertCallerOwnedMainPoolNotCooled = () => {
    const cooldown = callerOwnedMainPoolCooldown();
    if (cooldown?.cooldownUntil) {
      throw new CodexAccountCooldownError(
        MAIN_CODEX_ACCOUNT_ID, cooldown.cooldownUntil, cooldown.cooldownSource, cooldown.quotaScope,
      );
    }
  };
  const mainPinState = () => requestOwnedMainPinState(
    headers, config, policy, requestScopedMainCredential, fixedAccountId, quotaScope,
  );
  const requestOwnedMainPinCandidate = mainPinState().candidate;
  // During an owned startup, equality cannot be established until recovery and the
  // memory-only policy binding finish. This read-only fence never probes a foreign home, and it
  // waits out a window that closes on its own instead of refusing a request that arrived inside
  // it. Only a binding still pending at the deadline fails closed.
  if (isMainAccountHardLockEnabled(policy) && requestOwnedMainPinCandidate) {
    await awaitMainAccountPolicyBindingSettled(options);
  }
  const preserveRequestOwnedMainPin = () => mainPinState().preserve;
  if (fixedAccountId !== undefined && options.excludeAccountId !== undefined) {
    throw new Error("Codex auth context cannot select and exclude an account simultaneously");
  }
  const resolveCallerOwnedMainContext = async (): Promise<CodexAuthContext> => {
    const substituteStoredMain = options.substituteMainCredentialForDirect === true;
    // An internal route change can strip the admission bearer before this point.
    // Trusted substitution still has to claim and validate stored main below.
    if (!substituteStoredMain && !hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    if (!substituteStoredMain) {
      if (await mainAccountHardLockAppliesToCaller(headers, policy, options)) assertMainAccountPolicy(policy);
      assertCallerOwnedMainPoolNotCooled();
      if (reserve) {
        const selected = materializeCodexUpstreamAuth(headers, { kind: "main", accountId: null }, { config: policy });
        const token = selectedCodexToken(selected);
        const reserveAuthorization = await authorizeReserveCredential(token, captureMainQuotaWriter(token.chatgptAccountId),
          policy, options.signal, undefined, writerGeneration);
        return { kind: "main", accountId: null, reserveAuthorization };
      }
      if (options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)) {
        const entitled = await (
          options.isDirectCallerEntitledToCodexModel ?? isDirectCallerEntitledToCodexModel
        )(headers, options.modelId);
        if (!entitled) {
          throw new CodexModelAvailabilityError(
            "unsupported",
            "The selected ChatGPT account does not support this model",
          );
        }
      }
      if (callerMatchesObservedMain(headers)) assertMainAccountPolicy(policy);
      assertCallerOwnedMainPoolNotCooled();
      return { kind: "main", accountId: null };
    }

    // Admission-bearer Direct requests later replace the proxy secret with the stored
    // native-main credential. Reserve and claim that physical profile before entitlement
    // discovery or materialization can read it; caller-owned Direct credentials never enter
    // this branch. A missing turn admission must fail closed instead of recreating an
    // untracked native-main read.
    if (isNativeMainTrafficBlocked()) throw new CodexMainProfileDrainingError();
    const directSelectionAdmission = options.beginCodexAccountSelection?.();
    if (!directSelectionAdmission) throw new CodexMainProfileDrainingError();
    try {
      if (
        directSelectionAdmission.mainProfileDraining
        || !directSelectionAdmission.claimMainProfile()
        || isNativeMainTrafficBlocked()
      ) {
        throw new CodexMainProfileDrainingError();
      }
      if (isMainAccountHardLockEnabled(policy)) reconcileMainCodexAccountRuntimeState();
      if (!getMainAccountToken()) {
        try {
          await (options.getValidMainAccountToken ?? getValidMainAccountToken)({
            signal: options.signal, ...(options.nativeMainRefreshDependencies ?? {}),
          });
        } catch (cause) { throw new CodexAuthContextError(MAIN_CODEX_ACCOUNT_ID, cause); }
        options.signal?.throwIfAborted();
      }
      assertMainAccountPolicy(policy);
      if (options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)) {
        const entitled = entitledCodexAccountIdsForModel(
          await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config, {
            signal: options.signal,
            nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
          }),
          options.modelId,
        )?.has(MAIN_CODEX_ACCOUNT_ID) === true;
        if (!entitled) {
          throw new CodexModelAvailabilityError(
            "unsupported",
            "The selected ChatGPT account does not support this model",
          );
        }
      }
      assertMainAccountPolicy(policy);
      return { kind: "main", accountId: null };
    } finally {
      // The short selector reservation ends here. A successful claim remains owned by
      // the enclosing turn lease until the request or transferred stream settles.
      directSelectionAdmission.release();
    }
  };
  const affinityKey = codexRequestAffinityKey(headers, config, policy, { accountId: fixedAccountId, modelId: options.modelId, admission: options.admission, requestScopedMainCredential });
  const conversationStateKey = affinityKey ?? (requestScopedMainCredential && fixedAccountId === undefined && !reserve ? requestOwnedAffinityKey(headers) : undefined);
  // Pool discovery excludes request-owned main credentials by design: they must never be folded
  // into stored-account entitlement, affinity, or persistence state. An effective manual main pin
  // is the one exception where that exclusion is selection evidence in the opposite direction.
  // Validate the caller's own gated-model roster before using it, and fall through to a Pool model
  // detour when it lacks the grant. This branch performs no physical-main credential read.
  if (!poolOnlyApplies && preserveRequestOwnedMainPin()) {
    const callerEntitled = !options.modelId
      || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)
      || await (
        options.isDirectCallerEntitledToCodexModel ?? isDirectCallerEntitledToCodexModel
      )(headers, options.modelId);
    if (callerEntitled && preserveRequestOwnedMainPin()) {
      return { kind: "main", accountId: null, ...(mode === "pool" && conversationStateKey ? { conversationStateKey } : {}) };
    }
  }
  // An explicit namespace binding is stronger than the provider's default mode. It must use the
  // selected stored credential even while the canonical OpenAI provider is globally Direct.
  // A request-owned bearer is deliberately not represented as `main-pool`: Pool account ids own
  // durable health, quota, and affinity state, while this credential exists for one request only.
  if ((reserve && hasCallerCodexBearer(headers) && !options.substituteMainCredentialForDirect
      && (requestScopedMainCredential || mode === "direct"))
    || (mode === "direct" && fixedAccountId === undefined)
    || (requestScopedMainCredential && fixedAccountId === MAIN_CODEX_ACCOUNT_ID)) {
    return resolveCallerOwnedMainContext();
  }
  // A caller bearer can still accompany a request that selects a configured Pool account. Do not
  // let that request read, delete, or create a file-main affinity binding while deciding whether a
  // stored account is available. Optional caller-owned bindings use a separate namespace; fixed
  // selectors never own a binding.
  // A first-placing child consults its thread's family relation. Fixed and request-owned
  // credentials never enter stored Pool lineage, even when request-owned affinity is enabled.
  const lineage = affinityKey !== undefined && poolStateEligible(fixedAccountId, requestScopedMainCredential)
    ? recordCodexThreadLineage(headers)
    : undefined;
  // Why this request is on this account, carried to the request log so a move reads as an event
  // instead of something inferred from account labels across lines (#4546).
  let affinityDecision: CodexAffinityDecision | undefined;
  const resolveKeyedCallerMain = async (fallbackReason?: "cooldown" | "unusable"): Promise<CodexAuthContext> => {
    const withheld = requestScopedMainCredential && config.codexPool?.requestOwnedAffinity !== true;
    const decision = fallbackReason ? callerOwnedFallbackAffinityDecision(affinityDecision, affinityKey, quotaScope, options.modelId, withheld, fallbackReason)
      : honestAffinityDecision(affinityDecision, affinityKey, MAIN_CODEX_ACCOUNT_ID, quotaScope, options.modelId, withheld);
    const affinityBindingSnapshot = captureRequestOwnedAffinityBindings(affinityKey, quotaScope, options.modelId);
    const context = await resolveCallerOwnedMainContext();
    return context.kind === "main" ? { ...context, ...(affinityBindingSnapshot ? { affinityBindingSnapshot } : {}), ...(affinityKey ? { affinityKey } : {}), ...(conversationStateKey ? { conversationStateKey } : {}), ...(decision ? { affinityDecision: decision } : {}) } : context;
  };
  // The half-open trial this request was granted, if it is the one allowed to test a held
  // account. Declared out here because the release paths below and the returned context are on
  // opposite sides of several throws (#4701).
  let transientProbe: TransientProbeGrant | undefined;
  const releaseTransientProbeGrant = (): void => {
    if (!transientProbe) return;
    releaseTransientProbe(transientProbe.lease);
    transientProbe = undefined;
  };
  // Retained startup recovery makes the physical main identity ineligible. Routing
  // can still preserve service by selecting a healthy configured pool account. A
  // request-owned bearer likewise cannot inspect or reconcile file-main state.
  const nativeMainTrafficBlocked = isNativeMainTrafficBlocked();
  const selectionAdmission = options.beginCodexAccountSelection?.();
  const nativeMainReadsForbidden = requestScopedMainCredential
    || nativeMainTrafficBlocked
    || selectionAdmission?.mainProfileDraining === true;
  const nativeMainSelectionOnly = !nativeMainTrafficBlocked
    && selectionAdmission?.mainProfileDraining === true;
  let accountId: string;
  let mainDiscoveryFailure: unknown;
  // Answering this with the manual-pin predicate made `codexAccountUnusableReason` report
  // `main_credential_unavailable` for every UNPINNED request, so `getEligiblePoolAccounts` never
  // listed main and the strategy compared only the stored accounts. With one stored sibling the
  // pool degraded to "stored account until it cannot serve, then main", discarding the usage,
  // priority and reset ordering the operator configured (#5019).
  const requestOwnedMainCredentialLive = () => requestOwnedMainCredentialIsLive({
    preserveRequestOwnedMainPin: preserveRequestOwnedMainPin(),
    requestScopedMainCredential,
    nativeMainTrafficBlocked,
    mainProfileDraining: selectionAdmission?.mainProfileDraining === true,
    // Keeps the cooled account as the selection when the caller owns it, so the refusal is still
    // produced by the cooldown machinery below rather than by a second rule beside it.
    callerOwnsCooledPoolSubscription: requestScopedMainCredential
      && callerOwnsAnyCooledPoolSubscription(headers, config, quotaScope),
  });
  try {
    // A fileless login can change identity even while its previous expiry observation is usable.
    // The selector discovers it before identity-bound quota or hard-lock policy; dispatch still revalidates it.
    if (selectionAdmission && !nativeMainReadsForbidden && !options.isMainAccountTokenLive
      && !poolOnlyApplies
      && (fixedAccountId === undefined || fixedAccountId === MAIN_CODEX_ACCOUNT_ID)
      && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
      && !policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID)
      && (!getMainAccountToken() || !getMainAccountCredentialStatus().usable)) {
      try {
        await (options.getValidMainAccountToken ?? getValidMainAccountToken)({
          signal: options.signal, ...(options.nativeMainRefreshDependencies ?? {}),
        });
      } catch (cause) { mainDiscoveryFailure = cause; }
      options.signal?.throwIfAborted();
    }
    const excludeAccountIds = nativeMainReadsForbidden || poolOnlyApplies
      ? new Set([MAIN_CODEX_ACCOUNT_ID])
      : undefined;
    const mainModelGrantUnobserved = excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID) === true;
    const entitlementSnapshot = options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)
      ? await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config, {
        excludeAccountIds,
        signal: options.signal,
        nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
      })
      : undefined;
    const entitledAccountIds = entitlementSnapshot
      ? entitledCodexAccountIdsForModel(entitlementSnapshot, options.modelId)
      : undefined;
    const modelEligibleAccountIds = entitledAccountIds
      ? new Set([...entitledAccountIds].filter(candidate => !excludeAccountIds?.has(candidate)))
      : undefined;
    eligibility.modelEligibleAccountIds = modelEligibleAccountIds;
    // #4768: the flagships stay visible and never fail closed, so this is evidence routing may
    // ORDER by, not evidence it may refuse on. Read synchronously from rosters discovery has
    // already gathered -- no upstream fetch joins the request path for the most commonly
    // requested models in the product -- and passed to selection as a preference that is dropped
    // whenever honouring it would leave no candidate.
    //
    // Under the SAME exclusion the entitlement snapshot above uses. The reader validates each
    // cached roster against the account's current credential, and for native main that is a
    // synchronous read of the physical stored token -- exactly what this request is forbidden to
    // touch while a profile switch drains it or while it is served by a request-owned credential.
    // Excluding main here costs nothing: the preference is an ordering hint, so main becomes
    // unknown rather than denied, and unknown leaves selection exactly as it was.
    const deniedModelAccountIds = cachedDeniedCodexAccountIdsForModel(
      options.modelId,
      undefined,
      { excludeAccountIds },
    );
    eligibility.deniedModelAccountIds = deniedModelAccountIds;
    const selectionOptions = {
      // A fixed selector (exact account, Reserve) is outside the pool-only policy (#7410).
      explicitAccountSelector: fixedAccountId !== undefined,
      // Temporary switch drain keeps the candidate until the atomic claim rejects
      // it. Retained recovery makes main wholly ineligible so pool routing continues.
      nativeMainSelectionOnly,
      isMainAccountTokenLive: requestScopedMainCredential
        // Main stays excluded from this request's model roster below, so an account-gated model
        // still cannot be served from a candidacy this answer creates. Everything else -- pool
        // eligibility, shared-state preservation, and a caller-owned pin surviving a model detour
        // -- is answered without reading or selecting the physical main credential.
        ? requestOwnedMainCredentialLive
        : options.isMainAccountTokenLive,
      modelEligibleAccountIds,
      deniedModelAccountIds,
      requestOwnedMainCredential: requestScopedMainCredential,
      // Request-scoped and deliberately absent from `sharedStateSelectionOptions`: one
      // conversation's attachments say nothing about where unrelated threads should be served.
      retainAccountForUploadedFiles: options.retainAccountForUploadedFiles === true,
    };
    // A pre-drain selector reserves the native identity while reconciliation and
    // routing inspect it. Selectors arriving after the fence skip reconciliation
    // and may still route to non-main pool accounts without touching switch state.
    if (reserve && !nativeMainReadsForbidden && !selectionAdmission) throw new CodexMainProfileDrainingError();
    if (!nativeMainReadsForbidden) reconcileMainCodexAccountRuntimeState();
    // Annotated, not inferred. The two literals below carry neither `affinity` nor
    // `transientProbe`, so an inferred union makes `"k" in resolution` widen those reads to
    // `unknown` and a discriminant narrowing fail outright. Contextually typing every branch to
    // the resolver's own union is what lets the reads below stay total.
    const resolution: CodexThreadResolution = fixedAccountId !== undefined
      ? { status: "selected" as const, accountId: fixedAccountId }
      : options.excludeAccountId
      ? (() => {
          const selected = pickAlternateCodexAccount(
            config,
            options.excludeAccountId!,
            Date.now(),
            quotaScope,
            selectionOptions,
          );
          return selected
            ? { status: "selected" as const, accountId: selected }
            : { status: "none" as const };
        })()
      : resolveCodexAccountForThreadDetailed(
          affinityKey ?? null,
          config,
          Date.now(),
          quotaScope,
          selectionOptions,
          options.modelId,
          lineage,
        );
    if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
    // THE REFUSAL. Every candidate is held, the recovery budget is spent, and no detour is
    // left -- so this request must not reach upstream at all. Returning the held account here
    // is what #4701 is about: under a provider-wide 503 that is every bound request piling
    // onto an account already known to be failing. Thrown before any credential is read, so
    // nothing is sent and nothing is spent.
    if (resolution.status === "withheld") {
      throw new CodexRecoveryWithheldError(resolution.accountId, resolution.retryAt, resolution.detourAccountId);
    }
    const selected = resolution.status === "selected" ? resolution.accountId : null;
    affinityDecision = selected ? honestAffinityDecision(resolution.affinity, affinityKey, selected, quotaScope, options.modelId, requestScopedMainCredential && config.codexPool?.requestOwnedAffinity !== true) : resolution.affinity;
    transientProbe = resolution.status === "selected" ? resolution.transientProbe : undefined;
    // Every selector that can still name main (sentinels, preserved actives) ends here.
    if (selected === MAIN_CODEX_ACCOUNT_ID && poolOnlyApplies) {
      releaseTransientProbeGrant();
      throw new CodexPoolAuthenticationError();
    }
    // Main now takes part in ordering when the request carries its own main bearer (#5019), so
    // selection can name it outright rather than only through the no-candidate fallback below.
    // Serve that selection from the credential the request arrived with: the read fence above
    // forbids this request from claiming, reading or reconciling the stored main profile, and a
    // request-owned credential owns no shared health state, so there is nothing here to claim,
    // prime or cool down. Hand back any trial first -- no Pool account is being sent to.
    if (selected === MAIN_CODEX_ACCOUNT_ID && requestScopedMainCredential) {
      releaseTransientProbeGrant();
      const context = await resolveKeyedCallerMain();
      console.info("[codex] Pool selected caller-owned main credential.");
      return context;
    }
    if (!selected) {
      // After an entitlement-await recovery, current selection evidence outranks the saved
      // probe failure; retain it only while main is still unusable (as for fixed selection).
      if (mainDiscoveryFailure !== undefined && !getMainAccountCredentialStatus().usable) {
        throw new CodexAuthContextError(MAIN_CODEX_ACCOUNT_ID, mainDiscoveryFailure);
      }
      // A retry that excluded a failed Pool account may still use the validated caller-owned
      // main credential. Treating every exclusion as if main itself had failed strands a healthy
      // native bearer after the first Pool attempt. Preserve the exactly-once boundary by refusing
      // this fallback only when the excluded credential is main.
      if (
        requestScopedMainCredential
        && fixedAccountId === undefined
        && !poolOnlyApplies
        && !(callerMatchesObservedMain(headers) && policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID))
        && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
      ) {
        const context = await resolveKeyedCallerMain("unusable");
        console.info("[codex] Pool used caller-owned main credential: no selectable stored account.");
        return context;
      }
      if (fixedAccountId !== undefined) {
        if (modelEligibleAccountIds && !modelEligibleAccountIds.has(fixedAccountId)) {
          throw new CodexModelAvailabilityError(
            "unsupported",
            "Selected Codex account does not support this model",
          );
        }
        const mainReason = fixedAccountId === MAIN_CODEX_ACCOUNT_ID && !nativeMainReadsForbidden
          && !policy.pausedCodexAccountIds?.includes(fixedAccountId)
          ? codexAccountUnusableReason(config, fixedAccountId, selectionOptions) : undefined;
        throw new CodexPoolAuthenticationError("Selected Codex account is unavailable", {
          quarantinedMain: mainReason === "needs_reauth",
        });
      }
      // Recovery or a turn drain deliberately makes physical main unobservable.
      // If no healthy pool route is available, report the temporary fence rather
      // than turning a credential we were forbidden to inspect into a permanent
      // model-entitlement denial.
      // A configured pool retry/exclusion that finds no alternate preserves its
      // ordinary pool-auth failure instead of being mislabeled as a main fence.
      if (nativeMainReadsForbidden && !options.excludeAccountId) {
        throw new CodexMainProfileDrainingError();
      }
      if (!nativeMainReadsForbidden && !poolOnlyApplies && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
        && !policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID)
        && (!modelEligibleAccountIds || modelEligibleAccountIds.has(MAIN_CODEX_ACCOUNT_ID))) {
        assertMainAccountPolicy(policy);
      }
      if (modelEligibleAccountIds !== undefined) {
        const unsupported = entitledAccountIds?.size === 0 && !mainModelGrantUnobserved;
        throw new CodexModelAvailabilityError(
          unsupported ? "unsupported" : "temporarily_unavailable",
          unsupported
            ? "No eligible Codex account supports this model"
            : "Codex accounts that support this model are currently unavailable",
        );
      }
      throw new CodexPoolAuthenticationError(undefined, {
        quarantinedMain: !nativeMainReadsForbidden
          && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
          && !policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID)
          && codexAccountUnusableReason(config, MAIN_CODEX_ACCOUNT_ID, selectionOptions) === "needs_reauth",
      });
    }
    accountId = selected;
    if (accountId === MAIN_CODEX_ACCOUNT_ID) assertMainAccountPolicy(policy);
    if (accountId === MAIN_CODEX_ACCOUNT_ID && nativeMainTrafficBlocked) {
      throw new CodexMainProfileDrainingError();
    }
    if (
      accountId === MAIN_CODEX_ACCOUNT_ID
      && selectionAdmission
      && !selectionAdmission.claimMainProfile()
    ) {
      throw new CodexMainProfileDrainingError();
    }
    // Some legacy Pool fallbacks preserve a configured active account even when it is not
    // currently selectable, so token/cooldown code can produce the historical actionable error.
    // Model entitlement is different: sending the request would spend a turn on an account whose
    // authenticated roster already denied the model. Reassert this boundary after every selector.
    if (modelEligibleAccountIds && !modelEligibleAccountIds.has(accountId)) {
      throw new CodexModelAvailabilityError(
        "unsupported",
        fixedAccountId !== undefined
          ? "Selected Codex account does not support this model"
          : "No eligible Codex account supports this model",
      );
    }
    if (fixedAccountId !== undefined) {
      // Preserve exact-main discovery errors only while the current credential remains unusable, as above.
      if (accountId === MAIN_CODEX_ACCOUNT_ID && mainDiscoveryFailure !== undefined
        && !getMainAccountCredentialStatus().usable) {
        throw new CodexAuthContextError(MAIN_CODEX_ACCOUNT_ID, mainDiscoveryFailure);
      }
      if (policy.pausedCodexAccountIds?.includes(accountId)) {
        throw new CodexPoolAuthenticationError("Selected Codex account is unavailable");
      }
      if (isAccountNeedsReauth(accountId)) {
        throw new CodexPoolAuthenticationError("Selected Codex account needs reauthentication", {
          quarantinedMain: accountId === MAIN_CODEX_ACCOUNT_ID && !nativeMainReadsForbidden,
        });
      }
      const unusableReason = codexAccountUnusableReason(config, accountId, selectionOptions);
      if (unusableReason !== undefined) {
        throw new CodexPoolAuthenticationError("Selected Codex account is unavailable", {
          quarantinedMain: accountId === MAIN_CODEX_ACCOUNT_ID && unusableReason === "needs_reauth",
        });
      }
    }
  } catch (cause) {
    // Selection granted a trial and then a later policy check refused the account. The trial
    // never runs, so hand it back instead of leaving the held account unprobeable until its
    // deadline lapses (#4701).
    releaseTransientProbeGrant();
    throw cause;
  } finally {
    selectionAdmission?.release();
  }
  // Legacy selectors may retain an unusable account for actionable errors. A
  // deferred credential must never become request auth through that fallback.
  try {
    assertCodexAccountValidationReady(accountId);
    if (configuredCodexMainDuplicate(config, accountId)) throw new CodexPoolAuthenticationError(CODEX_MAIN_DUPLICATE_ACTION);
    assertPoolAccountCredits(accountId, poolCreditHoldResetAt(policy, accountId, config), poolCreditRecoveryNeeded(policy, accountId), quotaScope);
  } catch (cause) {
    // Nothing will reach upstream, so give the trial back instead of leaving the held account
    // unprobeable until the lease deadline lapses (#4701).
    releaseTransientProbeGrant();
    throw cause;
  }
  // Lazy prime: if the selected account has no quota yet, the pool is likely
  // unprimed (dashboard never opened, or startup prime was blocked). Kick a
  // best-effort prime so the NEXT routing decision has real scores. This never
  // blocks the current request, and the helper's single-flight guard collapses
  // repeated triggers into one pass. Opt-in priority failback also refreshes inactive
  // accounts; that path has a five-minute attempt limit inside the prime helper.
  const priorityFailback = codexAccountPriorityFailbackEnabled(config, accountId);
  if (fixedAccountId === undefined && !nativeMainReadsForbidden
    && (!getAccountQuota(accountId) || priorityFailback)) {
    const reason = priorityFailback ? "priority-failback" : "pre-route";
    if (options.primeCodexPoolQuotas) {
      void options.primeCodexPoolQuotas(config, reason).catch(() => {});
    } else {
      // Tracked from the import on: the prime registers itself only once the module resolves.
      void trackBackgroundWork(`codex-pool-quota-prime-import:${reason}`, import("./auth-api")
        .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, reason))
        .catch(() => {}));
    }
  }
  // Snapshot (not just the deadline) so a refused request can report WHY it is cooled:
  // a literal Retry-After reads very differently to a user than a reset-derived guess.
  const cooldown = getCodexQuotaHealthSnapshot(accountId, quotaScope);
  const cooldownUntil = cooldown?.cooldownUntil;
  // A transient-hold trial and a quota cooldown cannot both describe this account:
  // `isTransientOnlyAffinityBlock` refuses to recognise a transient hold on an account carrying
  // quota health, so the cooldown branch below is unreachable while a trial is held. That is
  // also why no request pays two recovery permits for one send. The release is defensive --
  // should that invariant ever move, the trial is handed back rather than stranded behind a
  // refusal that belongs to the other domain.
  if (cooldownUntil && transientProbe) releaseTransientProbeGrant();
  // A cooled-down account never sends traffic, so upstream recovery can never be
  // observed and the cooldown outlives the real limit. Admit one probe per
  // interval; its outcome decides whether the cooldown ends (#433).
  let probeLeaseId: string | undefined;
  let probeQuotaScope: CodexQuotaScope | undefined;
  if (cooldownUntil) {
    // Exact bindings are not Pool recovery traffic. Fail closed instead of consuming the Pool's
    // one probe lease or selecting another account.
    if (fixedAccountId !== undefined) {
      throw new CodexAccountCooldownError(accountId, cooldownUntil, cooldown?.cooldownSource, cooldown?.quotaScope);
    }
    probeQuotaScope = cooldown?.quotaScope;
    probeLeaseId = probeQuotaScope
      ? tryAcquireCodexQuotaScopeProbeLease(accountId, probeQuotaScope) ?? undefined
      : tryAcquireCodexQuotaProbeLease(accountId) ?? undefined;
    if (!probeLeaseId) {
      // The selector can retain the configured Pool account when no stored
      // alternate is eligible. A validated caller may still serve this request,
      // just as it can after an upstream rejection, without changing Pool state.
      if (requestScopedMainCredential && fixedAccountId === undefined && !poolOnlyApplies
        && !(callerMatchesObservedMain(headers) && policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID))
        && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
        && !callerIsCooledPoolAccount(headers, config, accountId)) {
        const context = await resolveKeyedCallerMain("cooldown");
        console.info("[codex] Pool used caller-owned main credential: stored account cooldown.");
        return context;
      }
      throw new CodexAccountCooldownError(accountId, cooldownUntil, cooldown?.cooldownSource, cooldown?.quotaScope);
    }
  }

  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // Main account in rotation: refresh auth.json before upstream I/O and fail closed if it vanished.
    let token: { accessToken: string; chatgptAccountId: string } | null;
    let mainQuotaWriter = captureObservedMainWriter();
    try {
      token = await (options.getValidMainAccountToken ?? getValidMainAccountToken)({
        signal: options.signal,
        ...(options.nativeMainRefreshDependencies ?? {}),
      });
      if (token) mainQuotaWriter = observeSelectedMainCredential(token, mainQuotaWriter);
      assertMainAccountPolicy(policy);
    } catch (cause) {
      releaseTransientProbeGrant();
      if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
      else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      // Policy refusals, including one that lands while the token refresh was in flight, are not
      // authentication failures: they must stay reset-bound 429s and never mark a valid login.
      if (cause instanceof CodexMainAccountHardLockError || cause instanceof CodexMainAccountCreditsOffError) throw cause;
      if (!options.signal?.aborted && shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
        markAccountNeedsReauth(accountId, writerGeneration);
      }
      throw new CodexAuthContextError(accountId, cause);
    }
    if (!token) {
      // Nothing will reach upstream, so give the probe back instead of burning it.
      releaseTransientProbeGrant();
      if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
      else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      throw new CodexPoolAuthenticationError(
        fixedAccountId !== undefined ? "Selected Codex account is unavailable" : undefined,
      );
    }
    let reserveAuthorization: MainReserveAuthorization | undefined;
    try {
      reserveAuthorization = reserve
        ? await authorizeReserveCredential(token, mainQuotaWriter, policy, options.signal, undefined, writerGeneration)
        : undefined;
    } catch (cause) {
      // A Reserve refusal ends the request here, so the trial it was holding never runs.
      releaseTransientProbeGrant();
      throw cause;
    }
    return {
      kind: "main-pool",
      accountId,
      writerGeneration,
      mainQuotaWriter,
      ...(reserveAuthorization ? { reserveAuthorization } : {}),
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      ...(fixedAccountId !== undefined ? { fixedAccount: true } : {}),
      ...(affinityKey ? { affinityKey } : {}),
      ...(conversationStateKey ? { conversationStateKey } : {}),
      ...(quotaScope ? { quotaScope } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
      ...(probeQuotaScope ? { probeQuotaScope } : {}),
      ...(affinityDecision ? { affinityDecision } : {}),
      ...(transientProbe ? { transientProbe } : {}),
    };
  }

  try {
    const token = await getValidCodexToken(accountId, { signal: options.signal });
    assertCodexAccountValidationReady(accountId);
    if (configuredCodexMainDuplicate(config, accountId)) throw new CodexPoolAuthenticationError(CODEX_MAIN_DUPLICATE_ACTION);
    assertPoolAccountCredits(accountId, poolCreditHoldResetAt(policy, accountId, config), poolCreditRecoveryNeeded(policy, accountId), quotaScope);
    return bindPoolCreditPolicy({
      kind: "pool",
      accountId,
      writerGeneration,
      generation: token.generation,
      poolQuotaWriter: capturePoolQuotaWriter(accountId, token),
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      ...(fixedAccountId !== undefined ? { fixedAccount: true } : {}),
      ...(affinityKey ? { affinityKey } : {}),
      ...(conversationStateKey ? { conversationStateKey } : {}),
      ...(quotaScope ? { quotaScope } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
      ...(probeQuotaScope ? { probeQuotaScope } : {}),
      ...(affinityDecision ? { affinityDecision } : {}),
      ...(transientProbe ? { transientProbe } : {}),
    }, config, policy);
  } catch (cause) {
    releaseTransientProbeGrant();
    if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
    else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
    // Post-refresh eligibility refusals do not invalidate a healthy credential.
    if (cause instanceof CodexPoolAccountCreditsOffError || cause instanceof CodexPoolAuthenticationError) throw cause;
    if (!options.signal?.aborted && shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
      markAccountNeedsReauth(accountId, writerGeneration);
    }
    throw new CodexAuthContextError(accountId, cause);
  }
}
