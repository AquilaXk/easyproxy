import type { EpxApiKeyEntry } from "../../types";
import { getApiKeyBudgetSnapshot } from "../api-key-budget";

const BUDGET_LIMIT_BOUNDS = {
  rpmLimit: 1_000_000,
  maxDailyRequests: 100_000_000,
  dailyTokenLimit: 10_000_000_000,
} as const;

const MIN_DAILY_COST_LIMIT_USD = 0.000001;
const MAX_DAILY_COST_LIMIT_USD = 1_000_000;

type BudgetLimitField = keyof typeof BUDGET_LIMIT_BOUNDS;
const BUDGET_FIELDS: readonly BudgetLimitField[] = ["rpmLimit", "maxDailyRequests", "dailyTokenLimit"];

export interface ApiKeyBudgetUsageDto {
  rpmCurrent: number;
  dailyRequestsUsed: number;
  dailyTokensUsed: number;
  dailyCostUsdUsed: number;
}

export function projectApiKeyBudgetDto(
  entry: Pick<EpxApiKeyEntry, "id" | "rpmLimit" | "maxDailyRequests" | "dailyTokenLimit" | "dailyCostLimitUsd">,
  now = Date.now(),
): {
  rpmLimit?: number;
  maxDailyRequests?: number;
  dailyTokenLimit?: number;
  dailyCostLimitUsd?: number;
  budgetUsage: ApiKeyBudgetUsageDto;
} {
  return {
    ...(entry.rpmLimit !== undefined ? { rpmLimit: entry.rpmLimit } : {}),
    ...(entry.maxDailyRequests !== undefined ? { maxDailyRequests: entry.maxDailyRequests } : {}),
    ...(entry.dailyTokenLimit !== undefined ? { dailyTokenLimit: entry.dailyTokenLimit } : {}),
    ...(entry.dailyCostLimitUsd !== undefined ? { dailyCostLimitUsd: entry.dailyCostLimitUsd } : {}),
    budgetUsage: getApiKeyBudgetSnapshot(entry.id, now),
  };
}

export function applyApiKeyBudgetPatch(
  entry: EpxApiKeyEntry,
  body: Record<string, unknown>,
): { ok: true; touched: boolean } | { ok: false; error: string } {
  let touched = false;
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
  const rawCost = body.dailyCostLimitUsd;
  if (rawCost !== undefined) {
    touched = true;
    if (rawCost === null) {
      delete entry.dailyCostLimitUsd;
    } else if (
      typeof rawCost !== "number"
      || !Number.isFinite(rawCost)
      || rawCost < MIN_DAILY_COST_LIMIT_USD
      || rawCost > MAX_DAILY_COST_LIMIT_USD
    ) {
      return { ok: false, error: `dailyCostLimitUsd must be null or a finite number between ${MIN_DAILY_COST_LIMIT_USD} and ${MAX_DAILY_COST_LIMIT_USD}` };
    } else {
      entry.dailyCostLimitUsd = rawCost;
    }
  }
  return { ok: true, touched };
}
