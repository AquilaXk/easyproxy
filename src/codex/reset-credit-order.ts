export interface CodexResetCreditLike {
  granted_at: string;
  expires_at: string | null;
}

function parseFiniteTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareRanks(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Whether a Codex reset credit has a valid finite expiry at or before `now`.
 * Null/empty or unparseable expiries return false so safety fences fail closed.
 */
export function isCodexResetCreditExpiredAt(
  credit: Pick<CodexResetCreditLike, "expires_at">,
  now: number,
): boolean {
  if (credit.expires_at === null || credit.expires_at === "") return false;
  const expires = Date.parse(credit.expires_at);
  return Number.isFinite(expires) && expires <= now;
}

/**
 * Sorts Codex reset credits for dashboard display:
 * 1. Primary: oldest `granted_at` first (matches WHAM server consume order),
 *    sorting unparseable `granted_at` values last.
 * 2. Secondary (same `granted_at` or both unparseable): soonest `expires_at` first (FEFO),
 *    sorting `null` or unparseable `expires_at` values last.
 * 3. Tertiary: original upstream order.
 */
export function sortCodexResetCreditsForDisplay<T extends CodexResetCreditLike>(
  credits: readonly T[],
): T[] {
  if (credits.length <= 1) return credits.slice();
  return credits
    .map((credit, index) => ({
      credit,
      index,
      grantedRank: parseFiniteTimestamp(credit.granted_at) ?? Number.POSITIVE_INFINITY,
      expiryRank: parseFiniteTimestamp(credit.expires_at) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) =>
      compareRanks(a.grantedRank, b.grantedRank)
      || compareRanks(a.expiryRank, b.expiryRank)
      || compareRanks(a.index, b.index),
    )
    .map((entry) => entry.credit);
}

/**
 * Filters out already-expired Codex credits at `now` and sorts remaining credits
 * for dashboard display (oldest `granted_at` first, FEFO `expires_at` tie-break).
 */
export function selectActiveCodexResetCreditsForDisplay<T extends CodexResetCreditLike>(
  credits: readonly T[],
  now: number,
): T[] {
  const ranked: Array<{ credit: T; index: number; grantedRank: number; expiryRank: number }> = [];
  for (let index = 0; index < credits.length; index += 1) {
    const credit = credits[index]!;
    if (isCodexResetCreditExpiredAt(credit, now)) continue;
    ranked.push({
      credit,
      index,
      grantedRank: parseFiniteTimestamp(credit.granted_at) ?? Number.POSITIVE_INFINITY,
      expiryRank: parseFiniteTimestamp(credit.expires_at) ?? Number.POSITIVE_INFINITY,
    });
  }
  if (ranked.length <= 1) return ranked.map((entry) => entry.credit);
  ranked.sort((a, b) =>
    compareRanks(a.grantedRank, b.grantedRank)
    || compareRanks(a.expiryRank, b.expiryRank)
    || compareRanks(a.index, b.index),
  );
  return ranked.map((entry) => entry.credit);
}
