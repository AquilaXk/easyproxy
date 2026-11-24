/**
 * Hourly usage rollups and precomputed preset snapshots backed by `usage-filter-index.sqlite` v6.
 *
 * `usage.jsonl` remains the source of truth. Every fast-path reader validates generation identity,
 * byte offset, digest, parity flags, and snapshot bounds before skipping a ledger scan, failing
 * closed to the streaming reader on any mismatch, corruption, or unsupported query shape.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { getConfigDir } from "../config/paths";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { baseProviderLabel } from "../providers/label";
import { cacheObservationFromUsage, type CacheTelemetryProvenance } from "./cache-provenance";
import { readUsageLedgerRowsAtOffsets } from "./ledger-scanner";
import {
  currentUsageLogRevision,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "./log";
import { createSourceFacetAccumulator } from "./source-facets";
import {
  isLegacyCodexUsage,
  matchesUsageSource,
  snapshotConfiguredKeyIds,
  USAGE_SOURCE_CLIENTS,
  type UsageSourceClient,
  type UsageSourceFilter,
} from "./source-filter";
import {
  USAGE_RANGES,
  USAGE_SURFACES,
  usageAttributions,
  type UsageSummary,
} from "./summary";
import { normalizeTimelineModelId, type TimelineQuery, type TimelineSeries, type UsageTimeline } from "./timeline";
import { usageDisplayTotalTokens } from "./totals";
import {
  activeAccountPricingProviders,
  activeConfiguredProviders,
  activeCreditPrices,
  activeUserCostOverlays,
} from "./user-cost-overlays";

export const HOUR_MS = 3_600_000;
/** Sentinel hour bucket stored for entries whose timestamp is missing or unrepresentable in Date. */
export const UNUSABLE_HOUR_BUCKET_MS = -9_007_199_254_740_991;
export const MAX_SUMMARY_SNAPSHOTS_PER_GENERATION = 64;
/** Fail-closed ceiling on a cached preset snapshot payload read from SQLite. */
export const MAX_SUMMARY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const INDEX_DB_FILENAME = "usage-filter-index.sqlite";

export const ROLLUP_PARITY_TOTAL_MISMATCH = 1 << 0;
export const ROLLUP_PARITY_USAGE_MISMATCH = 1 << 1;
export const ROLLUP_PARITY_CACHED_MISMATCH = 1 << 2;
export const ROLLUP_PARITY_NON_CONFIGURED_API_KEY = 1 << 3;
export const ROLLUP_PARITY_UNUSABLE_ATTRIBUTION = 1 << 4;

export const ROLLUP_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS usage_hourly_rollups (
  generation                  TEXT NOT NULL,
  hour_bucket_ms              INTEGER NOT NULL,
  surface                     TEXT NOT NULL,
  client                      TEXT NOT NULL,
  api_key_id                  TEXT NOT NULL,
  provider                    TEXT NOT NULL,
  model                       TEXT NOT NULL,
  usage_status                TEXT NOT NULL,
  cache_provenance            TEXT NOT NULL,
  combo_flag                  INTEGER NOT NULL,
  requests                    INTEGER NOT NULL,
  measured_requests           INTEGER NOT NULL,
  input_tokens                INTEGER NOT NULL,
  output_tokens               INTEGER NOT NULL,
  total_tokens                INTEGER NOT NULL,
  cached_input_tokens         INTEGER NOT NULL,
  cache_write_tokens          INTEGER NOT NULL,
  reasoning_tokens            INTEGER NOT NULL,
  cache_observed_input_tokens INTEGER NOT NULL,
  max_timestamp               INTEGER,
  PRIMARY KEY (
    generation,
    hour_bucket_ms,
    surface,
    client,
    api_key_id,
    provider,
    model,
    usage_status,
    cache_provenance,
    combo_flag
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_hourly_hour
  ON usage_hourly_rollups(generation, hour_bucket_ms);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_key
  ON usage_hourly_rollups(generation, api_key_id, hour_bucket_ms);

CREATE TABLE IF NOT EXISTS usage_summary_snapshots (
  generation        TEXT NOT NULL,
  snapshot_key      TEXT NOT NULL,
  indexed_offset    INTEGER NOT NULL,
  boundary_digest   TEXT NOT NULL,
  overlay_signature TEXT NOT NULL,
  time_zone         TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (generation, snapshot_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_summary_snapshots_updated
  ON usage_summary_snapshots(generation, updated_at);
`;

const UPSERT_HOURLY_ROLLUP_SQL = `
INSERT INTO usage_hourly_rollups (
  generation, hour_bucket_ms, surface, client, api_key_id, provider, model,
  usage_status, cache_provenance, combo_flag,
  requests, measured_requests, input_tokens, output_tokens, total_tokens,
  cached_input_tokens, cache_write_tokens, reasoning_tokens, cache_observed_input_tokens,
  max_timestamp
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (
  generation, hour_bucket_ms, surface, client, api_key_id, provider, model,
  usage_status, cache_provenance, combo_flag
) DO UPDATE SET
  requests = requests + excluded.requests,
  measured_requests = measured_requests + excluded.measured_requests,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  total_tokens = total_tokens + excluded.total_tokens,
  cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
  cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
  reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
  cache_observed_input_tokens = cache_observed_input_tokens + excluded.cache_observed_input_tokens,
  max_timestamp = CASE
    WHEN max_timestamp IS NULL THEN excluded.max_timestamp
    WHEN excluded.max_timestamp IS NULL THEN max_timestamp
    ELSE MAX(max_timestamp, excluded.max_timestamp)
  END
`;

/** Starts with NUL so temporary append-delta keys sort strictly before any base64url generation (`>= '-'`). */
export function appendStagingRollupGeneration(generation: string, appendId: string): string {
  return `\u0000${generation}\u0000${process.pid}\u0000${appendId}`;
}

export function dropRollupTables(db: Database): void {
  db.exec("DROP TABLE IF EXISTS usage_hourly_rollups");
  db.exec("DROP TABLE IF EXISTS usage_summary_snapshots");
}

export function deleteRollupsForGeneration(db: Database, generation: string): void {
  db.query("DELETE FROM usage_hourly_rollups WHERE generation = ?").run(generation);
  db.query("DELETE FROM usage_summary_snapshots WHERE generation = ?").run(generation);
}

/** Reclaim dead-PID or retired append-staging rollup buckets left by crashed processes. */
export function reclaimAbandonedAppendRollups(
  db: Database,
  publishedGeneration: string,
  processAlive: (pid: number) => boolean,
): void {
  const rows = db.query(
    "SELECT DISTINCT generation FROM usage_hourly_rollups WHERE generation < '-'",
  ).all() as Array<{ generation: string }>;
  if (rows.length === 0) return;
  const stale: string[] = [];
  for (const { generation } of rows) {
    const parts = generation.split("\u0000");
    // Format: \0<ownerGeneration>\0<pid>\0<appendId>
    const ownerGen = parts[1] ?? "";
    const pid = Number(parts[2]);
    if (!ownerGen || ownerGen !== publishedGeneration || !Number.isInteger(pid) || !processAlive(pid)) {
      stale.push(generation);
    }
  }
  if (stale.length === 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const del = db.prepare("DELETE FROM usage_hourly_rollups WHERE generation = ?");
    try {
      for (const generation of stale) del.run(generation);
    } finally {
      del.finalize();
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* lock released on close */ }
    throw error;
  }
}

export function commitPublishRollups(
  db: Database,
  publishedGeneration: string,
  indexedOffset: number,
  appendRollupGeneration?: string,
): void {
  if (appendRollupGeneration) {
    db.query(`
      INSERT INTO usage_hourly_rollups (
        generation, hour_bucket_ms, surface, client, api_key_id, provider, model,
        usage_status, cache_provenance, combo_flag,
        requests, measured_requests, input_tokens, output_tokens, total_tokens,
        cached_input_tokens, cache_write_tokens, reasoning_tokens, cache_observed_input_tokens,
        max_timestamp
      )
      SELECT ?, hour_bucket_ms, surface, client, api_key_id, provider, model,
             usage_status, cache_provenance, combo_flag,
             requests, measured_requests, input_tokens, output_tokens, total_tokens,
             cached_input_tokens, cache_write_tokens, reasoning_tokens, cache_observed_input_tokens,
             max_timestamp
      FROM usage_hourly_rollups
      WHERE generation = ?
      ON CONFLICT (
        generation, hour_bucket_ms, surface, client, api_key_id, provider, model,
        usage_status, cache_provenance, combo_flag
      ) DO UPDATE SET
        requests = requests + excluded.requests,
        measured_requests = measured_requests + excluded.measured_requests,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        cache_observed_input_tokens = cache_observed_input_tokens + excluded.cache_observed_input_tokens,
        max_timestamp = CASE
          WHEN max_timestamp IS NULL THEN excluded.max_timestamp
          WHEN excluded.max_timestamp IS NULL THEN max_timestamp
          ELSE MAX(max_timestamp, excluded.max_timestamp)
        END
    `).run(publishedGeneration, appendRollupGeneration);
    db.query("DELETE FROM usage_hourly_rollups WHERE generation = ?").run(appendRollupGeneration);
  }
  db.query("DELETE FROM usage_summary_snapshots WHERE generation = ? AND indexed_offset <> ?")
    .run(publishedGeneration, indexedOffset);
}

function usableTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

interface RollupDelta {
  hourBucketMs: number;
  surface: string;
  client: string;
  apiKeyId: string;
  provider: string;
  model: string;
  usageStatus: string;
  cacheProvenance: CacheTelemetryProvenance;
  comboFlag: 0 | 1;
  requests: number;
  measuredRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cacheObservedInputTokens: number;
  maxTimestamp: number | null;
}

export interface HourlyRollupAccumulator {
  addEntry(entry: PersistedUsageEntry): { parityFlags: number; admissionTimestamp: number | null };
  flush(db: Database, targetGeneration: string): void;
  clear(): void;
}

export function createHourlyRollupBatchAccumulator(): HourlyRollupAccumulator {
  const deltas = new Map<string, RollupDelta>();

  function mergeDelta(
    deltaKey: string,
    base: Omit<RollupDelta, "requests" | "measuredRequests" | "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens" | "cacheObservedInputTokens" | "maxTimestamp">,
    add: {
      measured: boolean;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      cacheObservedInputTokens: number;
      timestamp: number | null;
    },
  ): void {
    let row = deltas.get(deltaKey);
    if (!row) {
      row = {
        ...base,
        requests: 0,
        measuredRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cacheObservedInputTokens: 0,
        maxTimestamp: add.timestamp,
      };
      deltas.set(deltaKey, row);
    } else if (add.timestamp !== null && (row.maxTimestamp === null || add.timestamp > row.maxTimestamp)) {
      row.maxTimestamp = add.timestamp;
    }
    row.requests += 1;
    if (add.measured) row.measuredRequests += 1;
    row.inputTokens += add.inputTokens;
    row.outputTokens += add.outputTokens;
    row.totalTokens += add.totalTokens;
    row.cachedInputTokens += add.cachedInputTokens;
    row.cacheWriteTokens += add.cacheWriteTokens;
    row.reasoningTokens += add.reasoningTokens;
    row.cacheObservedInputTokens += add.cacheObservedInputTokens;
  }

  return {
    addEntry(entry: PersistedUsageEntry) {
      const ts = usableTimestamp(entry.timestamp);
      const hourBucketMs = ts !== null ? Math.floor(ts / HOUR_MS) * HOUR_MS : UNUSABLE_HOUR_BUCKET_MS;
      const surface = entry.surface ?? "";
      const client = entry.client ?? "";
      const apiKeyId = entry.apiKeyId ?? "";
      const comboFlag: 0 | 1 = entry.attempts?.length ? 1 : 0;
      const admissionTimestamp = entry.admissionKind ? ts : null;

      let parityFlags = 0;
      if (apiKeyId !== "" && entry.admissionKind !== "configured") {
        parityFlags |= ROLLUP_PARITY_NON_CONFIGURED_API_KEY;
      }

      let attributions: ReturnType<typeof usageAttributions> = [];
      let attrBroken = false;
      try {
        attributions = usageAttributions(entry);
      } catch {
        attrBroken = true;
      }
      if (
        attrBroken
        || attributions.length === 0
        || attributions.some(a => typeof a.provider !== "string" || typeof a.model !== "string")
      ) {
        parityFlags |= ROLLUP_PARITY_UNUSABLE_ATTRIBUTION;
        const status = entry.usageStatus ?? "";
        const isMeasured = status === "reported" || status === "estimated";
        const deltaKey = `${hourBucketMs}\0${surface}\0${client}\0${apiKeyId}\0\0\0${status}\0unknown\0${comboFlag}`;
        mergeDelta(
          deltaKey,
          {
            hourBucketMs,
            surface,
            client,
            apiKeyId,
            provider: "",
            model: "",
            usageStatus: status,
            cacheProvenance: "unknown",
            comboFlag,
          },
          {
            measured: isMeasured,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens) ? entry.totalTokens : 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            cacheObservedInputTokens: 0,
            timestamp: ts,
          },
        );
        return { parityFlags, admissionTimestamp };
      }

      for (const att of attributions) {
        const provider = baseProviderLabel(att.provider);
        const model = att.model;
        const usageStatus = att.usageStatus;
        const isMeasured = usageStatus === "reported" || usageStatus === "estimated";
        const { read, creation, provenance } = cacheObservationFromUsage(att.usage, att.cacheProvenance);
        const displayTotal = usageDisplayTotalTokens(att.usage, att.totalTokens);

        if (isMeasured !== (displayTotal !== undefined)) parityFlags |= ROLLUP_PARITY_TOTAL_MISMATCH;
        const hasIoTokens = typeof att.usage?.inputTokens === "number"
          && Number.isFinite(att.usage.inputTokens)
          && typeof att.usage?.outputTokens === "number"
          && Number.isFinite(att.usage.outputTokens);
        if (isMeasured !== hasIoTokens) parityFlags |= ROLLUP_PARITY_USAGE_MISMATCH;
        if ((provenance !== "unknown") !== (read !== undefined)) parityFlags |= ROLLUP_PARITY_CACHED_MISMATCH;

        const inputTokens = att.usage?.inputTokens ?? 0;
        const outputTokens = att.usage?.outputTokens ?? 0;
        const totalTokens = displayTotal ?? 0;
        const cachedInputTokens = read ?? 0;
        const cacheWriteTokens = creation ?? 0;
        const reasoningTokens = att.usage?.reasoningOutputTokens ?? 0;
        const cacheObservedInputTokens = provenance === "observed" && att.usage ? inputTokens : 0;

        const deltaKey = `${hourBucketMs}\0${surface}\0${client}\0${apiKeyId}\0${provider}\0${model}\0${usageStatus}\0${provenance}\0${comboFlag}`;
        mergeDelta(
          deltaKey,
          {
            hourBucketMs,
            surface,
            client,
            apiKeyId,
            provider,
            model,
            usageStatus,
            cacheProvenance: provenance,
            comboFlag,
          },
          {
            measured: isMeasured,
            inputTokens,
            outputTokens,
            totalTokens,
            cachedInputTokens,
            cacheWriteTokens,
            reasoningTokens,
            cacheObservedInputTokens,
            timestamp: ts,
          },
        );
      }

      return { parityFlags, admissionTimestamp };
    },

    flush(db: Database, targetGeneration: string) {
      if (deltas.size === 0) return;
      const stmt = db.prepare(UPSERT_HOURLY_ROLLUP_SQL);
      try {
        for (const row of deltas.values()) {
          stmt.run(
            targetGeneration,
            row.hourBucketMs,
            row.surface,
            row.client,
            row.apiKeyId,
            row.provider,
            row.model,
            row.usageStatus,
            row.cacheProvenance,
            row.comboFlag,
            row.requests,
            row.measuredRequests,
            row.inputTokens,
            row.outputTokens,
            row.totalTokens,
            row.cachedInputTokens,
            row.cacheWriteTokens,
            row.reasoningTokens,
            row.cacheObservedInputTokens,
            row.maxTimestamp,
          );
        }
      } finally {
        stmt.finalize();
      }
      deltas.clear();
    },

    clear() {
      deltas.clear();
    },
  };
}

/** Deterministic cross-process pricing signature hashed from all active pricing inputs. */
export function computeUsageOverlaySignature(): string {
  const configured = [...activeConfiguredProviders()].sort();
  const overlays = [...activeUserCostOverlays()]
    .map(row => ({
      provider: row.provider,
      modelId: row.modelId,
      cost4: row.cost4,
      ...(row.promptLengthPricing ? { promptLengthPricing: row.promptLengthPricing } : {}),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  const accountEntries = [...activeAccountPricingProviders()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const creditEntries = [...activeCreditPrices()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([configured, overlays, accountEntries, creditEntries]))
    .digest("hex");
}

export function buildSummarySnapshotKey(params: {
  maxReadBytes: number;
  overlaySignature: string;
  timeZone: string;
  localDate: string;
}): string {
  return `${params.localDate}|${params.maxReadBytes}|${params.overlaySignature}|${params.timeZone}`;
}

export type CachedPresetSummary = UsageSummary & {
  usageIncomplete?: true;
  usageIncompleteReason?: "oversized_rows";
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  snapshotWindowStart: number | null;
  snapshotWindowEnd: number | null;
};

export type PersistedApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

export interface PersistedApiKeyUsageSnapshot {
  configuredIds: string[];
  snapshotAt: number;
  attributionSince?: string;
  entries: Array<[string, PersistedApiKeyUsage]>;
  usageIncomplete?: true;
  usageIncompleteReason?: "oversized_rows";
}

export interface UsagePresetSnapshotPayload {
  localDate: string;
  maxReadBytes: number;
  usageIncomplete: boolean;
  snapshotWindowStart: number | null;
  snapshotWindowEnd: number | null;
  presets: Record<string, CachedPresetSummary>;
  apiKeySnapshot?: PersistedApiKeyUsageSnapshot;
}

interface PublishedMetaView {
  schemaVersion: number;
  generation: string;
  revision: UsageLogRevision | null;
  indexedOffset: number;
  digest: string;
  indexedRows: number;
  invalidRows: number;
  oversizedRows: number;
  minTimestamp: number | null;
  minAdmissionTimestamp: number | null;
  rollupParityFlags: number;
}

function readPublishedMetaView(db: Database): PublishedMetaView | null {
  let rows: Array<{ key: string; value: string }>;
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(row => row.name),
    );
    if (
      !tables.has("usage_filter_index_meta")
      || !tables.has("usage_rows")
      || !tables.has("usage_hourly_rollups")
      || !tables.has("usage_summary_snapshots")
    ) {
      return null;
    }
    rows = db.query("SELECT key, value FROM usage_filter_index_meta").all() as Array<{ key: string; value: string }>;
  } catch {
    return null;
  }
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.key, row.value);
  const text = (key: string) => map.get(key) ?? "";
  const num = (key: string) => {
    const raw = map.get(key);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const optNum = (key: string): number | null => {
    const raw = map.get(key);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const sourcePath = text("source_path");
  const revision: UsageLogRevision | null = sourcePath
    ? {
      path: sourcePath,
      dev: text("source_dev"),
      ino: text("source_ino"),
      birthtimeMs: num("source_birthtime_ms"),
      size: num("source_size"),
      mtimeMs: num("source_mtime_ms"),
      ctimeMs: num("source_ctime_ms"),
    }
    : null;
  return {
    schemaVersion: num("schema_version"),
    generation: text("generation"),
    revision,
    indexedOffset: num("indexed_offset"),
    digest: text("boundary_digest"),
    indexedRows: num("indexed_rows"),
    invalidRows: num("invalid_rows"),
    oversizedRows: num("oversized_rows"),
    minTimestamp: optNum("min_timestamp"),
    minAdmissionTimestamp: optNum("min_admission_timestamp"),
    rollupParityFlags: num("rollup_parity_flags"),
  };
}

function dbHasPublishedRows(db: Database, generation: string): boolean {
  return db.query("SELECT 1 AS present FROM usage_rows WHERE generation = ? LIMIT 1").get(generation) !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidPresetSummary(value: unknown, expectedRange: string, expectedSurface: string): value is CachedPresetSummary {
  if (!isPlainRecord(value)) return false;
  if (value.range !== expectedRange || value.surface !== expectedSurface) return false;
  if (typeof value.generatedAt !== "number" || !Number.isFinite(value.generatedAt)) return false;
  if (value.since !== null && (typeof value.since !== "number" || !Number.isFinite(value.since))) return false;
  if (typeof value.historyTruncated !== "boolean") return false;
  if (!Array.isArray(value.days) || !Array.isArray(value.models) || !Array.isArray(value.providers) || !Array.isArray(value.accounts)) {
    return false;
  }
  const summary = value.summary;
  if (!isPlainRecord(summary)) return false;
  if (!isFiniteNonNegInt(summary.requests) || !isFiniteNonNegInt(summary.measuredRequests)) return false;
  if (typeof summary.totalTokens !== "number" || !Number.isFinite(summary.totalTokens)) return false;
  if (typeof summary.estimatedCostUsd !== "number" || !Number.isFinite(summary.estimatedCostUsd)) return false;
  return true;
}

function isValidApiKeySnapshot(value: unknown): value is PersistedApiKeyUsageSnapshot {
  if (!isPlainRecord(value)) return false;
  if (!Array.isArray(value.configuredIds) || !value.configuredIds.every(id => typeof id === "string")) return false;
  if (typeof value.snapshotAt !== "number" || !Number.isFinite(value.snapshotAt)) return false;
  if (value.attributionSince !== undefined && typeof value.attributionSince !== "string") return false;
  if (!Array.isArray(value.entries)) return false;
  for (const pair of value.entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !isPlainRecord(pair[1])) return false;
    const item = pair[1];
    if (item.ambiguous === true) continue;
    if (!isFiniteNonNegInt(item.requests7d) || !isFiniteNonNegInt(item.totalRequests)) return false;
    if (item.lastUsedAt !== undefined && typeof item.lastUsedAt !== "string") return false;
  }
  return true;
}

function validateSnapshotPayload(
  rawJson: string,
  expectedLocalDate: string,
  expectedMaxReadBytes: number,
): UsagePresetSnapshotPayload | null {
  if (typeof rawJson !== "string" || Buffer.byteLength(rawJson, "utf8") > MAX_SUMMARY_SNAPSHOT_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (parsed.localDate !== expectedLocalDate || parsed.maxReadBytes !== expectedMaxReadBytes) return null;
  if (typeof parsed.usageIncomplete !== "boolean") return null;
  if (parsed.snapshotWindowStart !== null && (typeof parsed.snapshotWindowStart !== "number" || !Number.isFinite(parsed.snapshotWindowStart))) return null;
  if (parsed.snapshotWindowEnd !== null && (typeof parsed.snapshotWindowEnd !== "number" || !Number.isFinite(parsed.snapshotWindowEnd))) return null;
  if (!isPlainRecord(parsed.presets)) return null;

  const expectedKeys = USAGE_RANGES.flatMap(range => USAGE_SURFACES.map(surface => `${range}:${surface}`));
  if (Object.keys(parsed.presets).length !== expectedKeys.length) return null;
  for (const range of USAGE_RANGES) {
    for (const surface of USAGE_SURFACES) {
      if (!isValidPresetSummary(parsed.presets[`${range}:${surface}`], range, surface)) return null;
    }
  }
  if (parsed.apiKeySnapshot !== undefined && !isValidApiKeySnapshot(parsed.apiKeySnapshot)) {
    return null;
  }
  return parsed as unknown as UsagePresetSnapshotPayload;
}

/**
 * Persist precomputed preset summaries into `usage_summary_snapshots` ONLY when the existing
 * SQLite projection matches the computed aggregate's generation, byte offset, and digest.
 * Caps each generation at 64 snapshots by pruning oldest `updated_at` rows.
 */
export function persistUsageSummarySnapshot(options: {
  dbPath: string;
  identityKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
  overlaySignature: string;
  timeZone: string;
  localDate: string;
  maxReadBytes: number;
  payload: UsagePresetSnapshotPayload;
  updatedAt?: number;
  onlyIfAbsent?: boolean;
}): boolean {
  if (!existsSync(options.dbPath)) return false;
  const serialized = JSON.stringify(options.payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SUMMARY_SNAPSHOT_BYTES) return false;
  const snapshotKey = buildSummarySnapshotKey(options);
  const updatedAt = options.updatedAt ?? Date.now();
  let db: Database;
  try {
    db = new Database(options.dbPath, { create: false });
  } catch {
    return false;
  }
  try {
    db.exec("PRAGMA busy_timeout = 250");
    db.exec("BEGIN IMMEDIATE");
    try {
      const meta = readPublishedMetaView(db);
      if (
        !meta
        || meta.schemaVersion !== 6
        || !meta.generation
        || usageLogIdentityKey(meta.revision) !== options.identityKey
        || meta.indexedOffset !== options.processedThroughBytes
        || meta.digest !== options.processedThroughDigest
      ) {
        db.exec("ROLLBACK");
        return false;
      }
      if (options.onlyIfAbsent) {
        const existing = db.query(
          "SELECT 1 AS present FROM usage_summary_snapshots WHERE generation = ? AND snapshot_key = ? AND indexed_offset = ? AND boundary_digest = ? AND overlay_signature = ? AND time_zone = ?",
        ).get(
          meta.generation,
          snapshotKey,
          meta.indexedOffset,
          meta.digest,
          options.overlaySignature,
          options.timeZone,
        );
        if (existing !== null) {
          db.exec("ROLLBACK");
          return true;
        }
      }
      db.query(`
        INSERT OR REPLACE INTO usage_summary_snapshots (
          generation, snapshot_key, indexed_offset, boundary_digest, overlay_signature, time_zone, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        meta.generation,
        snapshotKey,
        meta.indexedOffset,
        meta.digest,
        options.overlaySignature,
        options.timeZone,
        serialized,
        updatedAt,
      );
      const countRow = db.query(
        "SELECT COUNT(*) AS count FROM usage_summary_snapshots WHERE generation = ?",
      ).get(meta.generation) as { count: number };
      if (countRow.count > MAX_SUMMARY_SNAPSHOTS_PER_GENERATION) {
        const excess = countRow.count - MAX_SUMMARY_SNAPSHOTS_PER_GENERATION;
        db.query(`
          DELETE FROM usage_summary_snapshots
          WHERE generation = ? AND snapshot_key IN (
            SELECT snapshot_key FROM usage_summary_snapshots
            WHERE generation = ?
            ORDER BY updated_at ASC, snapshot_key ASC
            LIMIT ?
          )
        `).run(meta.generation, meta.generation, excess);
      }
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* released on close */ }
      return false;
    }
    if (process.platform !== "win32") {
      hardenSecretPath(options.dbPath, { required: false });
    }
    return true;
  } finally {
    db.close();
  }
}

async function openVerifiedReadonlyIndex(expectedSchemaVersion: number): Promise<{
  db: Database;
  meta: PublishedMetaView;
  revision: UsageLogRevision;
} | null> {
  const dbPath = `${getConfigDir().replace(/[\\/]+$/, "")}/${INDEX_DB_FILENAME}`;
  if (!existsSync(dbPath)) return null;
  const revision = currentUsageLogRevision();
  if (!revision) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const meta = readPublishedMetaView(db);
    if (
      !meta
      || meta.schemaVersion !== expectedSchemaVersion
      || !meta.generation
      || usageLogIdentityKey(meta.revision) !== usageLogIdentityKey(revision)
      || meta.indexedOffset !== revision.size
      || usageLogRevisionKey(meta.revision) !== usageLogRevisionKey(revision)
    ) {
      db.close();
      return null;
    }
    await readUsageLedgerRowsAtOffsets({
      offsets: [],
      expectedIdentityKey: usageLogIdentityKey(revision),
      expectedRevisionKey: usageLogRevisionKey(revision),
      expectedProcessedThroughBytes: meta.indexedOffset,
      expectedProcessedThroughDigest: meta.digest,
      expectedFileSize: revision.size,
    });
    if (meta.indexedRows > 0 && !dbHasPublishedRows(db, meta.generation)) {
      db.close();
      return null;
    }
    return { db, meta, revision };
  } catch {
    db.close();
    return null;
  }
}

export async function readUsageSummarySnapshotPassive(options: {
  expectedSchemaVersion: number;
  overlaySignature: string;
  timeZone: string;
  localDate: string;
  maxReadBytes: number;
}): Promise<{
  revision: UsageLogRevision;
  generation: string;
  indexedRows: number;
  invalidRows: number;
  oversizedRows: number;
  payload: UsagePresetSnapshotPayload;
} | null> {
  const verified = await openVerifiedReadonlyIndex(options.expectedSchemaVersion);
  if (!verified) return null;
  const { db, meta, revision } = verified;
  try {
    const snapshotKey = buildSummarySnapshotKey(options);
    const row = db.query(`
      SELECT payload_json FROM usage_summary_snapshots
      WHERE generation = ? AND snapshot_key = ? AND indexed_offset = ? AND boundary_digest = ? AND overlay_signature = ? AND time_zone = ?
    `).get(
      meta.generation,
      snapshotKey,
      meta.indexedOffset,
      meta.digest,
      options.overlaySignature,
      options.timeZone,
    ) as { payload_json: string } | undefined;
    if (!row) return null;
    const payload = validateSnapshotPayload(row.payload_json, options.localDate, options.maxReadBytes);
    if (!payload) return null;
    return {
      revision,
      generation: meta.generation,
      indexedRows: meta.indexedRows,
      invalidRows: meta.invalidRows,
      oversizedRows: meta.oversizedRows,
      payload,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function readRowsInRangeFromOffsets(
  db: Database,
  generation: string,
  indexedOffset: number,
  sinceMs: number,
  beforeMs: number,
): number[] {
  const rows = db.query(`
    SELECT byte_offset FROM usage_rows
    WHERE generation = ? AND byte_offset < ? AND timestamp IS NOT NULL AND timestamp >= ? AND timestamp < ?
    ORDER BY byte_offset ASC
  `).all(generation, indexedOffset, sinceMs, beforeMs) as Array<{ byte_offset: number }>;
  return rows.map(row => row.byte_offset);
}

/**
 * Compute `getUsageSourceFacets` from `usage_hourly_rollups`, resolving split boundary hours via
 * `usage_rows` offsets and returning `null` cleanly whenever combo rows or parity mismatches require full scan.
 */
export async function querySourceFacetsFromRollup(options: {
  filter: UsageSourceFilter;
  configuredIds: readonly string[];
  since: number;
  until: number;
  timeZone: string;
  expectedSchemaVersion: number;
}): Promise<(ReturnType<ReturnType<typeof createSourceFacetAccumulator>["snapshot"]> & {
  sourceFilter: UsageSourceFilter;
  window: { since: number; until: number; timeZone: string };
  usageIncomplete: boolean;
}) | null> {
  if (options.until < options.since) return null;
  const verified = await openVerifiedReadonlyIndex(options.expectedSchemaVersion);
  if (!verified) return null;
  const { db, meta, revision } = verified;
  try {
    if ((meta.rollupParityFlags & ROLLUP_PARITY_NON_CONFIGURED_API_KEY) !== 0) return null;

    const startHour = Math.floor(options.since / HOUR_MS) * HOUR_MS;
    const endHour = Math.floor(options.until / HOUR_MS) * HOUR_MS;
    const hasStartSplit = options.since > startHour
      && db.query("SELECT 1 FROM usage_hourly_rollups WHERE generation = ? AND hour_bucket_ms = ? LIMIT 1")
        .get(meta.generation, startHour) !== null;
    const endMaxRow = db.query(
      "SELECT MAX(max_timestamp) AS max_ts FROM usage_hourly_rollups WHERE generation = ? AND hour_bucket_ms = ?",
    ).get(meta.generation, endHour) as { max_ts: number | null } | undefined;
    const hasEndSplit = endMaxRow?.max_ts !== null && endMaxRow?.max_ts !== undefined && endMaxRow.max_ts > options.until;

    const fullStartHour = hasStartSplit ? startHour + HOUR_MS : startHour;
    const fullEndHour = hasEndSplit ? endHour - HOUR_MS : endHour;

    if (fullStartHour <= fullEndHour) {
      const comboInFull = db.query(`
        SELECT 1 FROM usage_hourly_rollups
        WHERE generation = ? AND hour_bucket_ms >= ? AND hour_bucket_ms <= ? AND combo_flag = 1
        LIMIT 1
      `).get(meta.generation, fullStartHour, fullEndHour);
      if (comboInFull !== null) return null;
    }

    const boundaryOffsets: number[] = [];
    if (startHour === endHour) {
      if (hasStartSplit || hasEndSplit) {
        boundaryOffsets.push(...readRowsInRangeFromOffsets(db, meta.generation, meta.indexedOffset, options.since, options.until + 1));
      }
    } else {
      if (hasStartSplit) {
        boundaryOffsets.push(...readRowsInRangeFromOffsets(db, meta.generation, meta.indexedOffset, options.since, startHour + HOUR_MS));
      }
      if (hasEndSplit) {
        boundaryOffsets.push(...readRowsInRangeFromOffsets(db, meta.generation, meta.indexedOffset, endHour, options.until + 1));
      }
    }

    const accumulator = createSourceFacetAccumulator(options.filter, options.configuredIds, {
      since: options.since,
      until: options.until,
    });
    if (boundaryOffsets.length > 0) {
      const read = await readUsageLedgerRowsAtOffsets({
        offsets: boundaryOffsets,
        expectedIdentityKey: usageLogIdentityKey(revision),
        expectedRevisionKey: usageLogRevisionKey(revision),
        expectedProcessedThroughBytes: meta.indexedOffset,
        expectedProcessedThroughDigest: meta.digest,
        expectedFileSize: revision.size,
      });
      if (read.entries.length !== boundaryOffsets.length) return null;
      for (const entry of read.entries) accumulator.add(entry);
    }

    const snap = accumulator.snapshot();
    const apps = { ...snap.apps };
    const configured = new Set(snapshotConfiguredKeyIds(options.configuredIds));
    const keyCounts = new Map<string, number>();
    for (const dev of snap.devices) {
      if (dev.device.kind === "key") keyCounts.set(dev.device.id, dev.requests);
    }
    let allCount = snap.devices.find(d => d.device.kind === "all")?.requests ?? 0;
    let noKeyCount = snap.devices.find(d => d.device.kind === "no-key")?.requests ?? 0;
    let unconfiguredCount = snap.devices.find(d => d.device.kind === "unconfigured")?.requests ?? 0;
    let legacyUnclassifiedRequests = snap.legacyUnclassifiedRequests;

    if (fullStartHour <= fullEndHour) {
      const grouped = db.query(`
        SELECT surface, client, api_key_id, SUM(requests) AS requests
        FROM usage_hourly_rollups
        WHERE generation = ? AND hour_bucket_ms >= ? AND hour_bucket_ms <= ? AND combo_flag = 0
        GROUP BY surface, client, api_key_id
      `).all(meta.generation, fullStartHour, fullEndHour) as Array<{
        surface: string;
        client: string;
        api_key_id: string;
        requests: number;
      }>;
      const selectedDevice = options.filter.device;
      for (const row of grouped) {
        const synthetic = {
          ...(row.client ? { client: row.client as PersistedUsageEntry["client"] } : {}),
          ...(row.surface ? { surface: row.surface as PersistedUsageEntry["surface"] } : {}),
          ...(row.api_key_id ? { apiKeyId: row.api_key_id, admissionKind: "configured" as const } : {}),
        } as PersistedUsageEntry;
        for (const client of USAGE_SOURCE_CLIENTS) {
          if (matchesUsageSource(synthetic, { client, device: selectedDevice }, configured)) {
            apps[client] += row.requests;
          }
        }
        if (matchesUsageSource(synthetic, { client: "codex", device: selectedDevice }, configured) && isLegacyCodexUsage(synthetic)) {
          legacyUnclassifiedRequests += row.requests;
        }
        if (!matchesUsageSource(synthetic, { client: options.filter.client, device: { kind: "all" } }, configured)) {
          continue;
        }
        allCount += row.requests;
        if (!row.api_key_id) {
          noKeyCount += row.requests;
        } else if (keyCounts.has(row.api_key_id)) {
          keyCounts.set(row.api_key_id, keyCounts.get(row.api_key_id)! + row.requests);
        }
        if (matchesUsageSource(synthetic, { client: options.filter.client, device: { kind: "unconfigured" } }, configured)) {
          unconfiguredCount += row.requests;
        }
      }
    }

    return {
      apps,
      devices: [
        { device: { kind: "all" as const }, requests: allCount },
        { device: { kind: "no-key" as const }, requests: noKeyCount },
        ...[...keyCounts].map(([id, requests]) => ({ device: { kind: "key" as const, id }, requests })),
        { device: { kind: "unconfigured" as const }, requests: unconfiguredCount },
      ],
      legacyUnclassifiedRequests,
      unavailableConfiguredKeys: snap.unavailableConfiguredKeys,
      sourceFilter: { client: options.filter.client, device: { ...options.filter.device } },
      window: { since: options.since, until: options.until, timeZone: options.timeZone },
      usageIncomplete: meta.oversizedRows > 0 || meta.invalidRows > 0,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_IN_CHUNK = 400;

/**
 * Compute `ApiKeyUsageSnapshot` from `usage_hourly_rollups` + split 7d cutoff boundary rows.
 * Checks `usage_summary_snapshots` first when fresh (< 60s), then falls back to `usage_hourly_rollups`.
 */
export async function queryApiKeyUsageFromRollup(options: {
  configuredIds: string[];
  now: number;
  expectedSchemaVersion: number;
}): Promise<{
  snapshot: {
    rollup: Map<string, PersistedApiKeyUsage>;
    attributionSince?: string;
    usageIncomplete?: true;
    usageIncompleteReason?: "oversized_rows";
  };
  revision: UsageLogRevision;
} | null> {
  const verified = await openVerifiedReadonlyIndex(options.expectedSchemaVersion);
  if (!verified) return null;
  const { db, meta, revision } = verified;
  try {
    if ((meta.rollupParityFlags & ROLLUP_PARITY_NON_CONFIGURED_API_KEY) !== 0) return null;
    if (meta.minTimestamp !== null && meta.minTimestamp < 0) return null;
    const hasCombo = db.query("SELECT 1 FROM usage_hourly_rollups WHERE generation = ? AND combo_flag = 1 LIMIT 1")
      .get(meta.generation);
    if (hasCombo !== null) return null;

    const duplicated = new Set<string>();
    const uniqueSet = new Set<string>();
    for (const id of options.configuredIds) {
      if (uniqueSet.has(id)) duplicated.add(id);
      uniqueSet.add(id);
    }
    const queryIds = [...uniqueSet].filter(id => !duplicated.has(id) && id !== "");

    const totals = new Map<string, { requests7d: number; totalRequests: number; lastUsedAt?: string }>();
    const cutoff = options.now - SEVEN_DAYS_MS;
    const cutoffHour = Math.floor(cutoff / HOUR_MS) * HOUR_MS;
    const boundaryOffsets: number[] = [];

    for (let offset = 0; offset < queryIds.length; offset += KEY_IN_CHUNK) {
      const chunk = queryIds.slice(offset, offset + KEY_IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const totalRows = db.query(`
        SELECT api_key_id, SUM(requests) AS total_requests, MAX(max_timestamp) AS last_ts
        FROM usage_hourly_rollups
        WHERE generation = ? AND combo_flag = 0 AND api_key_id IN (${placeholders})
        GROUP BY api_key_id
      `).all(meta.generation, ...chunk) as Array<{ api_key_id: string; total_requests: number; last_ts: number | null }>;
      for (const row of totalRows) {
        totals.set(row.api_key_id, {
          requests7d: 0,
          totalRequests: row.total_requests,
          ...(row.last_ts !== null ? { lastUsedAt: new Date(row.last_ts).toISOString() } : {}),
        });
      }

      const full7dRows = db.query(`
        SELECT api_key_id, SUM(requests) AS requests_7d
        FROM usage_hourly_rollups
        WHERE generation = ? AND combo_flag = 0 AND hour_bucket_ms > ? AND api_key_id IN (${placeholders})
        GROUP BY api_key_id
      `).all(meta.generation, cutoffHour, ...chunk) as Array<{ api_key_id: string; requests_7d: number }>;
      for (const row of full7dRows) {
        const entry = totals.get(row.api_key_id);
        if (entry) entry.requests7d = row.requests_7d;
      }

      const splitExists = db.query(`
        SELECT 1 FROM usage_hourly_rollups
        WHERE generation = ? AND combo_flag = 0 AND hour_bucket_ms = ? AND api_key_id IN (${placeholders})
        LIMIT 1
      `).get(meta.generation, cutoffHour, ...chunk);
      if (splitExists !== null) {
        const offsetRows = db.query(`
          SELECT byte_offset FROM usage_rows
          WHERE generation = ? AND byte_offset < ? AND timestamp IS NOT NULL AND timestamp >= ? AND timestamp < ? AND api_key_id IN (${placeholders})
          ORDER BY byte_offset ASC
        `).all(meta.generation, meta.indexedOffset, cutoff, cutoffHour + HOUR_MS, ...chunk) as Array<{ byte_offset: number }>;
        for (const r of offsetRows) boundaryOffsets.push(r.byte_offset);
      }
    }

    if (boundaryOffsets.length > 0) {
      boundaryOffsets.sort((a, b) => a - b);
      const read = await readUsageLedgerRowsAtOffsets({
        offsets: boundaryOffsets,
        expectedIdentityKey: usageLogIdentityKey(revision),
        expectedRevisionKey: usageLogRevisionKey(revision),
        expectedProcessedThroughBytes: meta.indexedOffset,
        expectedProcessedThroughDigest: meta.digest,
        expectedFileSize: revision.size,
      });
      if (read.entries.length !== boundaryOffsets.length) return null;
      for (const entry of read.entries) {
        if (entry.admissionKind !== "configured" || !entry.apiKeyId) continue;
        const ts = usableTimestamp(entry.timestamp);
        if (ts === null || ts < cutoff) continue;
        const bucket = totals.get(entry.apiKeyId);
        if (bucket) bucket.requests7d += 1;
      }
    }

    const rollup = new Map<string, PersistedApiKeyUsage>();
    for (const id of options.configuredIds) {
      if (duplicated.has(id)) {
        rollup.set(id, { ambiguous: true });
      } else {
        rollup.set(id, totals.get(id) ?? { requests7d: 0, totalRequests: 0 });
      }
    }
    return {
      snapshot: {
        rollup,
        ...(meta.minAdmissionTimestamp !== null ? { attributionSince: new Date(meta.minAdmissionTimestamp).toISOString() } : {}),
        ...(meta.oversizedRows > 0 ? { usageIncomplete: true as const, usageIncompleteReason: "oversized_rows" as const } : {}),
      },
      revision,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Compute pure `aggregation=sum`, `grouping=model` timeline when buckets align on UTC hours
 * and parity flags prove exact equivalence to scanning `usage.jsonl`.
 */
export async function queryTimelineFromRollup(options: {
  query: TimelineQuery;
  maxReadBytes: number;
  maxEntries: number;
  expectedSchemaVersion: number;
}): Promise<UsageTimeline | null> {
  const { query } = options;
  if (query.aggregation !== "sum" || query.grouping !== "model" || query.bucketMinutes % 60 !== 0) {
    return null;
  }
  if (query.hiddenProviders.some(provider => baseProviderLabel(provider) !== provider)) {
    return null;
  }
  const bucketSeconds = query.bucketMinutes * 60;
  const buckets = Math.ceil((query.hours * 60) / query.bucketMinutes);
  const end = (Math.floor(query.now / 1000 / bucketSeconds) + 1) * bucketSeconds;
  const start = end - buckets * bucketSeconds;
  const startMs = start * 1000;
  const endMs = end * 1000;
  const bucketMs = bucketSeconds * 1000;
  if (startMs % HOUR_MS !== 0 || endMs % HOUR_MS !== 0) return null;

  const verified = await openVerifiedReadonlyIndex(options.expectedSchemaVersion);
  if (!verified) return null;
  const { db, meta, revision } = verified;
  try {
    if (revision.size > options.maxReadBytes || meta.indexedRows > options.maxEntries) {
      return null;
    }
    if ((meta.rollupParityFlags & ROLLUP_PARITY_UNUSABLE_ATTRIBUTION) !== 0) return null;
    if (query.metric === "total" && (meta.rollupParityFlags & ROLLUP_PARITY_TOTAL_MISMATCH) !== 0) return null;
    if ((query.metric === "input" || query.metric === "output") && (meta.rollupParityFlags & ROLLUP_PARITY_USAGE_MISMATCH) !== 0) return null;
    if (query.metric === "cached" && (meta.rollupParityFlags & ROLLUP_PARITY_CACHED_MISMATCH) !== 0) return null;

    const rows = db.query(`
      SELECT hour_bucket_ms, provider, model, usage_status, cache_provenance,
             SUM(requests) AS requests,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(total_tokens) AS total_tokens,
             SUM(cached_input_tokens) AS cached_input_tokens
      FROM usage_hourly_rollups
      WHERE generation = ? AND hour_bucket_ms >= ? AND hour_bucket_ms < ?
      GROUP BY hour_bucket_ms, provider, model, usage_status, cache_provenance
    `).all(meta.generation, startMs, endMs) as Array<{
      hour_bucket_ms: number;
      provider: string;
      model: string;
      usage_status: string;
      cache_provenance: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cached_input_tokens: number;
    }>;

    const hiddenProviders = new Set(query.hiddenProviders);
    const selectedModels = query.models === null ? null : new Set(query.models.map(normalizeTimelineModelId));
    const availableModels = new Set<string>();
    const series = new Map<string, { provider: string; model: string; points: number[] }>();
    let missingMeasurements = 0;

    for (const row of rows) {
      if (hiddenProviders.has(row.provider)) continue;
      const modelId = `${row.provider}/${row.model}`;
      availableModels.add(modelId);
      if (selectedModels && !selectedModels.has(modelId)) continue;

      let state = series.get(modelId);
      if (!state) {
        state = { provider: row.provider, model: row.model, points: Array<number>(buckets).fill(0) };
        series.set(modelId, state);
      }
      const isMeasured = row.usage_status === "reported" || row.usage_status === "estimated";
      let measured = true;
      let metricDelta = 0;
      if (query.metric === "total") {
        measured = isMeasured;
        metricDelta = row.total_tokens;
      } else if (query.metric === "input") {
        measured = isMeasured;
        metricDelta = row.input_tokens;
      } else if (query.metric === "output") {
        measured = isMeasured;
        metricDelta = row.output_tokens;
      } else {
        measured = row.cache_provenance !== "unknown";
        metricDelta = row.cached_input_tokens;
      }
      if (!measured) {
        missingMeasurements += row.requests;
        continue;
      }
      const bucket = Math.floor((row.hour_bucket_ms - startMs) / bucketMs);
      if (bucket >= 0 && bucket < buckets) {
        state.points[bucket] = (state.points[bucket] ?? 0) + metricDelta;
      }
    }

    const sortedRows: TimelineSeries[] = [...series]
      .map(([id, state]): TimelineSeries => ({
        id,
        provider: state.provider,
        model: state.model,
        total: state.points.reduce((sum, value) => sum + value, 0),
        points: state.points,
      }))
      .sort((left, right) => right.total - left.total || left.id.localeCompare(right.id));

    const kept = sortedRows.length > 24 ? sortedRows.slice(0, 23) : sortedRows;
    if (sortedRows.length > 24) {
      const otherPoints = Array<number>(buckets).fill(0);
      for (const row of sortedRows.slice(23)) {
        for (let index = 0; index < buckets; index += 1) {
          otherPoints[index] = (otherPoints[index] ?? 0) + (row.points[index] ?? 0);
        }
      }
      kept.push({
        id: "other",
        provider: "",
        model: "other",
        total: otherPoints.reduce((sum, value) => sum + value, 0),
        points: otherPoints,
      });
    }

    return {
      appliedFilters: {
        models: query.models === null ? null : [...new Set(query.models)].sort(),
        hiddenProviders: [...hiddenProviders].sort(),
      },
      start,
      end,
      bucketSeconds,
      buckets,
      metric: query.metric,
      aggregation: query.aggregation,
      grouping: query.grouping,
      series: kept,
      availableModels: [...availableModels].sort(),
      missingMeasurements,
      truncated: false,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
