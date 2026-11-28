import type { EpxApiKeyEntry } from "../../types";
import { parseStrictTimestampMs } from "../../lib/strict-timestamp";
import { getApiKeyBudgetHoldSnapshot, getApiKeyBudgetSnapshot } from "../api-key-budget";
import { isApiKeyExpired } from "../auth-cors";

const BUDGET_LIMIT_BOUNDS = {
  rpmLimit: 1_000_000,
  tpmLimit: 1_000_000_000,
  maxDailyRequests: 100_000_000,
  dailyTokenLimit: 10_000_000_000,
} as const;

const MIN_COST_LIMIT_USD = 0.000001;
const MAX_COST_LIMIT_USD = 1_000_000;
const ISO_OFFSET_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type BudgetLimitField = keyof typeof BUDGET_LIMIT_BOUNDS;
const BUDGET_FIELDS: readonly BudgetLimitField[] = ["rpmLimit", "tpmLimit", "maxDailyRequests", "dailyTokenLimit"];

type CostLimitField = "dailyCostLimitUsd" | "maxInFlightCostUsd";
const COST_LIMIT_FIELDS: readonly CostLimitField[] = ["dailyCostLimitUsd", "maxInFlightCostUsd"];

export interface ApiKeyBudgetUsageDto {
  rpmCurrent: number;
  tpmCurrent?: number;
  inFlightCostUsdUsed?: number;
  dailyRequestsUsed: number;
  dailyTokensUsed: number;
  dailyCostUsdUsed: number;
}

export function projectApiKeyBudgetDto(
  entry: Pick<
    EpxApiKeyEntry,
    "id" | "expiresAt" | "rpmLimit" | "tpmLimit" | "maxDailyRequests" | "dailyTokenLimit" | "dailyCostLimitUsd" | "maxInFlightCostUsd"
  >,
  now = Date.now(),
): {
  expiresAt?: string;
  expired?: boolean;
  rpmLimit?: number;
  tpmLimit?: number;
  maxDailyRequests?: number;
  dailyTokenLimit?: number;
  dailyCostLimitUsd?: number;
  maxInFlightCostUsd?: number;
  budgetUsage: ApiKeyBudgetUsageDto;
} {
  const base = getApiKeyBudgetSnapshot(entry.id, now);
  const hold = getApiKeyBudgetHoldSnapshot(entry.id, now);
  const includeTpm = entry.tpmLimit !== undefined || hold.tpmCurrent > 0;
  const includeInFlight = entry.maxInFlightCostUsd !== undefined || hold.inFlightCostUsdUsed > 0;
  const budgetUsage: ApiKeyBudgetUsageDto = {
    ...base,
    ...(includeTpm ? { tpmCurrent: hold.tpmCurrent } : {}),
    ...(includeInFlight ? { inFlightCostUsdUsed: hold.inFlightCostUsdUsed } : {}),
  };
  return {
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt, expired: isApiKeyExpired(entry, now) } : {}),
    ...(entry.rpmLimit !== undefined ? { rpmLimit: entry.rpmLimit } : {}),
    ...(entry.tpmLimit !== undefined ? { tpmLimit: entry.tpmLimit } : {}),
    ...(entry.maxDailyRequests !== undefined ? { maxDailyRequests: entry.maxDailyRequests } : {}),
    ...(entry.dailyTokenLimit !== undefined ? { dailyTokenLimit: entry.dailyTokenLimit } : {}),
    ...(entry.dailyCostLimitUsd !== undefined ? { dailyCostLimitUsd: entry.dailyCostLimitUsd } : {}),
    ...(entry.maxInFlightCostUsd !== undefined ? { maxInFlightCostUsd: entry.maxInFlightCostUsd } : {}),
    budgetUsage,
  };
}

export function applyApiKeyBudgetPatch(
  entry: EpxApiKeyEntry,
  body: Record<string, unknown>,
): { ok: true; touched: boolean } | { ok: false; error: string } {
  let touched = false;
  if (body.expiresAt !== undefined) {
    touched = true;
    const rawExpiry = body.expiresAt;
    if (rawExpiry === null) {
      delete entry.expiresAt;
    } else if (
      typeof rawExpiry !== "string"
      || rawExpiry.trim().length === 0
      || rawExpiry.length > 64
      || !ISO_OFFSET_INSTANT_RE.test(rawExpiry.trim())
      || !Number.isFinite(parseStrictTimestampMs(rawExpiry.trim()))
    ) {
      return { ok: false, error: "expiresAt must be null or an ISO-8601 timestamp with timezone offset" };
    } else {
      entry.expiresAt = rawExpiry.trim();
    }
  }
  for (const field of BUDGET_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    touched = true;
    if (raw === null) {
      delete entry[field];
      continue;
    }
    const max = BUDGET_LIMIT_BOUNDS[field];
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > max) {
      return { ok: false, error: `${field} must be null or an integer between 1 and ${max}` };
    }
    entry[field] = raw;
  }
  for (const costField of COST_LIMIT_FIELDS) {
    const rawCost = body[costField];
    if (rawCost === undefined) continue;
    touched = true;
    if (rawCost === null) {
      delete entry[costField];
    } else if (
      typeof rawCost !== "number"
      || !Number.isFinite(rawCost)
      || rawCost < MIN_COST_LIMIT_USD
      || rawCost > MAX_COST_LIMIT_USD
    ) {
      return { ok: false, error: `${costField} must be null or a finite number between ${MIN_COST_LIMIT_USD} and ${MAX_COST_LIMIT_USD}` };
    } else {
      entry[costField] = rawCost;
    }
  }
  return { ok: true, touched };
}
