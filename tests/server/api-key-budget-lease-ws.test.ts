import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpxConfig } from "../../src/types";
import { getDefaultConfig, saveConfig } from "../../src/config";
import {
  acquireApiKeyBudgetLease,
  consumeApiKeyBudget,
  flushApiKeyBudgets,
  getApiKeyBudgetSnapshot,
  MAX_TRACKED_API_KEYS,
  peekApiKeyBudgetUsage,
  reloadApiKeyBudgetsFromDiskForTests,
  resetApiKeyBudgetsForTests,
} from "../../src/server/api-key-budget";
import { createAdmittedHttpTurn } from "../../src/server/admitted-http-turn";
import { inboundBodyBudget, MAX_QUEUED_INBOUND_BODIES } from "../../src/server/inbound-body-budget";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { MAX_ACTIVE_TURNS, tryAdmitTurn, type ActiveTurnLease } from "../../src/server/lifecycle";
import {
  addFinalRequestLog,
  clearRequestLogsForTests,
  getRequestLogEntries,
} from "../../src/server/request-log";
import { MAX_CONFIGURABLE_INBOUND_BODY_BYTES, readJsonRequestBody } from "../../src/server/request-decompress";
import type { WsData } from "../../src/server/ws-bridge";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Frame = Record<string, any>;

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
const activeTurnLeases: ActiveTurnLease[] = [];
const openedSockets: Array<ServerWebSocket<WsData>> = [];
const tempDirs: string[] = [];
let savedEnvHome: string | undefined;

function createTempHome(prefix = "epx-budget-ws-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeWsConfig(overrides: Partial<EpxConfig> = {}): EpxConfig {
  return {
    ...getDefaultConfig(),
    port: 0,
    defaultProvider: "gateway",
    websockets: true,
    providers: {
      gateway: {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "upstream-test-key",
        models: ["normal"],
      },
    },
    ...overrides,
  } as EpxConfig;
}

function createMockSocket(
  handler: ReturnType<typeof createWebsocketHandler>,
  keyId: string,
  token = "epx_data_wssecretvalue0001",
): { ws: ServerWebSocket<WsData>; sent: Frame[] } {
  const sent: Frame[] = [];
  const ws = {
    readyState: 1,
    data: {
      headers: new Headers({
        "x-easyproxy-api-key": token,
        "thread-id": `thread-${keyId}`,
        session_id: `session-${keyId}`,
      }),
      admission: { kind: "configured", keyId, principalId: `key:${keyId}` },
    } as WsData,
    send(payload: string) {
      sent.push(JSON.parse(payload));
      return 1;
    },
    close() {
      handler.close(ws, 1000, "closed");
    },
  } as unknown as ServerWebSocket<WsData>;
  openedSockets.push(ws);
  return { ws, sent };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function sseCompletedBody(totalTokens: number, id = "resp_budget_1"): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [],
        usage: { input_tokens: Math.floor(totalTokens / 2), output_tokens: totalTokens - Math.floor(totalTokens / 2), total_tokens: totalTokens },
      },
    })}\n\n`,
  ];
  return new ReadableStream({
    start(controller) {
      for (const chunk of events) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

beforeEach(() => {
  savedEnvHome = process.env.EASYPROXY_HOME;
  clearRequestLogsForTests();
  resetApiKeyBudgetsForTests();
});

afterEach(async () => {
  for (const ws of openedSockets.splice(0)) {
    try { ws.close(); } catch { /* ignore */ }
  }
  for (const lease of activeTurnLeases.splice(0)) {
    try { lease.release(); } catch { /* ignore */ }
  }
  await Bun.sleep(10);
  globalThis.fetch = originalFetch;
  if (releaseSpendHome) {
    releaseSpendHome();
    releaseSpendHome = undefined;
  }
  resetApiKeyBudgetsForTests();
  clearRequestLogsForTests();
  if (savedEnvHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = savedEnvHome;
  for (const dir of tempDirs.splice(0)) {
    removeTreeWithRetry(dir);
  }
});

describe("api-key-budget lease, rollback, persistence, and WS enforcement", () => {
  test("prevents dailyTokenLimit TOCTOU bypass across concurrent streaming leases and settles once", () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const entry = { id: "key-concurrent", rpmLimit: 50, maxDailyRequests: 50, dailyTokenLimit: 1_000 };

    // First streaming turn reserves 600 tokens; remaining unreserved is 400.
    const lease1 = acquireApiKeyBudgetLease(entry, { reserveTokens: 600, now });
    expect(lease1.allowed).toBe(true);

    // Second concurrent streaming turn reserves another 600 tokens (0 + 600 < 1000 so admitted, bringing hold to 1200).
    const lease2 = acquireApiKeyBudgetLease(entry, { reserveTokens: 600, now: now + 10 });
    expect(lease2.allowed).toBe(true);

    // Third concurrent streaming turn observes dailyTokens + inFlightReservedTokens (1200 >= 1000) and is denied before starting.
    const denied = acquireApiKeyBudgetLease(entry, { reserveTokens: 1, now: now + 20 });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe("daily_token_limit_exceeded");

    // Settling lease1 with actual usage 300 releases its 600 hold and credits 300 actual tokens once.
    if (lease1.allowed) {
      lease1.lease.settleTokens(300, now + 50);
      lease1.lease.settleTokens(999, now + 60); // idempotent no-op
    }
    if (lease2.allowed) {
      // Interleaved second settlement runs with actual 250 -> total 550 < 1000, reopening capacity cleanly.
      lease2.lease.settleTokens(250, now + 70);
    }

    expect(getApiKeyBudgetSnapshot("key-concurrent", now + 80)).toEqual({
      rpmCurrent: 2,
      dailyRequestsUsed: 2,
      dailyTokensUsed: 550,
    });
    const reopened = acquireApiKeyBudgetLease(entry, { reserveTokens: 1, now: now + 90 });
    expect(reopened.allowed).toBe(true);
    if (reopened.allowed) reopened.lease.releaseUnused();
  });

  test("rolls back HTTP request budget on 503 server_busy and 413/400 body decode rejection without double-counting", async () => {
    const policy = {
      ...getDefaultConfig(),
      apiKeys: [{
        id: "key-rollback-http",
        name: "rollback",
        key: "epx_data_rollbacksecret0001",
        createdAt: "2026-11-22T00:00:00.000Z",
        rpmLimit: 2,
        maxDailyRequests: 2,
        dailyTokenLimit: 1_000,
      }],
    };
    const run = createAdmittedHttpTurn(
      () => MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
      () => new Response("busy", { status: 503 }),
    );
    const makeReq = (body: string) => new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "x-easyproxy-api-key": "epx_data_rollbacksecret0001" },
      body,
    });

    // 1. Saturate active turn slots -> 503 server_busy must roll back RPM, dailyCount, and reserved hold.
    for (let i = 0; i < MAX_ACTIVE_TURNS; i += 1) {
      const lease = tryAdmitTurn();
      if (!lease) throw new Error("expected turn slot");
      activeTurnLeases.push(lease);
    }
    const busyRes = await run(makeReq("{}"), policy, async () => new Response("ok"), {
      requestId: "req-503",
      start: Date.now(),
      logCtx: { model: "unknown", provider: "unknown", apiKeyId: "key-rollback-http" },
    });
    expect(busyRes.status).toBe(503);
    await busyRes.text();
    expect(getApiKeyBudgetSnapshot("key-rollback-http")).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 0,
      dailyTokensUsed: 0,
    });
    for (const lease of activeTurnLeases.splice(0)) lease.release();

    // 2. Handler runs, parses body with readJsonRequestBody, hits 413 -> rejected body rolls back budget cleanly.
    const smallLimitRun = createAdmittedHttpTurn(() => 64, () => new Response("busy", { status: 503 }));
    const logCtx413 = { model: "unknown", provider: "unknown", apiKeyId: "key-rollback-http" };
    const start413 = Date.now();
    const oversizedReq = makeReq(JSON.stringify({ input: "x".repeat(200) }));
    const tooLargeRes = await smallLimitRun(oversizedReq, policy, async () => {
      try {
        await readJsonRequestBody(oversizedReq, undefined, 64);
      } catch {
        addFinalRequestLog("req-413", start413, logCtx413, 413);
        return Response.json({ error: { type: "invalid_request_error", code: "inbound_body_too_large" } }, { status: 413 });
      }
      return new Response("unexpected", { status: 500 });
    }, { requestId: "req-413", start: start413, logCtx: logCtx413 });
    expect(tooLargeRes.status).toBe(413);
    await tooLargeRes.text();
    expect(getApiKeyBudgetSnapshot("key-rollback-http")).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 0,
      dailyTokensUsed: 0,
    });

    // 3. Normal completion settles tokens ONCE via addFinalRequestLog (never double-counted).
    const okStart = Date.now();
    const okLogCtx: Record<string, any> = {
      model: "gateway/normal",
      provider: "gateway",
      apiKeyId: "key-rollback-http",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    };
    const okRes = await run(makeReq("{}"), policy, async () => {
      addFinalRequestLog("req-ok", okStart, okLogCtx as any, 200);
      return new Response("ok", { status: 200 });
    }, { requestId: "req-ok", start: okStart, logCtx: okLogCtx as any });
    try {
      expect(okRes.status).toBe(200);
      await okRes.text();
      expect(getApiKeyBudgetSnapshot("key-rollback-http", okStart)).toEqual({
        rpmCurrent: 1,
        dailyRequestsUsed: 1,
        dailyTokensUsed: 150,
      });
    } finally {
      await okRes.body?.cancel().catch(() => undefined);
    }
  });

  test("persists UTC-day counters atomically (0o600) per EASYPROXY_HOME and survives reload + LRU eviction", () => {
    const homeA = createTempHome("epx-budget-home-a-");
    const homeB = createTempHome("epx-budget-home-b-");
    const t0 = Date.UTC(2026, 10, 22, 10, 0, 0);

    process.env.EASYPROXY_HOME = homeA;
    saveConfig(getDefaultConfig());
    const lease = acquireApiKeyBudgetLease({ id: "hot-key", maxDailyRequests: 50, dailyTokenLimit: 10_000 }, { now: t0 });
    expect(lease.allowed).toBe(true);
    if (lease.allowed) lease.lease.settleTokens(1_234, t0);

    // Overflow LRU beyond MAX_TRACKED_API_KEYS (1,024): hot-key moves out of hot ring cache into archived ledger.
    for (let i = 0; i < MAX_TRACKED_API_KEYS + 8; i += 1) {
      expect(consumeApiKeyBudget({ id: `flood-${i}`, maxDailyRequests: 5, rpmLimit: 5 }, t0)).toEqual({ allowed: true });
    }
    flushApiKeyBudgets();

    const ledgerPath = join(homeA, "api-key-budgets.json");
    expect(existsSync(ledgerPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    }
    const rawLedger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { version: number; keys: Record<string, { dailyCount: number; dailyTokens: number }> };
    expect(rawLedger.version).toBe(1);
    expect(rawLedger.keys["hot-key"]).toMatchObject({ dailyCount: 1, dailyTokens: 1_234 });

    // Switching config dir isolates stores completely.
    process.env.EASYPROXY_HOME = homeB;
    expect(getApiKeyBudgetSnapshot("hot-key", t0)).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 0,
      dailyTokensUsed: 0,
    });

    // Simulated restart in homeA hydrates dailyCount & dailyTokens (even keys evicted past 1,024!).
    process.env.EASYPROXY_HOME = homeA;
    reloadApiKeyBudgetsFromDiskForTests();
    expect(getApiKeyBudgetSnapshot("hot-key", t0)).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 1,
      dailyTokensUsed: 1_234,
    });
    expect(peekApiKeyBudgetUsage("flood-0", t0)).toEqual({ minuteCount: 0, dailyCount: 1 });
  });

  test("WS /v1/responses enforces rpmLimit, maxDailyRequests, dailyTokenLimit reservation, pre-parse bounds, and 503 rollback", async () => {
    const home = createTempHome("epx-ws-budget-");
    process.env.EASYPROXY_HOME = home;
    releaseSpendHome ??= acquireOwnedSpendHome();

    let upstreamRelease: (() => void) | undefined;
    let upstreamStarted = false;
    globalThis.fetch = (async () => {
      upstreamStarted = true;
      await new Promise<void>(resolve => { upstreamRelease = resolve; });
      return new Response(sseCompletedBody(250), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const cfg = makeWsConfig({
      maxInboundBodyBytes: 1_024,
      apiKeys: [{
        id: "key-ws-1",
        name: "ws-client",
        key: "epx_data_wssecretvalue0001",
        createdAt: "2026-11-22T00:00:00.000Z",
        rpmLimit: 2,
        maxDailyRequests: 2,
        dailyTokenLimit: 100,
      }],
    });
    saveConfig(cfg);
    const handler = createWebsocketHandler({ config: cfg, deps: {} } as ServeOptionsContext);

    // 1. Pre-parse JSON depth > 256 and oversized WS frame are rejected BEFORE JSON.parse or budget debit.
    const guardClient = createMockSocket(handler, "key-ws-1");
    handler.message(guardClient.ws, "[".repeat(257) + "]".repeat(257));
    expect(guardClient.sent.at(-1)?.error?.code).toBe("json_nesting_depth_exceeded");
    expect(guardClient.sent.at(-1)?.status).toBe(400);

    handler.message(guardClient.ws, JSON.stringify({ type: "response.create", model: "gateway/normal", input: "a".repeat(1024 * 1024 + 512) }));
    expect(guardClient.sent.at(-1)?.error?.code).toBe("inbound_body_too_large");
    expect(guardClient.sent.at(-1)?.status).toBe(413);
    expect(getApiKeyBudgetSnapshot("key-ws-1")).toEqual({ rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0 });

    // 2. Concurrent in-flight WS response.create holds 1 token out of dailyTokenLimit: 1 -> second parallel WS frame is rejected BEFORE first finishes!
    const cfgTok = makeWsConfig({
      apiKeys: [{
        id: "key-ws-tok",
        name: "ws-tok",
        key: "epx_data_wssecretvalue0003",
        createdAt: "2026-11-22T00:00:00.000Z",
        rpmLimit: 5,
        maxDailyRequests: 5,
        dailyTokenLimit: 1,
      }],
    });
    saveConfig(cfgTok);
    const handlerTok = createWebsocketHandler({ config: cfgTok, deps: {} } as ServeOptionsContext);
    const c1 = createMockSocket(handlerTok, "key-ws-tok", "epx_data_wssecretvalue0003");
    handlerTok.message(c1.ws, JSON.stringify({ type: "response.create", model: "gateway/normal", input: "hello" }));
    await waitFor(() => upstreamStarted, "first WS upstream started");

    // While c1 is mid-stream, c2 arrives concurrently -> held inFlightReservedTokens (1 >= dailyTokenLimit 1) blocks TOCTOU bypass!
    const c2 = createMockSocket(handlerTok, "key-ws-tok", "epx_data_wssecretvalue0003");
    handlerTok.message(c2.ws, JSON.stringify({ type: "response.create", model: "gateway/normal", input: "blocked-concurrent" }));
    expect(c2.sent.length).toBe(1);
    expect(c2.sent[0]).toMatchObject({
      type: "error",
      status: 429,
      error: { type: "rate_limit_error", code: "daily_token_limit_exceeded" },
    });
    expect(Number(c2.sent[0]?.headers?.["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(getRequestLogEntries().some(e =>
      e.status === 429
      && e.localTerminalReason === "daily_token_limit_exceeded"
      && e.errorCode === "rate_limit_exceeded")).toBe(true);

    upstreamRelease?.();
    await waitFor(() => c1.sent.some(f => f.type === "response.completed"), "first WS response.completed");
    expect(getApiKeyBudgetSnapshot("key-ws-tok").dailyTokensUsed).toBe(250);

    // 3. RPM & 503 server_busy rollback on WS key.
    resetApiKeyBudgetsForTests();
    clearRequestLogsForTests();
    const cfgRpm = makeWsConfig({
      apiKeys: [{
        id: "key-ws-rpm",
        name: "ws-rpm",
        key: "epx_data_wssecretvalue0002",
        createdAt: "2026-11-22T00:00:00.000Z",
        rpmLimit: 1,
        maxDailyRequests: 5,
      }],
    });
    saveConfig(cfgRpm);
    const handlerRpm = createWebsocketHandler({ config: cfgRpm, deps: {} } as ServeOptionsContext);
    for (let i = 0; i < MAX_ACTIVE_TURNS; i += 1) {
      const lease = tryAdmitTurn();
      if (!lease) throw new Error("expected turn slot");
      activeTurnLeases.push(lease);
    }
    const busyWs = createMockSocket(handlerRpm, "key-ws-rpm", "epx_data_wssecretvalue0002");
    handlerRpm.message(busyWs.ws, JSON.stringify({ type: "response.create", model: "gateway/normal", input: "busy" }));
    expect(busyWs.sent[0]).toMatchObject({ type: "error", status: 503, error: { code: "server_busy" } });
    // Rolled back cleanly -> quota still 0 used!
    expect(getApiKeyBudgetSnapshot("key-ws-rpm")).toEqual({ rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0 });
    for (const lease of activeTurnLeases.splice(0)) lease.release();

    // Now admit one real turn and verify next hits 429 rpm_limit_exceeded.
    globalThis.fetch = (async () => new Response(sseCompletedBody(40, "resp_rpm_1"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
    const okWs = createMockSocket(handlerRpm, "key-ws-rpm", "epx_data_wssecretvalue0002");
    handlerRpm.message(okWs.ws, JSON.stringify({ type: "response.create", model: "gateway/normal", input: "ok" }));
    await waitFor(() => okWs.sent.some(f => f.type === "response.completed"), "rpm WS completed");

    const deniedWs = createMockSocket(handlerRpm, "key-ws-rpm", "epx_data_wssecretvalue0002");
    handlerRpm.message(deniedWs.ws, JSON.stringify({ type: "response.create", model: "gateway/normal", input: "over" }));
    expect(deniedWs.sent[0]).toMatchObject({
      type: "error",
      status: 429,
      error: { type: "rate_limit_error", code: "rpm_limit_exceeded" },
    });
  });

  test("rolls back HTTP budget on pre-handler inboundBodyBudget 503 and replaces symlink ledger no-follow", async () => {
    const policy = {
      ...getDefaultConfig(),
      apiKeys: [{
        id: "key-body-busy",
        name: "body-busy",
        key: "epx_data_bodybusysecret01",
        createdAt: "2026-11-22T00:00:00.000Z",
        rpmLimit: 2,
        maxDailyRequests: 2,
        dailyTokenLimit: 500,
      }],
    };
    const run = createAdmittedHttpTurn(
      () => MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
      () => new Response("busy", { status: 503 }),
    );
    const bodyBusyStart = Date.now();
    const bodyBusyLogCtx = { model: "unknown", provider: "unknown", apiKeyId: "key-body-busy" };
    const satCtrl = new AbortController();
    const heldLease = await inboundBodyBudget.acquire(inboundBodyBudget.capacity(), satCtrl.signal, 100);
    expect(heldLease).not.toBeNull();
    const queuedWaiters: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_QUEUED_INBOUND_BODIES; i += 1) {
      queuedWaiters.push(inboundBodyBudget.acquire(1, satCtrl.signal, 5_000).catch(() => null));
    }
    try {
      const gzipReq = new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "x-easyproxy-api-key": "epx_data_bodybusysecret01",
          "content-encoding": "gzip",
          "content-length": "100",
        },
        body: new Uint8Array(100),
      });
      const res = await run(gzipReq, policy, async () => {
        throw new Error("handler must not enter when inboundBodyBudget is exhausted");
      }, { requestId: "req-body-busy-503", start: bodyBusyStart, logCtx: bodyBusyLogCtx });
      expect(res.status).toBe(503);
      await res.text();
    } finally {
      satCtrl.abort();
      heldLease?.release();
      await Promise.allSettled(queuedWaiters);
    }
    expect(getApiKeyBudgetSnapshot("key-body-busy", bodyBusyStart)).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 0,
      dailyTokensUsed: 0,
    });

    if (process.platform !== "win32") {
      const symHome = createTempHome("epx-budget-symlink-home-");
      const outsideTarget = join(createTempHome("epx-budget-outside-"), "sentinel.txt");
      writeFileSync(outsideTarget, "DO_NOT_OVERWRITE", "utf8");
      const symLedger = join(symHome, "api-key-budgets.json");
      symlinkSync(outsideTarget, symLedger);

      process.env.EASYPROXY_HOME = symHome;
      const lease = acquireApiKeyBudgetLease({ id: "sym-key", maxDailyRequests: 10 }, { now: bodyBusyStart });
      expect(lease.allowed).toBe(true);
      if (lease.allowed) lease.lease.settleTokens(10, bodyBusyStart);
      flushApiKeyBudgets();

      expect(readFileSync(outsideTarget, "utf8")).toBe("DO_NOT_OVERWRITE");
      expect(lstatSync(symLedger).isSymbolicLink()).toBe(false);
    }
  });
});
