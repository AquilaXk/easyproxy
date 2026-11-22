import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EpxApiKeyEntry } from "../types";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { Float64RingBuffer } from "../lib/ring-buffer";
import { isProtectedHomeUnderTest } from "../lib/test-home-guard";

export const MAX_TRACKED_API_KEYS = 1_024;
const MAX_ARCHIVED_DAILY_KEYS = 16_384;
const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 86_400_000;
const EXACT_RPM_RING_THRESHOLD = 1_024;
const LEDGER_FILENAME = "api-key-budgets.json";
const MAX_LEDGER_FILE_BYTES = 4 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 100;

export type ApiKeyBudgetDenialReason =
  | "rpm_limit_exceeded"
  | "daily_limit_exceeded"
  | "daily_token_limit_exceeded"
  | "invalid_budget_limit";

export type ApiKeyBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: ApiKeyBudgetDenialReason; retryAfterSec: number };

export interface ApiKeyBudgetLease {
  readonly keyId: string;
  readonly reservedTokens: number;
  /** Roll back RPM and daily request increments plus reserved token hold before execution. */
  releaseUnused(): void;
  /** Release only the in-flight reserved token hold without cancelling settled state. */
  releaseHoldOnly(): void;
  /** Release any active token reservation hold and commit actual token usage at most once. */
  settleTokens(actualTokens: number, now?: number): void;
}

export type ApiKeyBudgetLeaseDecision =
  | { allowed: true; lease: ApiKeyBudgetLease }
  | { allowed: false; reason: ApiKeyBudgetDenialReason; retryAfterSec: number };

export interface AcquireApiKeyBudgetOptions {
  reserveTokens?: number;
  now?: number;
}

interface StoredKeyBudget {
  utcDay: number;
  dailyCount: number;
  dailyTokens: number;
}

interface KeyBudgetState {
  rpmTimestamps: Float64RingBuffer;
  rpmBucketStartMin: number;
  rpmBucketCount: number;
  utcDay: number;
  dailyCount: number;
  dailyTokens: number;
  inFlightReservedTokens: number;
}

interface ConfigDirBudgetStore {
  readonly dir: string;
  readonly ledgerPath: string;
  readonly keys: Map<string, KeyBudgetState>;
  readonly archivedDaily: Map<string, StoredKeyBudget>;
  highestUtcDay: number;
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
}

const NOOP_LEASE: ApiKeyBudgetLease = {
  keyId: "",
  reservedTokens: 0,
  releaseUnused() {},
  releaseHoldOnly() {},
  settleTokens() {},
};

const stores = new Map<string, ConfigDirBudgetStore>();

registerOptionalShutdownHook("api-key-budgets", () => {
  flushApiKeyBudgets();
});

function currentConfigDir(): string {
  return resolve(getConfigDir());
}

function createEmptyStore(dir: string): ConfigDirBudgetStore {
  return {
    dir,
    ledgerPath: join(dir, LEDGER_FILENAME),
    keys: new Map(),
    archivedDaily: new Map(),
    highestUtcDay: 0,
    dirty: false,
    flushTimer: undefined,
  };
}

function hydrateStoreFromDisk(store: ConfigDirBudgetStore): void {
  if (isProtectedHomeUnderTest(store.dir)) return;
  let stat;
  try {
    stat = lstatSync(store.ledgerPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LEDGER_FILE_BYTES) return;
  let raw: string;
  try {
    raw = readFileSync(store.ledgerPath, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as { version?: unknown; keys?: unknown };
  if (record.version !== 1 || !record.keys || typeof record.keys !== "object" || Array.isArray(record.keys)) {
    return;
  }
  let maxDay = 0;
  for (const [keyId, val] of Object.entries(record.keys as Record<string, unknown>)) {
    if (!keyId || keyId === "__proto__" || keyId === "constructor" || keyId === "prototype") continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const row = val as { utcDay?: unknown; dailyCount?: unknown; dailyTokens?: unknown };
    if (
      typeof row.utcDay !== "number" || !Number.isSafeInteger(row.utcDay) || row.utcDay < 0 ||
      typeof row.dailyCount !== "number" || !Number.isSafeInteger(row.dailyCount) || row.dailyCount < 0 ||
      typeof row.dailyTokens !== "number" || !Number.isSafeInteger(row.dailyTokens) || row.dailyTokens < 0
    ) {
      continue;
    }
    if (row.dailyCount === 0 && row.dailyTokens === 0) continue;
    if (row.utcDay > maxDay) maxDay = row.utcDay;
    if (store.archivedDaily.size >= MAX_ARCHIVED_DAILY_KEYS) {
      const oldest = store.archivedDaily.keys().next().value;
      if (oldest !== undefined) store.archivedDaily.delete(oldest);
    }
    store.archivedDaily.set(keyId, {
      utcDay: row.utcDay,
      dailyCount: row.dailyCount,
      dailyTokens: row.dailyTokens,
    });
  }
  store.highestUtcDay = maxDay;
}

function getStore(): ConfigDirBudgetStore {
  const dir = currentConfigDir();
  const existing = stores.get(dir);
  if (existing) return existing;
  const store = createEmptyStore(dir);
  hydrateStoreFromDisk(store);
  stores.set(dir, store);
  return store;
}

function serializeStoreLedger(store: ConfigDirBudgetStore): string {
  const keysOut: Record<string, StoredKeyBudget> = Object.create(null);
  const cutoffDay = store.highestUtcDay;
  for (const [keyId, entry] of store.archivedDaily) {
    if (entry.utcDay < cutoffDay || (entry.dailyCount === 0 && entry.dailyTokens === 0)) continue;
    keysOut[keyId] = {
      utcDay: entry.utcDay,
      dailyCount: entry.dailyCount,
      dailyTokens: entry.dailyTokens,
    };
  }
  for (const [keyId, state] of store.keys) {
    if (state.utcDay < cutoffDay || (state.dailyCount === 0 && state.dailyTokens === 0)) {
      delete keysOut[keyId];
      continue;
    }
    keysOut[keyId] = {
      utcDay: state.utcDay,
      dailyCount: state.dailyCount,
      dailyTokens: state.dailyTokens,
    };
  }
  return JSON.stringify({ version: 1, keys: keysOut });
}

function flushStoreSync(store: ConfigDirBudgetStore): void {
  if (store.flushTimer !== undefined) {
    clearTimeout(store.flushTimer);
    store.flushTimer = undefined;
  }
  if (!store.dirty) return;
  if (isProtectedHomeUnderTest(store.dir) || !existsSync(store.dir)) {
    store.dirty = false;
    return;
  }
  try {
    atomicWriteFile(store.ledgerPath, serializeStoreLedger(store));
    store.dirty = false;
  } catch {
    // Keep dirty state false when directory is transient/disappearing under teardown.
    if (!existsSync(store.dir)) store.dirty = false;
  }
}

function scheduleFlush(store: ConfigDirBudgetStore): void {
  store.dirty = true;
  if (store.flushTimer !== undefined || isProtectedHomeUnderTest(store.dir)) return;
  const timer = setTimeout(() => {
    store.flushTimer = undefined;
    if (stores.get(store.dir) !== store) return;
    flushStoreSync(store);
  }, PERSIST_DEBOUNCE_MS);
  timer.unref?.();
  store.flushTimer = timer;
}

function setArchivedDaily(store: ConfigDirBudgetStore, keyId: string, entry: StoredKeyBudget): void {
  if (entry.dailyCount <= 0 && entry.dailyTokens <= 0) {
    store.archivedDaily.delete(keyId);
    return;
  }
  if (!store.archivedDaily.has(keyId) && store.archivedDaily.size >= MAX_ARCHIVED_DAILY_KEYS) {
    const oldest = store.archivedDaily.keys().next().value;
    if (oldest !== undefined) store.archivedDaily.delete(oldest);
  }
  store.archivedDaily.set(keyId, entry);
}

function pickEvictionCandidate(store: ConfigDirBudgetStore): [string, KeyBudgetState] | undefined {
  let fallback: [string, KeyBudgetState] | undefined;
  for (const pair of store.keys) {
    fallback ??= pair;
    if (pair[1].inFlightReservedTokens === 0) return pair;
  }
  return fallback;
}

function getOrCreateState(
  store: ConfigDirBudgetStore,
  keyId: string,
  utcDay: number,
  minuteBucket: number,
): KeyBudgetState {
  if (utcDay > store.highestUtcDay) store.highestUtcDay = utcDay;
  const existing = store.keys.get(keyId);
  if (existing) {
    // Refresh insertion order only when the map crosses half capacity to avoid delete+set churn on every turn.
    if (store.keys.size >= (MAX_TRACKED_API_KEYS >>> 1)) {
      store.keys.delete(keyId);
      store.keys.set(keyId, existing);
    }
    return existing;
  }
  if (store.keys.size >= MAX_TRACKED_API_KEYS) {
    const candidate = pickEvictionCandidate(store);
    if (candidate) {
      const [oldestKey, oldestState] = candidate;
      store.keys.delete(oldestKey);
      if (oldestState.utcDay >= store.highestUtcDay && (oldestState.dailyCount > 0 || oldestState.dailyTokens > 0)) {
        setArchivedDaily(store, oldestKey, {
          utcDay: oldestState.utcDay,
          dailyCount: oldestState.dailyCount,
          dailyTokens: oldestState.dailyTokens,
        });
        store.dirty = true;
        flushStoreSync(store);
      }
    }
  }
  const archived = store.archivedDaily.get(keyId);
  if (archived) store.archivedDaily.delete(keyId);
  const initialUtcDay = archived && archived.utcDay > utcDay ? archived.utcDay : utcDay;
  const sameDay = archived !== undefined && archived.utcDay === initialUtcDay;
  const fresh: KeyBudgetState = {
    rpmTimestamps: new Float64RingBuffer(EXACT_RPM_RING_THRESHOLD),
    rpmBucketStartMin: minuteBucket,
    rpmBucketCount: 0,
    utcDay: initialUtcDay,
    dailyCount: sameDay ? archived.dailyCount : 0,
    dailyTokens: sameDay ? archived.dailyTokens : 0,
    inFlightReservedTokens: 0,
  };
  store.keys.set(keyId, fresh);
  return fresh;
}

function pruneRpmTimestamps(state: KeyBudgetState, now: number): void {
  state.rpmTimestamps.pruneLeq(now - ONE_MINUTE_MS);
}

function recordTokensOnStore(store: ConfigDirBudgetStore, keyId: string, tokens: number, now: number): void {
  if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = getOrCreateState(store, keyId, utcDay, minuteBucket);
  if (utcDay < state.utcDay) return;
  if (utcDay > state.utcDay) {
    state.utcDay = utcDay;
    state.dailyCount = 0;
    state.dailyTokens = 0;
  }
  state.dailyTokens += Math.trunc(tokens);
  scheduleFlush(store);
}

function acquireBudgetInternal(
  entry: Pick<EpxApiKeyEntry, "id" | "rpmLimit" | "maxDailyRequests" | "dailyTokenLimit">,
  now: number,
  reserveTokens: number,
  withTokenHold: boolean,
): ApiKeyBudgetLeaseDecision {
  if (entry.rpmLimit !== undefined && (!Number.isSafeInteger(entry.rpmLimit) || entry.rpmLimit < 1)) {
    return { allowed: false, reason: "invalid_budget_limit", retryAfterSec: 60 };
  }
  if (entry.maxDailyRequests !== undefined && (!Number.isSafeInteger(entry.maxDailyRequests) || entry.maxDailyRequests < 1)) {
    return { allowed: false, reason: "invalid_budget_limit", retryAfterSec: 60 };
  }
  if (entry.dailyTokenLimit !== undefined && (!Number.isSafeInteger(entry.dailyTokenLimit) || entry.dailyTokenLimit < 1)) {
    return { allowed: false, reason: "invalid_budget_limit", retryAfterSec: 60 };
  }
  const rpmLimit = entry.rpmLimit;
  const maxDailyRequests = entry.maxDailyRequests;
  const dailyTokenLimit = entry.dailyTokenLimit;

  if (rpmLimit === undefined && maxDailyRequests === undefined && dailyTokenLimit === undefined) {
    return { allowed: true, lease: NOOP_LEASE };
  }

  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const store = getStore();
  const state = getOrCreateState(store, entry.id, utcDay, minuteBucket);

  if (utcDay > state.utcDay) {
    state.utcDay = utcDay;
    state.dailyCount = 0;
    state.dailyTokens = 0;
    store.dirty = true;
  }
  if (minuteBucket > state.rpmBucketStartMin) {
    state.rpmBucketStartMin = minuteBucket;
    state.rpmBucketCount = 0;
  }
  if (state.rpmTimestamps.length > 0) {
    pruneRpmTimestamps(state, now);
  }

  if (dailyTokenLimit !== undefined && state.dailyTokens + state.inFlightReservedTokens >= dailyTokenLimit) {
    const nextDayStartMs = (utcDay + 1) * ONE_DAY_MS;
    const retryAfterSec = Math.max(1, Math.ceil((nextDayStartMs - now) / 1000));
    return { allowed: false, reason: "daily_token_limit_exceeded", retryAfterSec };
  }

  if (maxDailyRequests !== undefined && state.dailyCount >= maxDailyRequests) {
    const nextDayStartMs = (utcDay + 1) * ONE_DAY_MS;
    const retryAfterSec = Math.max(1, Math.ceil((nextDayStartMs - now) / 1000));
    return { allowed: false, reason: "daily_limit_exceeded", retryAfterSec };
  }

  if (rpmLimit !== undefined) {
    const effectiveRpm = Math.max(state.rpmTimestamps.length, state.rpmBucketCount);
    if (effectiveRpm >= rpmLimit) {
      let retryAfterSec: number;
      if (rpmLimit <= EXACT_RPM_RING_THRESHOLD && state.rpmTimestamps.length >= rpmLimit) {
        const anchor = state.rpmTimestamps.at(state.rpmTimestamps.length - rpmLimit)!;
        retryAfterSec = Math.max(1, Math.ceil((anchor + ONE_MINUTE_MS - now) / 1000));
      } else {
        const nextMinuteStartMs = (minuteBucket + 1) * ONE_MINUTE_MS;
        retryAfterSec = Math.max(1, Math.ceil((nextMinuteStartMs - now) / 1000));
      }
      return { allowed: false, reason: "rpm_limit_exceeded", retryAfterSec };
    }
  }

  let dailyCountAdded = false;
  if (maxDailyRequests !== undefined) {
    state.dailyCount += 1;
    dailyCountAdded = true;
    scheduleFlush(store);
  }

  let rpmBucketAdded = false;
  let pushedTimestamp: number | undefined;
  if (rpmLimit !== undefined) {
    state.rpmBucketCount += 1;
    rpmBucketAdded = true;
    if (rpmLimit <= EXACT_RPM_RING_THRESHOLD) {
      state.rpmTimestamps.push(now);
      pushedTimestamp = now;
    }
  }

  const reservedTokens = withTokenHold && dailyTokenLimit !== undefined
    ? Math.min(dailyTokenLimit, Math.max(1, Math.trunc(Number.isFinite(reserveTokens) ? reserveTokens : 1)))
    : 0;
  if (reservedTokens > 0) {
    state.inFlightReservedTokens += reservedTokens;
  }

  let holdReleased = reservedTokens === 0;
  let settled = false;
  const leaseUtcDay = state.utcDay;

  const releaseHoldOnly = () => {
    if (holdReleased) return;
    holdReleased = true;
    state.inFlightReservedTokens = Math.max(0, state.inFlightReservedTokens - reservedTokens);
  };

  const lease: ApiKeyBudgetLease = {
    keyId: entry.id,
    reservedTokens,
    releaseHoldOnly,
    releaseUnused() {
      if (settled) return;
      settled = true;
      releaseHoldOnly();
      if (dailyCountAdded) {
        if (state.utcDay === leaseUtcDay && state.dailyCount > 0) {
          state.dailyCount -= 1;
          scheduleFlush(store);
        } else {
          const archived = store.archivedDaily.get(entry.id);
          if (archived && archived.utcDay === leaseUtcDay && archived.dailyCount > 0) {
            archived.dailyCount -= 1;
            setArchivedDaily(store, entry.id, archived);
            scheduleFlush(store);
          }
        }
      }
      if (rpmBucketAdded && state.rpmBucketStartMin === minuteBucket && state.rpmBucketCount > 0) {
        state.rpmBucketCount -= 1;
      }
      if (pushedTimestamp !== undefined) {
        state.rpmTimestamps.removeLastEqual(pushedTimestamp);
      }
    },
    settleTokens(actualTokens: number, settleNow = Date.now()) {
      releaseHoldOnly();
      if (settled) return;
      settled = true;
      if (Number.isFinite(actualTokens) && actualTokens > 0) {
        recordTokensOnStore(store, entry.id, actualTokens, settleNow);
      }
    },
  };

  return { allowed: true, lease };
}

/**
 * Checks per-key RPM, UTC-day request, and UTC-day token caps, holding an in-flight token
 * reservation until `lease.settleTokens(...)` or `lease.releaseUnused()` completes.
 */
export function acquireApiKeyBudgetLease(
  entry: Pick<EpxApiKeyEntry, "id" | "rpmLimit" | "maxDailyRequests" | "dailyTokenLimit">,
  options?: AcquireApiKeyBudgetOptions,
): ApiKeyBudgetLeaseDecision {
  const now = options?.now ?? Date.now();
  const reserveTokens = options?.reserveTokens ?? 1;
  return acquireBudgetInternal(entry, now, reserveTokens, true);
}

/**
 * Checks and consumes per-key `rpmLimit`, `maxDailyRequests`, and `dailyTokenLimit` quotas
 * before acquiring a server turn lease. Rejects fail-closed when any cap is invalid or exceeded
 * without incrementing counters on denial.
 */
export function consumeApiKeyBudget(
  entry: Pick<EpxApiKeyEntry, "id" | "rpmLimit" | "maxDailyRequests" | "dailyTokenLimit">,
  now = Date.now(),
): ApiKeyBudgetDecision {
  const decision = acquireBudgetInternal(entry, now, 0, false);
  return decision.allowed ? { allowed: true } : decision;
}

/** Records committed request token usage against the key's UTC-day token ledger. */
export function recordApiKeyTokens(keyId: string, tokens: number, now = Date.now()): void {
  if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
  const store = getStore();
  recordTokensOnStore(store, keyId, tokens, now);
}

export function getApiKeyBudgetSnapshot(keyId: string, now = Date.now()): {
  rpmCurrent: number;
  dailyRequestsUsed: number;
  dailyTokensUsed: number;
} {
  const store = getStore();
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = store.keys.get(keyId);
  if (!state) {
    const archived = store.archivedDaily.get(keyId);
    if (!archived || archived.utcDay !== utcDay) {
      return { rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0 };
    }
    return {
      rpmCurrent: 0,
      dailyRequestsUsed: archived.dailyCount,
      dailyTokensUsed: archived.dailyTokens,
    };
  }
  pruneRpmTimestamps(state, now);
  return {
    rpmCurrent: Math.max(state.rpmTimestamps.length, state.rpmBucketStartMin === minuteBucket ? state.rpmBucketCount : 0),
    dailyRequestsUsed: state.utcDay === utcDay ? state.dailyCount : 0,
    dailyTokensUsed: state.utcDay === utcDay ? state.dailyTokens : 0,
  };
}

export function peekApiKeyBudgetUsage(keyId: string, now = Date.now()): {
  minuteCount: number;
  dailyCount: number;
} {
  const snap = getApiKeyBudgetSnapshot(keyId, now);
  return { minuteCount: snap.rpmCurrent, dailyCount: snap.dailyRequestsUsed };
}

/** Synchronously flushes any dirty per-config-dir API-key budget ledgers to disk. */
export function flushApiKeyBudgets(): void {
  for (const store of stores.values()) {
    flushStoreSync(store);
  }
}

/** Clears in-memory stores after flushing so tests can simulate process restart hydration. */
export function reloadApiKeyBudgetsFromDiskForTests(): void {
  flushApiKeyBudgets();
  stores.clear();
}

export function resetApiKeyBudgetsForTests(): void {
  for (const store of stores.values()) {
    if (store.flushTimer !== undefined) {
      clearTimeout(store.flushTimer);
      store.flushTimer = undefined;
    }
    if (!isProtectedHomeUnderTest(store.dir) && existsSync(store.ledgerPath)) {
      try { unlinkSync(store.ledgerPath); } catch { /* already gone */ }
    }
  }
  const activeDir = currentConfigDir();
  const activeLedger = join(activeDir, LEDGER_FILENAME);
  if (!isProtectedHomeUnderTest(activeDir) && existsSync(activeLedger)) {
    try { unlinkSync(activeLedger); } catch { /* already gone */ }
  }
  stores.clear();
}
