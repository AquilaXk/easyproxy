/**
 * Ingest of canonical `usage.jsonl` rows into a request-history index file.
 *
 * Shared by the serving thread (tails, small rebuilds) and the rebuild worker
 * (large rebuilds, #6990), so both produce identical rows and meta. This
 * module imports no config or indexer state; the worker loads it on its own.
 */

import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import {
  encodePersistedRequestedModel,
  exactFileIdentity,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "../../usage/log";
import {
  HISTORY_DDL,
  HISTORY_META_KEYS,
  HISTORY_ROW_FLAG_HAS_ATTEMPTS,
  HISTORY_ROW_FLAG_HAS_RECOVERY_KINDS,
  HISTORY_ROW_FLAG_HAS_TIER,
  HISTORY_ROW_FLAG_LOCAL_REFUSAL,
  HISTORY_ROW_FLAG_LOCALLY_ANSWERED,
  HISTORY_ROW_FLAG_ZERO_SENDS,
  HISTORY_SCHEMA_VERSION,
} from "./schema";

export const REQUEST_HISTORY_INSERT_BATCH = 500;
export const REQUEST_HISTORY_READ_CHUNK_BYTES = 64 * 1024;
// The SQLite index is a disposable projection. Complete JSONL records above
// this bound are omitted from the projection; the canonical usage.jsonl is
// never truncated or rewritten by the indexer.
export const REQUEST_HISTORY_MAX_RECORD_BYTES = 1024 * 1024;

// One small observation per live database handle, never retained ledger bytes. An
// unterminated tail cannot advance indexedOffset, but need not be reread until its
// exact file revision changes. Schema/identity gates and lifecycle integrity checks still apply.
const tailObservations = new WeakMap<Database, {
  path: string;
  revision: string;
  nextOffset: number;
  endOffset: number | undefined;
}>();

function tailRevision(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** The ledger at the recorded path is no longer the file the rebuild started from. */
export class RequestHistoryIndexStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestHistoryIndexStaleError";
  }
}

const HISTORY_QUERY_CACHE = new WeakMap<Database, Map<string, ReturnType<Database["query"]>>>();
const MAX_CACHED_QUERIES_PER_DB = 32;

export function cachedHistoryQuery(dbHandle: Database, sql: string): ReturnType<Database["query"]> {
  let bySql = HISTORY_QUERY_CACHE.get(dbHandle);
  if (!bySql) {
    bySql = new Map();
    HISTORY_QUERY_CACHE.set(dbHandle, bySql);
  }
  const hit = bySql.get(sql);
  if (hit) return hit;
  const compiled = dbHandle.query(sql);
  if (bySql.size >= MAX_CACHED_QUERIES_PER_DB) {
    const oldest = bySql.keys().next().value;
    if (oldest !== undefined) bySql.delete(oldest);
  }
  bySql.set(sql, compiled);
  return compiled;
}

export function readAllMeta(dbHandle: Database): Map<string, string> {
  const rows = cachedHistoryQuery(dbHandle, "SELECT key, value FROM schema_meta").all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.key, row.value);
  return map;
}

export function metaValue(dbHandle: Database, key: string): string | null {
  const row = cachedHistoryQuery(dbHandle, "SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(dbHandle: Database, key: string, value: string | number): void {
  cachedHistoryQuery(
    dbHandle,
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

function metaNumber(dbHandle: Database, key: string): number {
  const value = metaValue(dbHandle, key);
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resetAndCreateSchema(dbHandle: Database): void {
  tailObservations.delete(dbHandle);
  dbHandle.exec("DROP TABLE IF EXISTS request_attempts");
  dbHandle.exec("DROP TABLE IF EXISTS requests");
  dbHandle.exec("DROP TABLE IF EXISTS schema_meta");
  dbHandle.exec(HISTORY_DDL);
  setMeta(dbHandle, HISTORY_META_KEYS.schemaVersion, HISTORY_SCHEMA_VERSION);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, 0);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, 0);
  setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
  setMeta(dbHandle, HISTORY_META_KEYS.lastError, "rebuilt");
}

export function recordSourceMeta(dbHandle: Database, revision: UsageLogRevision | null): void {
  tailObservations.delete(dbHandle);
  setMeta(dbHandle, HISTORY_META_KEYS.sourcePath, revision?.path ?? "");
  setMeta(dbHandle, HISTORY_META_KEYS.sourceDev, revision?.dev ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceIno, revision?.ino ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs, revision?.birthtimeMs ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, revision?.size ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, revision?.mtimeMs ?? 0);
}

function computeHistoryRowFlags(rowJson: string): number {
  let flags = 0;
  if (rowJson.includes('"attempts"')) flags |= HISTORY_ROW_FLAG_HAS_ATTEMPTS;
  if (rowJson.includes("recoveryKinds")) flags |= HISTORY_ROW_FLAG_HAS_RECOVERY_KINDS;
  if (rowJson.includes("Tier") || rowJson.includes("tierOutcome")) flags |= HISTORY_ROW_FLAG_HAS_TIER;
  if (rowJson.includes("local-refusal")) flags |= HISTORY_ROW_FLAG_LOCAL_REFUSAL;
  if (rowJson.includes("locallyAnswered")) flags |= HISTORY_ROW_FLAG_LOCALLY_ANSWERED;
  if (rowJson.includes('"sendCount":0')) flags |= HISTORY_ROW_FLAG_ZERO_SENDS;
  return flags;
}

/** Extract the `requests` row columns from a canonical persisted entry. */
function extractRow(entry: PersistedUsageEntry): Array<string | number | null> {
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : undefined;
  const rowJson = JSON.stringify(entry);
  const rowFlags = computeHistoryRowFlags(rowJson);
  return [
    entry.requestId,
    entry.timestamp,
    entry.provider,
    entry.model,
    // Old canonical JSONL rows can predate bounded selector persistence. Encode
    // the disposable projection on rebuild so exact filters match across versions.
    typeof entry.requestedModel === "string" ? encodePersistedRequestedModel(entry.requestedModel) : null,
    entry.status,
    entry.surface ?? null,
    entry.inboundProtocol ?? null,
    entry.apiKeyId ?? null,
    entry.conversationId ?? null,
    entry.routeDecision?.routeKind ?? null,
    entry.routeDecision?.profile?.id ?? null,
    entry.routeDecision?.profile?.revision ?? null,
    (attempts?.length ?? 0) > 1 ? 1 : 0,
    entry.durationMs,
    entry.firstOutputMs ?? null,
    entry.usageStatus,
    entry.usage ? JSON.stringify(entry.usage) : null,
    entry.totalTokens ?? null,
    entry.errorCode ?? null,
    entry.terminalStatus ?? null,
    entry.closeReason ?? null,
    attempts?.length ?? 1,
    rowFlags,
    entry.routeDecision ? JSON.stringify(entry.routeDecision) : null,
    rowJson,
  ];
}

const ROW_INSERT = `
INSERT OR IGNORE INTO requests (
  request_id, timestamp, provider, model, requested_model, status, surface,
  inbound_protocol, api_key_id, conversation_id, route_kind, profile_id,
  profile_revision, fallback, duration_ms, first_output_ms, usage_status,
  usage_json, total_tokens, error_code, terminal_status, close_reason,
  attempt_count, row_flags, decision_json, row_json
) VALUES (
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)`;

function parsedEntryFromLine(line: string): PersistedUsageEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as PersistedUsageEntry;
    if (parsed && typeof parsed === "object"
      && typeof parsed.requestId === "string"
      && typeof parsed.timestamp === "number"
      && typeof parsed.provider === "string"
      && typeof parsed.model === "string"
      && typeof parsed.status === "number"
      && typeof parsed.durationMs === "number") {
      return parsed;
    }
  } catch {
    /* skip partial / hand-edited lines, same as every other reader */
  }
  return null;
}

export interface IngestOptions {
  /** Ledger file the caller recorded; a different file at the path makes the ingest stale. */
  expected?: Pick<UsageLogRevision, "dev" | "ino">;
  /**
   * Stop at this byte offset instead of the size observed when the ingest
   * opens the ledger, so a worker rebuild indexes the snapshot its refresh
   * recorded and the next refresh picks up later appends as a tail.
   */
  endOffset?: number;
}

const ATTEMPT_INSERT = `
INSERT OR IGNORE INTO request_attempts (request_id, timestamp, provider, model)
VALUES (?, ?, ?, ?)`;

type AttemptIndexTuple = [string, number, string, string];

function extractFailoverAttemptTuples(entry: PersistedUsageEntry): AttemptIndexTuple[] {
  const attempts = entry.attempts;
  if (!Array.isArray(attempts) || attempts.length <= 1) return [];
  const tuples: AttemptIndexTuple[] = [];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt || typeof attempt.provider !== "string" || typeof attempt.model !== "string") continue;
    if (attempt.provider === entry.provider && attempt.model === entry.model) continue;
    const dedupeKey = `${attempt.provider}\u0000${attempt.model}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tuples.push([entry.requestId, entry.timestamp, attempt.provider, attempt.model]);
  }
  return tuples;
}

export function ingestSourceTail(
  dbHandle: Database,
  path: string,
  fromOffset: number,
  options: IngestOptions = {},
): number {
  let inserted = 0;
  let pending: Array<{ row: Array<string | number | null>; attempts: AttemptIndexTuple[] }> = [];
  const insert = dbHandle.prepare(ROW_INSERT);
  const insertAttempt = dbHandle.prepare(ATTEMPT_INSERT);
  let fd: number | undefined;
  try {
    const applyBatchRows = (rows: Array<{ row: Array<string | number | null>; attempts: AttemptIndexTuple[] }>) => {
      for (const item of rows) {
        // `changes` counts real inserts only; INSERT OR IGNORE replays add 0.
        const rowChanges = insert.run(...item.row).changes;
        inserted += rowChanges;
        if (rowChanges > 0) {
          for (const tuple of item.attempts) {
            insertAttempt.run(...tuple);
          }
        }
      }
    };
    const commitBatch = () => {
      dbHandle.transaction(applyBatchRows)(pending);
      pending = [];
    };
    const ingestLine = (line: Buffer) => {
      const entry = parsedEntryFromLine(line.toString("utf-8"));
      if (!entry) return;
      pending.push({
        row: extractRow(entry),
        attempts: extractFailoverAttemptTuples(entry),
      });
      if (pending.length >= REQUEST_HISTORY_INSERT_BATCH) commitBatch();
    };

    fd = openSync(path, "r");
    const stat = fstatSync(fd, { bigint: true });
    const expected = options.expected;
    if (expected) {
      const opened = exactFileIdentity(fd);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new RequestHistoryIndexStaleError("usage log changed before indexing");
      }
    }
    const revision = tailRevision(stat);
    const observed = tailObservations.get(dbHandle);
    if (observed?.path === path && observed.revision === revision
      && observed.nextOffset === fromOffset && observed.endOffset === options.endOffset) return 0;
    // A failed or interrupted attempt must never publish a reusable observation.
    tailObservations.delete(dbHandle);
    const size = options.endOffset === undefined
      ? Number(stat.size)
      : Math.min(Number(stat.size), options.endOffset);
    const readBuffer = Buffer.allocUnsafe(REQUEST_HISTORY_READ_CHUNK_BYTES);
    let position = fromOffset;
    let nextOffset = fromOffset;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let oversized = false;
    while (position < size) {
      const requested = Math.min(readBuffer.length, size - position);
      const bytesRead = readSync(fd, readBuffer, 0, requested, position);
      if (bytesRead === 0) throw new RequestHistoryIndexStaleError("usage log changed while indexing");
      let lineStart = 0;
      for (;;) {
        const index = readBuffer.indexOf(0x0a, lineStart);
        if (index === -1 || index >= bytesRead) break;
        const segment = readBuffer.subarray(lineStart, index);
        if (!oversized && fragmentBytes + segment.length <= REQUEST_HISTORY_MAX_RECORD_BYTES) {
          const line = fragments.length === 0
            ? segment
            : Buffer.concat([...fragments, segment], fragmentBytes + segment.length);
          ingestLine(line);
        }
        fragments = [];
        fragmentBytes = 0;
        oversized = false;
        lineStart = index + 1;
        nextOffset = position + index + 1;
      }
      const remainder = readBuffer.subarray(lineStart, bytesRead);
      if (remainder.length > 0) {
        if (!oversized && fragmentBytes + remainder.length <= REQUEST_HISTORY_MAX_RECORD_BYTES) {
          // Copy because readBuffer is reused on the next iteration.
          fragments.push(Buffer.from(remainder));
          fragmentBytes += remainder.length;
        } else {
          fragments = [];
          fragmentBytes = 0;
          oversized = true;
        }
      }
      position += bytesRead;
    }
    dbHandle.transaction(() => {
      if (pending.length > 0) {
        applyBatchRows(pending);
        pending = [];
      }
      const indexedRows = metaNumber(dbHandle, HISTORY_META_KEYS.indexedRows);
      setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, nextOffset);
      setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, indexedRows + inserted);
      setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, size);
      setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, Number(stat.mtimeNs) / 1_000_000);
      setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
    })();
    if (nextOffset < size && tailRevision(fstatSync(fd, { bigint: true })) === revision) {
      tailObservations.set(dbHandle, { path, revision, nextOffset, endOffset: options.endOffset });
    }
    return inserted;
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Windows file locks: an unterminated prepared statement keeps the DB
    // file busy after close (verified on Bun 1.3.14). Finalize always.
    insert.finalize();
    insertAttempt.finalize();
  }
}
