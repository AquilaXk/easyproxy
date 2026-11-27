/*
 * Per-instance Anthropic slow-mode / overage / grace eligibility tracker.
 * Wire header parsing adapted from can1357/oh-my-pi (MIT License).
 */
import {
  parseAnthropicSlowModeHeaders,
  type AnthropicHeaderLookup,
  type AnthropicSlowOffer,
  type AnthropicSlowStatus,
} from "../adapters/anthropic/slow-mode";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { RoutingMap, type AccountHealth } from "./anthropic-cooldown-state";

export interface AnthropicAccountSlowState {
  offer?: AnthropicSlowOffer;
  status?: AnthropicSlowStatus;
  blockedUntil?: number;
  slotBusyUntil?: number;
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
  overageInUse?: boolean;
  graceFiveHour?: number;
  graceSevenDay?: number;
  updatedAt: number;
}

const DEFAULT_SLOW_BLOCK_MS = 10 * 60_000;
const DEFAULT_SLOW_SLOT_BUSY_MS = 5_000;
const MAX_SLOW_SLOT_BUSY_MS = 60_000;

function createAnthropicSlowFallbackState() {
  const states = new RoutingMap<string, AnthropicAccountSlowState>();

  function recordSlowHeaders(accountId: string, headers: AnthropicHeaderLookup, now = Date.now()): void {
    const signal = parseAnthropicSlowModeHeaders(headers);
    if (!signal) return;
    const prev = states.get(accountId);
    const next: AnthropicAccountSlowState = {
      ...(prev ?? { updatedAt: now }),
      updatedAt: now,
    };
    if (signal.offer !== undefined) next.offer = signal.offer;
    if (signal.status !== undefined) next.status = signal.status;
    if (signal.overageStatus !== undefined) next.overageStatus = signal.overageStatus;
    if (signal.overageInUse) next.overageInUse = true;
    else if (signal.overageStatus !== undefined) next.overageInUse = false;
    if (signal.graceUtilization !== undefined) {
      next.graceFiveHour = signal.graceUtilization.fiveHour;
      next.graceSevenDay = signal.graceUtilization.sevenDay;
    }

    if (
      signal.offer === "control" ||
      signal.status === "ineligible" ||
      signal.status === "weekly_limit" ||
      signal.status === "budget_exhausted"
    ) {
      const resetSec = signal.status === "weekly_limit"
        ? (signal.weeklyResetAtSec ?? signal.unifiedResetAtSec)
        : (signal.budgetResetAtSec ?? signal.weeklyResetAtSec);
      const resetAt = resetSec !== undefined && resetSec * 1000 > now
        ? resetSec * 1000
        : now + DEFAULT_SLOW_BLOCK_MS;
      next.blockedUntil = Math.max(next.blockedUntil ?? 0, resetAt);
    } else if (signal.status === "active" || signal.status === "not_needed" || signal.offer === "treatment") {
      delete next.blockedUntil;
    }

    if (signal.status === "slot_busy") {
      const waitMs = Math.min(
        MAX_SLOW_SLOT_BUSY_MS,
        Math.max(500, signal.retryAfterMs ?? DEFAULT_SLOW_SLOT_BUSY_MS),
      );
      next.slotBusyUntil = Math.max(next.slotBusyUntil ?? 0, now + waitMs);
    } else if (signal.status === "active" || signal.status === "not_needed") {
      delete next.slotBusyUntil;
    }

    states.set(accountId, next);
  }

  function isSlowEligible(accountId: string, now = Date.now()): boolean {
    const state = states.get(accountId);
    if (!state) return true;
    if (state.offer === "control") return false;
    if (state.blockedUntil !== undefined && state.blockedUntil > now) return false;
    if (state.slotBusyUntil !== undefined && state.slotBusyUntil > now) return false;
    return true;
  }

  function getSlowOffer(accountId: string): AnthropicSlowOffer | undefined {
    return states.get(accountId)?.offer;
  }

  function getSlowSnapshot(accountId: string): AnthropicAccountSlowState | undefined {
    return states.get(accountId);
  }

  function clearAccount(accountId: string): void {
    states.delete(accountId);
  }

  function clearAll(): void {
    states.clear();
  }

  return Object.freeze({
    recordSlowHeaders,
    isSlowEligible,
    getSlowOffer,
    getSlowSnapshot,
    clearAccount,
    clearAll,
  });
}

const instances = new Map<AnthropicInstanceId, ReturnType<typeof createAnthropicSlowFallbackState>>();

export function anthropicSlowFallbackFor(instance: AnthropicInstanceId) {
  let state = instances.get(instance);
  if (!state) {
    state = createAnthropicSlowFallbackState();
    instances.set(instance, state);
  }
  return state;
}

export function recordAnthropicSlowSignalForInstance(
  instance: AnthropicInstanceId,
  accountId: string,
  headers: AnthropicHeaderLookup,
  now = Date.now(),
): void {
  if (!accountId) return;
  anthropicSlowFallbackFor(instance).recordSlowHeaders(accountId, headers, now);
}

export function clearAllAnthropicSlowFallbackState(): void {
  for (const state of instances.values()) state.clearAll();
}

/**
 * True when an active cooldown hold represents ONLY a 5-hour quota exhaustion
 * (never an account refusal, weekly 7d rejection, or undated refusal).
 */
export function isFiveHourOnlyQuotaHold(entry: AccountHealth | undefined, now: number): boolean {
  if (!entry || entry.cooldownUntil <= now) return false;
  if (entry.refusalStatus !== 429) return false;
  if (entry.refusedQuotaWindows.includes("weekly")) return false;
  return entry.refusedQuotaWindows.includes("five-hour");
}
