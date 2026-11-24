import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import { runPassiveRead } from "../../src/lib/passive-read";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  getFilteredUsageAggregate,
  getUsageAggregate,
  resetUsageAggregateCacheForTests,
} from "../../src/server/management/usage-aggregate-cache";
import { resetUsageSummaryCacheForTests } from "../../src/server/management/usage-summary-cache";
import { handleLogsUsageRoutes } from "../../src/server/management/logs-usage-routes";
import { getUsageSourceFacets, resetUsageSourceFacetsForTests } from "../../src/server/management/usage-source-facets";
import {
  clearApiKeyUsageCacheForTests,
  readApiKeyUsageRollup,
  rollupApiKeyUsage,
} from "../../src/server/management/api-key-usage";
import {
  handleUsageTimelineRoutes,
  resetUsageTimelineCacheForTests,
} from "../../src/server/management/usage-timeline-routes";
import type { ManagementContext } from "../../src/server/management/context";
import * as ledgerScannerModule from "../../src/usage/ledger-scanner";
import { scanUsageLedgerCooperatively } from "../../src/usage/ledger-scanner";
import {
  readUsageFilterCandidates,
  setUsageFilterIndexTestHooksForTests,
  USAGE_FILTER_INDEX_SCHEMA_VERSION,
  usageFilterIndexPath,
} from "../../src/usage/filter-index";
import {
  computeUsageOverlaySignature,
  MAX_SUMMARY_SNAPSHOT_BYTES,
  MAX_SUMMARY_SNAPSHOTS_PER_GENERATION,
  persistUsageSummarySnapshot,
} from "../../src/usage/summary-rollup";
import {
  currentUsageLogRevision,
  resetUsageReadCacheForTests,
  setManagementUsageMaxEntriesForTests,
  usageLogIdentityKey,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import {
  USAGE_RANGES,
  USAGE_SURFACES,
  createUsageSummaryAccumulator,
  localDateKey,
  rangeWindow,
} from "../../src/usage/summary";
import { createSourceFacetAccumulator } from "../../src/usage/source-facets";
import { createTimelineAccumulator, parseTimelineQuery } from "../../src/usage/timeline";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import type { EpxConfig } from "../../src/types";

const HOUR_MS = 3_600_000;
const TODAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const BASE_HOUR = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;

let testDir = "";
let previousHome: string | undefined;

function ledgerPath(): string {
  return join(testDir, "usage.jsonl");
}

function dbPath(): string {
  return usageFilterIndexPath(testDir);
}

function makeConfig(overrides: Partial<EpxConfig> = {}): EpxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    apiKeys: [
      { id: "key-a", name: "Alpha", keyHash: "h-a", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "key-b", name: "Beta", keyHash: "h-b", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      anthropic: { adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com", authMode: "forward" },
    },
    ...overrides,
  } as EpxConfig;
}

function makeRow(index: number, overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId: `req-${index}`,
    timestamp: BASE_HOUR + (index % 2) * HOUR_MS + 10_000 + index,
    provider: index % 2 === 0 ? "openai" : "anthropic",
    model: index % 2 === 0 ? "gpt-5.4" : "claude-sonnet-4-6",
    surface: index % 2 === 0 ? undefined : "claude",
    status: 200,
    durationMs: 25,
    usageStatus: "reported",
    usage: {
      inputTokens: 100 + index,
      outputTokens: 40 + index,
      cachedInputTokens: 20,
      reasoningOutputTokens: 5,
    },
    totalTokens: 140 + 2 * index,
    cacheProvenance: "observed",
    client: index % 2 === 0 ? "codex_cli" : "claude_code",
    apiKeyId: index % 2 === 0 ? "key-a" : "key-b",
    admissionKind: "configured",
    ...overrides,
  };
}

function writeRows(rows: readonly PersistedUsageEntry[]): void {
  writeFileSync(ledgerPath(), rows.map(row => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
}

function appendRows(rows: readonly PersistedUsageEntry[]): void {
  appendFileSync(ledgerPath(), rows.map(row => `${JSON.stringify(row)}\n`).join(""));
}

function mgmtCtx(pathAndQuery: string, config = makeConfig()): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${pathAndQuery}`);
  const req = new Request(url, { method: "GET" });
  return {
    req,
    url,
    config,
    deps: {} as ManagementContext["deps"],
    syncClaudeAgentDefsBestEffort: async () => {},
  } as ManagementContext;
}

async function callUsageRoute(pathAndQuery: string, config = makeConfig()): Promise<Record<string, unknown>> {
  const res = await handleLogsUsageRoutes(mgmtCtx(pathAndQuery, config));
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return await res!.json() as Record<string, unknown>;
}

async function callTimelineRoute(pathAndQuery: string, config = makeConfig()): Promise<Record<string, unknown>> {
  const res = await handleUsageTimelineRoutes(mgmtCtx(pathAndQuery, config));
  expect(res).toBeDefined();
  expect(res!.status).toBe(200);
  return await res!.json() as Record<string, unknown>;
}

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "epx-usage-rollup-"));
  process.env.EASYPROXY_HOME = testDir;
  resetUsageAggregateCacheForTests();
  resetUsageSummaryCacheForTests();
  resetUsageReadCacheForTests();
  clearApiKeyUsageCacheForTests();
  resetUsageSourceFacetsForTests();
  resetUsageTimelineCacheForTests();
  resetAppOwnedMemoryForTests();
  setManagementUsageMaxEntriesForTests(null);
  refreshUserCostOverlays(makeConfig());
});

afterEach(() => {
  setUsageFilterIndexTestHooksForTests(null);
  setManagementUsageMaxEntriesForTests(null);
  resetUsageAggregateCacheForTests();
  resetUsageSummaryCacheForTests();
  resetUsageReadCacheForTests();
  clearApiKeyUsageCacheForTests();
  resetUsageSourceFacetsForTests();
  resetUsageTimelineCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as EpxConfig);
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("SQLite usage summary rollups (schema v6)", () => {
  test("schema v6 upgrades v5 database cleanly and defines hourly rollup + snapshot tables", async () => {
    expect(USAGE_FILTER_INDEX_SCHEMA_VERSION).toBe(6);
    writeRows([makeRow(0), makeRow(1), makeRow(2)]);
    // Seed a synthetic v5 database with the prior meta and legacy tables.
    const legacy = new Database(dbPath(), { create: true });
    legacy.exec(`
      CREATE TABLE usage_filter_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE usage_rows (generation TEXT NOT NULL, byte_offset INTEGER NOT NULL, PRIMARY KEY (generation, byte_offset));
      CREATE TABLE usage_attributions (generation TEXT NOT NULL, byte_offset INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (generation, byte_offset, provider, model));
      CREATE TABLE usage_filter_index_writers (generation TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL);
      CREATE TABLE usage_filter_index_generations (generation TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      INSERT INTO usage_filter_index_meta (key, value) VALUES ('schema_version', '5');
    `);
    legacy.close();

    const read = await readUsageFilterCandidates({ provider: "openai", model: null, apiKeyId: null });
    expect(read).not.toBeNull();
    read!.close();

    const db = new Database(dbPath(), { readonly: true });
    try {
      const objects = db.query("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index')")
        .all() as Array<{ name: string; type: string; sql: string | null }>;
      const tables = new Set(objects.filter(o => o.type === "table").map(o => o.name));
      expect(tables.has("usage_hourly_rollups")).toBe(true);
      expect(tables.has("usage_summary_snapshots")).toBe(true);
      const rollupDef = objects.find(o => o.type === "table" && o.name === "usage_hourly_rollups");
      expect(rollupDef?.sql?.toUpperCase()).toContain("WITHOUT ROWID");
      const indexes = new Set(objects.filter(o => o.type === "index").map(o => o.name));
      expect(indexes.has("idx_usage_hourly_hour")).toBe(true);
      expect(indexes.has("idx_usage_hourly_key")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("crash during append before publish causes zero double-counting in usage_hourly_rollups", async () => {
    const initial = [makeRow(0), makeRow(1)];
    const appended = [makeRow(2), makeRow(3), makeRow(4)];
    writeRows(initial);
    const build = await readUsageFilterCandidates({ provider: null, model: null, apiKeyId: null });
    expect(build).not.toBeNull();
    build!.close();

    appendRows(appended);
    let injectedCrash = false;
    setUsageFilterIndexTestHooksForTests({
      beforePublish() {
        if (!injectedCrash) {
          injectedCrash = true;
          throw new Error("simulated crash before publish");
        }
      },
    });
    // First append attempt throws before publish (caught internally? readUsageFilterCandidates degrades only on non-hook errors or retries — call again cleanly).
    await expect(readUsageFilterCandidates({ provider: null, model: null, apiKeyId: null })).resolves.toBeNull();
    setUsageFilterIndexTestHooksForTests(null);

    const recovered = await readUsageFilterCandidates({ provider: null, model: null, apiKeyId: null });
    expect(recovered).not.toBeNull();
    recovered!.close();

    const config = makeConfig();
    const facets = await getUsageSourceFacets({ client: "all", device: { kind: "all" } }, ["key-a", "key-b"]);
    const apiRollup = await readApiKeyUsageRollup(["key-a", "key-b"]);
    expect(facets.devices.find(d => d.device.kind === "all")?.requests).toBe(5);
    expect(apiRollup.rollup.get("key-a")).toMatchObject({ totalRequests: 3 });
    expect(apiRollup.rollup.get("key-b")).toMatchObject({ totalRequests: 2 });

    // Confirm overlay-signature & timeline counts match full JSONL scan 1:1.
    const timeline = await callTimelineRoute("/api/usage/timeline?hours=24&bucketMinutes=60&metric=total&aggregation=sum&grouping=model", config);
    const oracleQuery = parseTimelineQuery(new URLSearchParams("hours=24&bucketMinutes=60&metric=total&aggregation=sum&grouping=model"), Number((timeline as { end: number }).end) * 1000 - 3_600_000);
    expect("error" in oracleQuery).toBe(false);
    const acc = createTimelineAccumulator(oracleQuery as Exclude<typeof oracleQuery, { error: string }>);
    for (const row of [...initial, ...appended]) acc.add(row);
    expect(timeline).toEqual(acc.finish());
  });

  test("usage_summary_snapshots caps 64 rows per generation and fails closed on corrupt/oversized JSON", async () => {
    const config = makeConfig();
    writeRows([makeRow(0), makeRow(1)]);
    await getFilteredUsageAggregate({});
    await getUsageAggregate({ configuredApiKeyIds: ["key-a", "key-b"] });

    const revision = currentUsageLogRevision()!;
    const db = new Database(dbPath(), { readonly: true });
    const meta = db.query("SELECT value FROM usage_filter_index_meta WHERE key = 'generation'").get() as { value: string };
    const digest = db.query("SELECT value FROM usage_filter_index_meta WHERE key = 'boundary_digest'").get() as { value: string };
    db.close();

    const basePayload = {
      localDate: localDateKey(Date.now()),
      maxReadBytes: 64 * 1024 * 1024,
      usageIncomplete: false,
      snapshotWindowStart: BASE_HOUR,
      snapshotWindowEnd: BASE_HOUR + HOUR_MS,
      presets: Object.fromEntries(
        USAGE_RANGES.flatMap(range => USAGE_SURFACES.map(surface => [`${range}:${surface}`, createUsageSummaryAccumulator().summarize(range, Date.now(), surface)])),
      ),
    };
    const identityKey = usageLogIdentityKey(revision);
    for (let i = 0; i < 70; i += 1) {
      persistUsageSummarySnapshot({
        dbPath: dbPath(),
        identityKey,
        processedThroughBytes: revision.size,
        processedThroughDigest: digest.value,
        overlaySignature: `sig-${i}`,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        localDate: basePayload.localDate,
        maxReadBytes: basePayload.maxReadBytes,
        payload: basePayload,
        updatedAt: 1_000 + i,
      });
    }

    const verifyDb = new Database(dbPath(), { readonly: true });
    const countRow = verifyDb.query("SELECT COUNT(*) AS c, MIN(updated_at) AS minUpdated FROM usage_summary_snapshots WHERE generation = ?")
      .get(meta.value) as { c: number; minUpdated: number };
    verifyDb.close();
    expect(countRow.c).toBe(MAX_SUMMARY_SNAPSHOTS_PER_GENERATION);
    // The initial aggregate saved 1 row at Date.now() (> 1069), so 64 retained rows span 1007..1069 + that initial row.
    expect(countRow.minUpdated).toBe(1_007);

    // Tamper the real overlay snapshot row with corrupt JSON and oversized JSON -> must fail closed and recompute safely.
    const rw = new Database(dbPath(), { create: false });
    const activeSig = computeUsageOverlaySignature();
    rw.query("INSERT OR REPLACE INTO usage_summary_snapshots (generation, snapshot_key, indexed_offset, boundary_digest, overlay_signature, time_zone, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(meta.value, `${basePayload.localDate}|${basePayload.maxReadBytes}|${activeSig}|${Intl.DateTimeFormat().resolvedOptions().timeZone}`, revision.size, digest.value, activeSig, Intl.DateTimeFormat().resolvedOptions().timeZone, "{not-valid-json", Date.now());
    rw.close();

    resetUsageSummaryCacheForTests();
    resetUsageAggregateCacheForTests();
    const res1 = await callUsageRoute("/api/usage?range=30d&surface=all", config);
    expect((res1.summary as { requests: number }).requests).toBe(2);

    // Oversized malicious payload beyond MAX_SUMMARY_SNAPSHOT_BYTES must also fail closed.
    const rw2 = new Database(dbPath(), { create: false });
    const bloated = "x".repeat(MAX_SUMMARY_SNAPSHOT_BYTES + 128);
    rw2.query("UPDATE usage_summary_snapshots SET payload_json = ? WHERE generation = ? AND overlay_signature = ?")
      .run(JSON.stringify({ junk: bloated }), meta.value, activeSig);
    rw2.close();

    resetUsageSummaryCacheForTests();
    resetUsageAggregateCacheForTests();
    const res2 = await callUsageRoute("/api/usage?range=30d&surface=all", config);
    expect((res2.summary as { requests: number }).requests).toBe(2);
  });

  test("overlay_signature changes on any overlay, credit price, configured provider, or account pricing provider mutation", () => {
    const baseSig = computeUsageOverlaySignature();

    refreshUserCostOverlays(makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "forward",
          modelCosts: { "gpt-5.4": { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } },
        },
        anthropic: { adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com", authMode: "forward" },
      },
    }));
    const overlaySig = computeUsageOverlaySignature();
    expect(overlaySig).not.toBe(baseSig);

    refreshUserCostOverlays(makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "forward",
          modelCosts: { "gpt-5.4": { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } },
          creditPriceUsd: 0.05,
        },
        anthropic: { adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com", authMode: "forward" },
      },
    }));
    const creditSig = computeUsageOverlaySignature();
    expect(creditSig).not.toBe(overlaySig);

    refreshUserCostOverlays(makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "forward",
          modelCosts: { "gpt-5.4": { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } },
          creditPriceUsd: 0.05,
        },
      },
    }));
    const providerRemovedSig = computeUsageOverlaySignature();
    expect(providerRemovedSig).not.toBe(creditSig);

    refreshUserCostOverlays(makeConfig({
      codexAccounts: [{
        id: "acc-1",
        credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 },
        provider: "openai-p112233",
      }],
    }));
    expect(computeUsageOverlaySignature()).not.toBe(providerRemovedSig);
  });

  test("cold-start hydrates all 16 presets and ApiKeyUsageSnapshot from SQLite with 0 JSONL scans", async () => {
    const config = makeConfig();
    const rows = [
      makeRow(0, { timestamp: TODAY_START + 60_000 }),
      makeRow(1, { timestamp: TODAY_START + 120_000, client: "grok", surface: "grok", apiKeyId: "key-b" }),
      makeRow(2, { timestamp: TODAY_START - 2 * 86_400_000, client: "codex_desktop", surface: undefined, apiKeyId: "key-a" }),
      makeRow(3, { timestamp: TODAY_START - 10 * 86_400_000, client: "claude_code", surface: "claude", apiKeyId: "key-a" }),
    ];
    writeRows(rows);
    await getFilteredUsageAggregate({});
    // Warm persistence via GET /api/usage.
    const baseline: Record<string, unknown> = {};
    await callUsageRoute("/api/usage?range=30d&surface=all", config);

    // Clear all RAM caches (simulating fresh process boot).
    resetUsageAggregateCacheForTests();
    resetUsageSummaryCacheForTests();
    clearApiKeyUsageCacheForTests();

    const originalScan = ledgerScannerModule.scanUsageLedgerCooperatively;
    let scans = 0;
    const scanSpy = spyOn(ledgerScannerModule, "scanUsageLedgerCooperatively").mockImplementation(async options => {
      scans += 1;
      return originalScan(options);
    });
    try {
      for (const range of USAGE_RANGES) {
        for (const surface of USAGE_SURFACES) {
          const actual = await callUsageRoute(`/api/usage?range=${range}&surface=${surface}`, config);
          baseline[`${range}:${surface}`] = actual;
        }
      }
      const keyRollup = await readApiKeyUsageRollup(["key-a", "key-b"], config.managementUsageMaxReadBytes);
      expect(scans).toBe(0);

      // Verify bit-for-bit parity against fresh non-cached full JSONL scan!
      resetUsageAggregateCacheForTests();
      resetUsageSummaryCacheForTests();
      clearApiKeyUsageCacheForTests();
      const acc = createUsageSummaryAccumulator({ mode: "row-unique" });
      for (const r of rows) acc.add(r);
      for (const range of USAGE_RANGES) {
        for (const surface of USAGE_SURFACES) {
          const actual = baseline[`${range}:${surface}`] as Record<string, unknown>;
          const expected = acc.summarize(range, Number(actual.generatedAt), surface);
          expect({ ...actual, generatedAt: expected.generatedAt }).toMatchObject(expected);
        }
      }
      const expectedKeys = rollupApiKeyUsage(rows, ["key-a", "key-b"]);
      expect(keyRollup.attributionSince).toBe(expectedKeys.attributionSince);
      expect([...keyRollup.rollup.entries()]).toEqual([...expectedKeys.rollup.entries()]);

      // Now mutate pricing overlay -> must invalidate cached snapshot!
      refreshUserCostOverlays(makeConfig({
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authMode: "forward",
            modelCosts: { "gpt-5.4": { input: 9.9, output: 19.9, cacheRead: 0, cacheWrite: 0 } },
          },
          anthropic: { adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com", authMode: "forward" },
        },
      }));
      resetUsageSummaryCacheForTests();
      scans = 0;
      const repriced = await callUsageRoute("/api/usage?range=all&surface=all", config);
      expect(scans).toBeGreaterThan(0);
      expect(Number((repriced.summary as { estimatedCostUsd: number }).estimatedCostUsd))
        .toBeGreaterThan(Number(((baseline["all:all"] as Record<string, unknown>).summary as { estimatedCostUsd: number }).estimatedCostUsd));
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("hourly rollups accelerate source-facets, api-key-usage, and sum timeline with split boundary hours & combo fallbacks", async () => {
    const now = BASE_HOUR + 2 * HOUR_MS + 1_234_000; // mid-hour on purpose
    const split7d = now - 7 * 24 * HOUR_MS;
    const split7dHour = Math.floor(split7d / HOUR_MS) * HOUR_MS;
    const split30d = rangeWindow("30d", Date.now()).since!;
    const rows: PersistedUsageEntry[] = [
      // Before and after 7d cutoff inside exact same hour bucket!
      makeRow(0, { timestamp: split7d - 5_000, apiKeyId: "key-a" }),
      makeRow(1, { timestamp: split7d + 5_000, apiKeyId: "key-a" }),
      // Inside first boundary hour near 30d start (both inside and outside window)
      makeRow(2, { timestamp: split30d - 10_000, apiKeyId: "key-b", client: undefined, surface: undefined }),
      makeRow(3, { timestamp: split30d + 10_000, apiKeyId: "key-b", client: undefined, surface: undefined }),
      // Deleted key (unconfigured) + environment admission (no apiKeyId) + Antigravity variant casing + unreported cache
      makeRow(4, { timestamp: BASE_HOUR + 5_000, provider: "google-antigravity", model: "gemini-3-pro-high", apiKeyId: "deleted-key", admissionKind: "configured", client: "aside" }),
      makeRow(5, { timestamp: BASE_HOUR + HOUR_MS + 5_000, provider: "anthropic-p112233", model: "claude-sonnet-4-6", apiKeyId: undefined, admissionKind: "environment", usageStatus: "unreported", usage: undefined, totalTokens: undefined, cacheProvenance: "unknown", client: "claude_desktop", surface: "claude-desktop" }),
      // Invalid timestamp row (must count in totalRequests but not requests7d or timeline)
      makeRow(6, { timestamp: 1e309, apiKeyId: "key-a" }),
    ];
    writeRows(rows);
    await getFilteredUsageAggregate({});

    const originalScan = ledgerScannerModule.scanUsageLedgerCooperatively;
    let scans = 0;
    const scanSpy = spyOn(ledgerScannerModule, "scanUsageLedgerCooperatively").mockImplementation(async options => {
      scans += 1;
      return originalScan(options);
    });
    try {
      const facets = await getUsageSourceFacets({ client: "all", device: { kind: "all" } }, ["key-a", "key-b"]);
      const apiUsage = await readApiKeyUsageRollup(["key-a", "key-b", "key-a"]);
      const timeline = await callTimelineRoute("/api/usage/timeline?hours=72&bucketMinutes=60&metric=cached&aggregation=sum&grouping=model");
      expect(scans).toBe(0);

      // Oracle check for source-facets against full scan:
      const facetAcc = createSourceFacetAccumulator({ client: "all", device: { kind: "all" } }, ["key-a", "key-b"], facets.window);
      for (const r of rows) facetAcc.add(r);
      expect({
        apps: facets.apps,
        devices: facets.devices,
        legacyUnclassifiedRequests: facets.legacyUnclassifiedRequests,
        unavailableConfiguredKeys: facets.unavailableConfiguredKeys,
      }).toEqual(facetAcc.snapshot());

      // Oracle check for duplicate + split boundary 7d key rollup:
      expect(apiUsage.rollup.get("key-a")).toEqual({ ambiguous: true });
      const keyExpected = rollupApiKeyUsage(rows, ["key-b"]);
      expect(apiUsage.rollup.get("key-b")).toEqual(keyExpected.rollup.get("key-b"));

      // Oracle check for timeline:
      const tlEndMs = Number(timeline.end) * 1000;
      const tlQuery = parseTimelineQuery(new URLSearchParams("hours=72&bucketMinutes=60&metric=cached&aggregation=sum&grouping=model"), tlEndMs - 3_600_000);
      const tlAcc = createTimelineAccumulator(tlQuery as Exclude<typeof tlQuery, { error: string }>);
      for (const r of rows) tlAcc.add(r);
      expect(timeline).toEqual(tlAcc.finish());

      // Append a combo row + test average/max timeline -> triggers exact fallback without losing parity!
      expect(split7dHour).toBeGreaterThan(0);
      const comboRow = makeRow(99, {
        timestamp: BASE_HOUR + 15_000,
        attempts: [
          { ordinal: 1, provider: "openai", model: "gpt-5.4", adapter: "openai-responses", status: 200, durationMs: 10, sendCount: 1, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 5 } },
          { ordinal: 2, provider: "anthropic", model: "claude-sonnet-4-6", adapter: "anthropic-messages", status: 200, durationMs: 12, sendCount: 1, usageStatus: "reported", usage: { inputTokens: 20, outputTokens: 8 } },
        ],
      });
      // Include a row where usageStatus is unreported but explicit totalTokens exists -> triggers ROLLUP_PARITY_TOTAL_MISMATCH fallback on metric=total.
      const totalMismatchRow = makeRow(100, {
        timestamp: BASE_HOUR + 20_000,
        provider: "openai",
        model: "gpt-5.4",
        usageStatus: "unreported",
        usage: undefined,
        totalTokens: 77,
        cacheProvenance: "unknown",
      });
      appendRows([comboRow, totalMismatchRow]);
      await getFilteredUsageAggregate({});
      resetUsageSourceFacetsForTests();
      resetUsageTimelineCacheForTests();
      clearApiKeyUsageCacheForTests();

      const facetsWithCombo = await getUsageSourceFacets({ client: "all", device: { kind: "all" } }, ["key-a", "key-b"]);
      expect(scans).toBeGreaterThan(0);
      const facetComboOracle = createSourceFacetAccumulator({ client: "all", device: { kind: "all" } }, ["key-a", "key-b"], facetsWithCombo.window);
      for (const r of [...rows, comboRow, totalMismatchRow]) facetComboOracle.add(r);
      expect(facetsWithCombo.devices.find(d => d.device.kind === "all")?.requests)
        .toBe(facetComboOracle.snapshot().devices.find(d => d.device.kind === "all")?.requests);

      const avgTimeline = await callTimelineRoute("/api/usage/timeline?hours=24&bucketMinutes=60&metric=total&aggregation=average&grouping=model");
      const avgAcc = createTimelineAccumulator(parseTimelineQuery(
        new URLSearchParams("hours=24&bucketMinutes=60&metric=total&aggregation=average&grouping=model"),
        Number(avgTimeline.end) * 1000 - 3_600_000,
      ) as Exclude<ReturnType<typeof parseTimelineQuery>, { error: string }>);
      for (const r of [...rows, comboRow, totalMismatchRow]) avgAcc.add(r);
      expect(avgTimeline).toEqual(avgAcc.finish());

      const sumTotalTimeline = await callTimelineRoute("/api/usage/timeline?hours=24&bucketMinutes=60&metric=total&aggregation=sum&grouping=model");
      const sumTotalAcc = createTimelineAccumulator(parseTimelineQuery(
        new URLSearchParams("hours=24&bucketMinutes=60&metric=total&aggregation=sum&grouping=model"),
        Number(sumTotalTimeline.end) * 1000 - 3_600_000,
      ) as Exclude<ReturnType<typeof parseTimelineQuery>, { error: string }>);
      for (const r of [...rows, comboRow, totalMismatchRow]) sumTotalAcc.add(r);
      expect(sumTotalTimeline).toEqual(sumTotalAcc.finish());
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("isPassiveRead performs zero writes, creates, or repairs on SQLite", async () => {
    writeRows([makeRow(0), makeRow(1)]);
    const config = makeConfig();
    await getFilteredUsageAggregate({});
    await callUsageRoute("/api/usage?range=30d&surface=all", config);
    resetUsageAggregateCacheForTests();
    resetUsageSummaryCacheForTests();
    clearApiKeyUsageCacheForTests();

    const fixedTime = new Date("2026-05-01T00:00:00.000Z");
    utimesSync(dbPath(), fixedTime, fixedTime);
    const beforeMtime = statSync(dbPath()).mtimeMs;

    await runPassiveRead(async () => {
      const res = await callUsageRoute("/api/usage?range=30d&surface=all", config);
      expect((res.summary as { requests: number }).requests).toBe(2);
      const facets = await getUsageSourceFacets({ client: "all", device: { kind: "all" } }, ["key-a", "key-b"]);
      expect(facets.devices.find(d => d.device.kind === "all")?.requests).toBe(2);
      const keys = await readApiKeyUsageRollup(["key-a", "key-b"]);
      expect(keys.rollup.get("key-a")).toMatchObject({ totalRequests: 1 });
    });

    expect(statSync(dbPath()).mtimeMs).toBe(beforeMtime);

    // On a read-only missing DB dir or corrupt file during passive read, falls back cleanly with zero DB creation.
    const emptyDir = mkdtempSync(join(tmpdir(), "epx-usage-rollup-passive-"));
    try {
      process.env.EASYPROXY_HOME = emptyDir;
      writeFileSync(join(emptyDir, "usage.jsonl"), `${JSON.stringify(makeRow(0))}\n`);
      chmodSync(emptyDir, 0o555);
      await runPassiveRead(async () => {
        const res = await callUsageRoute("/api/usage?range=30d&surface=all", config);
        expect((res.summary as { requests: number }).requests).toBe(1);
      });
      expect(existsSync(usageFilterIndexPath(emptyDir))).toBe(false);
    } finally {
      chmodSync(emptyDir, 0o755);
      removeTreeWithRetry(emptyDir);
    }
  });
});
