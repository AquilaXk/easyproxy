import { parseStrictTimestampMs } from "../lib/strict-timestamp";

export interface GrokResetCouponLike {
  tokenId: string;
  validityStart: string;
  validityEnd: string;
}

/**
 * Parses an optional coupon boundary timestamp.
 * Empty strings represent an omitted upstream bound (`null`);
 * non-empty strings that fail strict ISO/HTTP-date parsing return `NaN` so callers fail closed.
 */
function parseOptionalBound(raw: string): number | null {
  if (raw === "") return null;
  return parseStrictTimestampMs(raw);
}

function compareRanks(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function rankForSort(bound: number | null): number {
  return bound === null || Number.isNaN(bound) ? Number.POSITIVE_INFINITY : bound;
}

/**
 * Returns true when a Grok reset coupon is within its active validity window at `now`.
 * Omitted bounds (`""`) are unbounded; malformed non-empty bounds fail closed.
 */
export function isGrokResetCouponActiveAt(
  coupon: Pick<GrokResetCouponLike, "validityStart" | "validityEnd">,
  now: number,
): boolean {
  const start = parseOptionalBound(coupon.validityStart);
  if (Number.isNaN(start)) return false;
  if (start !== null && start > now) return false;
  const end = parseOptionalBound(coupon.validityEnd);
  if (Number.isNaN(end)) return false;
  if (end !== null && end <= now) return false;
  return true;
}

/**
 * Sorts Grok reset coupons in FEFO order (soonest `validityEnd` first), breaking ties
 * by earliest `validityStart` and then upstream index without `NaN` comparator drift.
 */
export function sortGrokResetCouponsFefo<
  T extends Pick<GrokResetCouponLike, "validityStart" | "validityEnd">,
>(coupons: readonly T[]): T[] {
  if (coupons.length <= 1) return coupons.slice();
  return coupons
    .map((coupon, index) => ({
      coupon,
      index,
      endRank: rankForSort(parseOptionalBound(coupon.validityEnd)),
      startRank: rankForSort(parseOptionalBound(coupon.validityStart)),
    }))
    .sort((a, b) =>
      compareRanks(a.endRank, b.endRank)
      || compareRanks(a.startRank, b.startRank)
      || compareRanks(a.index, b.index),
    )
    .map((entry) => entry.coupon);
}

/**
 * Filters to coupons currently active at `now` and sorts them in FEFO order.
 */
export function selectActiveGrokResetCouponsFefo<
  T extends Pick<GrokResetCouponLike, "validityStart" | "validityEnd">,
>(coupons: readonly T[], now: number): T[] {
  const ranked: Array<{ coupon: T; index: number; endRank: number; startRank: number }> = [];
  for (let index = 0; index < coupons.length; index += 1) {
    const coupon = coupons[index]!;
    const start = parseOptionalBound(coupon.validityStart);
    if (Number.isNaN(start)) continue;
    if (start !== null && start > now) continue;
    const end = parseOptionalBound(coupon.validityEnd);
    if (Number.isNaN(end)) continue;
    if (end !== null && end <= now) continue;
    ranked.push({
      coupon,
      index,
      endRank: end === null ? Number.POSITIVE_INFINITY : end,
      startRank: start === null ? Number.POSITIVE_INFINITY : start,
    });
  }
  if (ranked.length <= 1) return ranked.map((entry) => entry.coupon);
  ranked.sort((a, b) =>
    compareRanks(a.endRank, b.endRank)
    || compareRanks(a.startRank, b.startRank)
    || compareRanks(a.index, b.index),
  );
  return ranked.map((entry) => entry.coupon);
}
