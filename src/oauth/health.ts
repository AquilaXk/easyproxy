import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { MainAccountHardLockStatus } from "../codex/main-account-hard-lock";
import type { MainAccountExternalUsageWarning } from "../codex/main-account-external-usage";
import { getCodexAccountHealthSnapshot } from "../codex/routing";
import { anthropicRoutingFor } from "./anthropic-routing";
import { isAccountNeedsReauth } from "../codex/account-runtime-state";
import { getCodexAccountCredential, listCodexAccountIds } from "../codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { readRuntimePort } from "../config/process-state";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { findLiveProxy } from "../server/proxy-liveness";
import { fetchBoundLocalManagementRead } from "../server/local-management-read-client";
import { accountNeedsReauthForStatus, loadAuthStore, peekAuthStore, peekOAuthRefreshIntent, readOAuthRefreshIntent } from "./store";
import type { ProviderAccount } from "./types";
import {
  CODEX_REAUTH_ACTION,
  MASKED_ACCOUNT_FALLBACK,
  oauthAccountHealthFields,
  oauthHealthActionFor as actionFor,
  oauthHealthLabel,
  oauthHealthSummary,
  projectCodexAccountHealth,
  projectOAuthAccountHealth,
  type CodexPoolAccountHealth,
  type OAuthAccountHealth,
  type OAuthAccountHealthFields,
  type OAuthHealthEntry,
  type OAuthHealthLabel,
  type OAuthReauthReason,
  type OAuthWarningReason,
} from "./codex-account-health";

export {
  CODEX_REAUTH_ACTION,
  MASKED_ACCOUNT_FALLBACK,
  oauthAccountHealthFields,
  oauthHealthLabel,
  oauthHealthSummary,
  projectCodexAccountHealth,
  projectOAuthAccountHealth,
  type CodexPoolAccountHealth,
  type OAuthAccountHealth,
  type OAuthAccountHealthFields,
  type OAuthHealthEntry,
  type OAuthHealthLabel,
  type OAuthReauthReason,
};

export type CollectOAuthHealthOptions = {
  /** Skip chmod/backup side effects when reading credential files (doctor/status). */
  observeOnly?: boolean;
  /**
   * When true (default), include Codex entries from this process's in-memory maps.
   * CLI surfaces should prefer {@link collectOAuthHealthEntriesForCli} which queries the live proxy.
   */
  includeLocalCodex?: boolean;
};

export function projectStoredOAuthAccountHealth(
  provider: string,
  account: ProviderAccount,
  now = Date.now(),
  opts: { observeOnly?: boolean } = {},
): OAuthAccountHealth {
  const anthropicSnap = isAnthropicInstanceId(provider)
    ? anthropicRoutingFor(provider).getAnthropicAccountHealthSnapshot(account.id, now)
    : null;
  const needsReauth = accountNeedsReauthForStatus(provider, account, now);
  return projectOAuthAccountHealth({
    needsReauth,
    reauthReason: needsReauth
      ? (account.needsReauthCause === "tos_violation" ? "tos_violation" : account.needsReauthReason ?? "refresh_failed")
      : undefined,
    cooldownUntilMs: anthropicSnap?.cooldownUntil,
    // Same mapping as the Codex pool's `cooldownReasonFromSource`: only a Retry-After is
    // request-rate throttling. A reset-derived cooldown means a usage window is spent, which
    // is quota, and reporting it as a rate limit would tell the operator to retry shortly.
    cooldownReason: anthropicSnap?.cooldownSource === "retry-after" ? "rate_limit" : anthropicSnap ? "quota" : undefined,
    warningReason: detectOAuthWarning(provider, account, opts.observeOnly === true, now),
    now,
  });
}

export function detectOAuthWarning(
  provider: string,
  account: ProviderAccount,
  observeOnly = false,
  now = Date.now(),
): OAuthWarningReason | undefined {
  const intent = observeOnly
    ? peekOAuthRefreshIntent(provider, account.id)
    : readOAuthRefreshIntent(provider, account.id);
  if (intent?.uncertain) return "refresh_conflict";
  const cred = account.credential;
  if (!cred?.access) return "stale_credentials";
  if (!cred.refresh) {
    if (
      provider === "kiro"
      && typeof cred.expires === "number"
      && Number.isFinite(cred.expires)
      && cred.expires > now
    ) {
      return undefined;
    }
    return "stale_credentials";
  }
  return undefined;
}

function pushEntry(
  entries: OAuthHealthEntry[],
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
): void {
  const action = actionFor(provider, health);
  entries.push({
    provider,
    accountId,
    health,
    ...(action ? { action } : {}),
  });
}

function collectLocalCodexEntries(now: number): OAuthHealthEntry[] {
  const entries: OAuthHealthEntry[] = [];
  const codexIds = new Set(listCodexAccountIds());
  codexIds.add(MAIN_CODEX_ACCOUNT_ID);
  for (const accountId of codexIds) {
    const snap = getCodexAccountHealthSnapshot(accountId, now);
    const needsReauth = isAccountNeedsReauth(accountId);
    const hasPoolCredential = accountId !== MAIN_CODEX_ACCOUNT_ID && getCodexAccountCredential(accountId) !== null;
    if (!hasPoolCredential && !needsReauth && !snap) continue;

    // Call the projector rather than inlining a second copy of it. This collector serves the CLI
    // (`epx status`, `epx doctor`) while the dashboard DTO goes through projectCodexAccountHealth,
    // and the duplicated body is exactly how the CLI would have kept reporting a revoked account
    // as healthy after the dashboard stopped.
    const health = projectCodexAccountHealth({ accountId, needsReauth, now });
    pushEntry(entries, "codex", accountId, health);
  }
  return entries;
}

export function collectOAuthHealthEntries(
  now = Date.now(),
  opts: CollectOAuthHealthOptions = {},
): OAuthHealthEntry[] {
  const observeOnly = opts.observeOnly === true;
  const includeLocalCodex = opts.includeLocalCodex !== false;
  const entries: OAuthHealthEntry[] = [];
  const store = observeOnly ? peekAuthStore() : loadAuthStore();

  for (const [provider, set] of Object.entries(store)) {
    for (const account of set.accounts) {
      const health = projectStoredOAuthAccountHealth(provider, account, now, { observeOnly });
      pushEntry(entries, provider, account.id, health);
    }
  }

  if (includeLocalCodex) {
    for (const entry of collectLocalCodexEntries(now)) entries.push(entry);
  }

  return entries;
}

export type CodexMainAccountPolicyHealth = MainAccountHardLockStatus & { externalUsage?: MainAccountExternalUsageWarning };

type ProxyCodexAccountHealth = {
  mainAccountHardLock?: unknown;
  id: string;
  health?: OAuthAccountHealth;
  needsReauth?: boolean;
};

const KNOWN_HEALTH_STATUSES = new Set(["healthy", "cooldown", "reauth_required", "warning"]);

function coerceRemoteAccountHealth(
  account: ProxyCodexAccountHealth,
): OAuthAccountHealth {
  const raw = account.health;
  if (raw && typeof raw === "object" && KNOWN_HEALTH_STATUSES.has((raw as { status?: string }).status ?? "")) {
    return raw;
  }
  return projectOAuthAccountHealth({ needsReauth: account.needsReauth === true });
}

type LiveProxyCodexHealthResult = {
  mainAccountHardLock?: CodexMainAccountPolicyHealth;
  source: CodexHealthSource;
  entries: OAuthHealthEntry[] | null;
};

/** Whitelisted projection: never forward account metadata or arbitrary management fields. */
export function projectMainAccountPolicyHealth(value: unknown): CodexMainAccountPolicyHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const thresholds = raw.thresholds as { short?: unknown; long?: unknown } | undefined;
  const percent = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
  if (typeof raw.enabled !== "boolean" || typeof raw.state !== "string"
    || !(raw.enabled ? ["unknown", "ready", "blocked"] : ["off"]).includes(raw.state)
    || !thresholds || !percent(thresholds.short) || !percent(thresholds.long)
    || !Number.isInteger(thresholds.short) || !Number.isInteger(thresholds.long)
    || thresholds.short < 80 || thresholds.short > thresholds.long) return undefined;
  const result: CodexMainAccountPolicyHealth = { enabled: raw.enabled,
    state: raw.state as MainAccountHardLockStatus["state"], thresholds: { short: thresholds.short, long: thresholds.long } };
  if (raw.window === "short" || raw.window === "long") result.window = raw.window;
  if (typeof raw.resetAt === "number" && Number.isFinite(raw.resetAt)) result.resetAt = raw.resetAt;
  const warning = raw.externalUsage as Partial<MainAccountExternalUsageWarning> | undefined;
  if (warning && (warning.window === "short" || warning.window === "long")
    && percent(warning.fromPercent) && percent(warning.toPercent)
    && typeof warning.observedAt === "number" && Number.isFinite(warning.observedAt)) {
    result.externalUsage = { window: warning.window, fromPercent: warning.fromPercent,
      toPercent: warning.toPercent, observedAt: warning.observedAt };
  }
  return result;
}

export async function fetchCodexHealthFromLiveProxy(
  fetchImpl: typeof fetch | undefined = undefined,
  findLiveProxyImpl: typeof findLiveProxy = findLiveProxy,
  readRuntimePortImpl: typeof readRuntimePort = readRuntimePort,
): Promise<LiveProxyCodexHealthResult> {
  const live = await findLiveProxyImpl();
  if (!live) return { source: "unavailable", entries: null };
  try {
    const read = await fetchBoundLocalManagementRead(
      live,
      LOCAL_MANAGEMENT_READ_PATHS.codexAccounts,
      { fetchImpl, readRuntime: readRuntimePortImpl, timeoutMs: 4_000 },
    );
    if (read.kind === "unavailable") {
      return { source: "management-api-unavailable", entries: null };
    }
    const res = read.response;
    if (res.status === 401 || res.status === 403) {
      return { source: "management-auth-failed", entries: null };
    }
    if (!res.ok) return { source: "management-api-unavailable", entries: null };
    const json = await res.json() as { accounts?: ProxyCodexAccountHealth[] };
    if (!Array.isArray(json.accounts)) return { source: "management-api-unavailable", entries: null };
    const entries: OAuthHealthEntry[] = [];
    for (const account of json.accounts) {
      if (!account?.id || typeof account.id !== "string") continue;
      pushEntry(entries, "codex", account.id, coerceRemoteAccountHealth(account));
    }
    const mainAccountHardLock = projectMainAccountPolicyHealth(
      json.accounts.find(account => account?.id === MAIN_CODEX_ACCOUNT_ID)?.mainAccountHardLock,
    );
    return { source: "management-api", entries, ...(mainAccountHardLock ? { mainAccountHardLock } : {}) };
  } catch {
    return { source: "management-api-unavailable", entries: null };
  }
}

/** How CLI/doctor obtained Codex cooldown/reauth (proxy memory only lives in the proxy). */
export type CodexHealthSource =
  | "management-api"
  | "unavailable"
  | "management-auth-failed"
  | "management-api-unavailable";

export type OAuthCliHealthReport = {
  mainAccountHardLock?: CodexMainAccountPolicyHealth;
  entries: OAuthHealthEntry[];
  codexHealthSource: CodexHealthSource;
};

/** Shown by `epx status` / `epx doctor` when the proxy management API is unreachable. */
export const CODEX_HEALTH_UNAVAILABLE_NOTE =
  "Codex health: unavailable (proxy not running; live cooldown/reauth requires the management API)";
export const CODEX_HEALTH_AUTH_FAILED_NOTE =
  "Codex health: unavailable (proxy running; management authentication failed)";
export const CODEX_HEALTH_MANAGEMENT_API_UNAVAILABLE_NOTE =
  "Codex health: unavailable (proxy running; management API did not return account health)";

/**
 * CLI/doctor collector: observe-only OAuth store reads, and Codex health only from the
 * running proxy management API. Never reads proxy process-local maps from the CLI process.
 */
export async function collectOAuthHealthEntriesForCli(
  now = Date.now(),
  deps: {
    fetchImpl?: typeof fetch;
    findLiveProxyImpl?: typeof findLiveProxy;
    readRuntimePortImpl?: typeof readRuntimePort;
  } = {},
): Promise<OAuthCliHealthReport> {
  const entries = collectOAuthHealthEntries(now, { observeOnly: true, includeLocalCodex: false });
  const remote = await fetchCodexHealthFromLiveProxy(
    deps.fetchImpl,
    deps.findLiveProxyImpl,
    deps.readRuntimePortImpl,
  );
  if (remote.entries) {
    for (const entry of remote.entries) entries.push(entry);
    return { entries, codexHealthSource: "management-api",
      ...(remote.mainAccountHardLock ? { mainAccountHardLock: remote.mainAccountHardLock } : {}) };
  }
  return { entries, codexHealthSource: remote.source };
}
