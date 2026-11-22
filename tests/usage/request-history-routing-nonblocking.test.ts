import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import {
  closeRequestHistoryIndex,
  MAX_ROUTING_SYNC_TAIL_BYTES,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  requestHistoryDb,
} from "../../src/routing/history/indexer";
import { HISTORY_DB_FILENAME } from "../../src/routing/history/schema";
import { appendUsageEntry, resetUsageReadCacheForTests, usageLogPath, type PersistedUsageEntry } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function sampleEntry(id: string, ts: number, pad = ""): PersistedUsageEntry {
  return {
    requestId: id,
    timestamp: ts,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 25,
    usageStatus: "reported",
    ...(pad ? { apiKeyId: pad } : {}),
  };
}

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "epx-routing-nonblocking-"));
  process.env.EASYPROXY_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(async () => {
  closeRequestHistoryIndex();
  await flushConfigDirHardeningForTests();
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("request-history non-blocking routing indexer", () => {
  test("configures journal_size_limit and returns immediately without blocking under SQLITE_BUSY write contention", async () => {
    for (let i = 0; i < 4; i += 1) {
      appendUsageEntry(sampleEntry(`seed-${i}`, 10_000 + i));
    }
    const initial = await openRequestHistoryIndex();
    expect(initial.indexedRows).toBe(4);
    const limitRow = requestHistoryDb().query("PRAGMA journal_size_limit").get() as { journal_size_limit: number };
    expect(limitRow.journal_size_limit).toBe(67_108_864);

    // Append one small entry, then hold an external BEGIN IMMEDIATE write lock on a second connection.
    appendUsageEntry(sampleEntry("contended-row", 10_100));
    const contender = new Database(join(getConfigDir(), HISTORY_DB_FILENAME));
    let committed = false;
    try {
      contender.exec("BEGIN IMMEDIATE");
      const startedAt = performance.now();
      const routingMeta = openRequestHistoryIndexSync();
      const elapsedMs = performance.now() - startedAt;

      // Must fail-fast with busy_timeout=0 instead of blocking up to 5000ms, returning existing indexed metadata.
      expect(elapsedMs).toBeLessThan(200);
      expect(routingMeta.indexedRows).toBe(4);

      // Restored busy_timeout must still allow async catch-up once the write lock is released.
      contender.exec("COMMIT");
      committed = true;

      for (let i = 0; i < 100; i += 1) {
        const after = await openRequestHistoryIndex();
        if (after.indexedRows >= 5) break;
        await Bun.sleep(5);
      }
      const caughtUp = await openRequestHistoryIndex();
      expect(caughtUp.indexedRows).toBe(5);
    } finally {
      if (!committed) {
        try { contender.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      contender.close();
    }
  });

  test("skips synchronous tail ingestion above 64 KiB on routing path and triggers async catch-up", async () => {
    appendUsageEntry(sampleEntry("initial-1", 20_000));
    const base = await openRequestHistoryIndex();
    expect(base.indexedRows).toBe(1);

    // Append > 64 KiB unindexed JSONL rows (< workerRebuildMinBytes).
    const chunkLines: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      chunkLines.push(`${JSON.stringify(sampleEntry(`bulk-${i}`, 20_100 + i, "k".repeat(950)))}\n`);
    }
    const bulkPayload = chunkLines.join("");
    expect(Buffer.byteLength(bulkPayload)).toBeGreaterThan(MAX_ROUTING_SYNC_TAIL_BYTES);
    appendFileSync(usageLogPath(), bulkPayload, "utf8");

    const startedAt = performance.now();
    const syncMeta = openRequestHistoryIndexSync();
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(100);
    expect(syncMeta.indexedRows).toBe(1);

    // Non-blocking catch-up scheduled via timer completes cleanly without manual intervention.
    let caughtUpRows = 0;
    for (let i = 0; i < 200; i += 1) {
      await Bun.sleep(10);
      const latest = await openRequestHistoryIndex();
      caughtUpRows = latest.indexedRows;
      if (caughtUpRows === 81) break;
    }
    expect(caughtUpRows).toBe(81);
  });
});
