import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EpxApiKeyEntry } from "../types";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { Float64RingBuffer } from "../lib/ring-buffer";
import { isProtectedHomeUnderTest } from "../lib/test-home-guard";
import { isCodexUsageAccountLogLabel, type PersistedUsageEntry } from "../usage/log";
import { computeEntryCost } from "../usage/summary";

export const MAX_TRACKED_API_KEYS = 1_024;
const MAX_ARCHIVED_DAILY_KEYS = 16_384;
const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 86_400_000;
const EXACT_RPM_RING_THRESHOLD = 1_024;
const MICROS_PER_USD = 1_000_000;
const MIN_DAILY_COST_LIMIT_USD = 0.000001;
const MAX_DAILY_COST_LIMIT_USD = 1_000_000;
const LEDGER_FILENAME = "api-key-budgets.json";
const MAX_LEDGER_FILE_BYTES = 4 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 100;

export type ApiKeyBudgetDenialReason =
  | "rpm_limit_exceeded"
  | "tpm_limit_exceeded"
  | "daily_limit_exceeded"
  | "daily_token_limit_exceeded"
  | "daily_cost_limit_exceeded"
  | "in_flight_cost_limit_exceeded"
  | "invalid_budget_limit";

export type ApiKeyBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: ApiKeyBudgetDenialReason; retryAfterSec: number };

export type ApiKeyBudgetEntry = Pick<
  EpxApiKeyEntry,
  "id" | "rpmLimit" | "tpmLimit" | "maxDailyRequests" | "dailyTokenLimit" | "dailyCostLimitUsd" | "maxInFlightCostUsd"
>;

export interface ApiKeyBudgetLease {
  readonly keyId: string;
  readonly reservedTokens: number;
  readonly reservedCostUsd: number;
  /** Roll back RPM and daily request increments plus active in-flight holds before execution. */
  releaseUnused(): void;
  /** Release any active in-flight token and USD holds without cancelling settled state. */
  releaseHoldOnly(): void;
  /** Atomically resize or set active in-flight token and USD holds before upstream dispatch. */
  reserveHold(entry: ApiKeyBudgetEntry, options?: { tokens?: number; costUsd?: number; now?: number }): ApiKeyBudgetDecision;
  /** Release any active token reservation hold and commit actual token usage at most once. */
  settleTokens(actualTokens: number, now?: number): void;
  /** Release any active USD reservation hold and commit settled USD spend at most once. */
  settleCostUsd(costUsd: number, now?: number): void;
}

export type ApiKeyBudgetLeaseDecision =
  | { allowed: true; lease: ApiKeyBudgetLease }
  | { allowed: false; reason: ApiKeyBudgetDenialReason; retryAfterSec: number };

export interface AcquireApiKeyBudgetOptions {
  reserveTokens?: number;
  reserveCostUsd?: number;
  now?: number;
}

interface StoredKeyBudget {
  utcDay: number;
  dailyCount: number;
  dailyTokens: number;
  dailyCostMicros: number;
}

interface KeyBudgetState {
  rpmTimestamps: Float64RingBuffer;
  rpmBucketStartMin: number;
  rpmBucketCount: number;
  tpmBucketSec: Float64Array;
  tpmBucketTokens: Float64Array;
  utcDay: number;
  dailyCount: number;
  dailyTokens: number;
  dailyCostMicros: number;
  inFlightReservedTokens: number;
  inFlightHoldMicros: number;
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
  reservedCostUsd: 0,
  releaseUnused() {},
  releaseHoldOnly() {},
  reserveHold() { return { allowed: true }; },
  settleTokens() {},
  settleCostUsd() {},
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
    const row = val as { utcDay?: unknown; dailyCount?: unknown; dailyTokens?: unknown; dailyCostMicros?: unknown };
    const dailyCostMicros = row.dailyCostMicros ?? 0;
    if (
      typeof row.utcDay !== "number" || !Number.isSafeInteger(row.utcDay) || row.utcDay < 0 ||
      typeof row.dailyCount !== "number" || !Number.isSafeInteger(row.dailyCount) || row.dailyCount < 0 ||
      typeof row.dailyTokens !== "number" || !Number.isSafeInteger(row.dailyTokens) || row.dailyTokens < 0 ||
      typeof dailyCostMicros !== "number" || !Number.isSafeInteger(dailyCostMicros) || dailyCostMicros < 0
    ) {
      continue;
    }
    if (row.dailyCount === 0 && row.dailyTokens === 0 && dailyCostMicros === 0) continue;
    if (row.utcDay > maxDay) maxDay = row.utcDay;
    if (store.archivedDaily.size >= MAX_ARCHIVED_DAILY_KEYS) {
      const oldest = store.archivedDaily.keys().next().value;
      if (oldest !== undefined) store.archivedDaily.delete(oldest);
    }
    store.archivedDaily.set(keyId, {
      utcDay: row.utcDay,
      dailyCount: row.dailyCount,
      dailyTokens: row.dailyTokens,
      dailyCostMicros,
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
    if (entry.utcDay < cutoffDay || (entry.dailyCount === 0 && entry.dailyTokens === 0 && entry.dailyCostMicros === 0)) continue;
    keysOut[keyId] = {
      utcDay: entry.utcDay,
      dailyCount: entry.dailyCount,
      dailyTokens: entry.dailyTokens,
      dailyCostMicros: entry.dailyCostMicros,
    };
  }
  for (const [keyId, state] of store.keys) {
    if (state.utcDay < cutoffDay || (state.dailyCount === 0 && state.dailyTokens === 0 && state.dailyCostMicros === 0)) {
      delete keysOut[keyId];
      continue;
    }
    keysOut[keyId] = {
      utcDay: state.utcDay,
      dailyCount: state.dailyCount,
      dailyTokens: state.dailyTokens,
      dailyCostMicros: state.dailyCostMicros,
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
    atomicWriteFileNoFollow(store.ledgerPath, serializeStoreLedger(store));
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
  if (entry.dailyCount <= 0 && entry.dailyTokens <= 0 && entry.dailyCostMicros <= 0) {
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
      if (oldestState.utcDay >= store.highestUtcDay && (oldestState.dailyCount > 0 || oldestState.dailyTokens > 0 || oldestState.dailyCostMicros > 0)) {
        setArchivedDaily(store, oldestKey, {
          utcDay: oldestState.utcDay,
          dailyCount: oldestState.dailyCount,
          dailyTokens: oldestState.dailyTokens,
          dailyCostMicros: oldestState.dailyCostMicros,
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
    tpmBucketSec: new Float64Array(60),
    tpmBucketTokens: new Float64Array(60),
    utcDay: initialUtcDay,
    dailyCount: sameDay ? archived.dailyCount : 0,
    dailyTokens: sameDay ? archived.dailyTokens : 0,
    dailyCostMicros: sameDay ? archived.dailyCostMicros : 0,
    inFlightReservedTokens: 0,
    inFlightHoldMicros: 0,
  };
  store.keys.set(keyId, fresh);
  return fresh;
}

function pruneRpmTimestamps(state: KeyBudgetState, now: number): void {
  state.rpmTimestamps.pruneLeq(now - ONE_MINUTE_MS);
}

function resetStateForUtcDay(state: KeyBudgetState, utcDay: number): void {
  state.utcDay = utcDay;
  state.dailyCount = 0;
  state.dailyTokens = 0;
  state.dailyCostMicros = 0;
}

function usdToMicrosClamped(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  const raw = Math.round(costUsd * MICROS_PER_USD);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, raw);
}

function recordTpmTokensOnState(state: KeyBudgetState, tokens: number, now: number): void {
  const sec = Math.floor(now / 1000);
  const slot = ((sec % 60) + 60) % 60;
  if (state.tpmBucketSec[slot] === sec) {
    state.tpmBucketTokens[slot] += tokens;
  } else {
    state.tpmBucketSec[slot] = sec;
    state.tpmBucketTokens[slot] = tokens;
  }
}

function summarizeTpmWindow(state: KeyBudgetState, now: number): { usedTokens: number; retryAfterSec: number } {
  const sec = Math.floor(now / 1000);
  const cutoffSec = sec - 60;
  let usedTokens = 0;
  let oldestSec = sec;
  let hasEntry = false;
  for (let i = 0; i < 60; i += 1) {
    const slotSec = state.tpmBucketSec[i]!;
    const tokens = state.tpmBucketTokens[i]!;
    if (slotSec > cutoffSec && tokens > 0) {
      usedTokens += tokens;
      if (!hasEntry || slotSec < oldestSec) {
        oldestSec = slotSec;
        hasEntry = true;
      }
    } else if (slotSec <= cutoffSec && slotSec !== 0) {
      state.tpmBucketSec[i] = 0;
      state.tpmBucketTokens[i] = 0;
    }
  }
  const retryAfterSec = hasEntry ? Math.max(1, oldestSec + 60 - sec) : 60;
  return { usedTokens, retryAfterSec };
}

function recordTokensOnStore(store: ConfigDirBudgetStore, keyId: string, tokens: number, now: number): void {
  if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
  const wholeTokens = Math.trunc(tokens);
  if (wholeTokens <= 0) return;
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = getOrCreateState(store, keyId, utcDay, minuteBucket);
  if (utcDay < state.utcDay) return;
  if (utcDay > state.utcDay) resetStateForUtcDay(state, utcDay);
  state.dailyTokens += wholeTokens;
  recordTpmTokensOnState(state, wholeTokens, now);
  scheduleFlush(store);
}

function recordCostMicrosOnStore(store: ConfigDirBudgetStore, keyId: string, costMicros: number, now: number): void {
  if (!keyId || !Number.isSafeInteger(costMicros) || costMicros <= 0) return;
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = getOrCreateState(store, keyId, utcDay, minuteBucket);
  if (utcDay < state.utcDay) return;
  if (utcDay > state.utcDay) resetStateForUtcDay(state, utcDay);
  state.dailyCostMicros = Math.min(Number.MAX_SAFE_INTEGER, state.dailyCostMicros + costMicros);
  scheduleFlush(store);
}

export function hasApiKeyBudgetLimits(
  entry: ApiKeyBudgetEntry,
): boolean {
  return entry.rpmLimit !== undefined
    || entry.tpmLimit !== undefined
    || entry.maxDailyRequests !== undefined
    || entry.dailyTokenLimit !== undefined
    || entry.dailyCostLimitUsd !== undefined
    || entry.maxInFlightCostUsd !== undefined;
}

function parseValidatedCostMicros(
  value: number | undefined,
): { ok: true; micros: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, micros: undefined };
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < MIN_DAILY_COST_LIMIT_USD
    || value > MAX_DAILY_COST_LIMIT_USD
  ) {
    return { ok: false };
  }
  const micros = Math.round(value * MICROS_PER_USD);
  if (!Number.isSafeInteger(micros) || micros < 1) {
    return { ok: false };
  }
  return { ok: true, micros };
}

function validateBudgetLimits(entry: ApiKeyBudgetEntry): {
  ok: true;
  rpmLimit?: number;
  tpmLimit?: number;
  maxDailyRequests?: number;
  dailyTokenLimit?: number;
  dailyCostLimitMicros?: number;
  maxInFlightCostMicros?: number;
} | { ok: false } {
  if (entry.rpmLimit !== undefined && (!Number.isSafeInteger(entry.rpmLimit) || entry.rpmLimit < 1)) return { ok: false };
  if (entry.tpmLimit !== undefined && (!Number.isSafeInteger(entry.tpmLimit) || entry.tpmLimit < 1)) return { ok: false };
  if (entry.maxDailyRequests !== undefined && (!Number.isSafeInteger(entry.maxDailyRequests) || entry.maxDailyRequests < 1)) return { ok: false };
  if (entry.dailyTokenLimit !== undefined && (!Number.isSafeInteger(entry.dailyTokenLimit) || entry.dailyTokenLimit < 1)) return { ok: false };
  const dailyCost = parseValidatedCostMicros(entry.dailyCostLimitUsd);
  if (!dailyCost.ok) return { ok: false };
  const maxInFlight = parseValidatedCostMicros(entry.maxInFlightCostUsd);
  if (!maxInFlight.ok) return { ok: false };
  return {
    ok: true,
    rpmLimit: entry.rpmLimit,
    tpmLimit: entry.tpmLimit,
    maxDailyRequests: entry.maxDailyRequests,
    dailyTokenLimit: entry.dailyTokenLimit,
    dailyCostLimitMicros: dailyCost.micros,
    maxInFlightCostMicros: maxInFlight.micros,
  };
}

function acquireBudgetInternal(
  entry: ApiKeyBudgetEntry,
  now: number,
  reserveTokens: number,
  reserveCostUsd: number,
  withHold: boolean,
): ApiKeyBudgetLeaseDecision {
  const validated = validateBudgetLimits(entry);
  if (!validated.ok) {
    return { allowed: false, reason: "invalid_budget_limit", retryAfterSec: 60 };
  }
  const {
    rpmLimit,
    tpmLimit,
    maxDailyRequests,
    dailyTokenLimit,
    dailyCostLimitMicros,
    maxInFlightCostMicros,
  } = validated;

  if (
    rpmLimit === undefined
    && tpmLimit === undefined
    && maxDailyRequests === undefined
    && dailyTokenLimit === undefined
    && dailyCostLimitMicros === undefined
    && maxInFlightCostMicros === undefined
  ) {
    return { allowed: true, lease: NOOP_LEASE };
  }

  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const store = getStore();
  const state = getOrCreateState(store, entry.id, utcDay, minuteBucket);

  if (utcDay > state.utcDay) {
    resetStateForUtcDay(state, utcDay);
    store.dirty = true;
  }
  if (minuteBucket > state.rpmBucketStartMin) {
    state.rpmBucketStartMin = minuteBucket;
    state.rpmBucketCount = 0;
  }
  if (state.rpmTimestamps.length > 0) {
    pruneRpmTimestamps(state, now);
  }

  const normalizedHoldTokens = withHold && (dailyTokenLimit !== undefined || tpmLimit !== undefined)
    ? Math.max(1, Math.trunc(Number.isFinite(reserveTokens) ? reserveTokens : 1))
    : 0;
  const requestedHoldMicros = withHold && (dailyCostLimitMicros !== undefined || maxInFlightCostMicros !== undefined)
    ? usdToMicrosClamped(reserveCostUsd)
    : 0;

  if (maxInFlightCostMicros !== undefined) {
    if (state.inFlightHoldMicros >= maxInFlightCostMicros || state.inFlightHoldMicros + requestedHoldMicros > maxInFlightCostMicros) {
      return { allowed: false, reason: "in_flight_cost_limit_exceeded", retryAfterSec: 1 };
    }
  }

  if (dailyCostLimitMicros !== undefined) {
    if (
      state.dailyCostMicros + state.inFlightHoldMicros >= dailyCostLimitMicros
      || state.dailyCostMicros + state.inFlightHoldMicros + requestedHoldMicros > dailyCostLimitMicros
    ) {
      const nextDayStartMs = (utcDay + 1) * ONE_DAY_MS;
      const retryAfterSec = Math.max(1, Math.ceil((nextDayStartMs - now) / 1000));
      return { allowed: false, reason: "daily_cost_limit_exceeded", retryAfterSec };
    }
  }

  if (tpmLimit !== undefined) {
    const tpm = summarizeTpmWindow(state, now);
    const projectedTpm = tpm.usedTokens + state.inFlightReservedTokens;
    if (projectedTpm >= tpmLimit) {
      return { allowed: false, reason: "tpm_limit_exceeded", retryAfterSec: tpm.retryAfterSec };
    }
  }

  if (dailyTokenLimit !== undefined) {
    const projectedDailyTokens = state.dailyTokens + state.inFlightReservedTokens;
    if (projectedDailyTokens >= dailyTokenLimit) {
      const nextDayStartMs = (utcDay + 1) * ONE_DAY_MS;
      const retryAfterSec = Math.max(1, Math.ceil((nextDayStartMs - now) / 1000));
      return { allowed: false, reason: "daily_token_limit_exceeded", retryAfterSec };
    }
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

  let activeReservedTokens = 0;
  if (normalizedHoldTokens > 0) {
    const tokenCap = Math.min(
      dailyTokenLimit ?? Number.MAX_SAFE_INTEGER,
      tpmLimit ?? Number.MAX_SAFE_INTEGER,
    );
    activeReservedTokens = reserveTokens > 1 ? normalizedHoldTokens : Math.min(tokenCap, normalizedHoldTokens);
    state.inFlightReservedTokens += activeReservedTokens;
  }
  let activeHoldMicros = requestedHoldMicros;
  if (activeHoldMicros > 0) {
    state.inFlightHoldMicros += activeHoldMicros;
  }

  let unusedReleased = false;
  let tokensSettled = false;
  let costSettled = false;
  const leaseUtcDay = state.utcDay;

  const releaseTokenHold = () => {
    if (activeReservedTokens <= 0) return;
    state.inFlightReservedTokens = Math.max(0, state.inFlightReservedTokens - activeReservedTokens);
    activeReservedTokens = 0;
  };
  const releaseCostHold = () => {
    if (activeHoldMicros <= 0) return;
    state.inFlightHoldMicros = Math.max(0, state.inFlightHoldMicros - activeHoldMicros);
    activeHoldMicros = 0;
  };
  const releaseHoldOnly = () => {
    releaseTokenHold();
    releaseCostHold();
  };

  const lease: ApiKeyBudgetLease = {
    keyId: entry.id,
    get reservedTokens() { return activeReservedTokens; },
    get reservedCostUsd() { return activeHoldMicros / MICROS_PER_USD; },
    releaseHoldOnly,
    reserveHold(nextEntry: ApiKeyBudgetEntry, holdOpts?: { tokens?: number; costUsd?: number; now?: number }): ApiKeyBudgetDecision {
      if (unusedReleased || tokensSettled || costSettled) return { allowed: true };
      const checkNow = holdOpts?.now ?? Date.now();
      const limits = validateBudgetLimits(nextEntry);
      if (!limits.ok) return { allowed: false, reason: "invalid_budget_limit", retryAfterSec: 60 };
      const checkUtcDay = Math.floor(checkNow / ONE_DAY_MS);
      if (checkUtcDay > state.utcDay) {
        resetStateForUtcDay(state, checkUtcDay);
        store.dirty = true;
      }
      const hasTokenQuota = limits.dailyTokenLimit !== undefined || limits.tpmLimit !== undefined;
      const requestedTokens = hasTokenQuota && holdOpts?.tokens !== undefined && Number.isFinite(holdOpts.tokens) && holdOpts.tokens > 0
        ? Math.trunc(holdOpts.tokens)
        : activeReservedTokens;
      const hasCostQuota = limits.dailyCostLimitMicros !== undefined || limits.maxInFlightCostMicros !== undefined;
      const requestedMicros = hasCostQuota && holdOpts?.costUsd !== undefined
        ? usdToMicrosClamped(holdOpts.costUsd)
        : activeHoldMicros;
      const otherTokens = Math.max(0, state.inFlightReservedTokens - activeReservedTokens);
      const otherMicros = Math.max(0, state.inFlightHoldMicros - activeHoldMicros);

      if (limits.maxInFlightCostMicros !== undefined && otherMicros + requestedMicros > limits.maxInFlightCostMicros) {
        return { allowed: false, reason: "in_flight_cost_limit_exceeded", retryAfterSec: 1 };
      }
      let targetMicros = requestedMicros;
      if (limits.dailyCostLimitMicros !== undefined) {
        const remainingMicros = limits.dailyCostLimitMicros - state.dailyCostMicros - otherMicros;
        if (remainingMicros <= 0 || (otherMicros > 0 && remainingMicros < requestedMicros)) {
          const nextDayStartMs = (checkUtcDay + 1) * ONE_DAY_MS;
          return { allowed: false, reason: "daily_cost_limit_exceeded", retryAfterSec: Math.max(1, Math.ceil((nextDayStartMs - checkNow) / 1000)) };
        }
        if (otherMicros === 0 && targetMicros > remainingMicros) {
          targetMicros = remainingMicros;
        }
      }
      if (limits.tpmLimit !== undefined) {
        const tpm = summarizeTpmWindow(state, checkNow);
        if (tpm.usedTokens + otherTokens >= limits.tpmLimit || tpm.usedTokens + otherTokens + requestedTokens > limits.tpmLimit) {
          return { allowed: false, reason: "tpm_limit_exceeded", retryAfterSec: tpm.retryAfterSec };
        }
      }
      let targetTokens = requestedTokens;
      if (limits.dailyTokenLimit !== undefined) {
        const remainingTokens = limits.dailyTokenLimit - state.dailyTokens - otherTokens;
        if (remainingTokens <= 0) {
          const nextDayStartMs = (checkUtcDay + 1) * ONE_DAY_MS;
          return { allowed: false, reason: "daily_token_limit_exceeded", retryAfterSec: Math.max(1, Math.ceil((nextDayStartMs - checkNow) / 1000)) };
        }
        // Without a separate tpmLimit, keep a non-blocking floor hold on the lone active request when configured tiny (e.g. limit=1).
        if (limits.tpmLimit === undefined && targetTokens > remainingTokens) {
          targetTokens = remainingTokens;
        } else if (otherTokens > 0 && targetTokens > remainingTokens) {
          const nextDayStartMs = (checkUtcDay + 1) * ONE_DAY_MS;
          return { allowed: false, reason: "daily_token_limit_exceeded", retryAfterSec: Math.max(1, Math.ceil((nextDayStartMs - checkNow) / 1000)) };
        }
      }
      state.inFlightReservedTokens = otherTokens + targetTokens;
      activeReservedTokens = targetTokens;
      state.inFlightHoldMicros = otherMicros + targetMicros;
      activeHoldMicros = targetMicros;
      return { allowed: true };
    },
    releaseUnused() {
      if (unusedReleased || tokensSettled || costSettled) return;
      unusedReleased = true;
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
      releaseTokenHold();
      if (unusedReleased || tokensSettled) return;
      tokensSettled = true;
      if (Number.isFinite(actualTokens) && actualTokens > 0) {
        recordTokensOnStore(store, entry.id, actualTokens, settleNow);
      }
    },
    settleCostUsd(costUsd: number, settleNow = Date.now()) {
      releaseCostHold();
      if (unusedReleased || costSettled) return;
      costSettled = true;
      const micros = usdToMicrosClamped(costUsd);
      if (micros > 0) {
        recordCostMicrosOnStore(store, entry.id, micros, settleNow);
      }
    },
  };

  return { allowed: true, lease };
}

/**
 * Checks per-key RPM, TPM, UTC-day request, UTC-day token, UTC-day USD cost, and max in-flight USD
 * caps, holding active token and USD reservations until settled or released.
 */
export function acquireApiKeyBudgetLease(
  entry: ApiKeyBudgetEntry,
  options?: AcquireApiKeyBudgetOptions,
): ApiKeyBudgetLeaseDecision {
  const now = options?.now ?? Date.now();
  const reserveTokens = options?.reserveTokens ?? 1;
  const reserveCostUsd = options?.reserveCostUsd ?? 0;
  return acquireBudgetInternal(entry, now, reserveTokens, reserveCostUsd, true);
}

/**
 * Checks and consumes per-key `rpmLimit`, `tpmLimit`, `maxDailyRequests`, `dailyTokenLimit`,
 * `dailyCostLimitUsd`, and `maxInFlightCostUsd` quotas before acquiring a server turn lease.
 */
export function consumeApiKeyBudget(
  entry: ApiKeyBudgetEntry,
  now = Date.now(),
): ApiKeyBudgetDecision {
  const decision = acquireBudgetInternal(entry, now, 0, 0, false);
  return decision.allowed ? { allowed: true } : decision;
}

/** Records committed request token usage against the key's UTC-day token ledger. */
export function recordApiKeyTokens(keyId: string, tokens: number, now = Date.now()): void {
  if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
  const store = getStore();
  recordTokensOnStore(store, keyId, tokens, now);
}

/** Records committed USD spend (converted to integer microdollars) against the key's UTC-day ledger. */
export function recordApiKeyCostUsd(keyId: string, costUsd: number, now = Date.now()): void {
  if (!keyId) return;
  const micros = usdToMicrosClamped(costUsd);
  if (micros <= 0) return;
  const store = getStore();
  recordCostMicrosOnStore(store, keyId, micros, now);
}

export type ApiKeyBudgetSettlementEntry = Omit<PersistedUsageEntry, "accountLogLabel"> & {
  readonly accountLogLabel?: string;
};

/** Settles both token and USD cost budgets for a finalized request log entry (or rolls back rejected requests). */
export function settleApiKeyRequestBudget(
  logCtx: {
    readonly apiKeyBudgetLease?: ApiKeyBudgetLease;
    readonly apiKeyId?: string;
    readonly requestBodyHolder?: { readonly rejected?: boolean };
  },
  entry: ApiKeyBudgetSettlementEntry,
  totalTokens: number | undefined,
  now: number,
): void {
  const lease = logCtx.apiKeyBudgetLease;
  if (!lease && !logCtx.apiKeyId) return;
  if (lease && logCtx.requestBodyHolder?.rejected) {
    lease.releaseUnused();
    return;
  }
  const { accountLogLabel, ...baseEntry } = entry;
  const normalizedEntry: PersistedUsageEntry =
    accountLogLabel !== undefined && isCodexUsageAccountLogLabel(accountLogLabel)
      ? { ...baseEntry, accountLogLabel }
      : baseEntry;
  const cost = computeEntryCost(normalizedEntry);
  if (lease) {
    lease.settleTokens(totalTokens ?? 0, now);
    lease.settleCostUsd(cost.costTotal > 0 ? cost.costTotal : 0, now);
    return;
  }
  if (totalTokens !== undefined && totalTokens > 0) {
    recordApiKeyTokens(logCtx.apiKeyId!, totalTokens, now);
  }
  if (cost.costTotal > 0) {
    recordApiKeyCostUsd(logCtx.apiKeyId!, cost.costTotal, now);
  }
}

export function getApiKeyBudgetSnapshot(keyId: string, now = Date.now()): {
  rpmCurrent: number;
  dailyRequestsUsed: number;
  dailyTokensUsed: number;
  dailyCostUsdUsed: number;
} {
  const store = getStore();
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = store.keys.get(keyId);
  if (!state) {
    const archived = store.archivedDaily.get(keyId);
    if (!archived || archived.utcDay !== utcDay) {
      return { rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0, dailyCostUsdUsed: 0 };
    }
    return {
      rpmCurrent: 0,
      dailyRequestsUsed: archived.dailyCount,
      dailyTokensUsed: archived.dailyTokens,
      dailyCostUsdUsed: archived.dailyCostMicros / MICROS_PER_USD,
    };
  }
  pruneRpmTimestamps(state, now);
  return {
    rpmCurrent: Math.max(state.rpmTimestamps.length, state.rpmBucketStartMin === minuteBucket ? state.rpmBucketCount : 0),
    dailyRequestsUsed: state.utcDay === utcDay ? state.dailyCount : 0,
    dailyTokensUsed: state.utcDay === utcDay ? state.dailyTokens : 0,
    dailyCostUsdUsed: state.utcDay === utcDay ? state.dailyCostMicros / MICROS_PER_USD : 0,
  };
}

export function getApiKeyBudgetHoldSnapshot(keyId: string, now = Date.now()): {
  rpmCurrent: number;
  tpmCurrent: number;
  inFlightTokens: number;
  inFlightCostUsdUsed: number;
  dailyRequestsUsed: number;
  dailyTokensUsed: number;
  dailyCostUsdUsed: number;
} {
  const base = getApiKeyBudgetSnapshot(keyId, now);
  const store = getStore();
  const state = store.keys.get(keyId);
  if (!state) {
    return { ...base, tpmCurrent: 0, inFlightTokens: 0, inFlightCostUsdUsed: 0 };
  }
  const tpm = summarizeTpmWindow(state, now);
  return {
    ...base,
    tpmCurrent: tpm.usedTokens,
    inFlightTokens: state.inFlightReservedTokens,
    inFlightCostUsdUsed: state.inFlightHoldMicros / MICROS_PER_USD,
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
