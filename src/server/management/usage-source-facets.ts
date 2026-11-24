import { existsSync } from "node:fs";
import { getConfigDir } from "../../config/paths";
import { USAGE_FILTER_INDEX_SCHEMA_VERSION, usageFilterIndexPath } from "../../usage/filter-index";
import { scanUsageLedgerCooperatively } from "../../usage/ledger-scanner";
import { currentUsageLogRevision, usageLogIdentityKey, usageLogRevisionKey } from "../../usage/log";
import { createSourceFacetAccumulator } from "../../usage/source-facets";
import { snapshotConfiguredKeyIds, type UsageSourceFilter } from "../../usage/source-filter";
import { rangeWindow } from "../../usage/summary";
import { querySourceFacetsFromRollup } from "../../usage/summary-rollup";

const MAX_FLIGHTS = 4;
const FACET_CACHE_TTL_MS = 15_000;
const MAX_FACET_CACHE_ENTRIES = 16;
const flights = new Map<string, Promise<SourceFacets>>();
const facetCache = new Map<string, { expiresAt: number; value: SourceFacets }>();

export class SourceFacetsBusyError extends Error {}
type SourceFacets = ReturnType<ReturnType<typeof createSourceFacetAccumulator>["snapshot"]> & {
  sourceFilter: UsageSourceFilter;
  window: { since: number; until: number; timeZone: string };
  usageIncomplete: boolean;
};

export function resetUsageSourceFacetsForTests(): void {
  flights.clear();
  facetCache.clear();
}

/** Single-flight identical requests; never retain arbitrary historical key IDs. */
export async function getUsageSourceFacets(filter: UsageSourceFilter, configuredIds: readonly string[]): Promise<SourceFacets> {
  const ids = snapshotConfiguredKeyIds(configuredIds);
  const captured: UsageSourceFilter = { client: filter.client, device: { ...filter.device } };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const revision = currentUsageLogRevision();
  const key = JSON.stringify([getConfigDir(), captured, ids, timeZone, usageLogIdentityKey(revision), usageLogRevisionKey(revision)]);
  const now = Date.now();
  const cached = facetCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ...cached.value };
  }
  if (cached) facetCache.delete(key);
  const existing = flights.get(key);
  if (existing) return existing;
  if (flights.size >= MAX_FLIGHTS) throw new SourceFacetsBusyError("usage facets busy");
  const flight = (async () => {
    const until = Date.now();
    const since = rangeWindow("30d", until).since!;
    const fromRollup = existsSync(usageFilterIndexPath(getConfigDir()))
      ? await querySourceFacetsFromRollup({
        filter: captured,
        configuredIds: ids,
        since,
        until,
        timeZone,
        expectedSchemaVersion: USAGE_FILTER_INDEX_SCHEMA_VERSION,
      })
      : null;
    let result: SourceFacets;
    if (fromRollup) {
      if (Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) throw new Error("time zone changed");
      result = fromRollup;
    } else {
      const accumulator = createSourceFacetAccumulator(captured, ids, { since, until });
      const scan = await scanUsageLedgerCooperatively({ onEntry: row => accumulator.add(row) });
      if (Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) throw new Error("time zone changed");
      result = {
        ...accumulator.snapshot(),
        sourceFilter: captured,
        window: { since, until, timeZone },
        usageIncomplete: scan.oversizedRows > 0 || scan.invalidRows > 0,
      };
    }
    const settleNow = Date.now();
    for (const [k, entry] of facetCache) {
      if (entry.expiresAt <= settleNow) facetCache.delete(k);
    }
    if (facetCache.size >= MAX_FACET_CACHE_ENTRIES) {
      const oldest = facetCache.keys().next().value;
      if (oldest !== undefined) facetCache.delete(oldest);
    }
    facetCache.set(key, { expiresAt: settleNow + FACET_CACHE_TTL_MS, value: result });
    return result;
  })();
  flights.set(key, flight);
  try { return await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
}
