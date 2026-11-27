/*
 * Adapted from can1357/oh-my-pi (packages/ai/src/providers/anthropic-slow-mode.ts),
 * licensed under the MIT License.
 */

/** Request header that opts a first-party OAuth request into Anthropic's slow lane. */
export const ANTHROPIC_USAGE_LIMIT_HEADER = "anthropic-usage-limit";
/** {@link ANTHROPIC_USAGE_LIMIT_HEADER} value selecting the slow lane. */
export const ANTHROPIC_SLOW_USAGE_LIMIT = "slow";

/** Server-side experiment arm; only `treatment` accounts are eligible for the slow lane. */
export type AnthropicSlowOffer = "treatment" | "control";

/** `anthropic-ratelimit-unified-slow-status` values; unknown values map to `unrecognized`. */
export type AnthropicSlowStatus =
  | "active"
  | "not_needed"
  | "slot_busy"
  | "weekly_limit"
  | "budget_exhausted"
  | "ineligible"
  | "off"
  | "unrecognized";

/** Slow-lane, grace-allowance, and overage signals carried on an Anthropic response. */
export interface AnthropicSlowModeSignal {
  offer?: AnthropicSlowOffer;
  status?: AnthropicSlowStatus;
  retryAfterMs?: number;
  maxWaitMs?: number;
  budgetUtilization?: number;
  budgetResetAtSec?: number;
  unifiedResetAtSec?: number;
  fiveHourResetAtSec?: number;
  weeklyResetAtSec?: number;
  unifiedLimitClaim: boolean;
  overageInUse: boolean;
  graceUtilization?: { fiveHour: number; sevenDay: number };
  overageAllowed?: boolean;
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
}

const SLOW_HEADER_PREFIX = "anthropic-ratelimit-unified-slow-";
const MAX_SLOW_HEADER_CHARS = 128;

export interface AnthropicHeaderLookup {
  get(name: string): string | null;
}

function readBoundedHeader(headers: AnthropicHeaderLookup | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const raw = headers.get(name);
  if (raw === null || raw.length > MAX_SLOW_HEADER_CHARS) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNonNegative(headers: AnthropicHeaderLookup, name: string): number | undefined {
  const raw = readBoundedHeader(headers, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readUtilization(headers: AnthropicHeaderLookup, name: string): number {
  const value = readNonNegative(headers, name);
  return value === undefined ? 0 : Math.min(1, value);
}

function parseSlowStatus(raw: string | undefined): AnthropicSlowStatus | undefined {
  if (raw === undefined) return undefined;
  switch (raw) {
    case "active":
    case "not_needed":
    case "slot_busy":
    case "weekly_limit":
    case "budget_exhausted":
    case "ineligible":
    case "off":
      return raw;
    default:
      return "unrecognized";
  }
}

/** Normalize inbound `anthropic-usage-limit` header values; only `"slow"` is forwarded. */
export function normalizeInboundAnthropicUsageLimit(value: string | null | undefined): "slow" | undefined {
  if (typeof value !== "string" || value.length > MAX_SLOW_HEADER_CHARS) return undefined;
  return value.trim().toLowerCase() === ANTHROPIC_SLOW_USAGE_LIMIT ? ANTHROPIC_SLOW_USAGE_LIMIT : undefined;
}

/**
 * Parse Anthropic slow-lane, grace-allowance, and overage response headers.
 * Returns `undefined` when no relevant header is present.
 */
export function parseAnthropicSlowModeHeaders(
  headers: AnthropicHeaderLookup | null | undefined,
): AnthropicSlowModeSignal | undefined {
  if (!headers) return undefined;
  const offerRaw = readBoundedHeader(headers, `${SLOW_HEADER_PREFIX}offer`);
  const offer = offerRaw === "treatment" || offerRaw === "control" ? offerRaw : undefined;
  const status = parseSlowStatus(readBoundedHeader(headers, `${SLOW_HEADER_PREFIX}status`));
  const retryAfterSec = readNonNegative(headers, `${SLOW_HEADER_PREFIX}retry-after`);
  const maxWaitSec = readNonNegative(headers, `${SLOW_HEADER_PREFIX}max-wait`);
  const budgetUtilization = readNonNegative(headers, `${SLOW_HEADER_PREFIX}budget-utilization`);
  const budgetResetAtSec = readNonNegative(headers, `${SLOW_HEADER_PREFIX}budget-reset`);
  const unifiedResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-reset");
  const fiveHourResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-5h-reset");
  const weeklyResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-7d-reset");
  const claimHeader = readBoundedHeader(headers, "anthropic-ratelimit-unified-representative-claim");
  const overageStatusRaw = readBoundedHeader(headers, "anthropic-ratelimit-unified-overage-status");
  const overageStatus =
    overageStatusRaw === "allowed" || overageStatusRaw === "allowed_warning" || overageStatusRaw === "rejected"
      ? overageStatusRaw
      : undefined;
  const unifiedLimitClaim = Boolean(claimHeader || overageStatusRaw);
  const overageInUse = readBoundedHeader(headers, "anthropic-ratelimit-unified-overage-in-use") === "true";
  const overageAllowed = overageStatus === "allowed" || overageStatus === "allowed_warning";
  const graceUtilization =
    readBoundedHeader(headers, "anthropic-ratelimit-unified-status") === undefined
      ? undefined
      : {
          fiveHour: readUtilization(headers, "anthropic-ratelimit-unified-grace-5h-utilization"),
          sevenDay: readUtilization(headers, "anthropic-ratelimit-unified-grace-7d-utilization"),
        };

  const hasSlowFacts =
    offer !== undefined ||
    status !== undefined ||
    retryAfterSec !== undefined ||
    maxWaitSec !== undefined ||
    budgetUtilization !== undefined ||
    budgetResetAtSec !== undefined;
  if (
    !hasSlowFacts &&
    graceUtilization === undefined &&
    !unifiedLimitClaim &&
    fiveHourResetAtSec === undefined &&
    unifiedResetAtSec === undefined
  ) {
    return undefined;
  }

  return {
    ...(offer !== undefined ? { offer } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterSec !== undefined ? { retryAfterMs: Math.round(retryAfterSec * 1000) } : {}),
    ...(maxWaitSec !== undefined ? { maxWaitMs: Math.round(maxWaitSec * 1000) } : {}),
    ...(budgetUtilization !== undefined ? { budgetUtilization: Math.min(1, budgetUtilization) } : {}),
    ...(budgetResetAtSec !== undefined ? { budgetResetAtSec } : {}),
    ...(unifiedResetAtSec !== undefined ? { unifiedResetAtSec } : {}),
    ...(fiveHourResetAtSec !== undefined ? { fiveHourResetAtSec } : {}),
    ...(weeklyResetAtSec !== undefined ? { weeklyResetAtSec } : {}),
    unifiedLimitClaim,
    overageInUse,
    ...(overageAllowed ? { overageAllowed } : {}),
    ...(overageStatus !== undefined ? { overageStatus } : {}),
    ...(graceUtilization !== undefined ? { graceUtilization } : {}),
  };
}
