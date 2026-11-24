/** Leaf state store for per-account Kiro allowance exhaustion verdicts. */
import { getAccountSet } from "../oauth/store";
import type { ProviderAccount } from "../oauth/types";
import { kiroEvidenceIdentity, type KiroPersistedVerdict } from "./kiro-account-evidence";
import { ACCOUNT_QUOTA_TTL_MS } from "./quota-wire";

export interface KiroUsageStateEntry {
  exhausted: boolean;
  nextResetAt?: number;
  observedAt: number;
  identity: string;
}

export interface KiroUsageVerdictSnapshot {
  exhausted: boolean;
  nextResetAt?: number;
}

const kiroCacheKey = (accountId: string): string => `kiro\u0000${accountId}`;

/**
 * Exhaustion state, keyed identically to per-account quota rows.
 * Written inside quota commit guards and cleared on logout/reconcile so a removed account
 * cannot leave a verdict behind for its replacement.
 */
const usageState = new Map<string, KiroUsageStateEntry>();

export function getKiroUsageStateEntry(key: string): KiroUsageStateEntry | undefined {
  return usageState.get(key);
}

export function setKiroUsageStateEntry(key: string, entry: KiroUsageStateEntry): void {
  usageState.set(key, entry);
}

/** Record exhaustion for a probed account. Called from the quota cache's commit guard. */
export function commitKiroAccountUsageState(key: string, snapshot: KiroUsageVerdictSnapshot | null, identity?: string): void {
  if (!snapshot) {
    usageState.delete(key);
    return;
  }
  if (!identity) return;
  usageState.set(key, {
    exhausted: snapshot.exhausted,
    ...(snapshot.nextResetAt !== undefined ? { nextResetAt: snapshot.nextResetAt } : {}),
    observedAt: Date.now(), identity,
  });
}

export function* kiroPersistableVerdicts(now = Date.now()): IterableIterator<[string, KiroPersistedVerdict]> {
  const live = new Map(getAccountSet("kiro")?.accounts.map(account =>
    [kiroCacheKey(account.id), kiroEvidenceIdentity(account)]) ?? []);
  for (const [key, entry] of usageState) {
    if (live.get(key) !== entry.identity || entry.observedAt > now
      || now - entry.observedAt >= ACCOUNT_QUOTA_TTL_MS
      || (entry.nextResetAt !== undefined && entry.nextResetAt <= now)) continue;
    yield [key, { exhausted: entry.exhausted, observedAt: entry.observedAt, identity: entry.identity,
      ...(entry.nextResetAt !== undefined ? { resetAt: entry.nextResetAt } : {}) }];
  }
}

export function hydrateKiroUsageVerdict(key: string, verdict: KiroPersistedVerdict, account: ProviderAccount): void {
  if (usageState.has(key) || verdict.identity !== kiroEvidenceIdentity(account)) return;
  usageState.set(key, { exhausted: verdict.exhausted, observedAt: verdict.observedAt,
    identity: verdict.identity, ...(verdict.resetAt !== undefined ? { nextResetAt: verdict.resetAt } : {}) });
}

/**
 * Is this account known to be out of allowance right now?
 *
 * Returns `null` (unknown) rather than a stale `true`: an expired reading, or one whose
 * reset time has already passed, must degrade to "try it again", never to "keep it parked".
 */
export function getKiroAccountExhaustion(
  key: string,
  account: ProviderAccount,
  now = Date.now(),
): { exhausted: boolean; nextResetAt?: number } | null {
  const entry = usageState.get(key);
  if (!entry || entry.identity !== kiroEvidenceIdentity(account)) return null;
  if (entry.observedAt > now || now - entry.observedAt >= ACCOUNT_QUOTA_TTL_MS) return null;
  if (entry.nextResetAt !== undefined && entry.nextResetAt <= now) return null;
  return {
    exhausted: entry.exhausted,
    ...(entry.nextResetAt !== undefined ? { nextResetAt: entry.nextResetAt } : {}),
  };
}

/** Drop rows for one provider prefix, or all of them. Mirrors clearAccountQuotaCache. */
export function clearKiroAccountUsageState(prefix?: string): void {
  if (!prefix) {
    usageState.clear();
    return;
  }
  for (const key of [...usageState.keys()]) {
    if (key.startsWith(prefix)) usageState.delete(key);
  }
}

/** Drop rows whose account no longer exists. Mirrors reconcileProviderAccountQuotaRows. */
export function reconcileKiroAccountUsageState(liveKeys: ReadonlySet<string>): number {
  let removed = 0;
  for (const key of [...usageState.keys()]) {
    if (liveKeys.has(key)) continue;
    usageState.delete(key);
    removed += 1;
  }
  return removed;
}
