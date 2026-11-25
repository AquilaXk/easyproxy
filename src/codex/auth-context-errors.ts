import { formatClientRetryAfter } from "../lib/client-retry-after";
import { ConfigMutationLockError } from "../config";
import { maskAccountId } from "../lib/privacy";
import { formatErrorResponse, formatUsageLimitReachedResponse } from "../bridge";
import { authorizationCredential } from "../lib/authorization-scheme";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { UpstreamRetryEvidenceError } from "../lib/upstream-retry";
import { extractAccountId } from "../oauth/chatgpt";
import type { DataPlaneAdmission } from "../server/auth-cors";
import type { EpxConfig } from "../types";
import { poolCreditRecoveryRetryAt } from "./pool-credit-policy";
import { nextQuotaQueryDelay } from "./quota-query-backoff";
import { noteMainAccountActivity } from "./main-account-external-usage";
import type { PoolQuotaWriter } from "./quota-types";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshStaleError,
  readCodexAccountRecord,
} from "./account-store";
import { isAccountNeedsReauth } from "./account-runtime-state";
import { NativeProfileError } from "./native-profile-types";
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
  mainAccountTokenQuotaWriter,
} from "./main-account";
import { nativeMainStartupGateSnapshot, type NativeMainStartupBlockReason } from "./native-profile-startup";
import {
  getCodexQuotaHealthSnapshot,
  releaseCodexQuotaProbeLease,
  releaseCodexQuotaScopeProbeLease,
  type CodexAffinityDecision,
  type CodexCooldownSource,
  type CodexQuotaScope,
  type TransientProbeGrant,
} from "./routing";
import { releaseTransientProbe } from "../routing/probe-lease";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import { isValidWhamHistoryObservation, parseMainPolicyUsageQuota, parseUsageQuota, setAccountQuotaFromParsed } from "./quota";
import { codexAccountUsesCreditsAfterLimit } from "./account-credit-use";
import { getMainAccountHardLockStatus, resolveMainAccountHardLockThresholds } from "./main-account-hard-lock";
import {
  captureMainAccountIdentityGeneration,
  isMainQuotaWriterLive,
  matchesMainQuotaCredential,
  observeMainQuotaCredential,
  type MainQuotaDispatch,
  type MainQuotaWriter,
  getObservedMainQuotaIdentityKey,
} from "./main-account-cache";
import { mainCreditsHoldResetAt } from "./request-owned-main-pin";
import { CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE, isCodexReserveRequestEligible } from "./loopback-target";
import { getMainReserveAuthorization, isMainReserveAuthorizationLive, type MainReserveAuthorization } from "./reserve-availability";

export type CodexAuthContext =
  | {
      kind: "main"; accountId: null; reserveAuthorization?: MainReserveAuthorization; affinityKey?: string; conversationStateKey?: string; affinityDecision?: CodexAffinityDecision; affinityBindingSnapshot?: import("./request-owned-affinity").RequestOwnedBindingSnapshot;
      /** Captured for the observed main credential actually selected for upstream. */
      mainQuotaDispatch?: MainQuotaDispatch;
    }
  | {
      kind: "pool";
      accountId: string;
      writerGeneration: number;
      generation: number;
      poolQuotaWriter?: PoolQuotaWriter;
      accessToken: string;
      chatgptAccountId: string;
      /** Bypass Pool selection and suppress quota/transient failover for an exact selector. */
      fixedAccount?: boolean;
      /** Pool binding key; the Desktop fallback is an opaque process-local HMAC. */
      affinityKey?: string; conversationStateKey?: string;
      /**
       * Set when this request was admitted through an active quota cooldown as
       * the account's single probe. Must be echoed into the upstream outcome so
       * only this request can clear the cooldown (#433).
       */
      probeLeaseId?: string;
      /** Native model quota group selected for this request, when known. */
      quotaScope?: CodexQuotaScope;
      /** What happened to this thread's binding on this request (#4546). */
      affinityDecision?: CodexAffinityDecision;
      /** Per-account egress proxy URL pinned on this pool slot. */
      proxy?: string;
      /** Scope that owns `probeLeaseId`, when it is a scoped recovery probe. */
      probeQuotaScope?: CodexQuotaScope;
      /**
       * Set when this request is the ONE dispatch admitted to test an account held under a
       * transient 5xx hold (#4701). Echo it into the upstream outcome so the trial is settled
       * by the request that ran it, and release it on any path that never reaches upstream.
       */
      transientProbe?: TransientProbeGrant;
    }
  | {
      // Main account rotating in the Pool (Option A), token from ~/.codex/auth.json; never request-owned "main".
      kind: "main-pool";
      accountId: string;
      writerGeneration: number;
      /** Captured before async credential work; never reconstructed after the upstream response. */
      mainQuotaWriter?: MainQuotaWriter;
      /** Immutable credential proof captured while materializing this physical attempt's headers. */
      mainQuotaDispatch?: MainQuotaDispatch;
      reserveAuthorization?: MainReserveAuthorization;
      accessToken: string;
      chatgptAccountId: string;
      /** Bypass Pool selection and suppress quota/transient failover for an exact selector. */
      fixedAccount?: boolean;
      affinityKey?: string; conversationStateKey?: string; // See `pool.affinityKey`.
      /** See `pool.probeLeaseId`. */
      probeLeaseId?: string;
      quotaScope?: CodexQuotaScope;
      probeQuotaScope?: CodexQuotaScope;
      /** See `pool.transientProbe`. */
      transientProbe?: TransientProbeGrant;
      affinityDecision?: CodexAffinityDecision;
    };

export type CodexAuthPolicyConfig = Readonly<Pick<EpxConfig,
  "codexMainAccountHardLock" | "codexMainAccountHardLockThresholds" | "codexDesktopAuthless" | "codexReserveEnabled"
  | "codexReserveMigration" | "runtimeRole" | "pausedCodexAccountIds"
  | "creditCodexAccountIds" | "codexAccounts" | "codexUseRemainingQuotaAccountIds"
>>;

export interface CodexAccountSelectionAdmission {
  readonly mainProfileDraining: boolean;
  claimMainProfile(): boolean;
  release(): void;
}

/** Probe lease carried by this context, when it holds one. */
export function codexProbeLeaseId(ctx: CodexAuthContext | undefined): string | undefined {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.probeLeaseId : undefined;
}

/** Scope of a lease carried by this context, when it probes a model-specific quota. */
export function codexProbeQuotaScope(ctx: CodexAuthContext | undefined): CodexQuotaScope | undefined {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.probeQuotaScope : undefined;
}

/** The transient-hold recovery probe carried by this context, when it holds one (#4701). */
export function codexTransientProbeGrant(ctx: CodexAuthContext | undefined): TransientProbeGrant | undefined {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.transientProbe : undefined;
}

/**
 * Hand back a probe lease for a request that will not reach upstream. Safe to call with a context that holds no lease.
 *
 * BOTH leases, deliberately. A context can carry the quota-cooldown probe or the transient-hold
 * probe, and every one of the ~30 call sites that already hands back the first is a path where
 * the second would leak too. Releasing them together is what makes those sites correct for the
 * new lease without re-deriving the discard set by hand -- the failure mode being avoided is a
 * held account nobody may probe because the request that held the trial went away quietly.
 */
export function releaseCodexAuthContextProbeLease(ctx: CodexAuthContext | undefined): void {
  const transientProbe = codexTransientProbeGrant(ctx);
  if (transientProbe) releaseTransientProbe(transientProbe.lease);
  const leaseId = codexProbeLeaseId(ctx);
  if (!ctx || ctx.kind === "main" || !leaseId) return;
  if (ctx.probeQuotaScope) releaseCodexQuotaScopeProbeLease(ctx.accountId!, ctx.probeQuotaScope, leaseId);
  else releaseCodexQuotaProbeLease(ctx.accountId!, leaseId);
}

export class CodexAuthContextError extends Error {
  accountId: string;

  constructor(accountId: string, cause: unknown) {
    super("Codex pool account auth failed", { cause });
    this.name = "CodexAuthContextError";
    this.accountId = accountId;
  }
}

export class CodexPoolAuthenticationError extends Error {
  readonly quarantinedMain: boolean;
  constructor(message = "OpenAI account pool has no usable account credential", options?: { quarantinedMain?: boolean }) {
    super(message);
    this.name = "CodexPoolAuthenticationError";
    this.quarantinedMain = options?.quarantinedMain === true;
  }
}

export type CodexModelAvailabilityReason = "unsupported" | "temporarily_unavailable";

/** A model/account compatibility failure is not a credential failure. */
export class CodexModelAvailabilityError extends CodexPoolAuthenticationError {
  reason: CodexModelAvailabilityReason;

  constructor(reason: CodexModelAvailabilityReason, message: string) {
    super(message);
    this.name = "CodexModelAvailabilityError";
    this.reason = reason;
  }
}

export class CodexAccountValidationPendingError extends CodexPoolAuthenticationError {
  constructor() {
    super("Codex account validation is pending; refresh quota after recovery to validate it");
    this.name = "CodexAccountValidationPendingError";
  }
}

export function assertCodexAccountValidationReady(accountId: string): void {
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && readCodexAccountRecord(accountId)?.codexValidationPending) {
    throw new CodexAccountValidationPendingError();
  }
}

export const CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE =
  "EasyProxy local native-main profile maintenance is active; retry this request";

export class CodexMainProfileDrainingError extends Error {
  /**
   * Which startup-gate state fenced this request, when one did. Undefined means the
   * fence came from somewhere other than the startup gate — the turn-drain claim race
   * throws this same error while the gate reads `ready`, and inventing a reason there
   * would point the next report at a gate that never closed.
   *
   * Captured here rather than at the throw sites because this is the last moment it is
   * both in scope and still true: every catch site has already lost it, and re-reading
   * the gate later can observe a recovery that completed in between (#2108).
   */
  readonly reason?: NativeMainStartupBlockReason;

  constructor() {
    super(CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE);
    this.name = "CodexMainProfileDrainingError";
    const gate = nativeMainStartupGateSnapshot();
    if (gate.status !== "blocked") return;
    this.reason = gate.reason;
    reportNativeMainFenceReason(gate.reason);
  }
}

/**
 * #2108: a reboot could leave this fence closed until `epx restart`, and the report was
 * unactionable because the settled reason was never written anywhere. It cannot ride the
 * message (claude-messages.ts matches that string exactly to keep the fence a 503 rather
 * than an Anthropic 529) and it cannot ride a header (/api/logs reads only error.message
 * from the body, and the Claude surface rebuilds its response headers from scratch), so
 * stdout is the one surface that covers every path this fence fires on.
 *
 * Deduped per distinct reason: the original report shows three 503s in eleven seconds and
 * a real client retries harder than that, so a per-request line would bury the signal.
 * Only the reason is emitted; the snapshot's homeId is derived from a profile directory.
 */
const reportedFenceReasons = new Set<NativeMainStartupBlockReason>();

function reportNativeMainFenceReason(reason: NativeMainStartupBlockReason): void {
  if (reportedFenceReasons.has(reason)) return;
  reportedFenceReasons.add(reason);
  console.warn(
    `native-main admission is fenced (reason: ${reason}); native model requests return 503 until it clears`,
  );
}

/**
 * Test-only reset for the dedup set above.
 *
 * The dedup is process-lifetime module state, so it is order-sensitive across test files
 * sharing one Bun process: whichever file constructs this error first consumes the one-shot
 * warn, and a later file asserting on it would see nothing and pass vacuously. Any test that
 * asserts on the warn must call this first — an `afterEach` in the asserting file is not
 * enough on its own, because the consuming file may not be the asserting one.
 */
export function __resetNativeMainFenceReasonLog(): void {
  reportedFenceReasons.clear();
}

export function codexMainProfileDrainingResponse(): Response {
  const response = formatErrorResponse(503, "server_busy", CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE);
  const headers = new Headers(response.headers);
  headers.set("Retry-After", "1");
  return new Response(response.body, { status: response.status, headers });
}

export class CodexDirectAuthenticationError extends Error {
  constructor() {
    super("Codex Direct requires a caller Authorization bearer token");
    this.name = "CodexDirectAuthenticationError";
  }
}

export function hasCallerCodexBearer(headers: Headers): boolean {
  return /^Bearer\s+\S+/i.test(headers.get("authorization")?.trim() ?? "");
}

export class CodexAccountCooldownError extends Error {
  accountId: string;
  cooldownUntil: number;
  cooldownSource?: CodexCooldownSource;
  quotaScope?: CodexQuotaScope;

  constructor(
    accountId: string,
    cooldownUntil: number,
    cooldownSource?: CodexCooldownSource,
    quotaScope?: CodexQuotaScope,
  ) {
    super("Selected Codex account is cooling down");
    this.name = "CodexAccountCooldownError";
    this.accountId = accountId;
    this.cooldownUntil = cooldownUntil;
    this.cooldownSource = cooldownSource;
    this.quotaScope = quotaScope;
  }
}

export class CodexMainAccountHardLockError extends CodexAccountCooldownError {
  readonly resetAt?: number;
  /**
   * Earliest known recovery of another stored pool account, set only when an unpinned pool
   * selection reached main (#7046). A hint for the client's retry time; never routing input.
   */
  poolRecoveryAt?: number;

  constructor(resetAt?: number, thresholds = resolveMainAccountHardLockThresholds(undefined)) {
    super(MAIN_CODEX_ACCOUNT_ID, resetAt ?? 0);
    this.name = "CodexMainAccountHardLockError";
    this.resetAt = resetAt;
    this.message = `Codex main account is blocked by the main-account quota policy (5h ≥ ${thresholds.short}%, weekly ≥ ${thresholds.long}%).`
      + " Choose another account, wait for quota to reset, or disable codexMainAccountHardLock in Settings.";
  }
}

/** A stored pool account's spending policy is independent of account selection. */
export class CodexPoolAccountCreditsOffError extends CodexAccountCooldownError {
  readonly resetAt: number;

  constructor(accountId: string, resetAt: number, creditRecovery = false, quotaScope?: CodexQuotaScope) {
    // Keep the included reset; a metadata hint neither admits nor clears an upstream hold.
    super(accountId, creditRecovery ? poolCreditRecoveryRetryAt(accountId, resetAt, quotaScope) : resetAt);
    this.name = "CodexPoolAccountCreditsOffError";
    this.resetAt = resetAt;
    this.message = creditRecovery
      ? "The selected Codex account reached its usage limit and needs a fresh credit observation. Retry later; spending remains blocked until fresh spendable credits are observed."
      : "The selected Codex account reached its usage limit, and spending credits is off or no fresh spendable balance is available."
      + " Wait for the limit to reset, choose another account, or explicitly allow credits for this account in Codex Auth.";
  }
}

export function assertPoolAccountCredits(accountId: string, resetAt: number | undefined, creditRecovery: boolean, quotaScope?: CodexQuotaScope): void {
  if (resetAt !== undefined) throw new CodexPoolAccountCreditsOffError(accountId, resetAt, creditRecovery, quotaScope);
}

/** The main login may not spend credits and one of its usage windows is full (#6334). */
export class CodexMainAccountCreditsOffError extends CodexAccountCooldownError {
  readonly resetAt?: number;

  constructor(resetAt?: number, creditRecovery = false) {
    // Keep the included reset as policy evidence, but let consented callers retry within the base metadata recovery interval even when backoff grows longer.
    super(MAIN_CODEX_ACCOUNT_ID, creditRecovery
      ? Math.min(resetAt ?? Infinity, Date.now() + nextQuotaQueryDelay()) : resetAt ?? 0);
    this.name = "CodexMainAccountCreditsOffError";
    this.resetAt = resetAt;
    this.message = "Codex main account reached its usage limit, and spending ChatGPT credits is off or no fresh spendable balance is available."
      + " Choose another account, wait for the limit to reset, or allow the main account under \"Use credits\" in Codex Auth.";
  }
}

export class CodexReserveUnavailableError extends CodexAccountCooldownError {
  constructor() {
    super(MAIN_CODEX_ACCOUNT_ID, 0);
    this.name = "CodexReserveUnavailableError";
    this.message = "Codex Reserve is unavailable for this main credential."
      + " Use the stored main login or its matching caller credential, and retry when OpenAI grants Reserve access."
      + " Reserve compatibility requires the local Reserve setting (codexReserveEnabled); it cannot switch accounts automatically.";
  }
}

/** A local unsupported-helper refusal; retain Reserve policy error mapping on delayed sends. */
export class CodexReserveHelperUnsupportedError extends CodexReserveUnavailableError {
  constructor() {
    super();
    this.name = "CodexReserveHelperUnsupportedError";
    this.message = CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE;
  }
}

/**
 * Human-readable account label for a client-visible error. NEVER the raw id: the proxy
 * supports non-loopback binds (auth-cors.ts `isApiAuthRequired` requires a token there
 * rather than refusing), so data-plane bodies can reach remote authenticated clients.
 * The main login has no secret id, so it renders as the literal alias users type.
 */
export function cooldownAccountLabel(accountId: string): string {
  return accountId === MAIN_CODEX_ACCOUNT_ID ? "main" : maskAccountId(accountId) ?? "account-…????";
}

/**
 * Every account bound to this conversation is held after upstream failures, the recovery
 * budget for this window is spent, and there is no detour left -- so this request is refused
 * BEFORE any upstream I/O (#4701).
 */
export class CodexRecoveryWithheldError extends CodexAccountCooldownError {
  /** The sibling still remembered for this thread, when one exists but is itself unusable. */
  readonly detourAccountId?: string;

  constructor(accountId: string, retryAt: number, detourAccountId?: string) {
    super(accountId, retryAt);
    this.name = "CodexRecoveryWithheldError";
    this.detourAccountId = detourAccountId;
    this.message = `Codex account (${cooldownAccountLabel(accountId)}) is held after repeated upstream`
      + ` failures and the pool's recovery budget for this window is spent, so nothing was sent`
      + ` upstream. Retry after ${new Date(retryAt).toISOString()}.`
      + " This clears on its own as the account recovers; no cooldown to lift and no account to switch.";
  }
}

export class CodexMainSubstitutionUnavailableError extends Error {
  constructor() {
    super("No usable Codex main credential to substitute for an admission bearer");
    this.name = "CodexMainSubstitutionUnavailableError";
  }
}

export function assertMainAccountPolicy(
  config: Pick<EpxConfig, "codexMainAccountHardLock" | "codexMainAccountHardLockThresholds" | "creditCodexAccountIds" | "codexUseRemainingQuotaAccountIds"> | undefined,
): void {
  if (config) {
    const status = getMainAccountHardLockStatus(config);
    if (status.state === "blocked") throw new CodexMainAccountHardLockError(status.resetAt, status.thresholds);
    const creditsResetAt = mainCreditsHoldResetAt(config);
    if (creditsResetAt !== undefined) throw new CodexMainAccountCreditsOffError(creditsResetAt,
      codexAccountUsesCreditsAfterLimit(config, MAIN_CODEX_ACCOUNT_ID));
  }
  // Only an admitted request is easyproxy's own use of the main account. Counting a refused one
  // would hide outside usage from the warning exactly while the lock is holding.
  noteMainAccountActivity();
}

export function captureObservedMainWriter(): MainQuotaWriter | undefined {
  const identityKey = getObservedMainQuotaIdentityKey();
  return identityKey === undefined ? undefined : {
    identityKey,
    identityGeneration: captureMainAccountIdentityGeneration(),
  };
}

export function observeSelectedMainCredential(
  token: { accessToken: string; chatgptAccountId: string },
  writer: MainQuotaWriter | undefined,
): MainQuotaWriter | undefined {
  // A claimed RPC can observe a replacement identity while the caller awaits it. Only that
  // exact result carries the replacement writer; stale results keep their stale fence.
  const ownedWriter = mainAccountTokenQuotaWriter(token);
  if (ownedWriter) return ownedWriter;
  if (!writer) return undefined;
  // Carry an explicitly stale writer through to quota's rejection fence; turning it into an
  // untagged write would instead invalidate the replacement account's trusted observation.
  if (!isMainQuotaWriterLive(writer)) return writer;
  const observed = observeMainQuotaCredential(token.accessToken, token.chatgptAccountId);
  return observed?.identityKey === writer.identityKey ? writer : undefined;
}

export function requiresReserveAuthorization(
  config: CodexAuthPolicyConfig | undefined,
  modelId: string | undefined,
  admission: Pick<DataPlaneAdmission, "source"> | undefined,
): boolean {
  return modelId === NATIVE_RESERVE_MODEL && !!config && isCodexReserveRequestEligible(config, admission);
}

export function assertReserveAdmission(config: CodexAuthPolicyConfig): void {
  if (config.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID) || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) {
    throw new CodexReserveUnavailableError();
  }
  assertMainAccountPolicy(config);
  const cooldown = getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "reserve");
  if (cooldown?.cooldownUntil) {
    throw new CodexAccountCooldownError(MAIN_CODEX_ACCOUNT_ID, cooldown.cooldownUntil, cooldown.cooldownSource, cooldown.quotaScope);
  }
}

/** Authorize a reserve request for the main credential, re-checking admission and writer liveness, and publish the ordinary quota observed during the capability read. */
export async function authorizeReserveCredential(
  token: { accessToken: string; chatgptAccountId: string },
  writer: MainQuotaWriter | undefined,
  config: CodexAuthPolicyConfig,
  signal?: AbortSignal,
  existing?: MainReserveAuthorization,
  writerGeneration = captureConfigGeneration(),
): Promise<MainReserveAuthorization> {
  assertReserveAdmission(config);
  if (!writer || !isMainQuotaWriterLive(writer)
    || !matchesMainQuotaCredential(token.accessToken, token.chatgptAccountId)) {
    throw new CodexReserveUnavailableError();
  }
  const authorization = isMainReserveAuthorizationLive(existing, token) ? existing
    : await getMainReserveAuthorization({
      token, writer, signal,
      /** Publish the ordinary usage observed during the reserve capability read: parse it once and reuse that observation as the advisory decision evidence when it is a valid history observation. */
      observeOrdinaryQuota(data, capturedWriter) {
        const parsed = parseUsageQuota(data);
        setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, parsed, writerGeneration,
          capturedWriter, parseMainPolicyUsageQuota(data), undefined, false, false, isValidWhamHistoryObservation(data) ? parsed : null);
      },
    });
  // The capability read also publishes ordinary quota. A new 99% reading or cooldown wins.
  assertReserveAdmission(config);
  if (signal?.aborted) throw signal.reason;
  if (!authorization || !isMainReserveAuthorizationLive(authorization, token)) throw new CodexReserveUnavailableError();
  return authorization;
}

export function selectedCodexToken(headers: Headers): { accessToken: string; chatgptAccountId: string } {
  return {
    accessToken: authorizationCredential(headers) ?? "",
    chatgptAccountId: headers.get("chatgpt-account-id") ?? "",
  };
}

/** Retry history must not turn a later local admission refusal into a network failure. */
export function unwrapUpstreamRetryEvidenceError(error: unknown): unknown {
  const seen = new Set<unknown>();
  while (error instanceof UpstreamRetryEvidenceError && !seen.has(error)) {
    seen.add(error);
    error = error.cause;
  }
  return error;
}

/**
 * Actionable message for a cooled-down account: until when, why, and how to escape.
 * Shared by every transport so the WebSocket surface (Codex Desktop) says the same thing
 * as HTTP. The bare "cooling down" string left users with no route but commenting out the
 * injected `openai_base_url` in config.toml.
 */
export function cooldownErrorMessage(err: CodexAccountCooldownError, accountSelector?: string): string {
  if (err instanceof CodexMainAccountHardLockError
    // A credits-off refusal is a configuration policy, not a cooldown: clearing a cooldown
    // cannot lift it, so its own wording (wait for the reset or allow credits) is the remedy.
    || err instanceof CodexMainAccountCreditsOffError
    || err instanceof CodexPoolAccountCreditsOffError
    || err instanceof CodexReserveUnavailableError
    // A transient-hold refusal is not a quota cooldown. Its own wording is the only accurate
    // one, and the quota recovery advice below would send the operator after a cooldown that
    // does not exist (#4701).
    || err instanceof CodexRecoveryWithheldError) return err.message;
  const until = new Date(err.cooldownUntil).toISOString();
  const scopeLabels: Record<CodexQuotaScope, string> = {
    shared: "shared native quota", reserve: "Reserve quota",
  };
  const scope = err.quotaScope ? scopeLabels[err.quotaScope] : null;
  const selected = accountSelector
    ? `Selected Codex account selector (${accountSelector})`
    : `Selected Codex account (${cooldownAccountLabel(err.accountId)})`;
  const recovery = accountSelector
    ? " This request is pinned to that selector and will not switch accounts; choose another account-qualified model or retry later."
    : " Run 'epx account list openai' to find the id, then"
      + " 'epx account clear-cooldown openai <id>' to lift it, or switch accounts with 'epx account use openai <id>'.";
  return `${selected}${scope ? ` ${scope} is` : " is"} cooling down until ${until}`
    + ` (source: ${err.cooldownSource ?? "default"}).${recovery}`;
}

/**
 * The soonest a main hard-lock refusal is worth retrying: a sibling pool account's known
 * recovery when it comes first, otherwise main's own reset (#7046). A pool hint is held to at
 * least {@link MAIN_HARD_LOCK_MIN_POOL_RETRY_MS} so a hold about to lapse cannot turn the refusal
 * into a tight retry loop. Null when neither time is known and still in the future.
 */
export const MAIN_HARD_LOCK_MIN_POOL_RETRY_MS = 60_000;
export function mainHardLockRetryAt(err: CodexMainAccountHardLockError, now: number): number | null {
  const future = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > now ? value : null;
  const main = future(err.resetAt);
  const pool = future(err.poolRecoveryAt);
  const poolRetryAt = pool === null ? null : Math.max(pool, now + MAIN_HARD_LOCK_MIN_POOL_RETRY_MS);
  if (poolRetryAt !== null && (main === null || poolRetryAt < main)) return poolRetryAt;
  return main;
}

/** HTTP form of {@link cooldownErrorMessage}, carrying Retry-After for well-behaved clients. */
export function cooldownErrorResponse(
  err: CodexAccountCooldownError,
  now = Date.now(),
  accountSelector?: string,
): Response {
  if (err instanceof CodexMainAccountHardLockError) {
    // A local policy refusal with a known horizon, not a transient throttle (#7046): Codex keeps
    // a Goal active and sleeps through `rate_limit_exceeded` for the whole Retry-After, but
    // stops on `usage_limit_reached` and shows the reset. The guard itself is unchanged.
    const retryAt = mainHardLockRetryAt(err, now);
    return formatUsageLimitReachedResponse(cooldownErrorMessage(err, accountSelector), retryAt,
      retryAt === null ? null : Math.max(1, Math.ceil((retryAt - now) / 1000)));
  }
  const res = formatErrorResponse(429, "rate_limit_error", cooldownErrorMessage(err, accountSelector));
  const headers = new Headers(res.headers);
  if (!(err instanceof CodexReserveUnavailableError)) {
    const advice = formatClientRetryAfter(Math.max(1, Math.ceil((err.cooldownUntil - now) / 1000)));
    if (advice !== undefined) headers.set("Retry-After", advice);
  }
  return new Response(res.body, { status: res.status, headers });
}

export class CodexThreadAffinityExpiredError extends Error {
  accountId: string;

  constructor(accountId: string) {
    super("Codex thread account affinity expired");
    this.name = "CodexThreadAffinityExpiredError";
    this.accountId = accountId;
  }
}

export function shouldMarkAccountNeedsReauthForCodexAuthFailure(cause: unknown): boolean {
  return !(cause instanceof CodexMainAccountHardLockError)
    && !(cause instanceof CodexMainAccountCreditsOffError)
    && !(cause instanceof CodexPoolAccountCreditsOffError)
    && !(cause instanceof CodexAccountValidationPendingError)
    && !(cause instanceof CodexReserveUnavailableError)
    && !(cause instanceof CodexCredentialGenerationConflictError)
    && !(cause instanceof CodexCredentialRefreshLockTimeoutError)
    && !(cause instanceof CodexCredentialRefreshBusyError)
    && !(cause instanceof CodexCredentialRefreshStaleError)
    && !(cause instanceof MainAuthJsonChangedDuringRefreshError)
    && !(cause instanceof MainAccountTokenRefreshError)
    && !(cause instanceof NativeProfileError && cause.retryable)
    && !(cause instanceof DOMException && cause.name === "AbortError")
    && !(cause instanceof ConfigMutationLockError);
}
