import type { EpxApiKeyEntry } from "../types";
import { Float64RingBuffer } from "../lib/ring-buffer";

export const MAX_TRACKED_API_KEYS = 1_024;
const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 86_400_000;
const EXACT_RPM_RING_THRESHOLD = 1_024;

export type ApiKeyBudgetDenialReason =
  | "rpm_limit_exceeded"
  | "daily_limit_exceeded"
  | "daily_token_limit_exceeded"
  | "invalid_budget_limit";

export type ApiKeyBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: ApiKeyBudgetDenialReason; retryAfterSec: number };

interface KeyBudgetState {
  rpmTimestamps: Float64RingBuffer;
  rpmBucketStartMin: number;
  rpmBucketCount: number;
  utcDay: number;
  dailyCount: number;
  dailyTokens: number;
}

const keyBudgets = new Map<string, KeyBudgetState>();

function getOrCreateState(keyId: string, utcDay: number, minuteBucket: number): KeyBudgetState {
  const existing = keyBudgets.get(keyId);
  if (existing) {
    // Refresh insertion order only when the map crosses half capacity to avoid delete+set churn on every turn.
    if (keyBudgets.size >= (MAX_TRACKED_API_KEYS >>> 1)) {
      keyBudgets.delete(keyId);
      keyBudgets.set(keyId, existing);
    }
    return existing;
  }
  if (keyBudgets.size >= MAX_TRACKED_API_KEYS) {
    const oldestKey = keyBudgets.keys().next().value;
    if (oldestKey !== undefined) keyBudgets.delete(oldestKey);
  }
  const fresh: KeyBudgetState = {
    rpmTimestamps: new Float64RingBuffer(EXACT_RPM_RING_THRESHOLD),
    rpmBucketStartMin: minuteBucket,
    rpmBucketCount: 0,
    utcDay,
    dailyCount: 0,
    dailyTokens: 0,
  };
  keyBudgets.set(keyId, fresh);
  return fresh;
}

function pruneRpmTimestamps(state: KeyBudgetState, now: number): void {
  state.rpmTimestamps.pruneLeq(now - ONE_MINUTE_MS);
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
    return { allowed: true };
  }

  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = getOrCreateState(entry.id, utcDay, minuteBucket);

  if (utcDay > state.utcDay) {
    state.utcDay = utcDay;
    state.dailyCount = 0;
    state.dailyTokens = 0;
  }
  if (minuteBucket > state.rpmBucketStartMin) {
    state.rpmBucketStartMin = minuteBucket;
    state.rpmBucketCount = 0;
  }
  if (state.rpmTimestamps.length > 0) {
    pruneRpmTimestamps(state, now);
  }

  if (dailyTokenLimit !== undefined && state.dailyTokens >= dailyTokenLimit) {
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

  if (maxDailyRequests !== undefined) {
    state.dailyCount += 1;
  }
  if (rpmLimit !== undefined) {
    state.rpmBucketCount += 1;
    if (rpmLimit <= EXACT_RPM_RING_THRESHOLD) {
      state.rpmTimestamps.push(now);
    }
  }
  return { allowed: true };
}

/** Records committed request token usage against the key's UTC-day token ledger. */
export function recordApiKeyTokens(keyId: string, tokens: number, now = Date.now()): void {
  if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
  const state = getOrCreateState(keyId, utcDay, minuteBucket);
  if (utcDay < state.utcDay) return;
  if (utcDay > state.utcDay) {
    state.utcDay = utcDay;
    state.dailyCount = 0;
    state.dailyTokens = 0;
  }
  state.dailyTokens += Math.trunc(tokens);
}

export function getApiKeyBudgetSnapshot(keyId: string, now = Date.now()): {
  rpmCurrent: number;
  dailyRequestsUsed: number;
  dailyTokensUsed: number;
} {
  const state = keyBudgets.get(keyId);
  if (!state) return { rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0 };
  const utcDay = Math.floor(now / ONE_DAY_MS);
  const minuteBucket = Math.floor(now / ONE_MINUTE_MS);
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

export function resetApiKeyBudgetsForTests(): void {
  keyBudgets.clear();
}
