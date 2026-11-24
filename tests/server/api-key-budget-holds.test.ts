import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccessCommand } from "../../src/cli/access";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import {
  acquireApiKeyBudgetLease,
  consumeApiKeyBudget,
  getApiKeyBudgetHoldSnapshot,
  resetApiKeyBudgetsForTests,
} from "../../src/server/api-key-budget";
import { isApiKeyExpired, resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { createAdmittedHttpTurn } from "../../src/server/admitted-http-turn";
import { reservePreDispatchApiKeyHold } from "../../src/server/api-key-budget-estimate";
import { handleManagementAPI } from "../../src/server/management-api";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../../src/server/request-decompress";
import type { EpxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { settleServerAuthFixture, startManagementServerFixture } from "../helpers/server-auth-fixture";

describe("virtual API key expiry, TPM window, and in-flight USD holds", () => {
  const homes: string[] = [];
  const origHome = process.env.EASYPROXY_HOME;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "epx-key-holds-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;
    resetApiKeyBudgetsForTests();
    clearRequestLogsForTests();
  });

  afterEach(async () => {
    resetApiKeyBudgetsForTests();
    clearRequestLogsForTests();
    if (origHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = origHome;
    while (homes.length > 0) removeTreeWithRetry(homes.pop()!);
  });

  test("enforces expiresAt fail-closed across helper, data-plane admission, and live HTTP routes", async () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);
    expect(isApiKeyExpired({ expiresAt: "2026-11-24T11:59:59Z" }, now)).toBe(true);
    expect(isApiKeyExpired({ expiresAt: "not-a-timestamp" }, now)).toBe(true);
    expect(isApiKeyExpired({ expiresAt: "2026-11-24T12:00:01Z" }, now)).toBe(false);
    expect(isApiKeyExpired({}, now)).toBe(false);

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      apiKeys: [
        {
          id: "k-expired",
          name: "expired-key",
          key: "epx_data_expiredkey0000001",
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2026-11-24T11:00:00Z",
        },
        {
          id: "k-corrupt",
          name: "corrupt-expiry",
          key: "epx_data_corruptkey0000001",
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "invalid-date-format",
        },
        {
          id: "k-active",
          name: "active-key",
          key: "epx_data_activekey00000001",
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
    };

    const expiredPolicy = { hostname: cfg.hostname, apiKeys: cfg.apiKeys };
    const { resolveApiAuth, resolveResponsesApiAuth } = await import("../../src/server/auth-cors");

    const expiredReq = new Request("http://example.test/v1/responses", {
      headers: { "x-easyproxy-api-key": "epx_data_expiredkey0000001" },
    });
    expect(resolveResponsesApiAuth(expiredReq, expiredPolicy)).toBeNull();
    expect(resolveDataPlaneAdmissionSecret("epx_data_expiredkey0000001", cfg, "dedicated", { now })).toBeNull();

    const corruptToken = ["epx_data_", "corruptkey0000001"].join("");
    const corruptReq = new Request("http://example.test/v1/chat/completions", {
      headers: { authorization: `Bearer ${corruptToken}` },
    });
    expect(resolveResponsesApiAuth(corruptReq, expiredPolicy)).toBeNull();
    expect(resolveDataPlaneAdmissionSecret(corruptToken, cfg, "bearer", { now })).toBeNull();

    const activeReq = new Request("http://example.test/v1/messages", {
      headers: { "x-api-key": "epx_data_activekey00000001" },
    });
    expect(resolveApiAuth(activeReq, expiredPolicy)).toMatchObject({
      kind: "configured",
      keyId: "k-active",
    });
    expect(resolveDataPlaneAdmissionSecret("epx_data_activekey00000001", cfg, "x-api-key", { now })).toMatchObject({
      kind: "configured",
      keyId: "k-active",
    });

    // Live server check across /v1/responses, /v1/chat/completions, /v1/messages for expired key -> 401.
    const serverHome = mkdtempSync(join(tmpdir(), "epx-key-expiry-srv-"));
    homes.push(serverHome);
    const fixture = await startManagementServerFixture(serverHome, {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      apiKeys: [
        {
          id: "k-exp-live",
          name: "expired-live",
          key: "epx_data_expiredlivekey001",
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2020-01-01T00:00:00Z",
        },
      ],
    });
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      for (const path of ["/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/embeddings"]) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-easyproxy-api-key": "epx_data_expiredlivekey001",
            "x-api-key": "epx_data_expiredlivekey001",
          },
          body: "{}",
        });
        expect(res.status).toBe(401);
      }
    } finally {
      await fixture.close();
      await settleServerAuthFixture(serverHome);
    }
  });

  test("enforces sliding 60s tpmLimit with Retry-After recovery", () => {
    const t0 = Date.UTC(2026, 10, 24, 15, 0, 0);
    const entry = { id: "key-tpm", tpmLimit: 1_000 };

    const first = acquireApiKeyBudgetLease(entry, { now: t0 });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(first.lease.reserveHold(entry, { tokens: 700, now: t0 })).toEqual({ allowed: true });

    // Concurrent second request asking for 400 tokens pushes 700 + 400 = 1100 > 1000.
    const second = acquireApiKeyBudgetLease(entry, { now: t0 + 1_000 });
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;
    const deniedHold = second.lease.reserveHold(entry, { tokens: 400, now: t0 + 1_000 });
    expect(deniedHold.allowed).toBe(false);
    if (!deniedHold.allowed) {
      expect(deniedHold.reason).toBe("tpm_limit_exceeded");
      expect(deniedHold.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
    second.lease.releaseUnused();

    // Settle first turn at 900 actual tokens; tpmCurrent becomes 900.
    first.lease.settleTokens(900, t0 + 2_000);
    expect(getApiKeyBudgetHoldSnapshot("key-tpm", t0 + 2_000).tpmCurrent).toBe(900);

    // Next request asking for 200 tokens is rejected (900 + 200 > 1000).
    const third = acquireApiKeyBudgetLease(entry, { now: t0 + 5_000 });
    expect(third.allowed).toBe(true);
    if (!third.allowed) return;
    const thirdDenied = third.lease.reserveHold(entry, { tokens: 200, now: t0 + 5_000 });
    expect(thirdDenied.allowed).toBe(false);
    if (!thirdDenied.allowed) {
      expect(thirdDenied.reason).toBe("tpm_limit_exceeded");
    }
    third.lease.releaseUnused();

    // Even a new admission with already-full TPM >= limit fails closed before reservation.
    const fullTurn = acquireApiKeyBudgetLease(entry, { now: t0 + 5_000 });
    expect(fullTurn.allowed).toBe(true);
    if (fullTurn.allowed) {
      expect(fullTurn.lease.reserveHold(entry, { tokens: 101, now: t0 + 5_000 }).allowed).toBe(false);
      fullTurn.lease.releaseUnused();
    }

    // Consume the remaining 100 tokens -> 1000/1000 reached; subsequent consumeApiKeyBudget blocks until window expires.
    const exactFit = acquireApiKeyBudgetLease(entry, { now: t0 + 10_000 });
    expect(exactFit.allowed).toBe(true);
    if (exactFit.allowed) {
      expect(exactFit.lease.reserveHold(entry, { tokens: 100, now: t0 + 10_000 })).toEqual({ allowed: true });
      exactFit.lease.settleTokens(100, t0 + 10_000);
    }
    const blockedAtStart = consumeApiKeyBudget(entry, t0 + 20_000);
    expect(blockedAtStart.allowed).toBe(false);
    if (!blockedAtStart.allowed) {
      expect(blockedAtStart.reason).toBe("tpm_limit_exceeded");
      expect(blockedAtStart.retryAfterSec).toBeGreaterThanOrEqual(30);
    }

    // After 60 seconds past t0+10_000, the sliding window drops to 0 and requests succeed again.
    expect(consumeApiKeyBudget(entry, t0 + 71_000)).toEqual({ allowed: true });
  });

  test("reserves concurrent in-flight USD holds, rejects overflow 429, settles partial spend, and cleans up cancelled holds", async () => {
    const t0 = Date.UTC(2026, 10, 24, 16, 0, 0);
    const entry = {
      id: "k-inflight",
      maxInFlightCostUsd: 0.1,
      dailyCostLimitUsd: 0.15,
    };

    const lease1 = acquireApiKeyBudgetLease(entry, { now: t0 });
    expect(lease1.allowed).toBe(true);
    if (!lease1.allowed) return;
    expect(lease1.lease.reserveHold(entry, { costUsd: 0.08, now: t0 })).toEqual({ allowed: true });
    expect(getApiKeyBudgetHoldSnapshot("k-inflight", t0).inFlightCostUsdUsed).toBeCloseTo(0.08, 6);

    // Concurrent lease2 requesting $0.05 exceeds maxInFlightCostUsd ($0.08 + $0.05 > $0.10).
    const lease2 = acquireApiKeyBudgetLease(entry, { now: t0 + 100 });
    expect(lease2.allowed).toBe(true);
    if (!lease2.allowed) return;
    const holdFail = lease2.lease.reserveHold(entry, { costUsd: 0.05, now: t0 + 100 });
    expect(holdFail).toEqual({
      allowed: false,
      reason: "in_flight_cost_limit_exceeded",
      retryAfterSec: 1,
    });
    lease2.lease.releaseUnused();

    // Settling lease1 at $0.02 releases the remaining $0.06 unused hold immediately.
    lease1.lease.settleCostUsd(0.02, t0 + 500);
    expect(getApiKeyBudgetHoldSnapshot("k-inflight", t0 + 500).inFlightCostUsdUsed).toBe(0);

    // Now test dailyCostLimitUsd enforcement under concurrent hold when maxInFlightCostUsd allows more headroom.
    const dailyCapEntry = {
      id: "k-inflight",
      maxInFlightCostUsd: 0.25,
      dailyCostLimitUsd: 0.12,
    };
    // Now $0.10 daily room remains ($0.12 - $0.02), and $0.08 concurrent hold is allowed.
    const lease3 = acquireApiKeyBudgetLease(dailyCapEntry, { now: t0 + 600 });
    expect(lease3.allowed).toBe(true);
    if (!lease3.allowed) return;
    expect(lease3.lease.reserveHold(dailyCapEntry, { costUsd: 0.08, now: t0 + 600 })).toEqual({ allowed: true });

    // Concurrent lease4 requesting $0.05 leaves insufficient daily room ($0.02 settled + $0.08 held = $0.10 used -> $0.02 left < $0.05) while in-flight total ($0.13) is still below $0.25.
    const lease4 = acquireApiKeyBudgetLease(dailyCapEntry, { now: t0 + 700 });
    expect(lease4.allowed).toBe(true);
    if (!lease4.allowed) return;
    const dailyHoldFail = lease4.lease.reserveHold(dailyCapEntry, { costUsd: 0.05, now: t0 + 700 });
    expect(dailyHoldFail.allowed).toBe(false);
    if (!dailyHoldFail.allowed) {
      expect(dailyHoldFail.reason).toBe("daily_cost_limit_exceeded");
    }
    lease4.lease.releaseUnused();

    // Cancelling lease3 via releaseHoldOnly() returns inFlightCostUsdUsed back to 0 cleanly.
    lease3.lease.releaseHoldOnly();
    expect(getApiKeyBudgetHoldSnapshot("k-inflight", t0 + 800).inFlightCostUsdUsed).toBe(0);

    // Verify pre-dispatch HTTP turn integration via createAdmittedHttpTurn + reservePreDispatchApiKeyHold across protocols.
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      apiKeys: [
        {
          id: "k-http-hold",
          name: "http-hold",
          key: "epx_data_httphold0000001",
          createdAt: "2026-01-01T00:00:00Z",
          maxInFlightCostUsd: 0.00015,
        },
      ],
    };
    const run = createAdmittedHttpTurn(
      () => MAX_DECOMPRESSED_BODY_BYTES,
      () => new Response("busy", { status: 503 }),
    );
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstHolding = new Promise<void>((resolve) => { firstStarted = resolve; });

    const req1 = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "x-easyproxy-api-key": "epx_data_httphold0000001" },
      body: JSON.stringify({ model: "custom/unpriced", input: "hello" }),
    });
    const logCtx1: any = { model: "custom/unpriced", provider: "custom", apiKeyId: "k-http-hold" };
    const turn1 = run(req1, cfg, async () => {
      const blocked = await reservePreDispatchApiKeyHold({
        req: req1,
        config: cfg,
        logCtx: logCtx1,
        providerName: "custom",
        modelId: "unpriced",
        estimatedInputTokens: 100,
      });
      expect(blocked).toBeNull();
      firstStarted();
      await firstDone;
      return new Response("ok", { status: 200 });
    }, { requestId: "hold-1", start: Date.now(), logCtx: logCtx1 });

    await firstHolding;
    // While req1 is in-flight holding $0.0001, concurrent req2 (Messages surface) holding another $0.0001 hits 429 in_flight_cost_limit_exceeded!
    const req2 = new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "epx_data_httphold0000001" },
      body: JSON.stringify({ model: "custom/unpriced", messages: [{ role: "user", content: "hi" }] }),
    });
    const logCtx2: any = { model: "custom/unpriced", provider: "custom", apiKeyId: "k-http-hold" };
    const turn2 = await run(req2, cfg, async () => {
      const refusal = await reservePreDispatchApiKeyHold({
        req: req2,
        config: cfg,
        logCtx: logCtx2,
        providerName: "custom",
        modelId: "unpriced",
        estimatedInputTokens: 100,
        anthropicSurface: true,
      });
      expect(refusal).not.toBeNull();
      return refusal!;
    }, { requestId: "hold-2", start: Date.now(), logCtx: logCtx2 });

    expect(turn2.status).toBe(429);
    expect(Number(turn2.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const turn2Body = await turn2.json() as Record<string, unknown>;
    expect(JSON.stringify(turn2Body)).toContain("rate_limit_error");

    releaseFirst();
    const res1 = await turn1;
    expect(res1.status).toBe(200);
    // Once turn1 exited, its active lease released the hold so a fresh turn3 passes cleanly.
    expect(getApiKeyBudgetHoldSnapshot("k-http-hold").inFlightCostUsdUsed).toBe(0);
  });

  test("management /api/keys and CLI epx access key set manage tpmLimit, maxInFlightCostUsd, and expiresAt", async () => {
    const config = getDefaultConfig();
    saveConfig(config);

    // POST /api/keys with budget limits & future expiry
    const createReq = new ManagementRequest("http://127.0.0.1/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "quota-key",
        tpmLimit: 50_000,
        maxInFlightCostUsd: 2.5,
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    });
    const createRes = (await handleManagementAPI(createReq, new URL(createReq.url), config))!;
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as Record<string, unknown>;
    expect(created.tpmLimit).toBe(50_000);
    expect(created.maxInFlightCostUsd).toBe(2.5);
    expect(created.expiresAt).toBe("2030-01-01T00:00:00Z");
    expect(created.expired).toBe(false);
    expect(typeof created.key).toBe("string");
    const keyId = String(created.id);

    // GET /api/keys immediately reflects the newly created budget/expiry fields on persisted config.
    const getCreatedReq = new ManagementRequest("http://127.0.0.1/api/keys", { method: "GET" });
    const getCreatedRes = (await handleManagementAPI(getCreatedReq, new URL(getCreatedReq.url), config))!;
    expect(getCreatedRes.status).toBe(200);
    const getCreatedBody = await getCreatedRes.json() as { keys: Array<Record<string, unknown>> };
    expect(getCreatedBody.keys.find(k => k.id === keyId)).toMatchObject({
      tpmLimit: 50_000,
      maxInFlightCostUsd: 2.5,
      expiresAt: "2030-01-01T00:00:00Z",
      expired: false,
    });

    // Reject invalid expiresAt and out-of-range limits fail-closed (400)
    const badReq = new ManagementRequest("http://127.0.0.1/api/keys", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: keyId,
        expiresAt: "tomorrow",
      }),
    });
    const badRes = (await handleManagementAPI(badReq, new URL(badReq.url), config))!;
    expect(badRes.status).toBe(400);

    // CLI `epx access key set` sends PATCH with exact fields and clears with "none"
    const patchPayloads: Array<Record<string, unknown>> = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/keys") && (!init?.method || init.method === "GET")) {
        const req = new ManagementRequest(url, { method: "GET" });
        return (await handleManagementAPI(req, new URL(url), config))!;
      }
      if (url.endsWith("/api/keys") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchPayloads.push(body);
        const req = new ManagementRequest(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return (await handleManagementAPI(req, new URL(url), config))!;
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const deps = { baseUrl: "http://127.0.0.1", fetchImpl: mockFetch };
    expect(await handleAccessCommand([
      "key", "set", "quota-key",
      "--tpm-limit", "90000",
      "--max-in-flight-cost-usd", "1.25",
      "--expires-at", "2032-06-01T00:00:00Z",
      "--json",
    ], deps)).toBe(0);
    expect(patchPayloads.at(-1)).toMatchObject({
      id: keyId,
      tpmLimit: 90_000,
      maxInFlightCostUsd: 1.25,
      expiresAt: "2032-06-01T00:00:00Z",
    });

    // Clear fields via "none"
    expect(await handleAccessCommand([
      "key", "set", keyId,
      "--tpm-limit", "none",
      "--max-in-flight-cost-usd", "none",
      "--expires-at", "none",
      "--json",
    ], deps)).toBe(0);
    expect(patchPayloads.at(-1)).toEqual({
      id: keyId,
      tpmLimit: null,
      maxInFlightCostUsd: null,
      expiresAt: null,
    });
    const persisted = loadConfig().apiKeys?.find(k => k.id === keyId);
    expect(persisted?.tpmLimit).toBeUndefined();
    expect(persisted?.maxInFlightCostUsd).toBeUndefined();
    expect(persisted?.expiresAt).toBeUndefined();
  });

  test("pre-dispatch hold refusal rolls back RPM and dailyCount, and clamps lone turn against dailyTokenLimit alongside tpmLimit", async () => {
    const now = Date.UTC(2026, 10, 24, 15, 0, 0);
    const tpmKey = {
      id: "k-rollback",
      name: "rollback",
      key: "epx_data_rollback00000001",
      createdAt: "2026-01-01T00:00:00Z",
      rpmLimit: 2,
      maxDailyRequests: 2,
      tpmLimit: 100,
    };
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      apiKeys: [tpmKey],
    };
    const runAdmitted = createAdmittedHttpTurn(
      () => MAX_DECOMPRESSED_BODY_BYTES,
      () => Response.json({ error: "busy" }, { status: 503 }),
    );

    const logCtx: { model: string; provider: string; apiKeyId?: string; apiKeyBudgetLease?: unknown } = {
      model: "p/m",
      provider: "p",
      apiKeyId: tpmKey.id,
    };
    const res429 = await runAdmitted(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "x-easyproxy-api-key": tpmKey.key, "content-type": "application/json" },
        body: JSON.stringify({ model: "p/m", input: "x".repeat(2000) }),
      }),
      cfg,
      async () => {
        const refusal = await reservePreDispatchApiKeyHold({
          req: new Request("http://127.0.0.1/v1/responses", { method: "POST" }),
          config: cfg,
          logCtx: logCtx as never,
          providerName: "p",
          modelId: "m",
          estimatedInputTokens: 500,
          maxOutputTokens: 0,
        });
        expect(refusal?.status).toBe(429);
        return refusal!;
      },
      { requestId: "req-rb-1", start: now, logCtx: logCtx as never },
    );
    expect(res429.status).toBe(429);
    const snapAfterRefusal = getApiKeyBudgetHoldSnapshot(tpmKey.id, now);
    expect(snapAfterRefusal.rpmCurrent).toBe(0);
    expect(snapAfterRefusal.dailyRequestsUsed).toBe(0);
    expect(snapAfterRefusal.inFlightTokens).toBe(0);

    // Lone turn clamps to remaining dailyTokenLimit even when tpmLimit is also set.
    const comboEntry = {
      id: "k-clamp",
      name: "clamp",
      key: "epx_data_clamp0000000001",
      createdAt: "2026-01-01T00:00:00Z",
      tpmLimit: 500,
      dailyTokenLimit: 10,
    };
    const first = acquireApiKeyBudgetLease(comboEntry, { now, reserveTokens: 1 });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(first.lease.reserveHold(comboEntry, { tokens: 80, costUsd: 0, now })).toEqual({ allowed: true });
    expect(first.lease.reservedTokens).toBe(10);
    const second = acquireApiKeyBudgetLease(comboEntry, { now, reserveTokens: 1 });
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.reason).toBe("daily_token_limit_exceeded");
    first.lease.releaseUnused();
  });

  test("enforces pre-dispatch TPM and in-flight holds on combo routes without reaching upstream or cooling targets", async () => {
    const serverHome = mkdtempSync(join(tmpdir(), "epx-combo-hold-srv-"));
    homes.push(serverHome);
    let upstreamHits = 0;
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        upstreamHits += 1;
        return Response.json({
          id: "resp_ok",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        });
      },
    });
    const comboKey = {
      id: "k-combo-tpm",
      name: "combo-tpm",
      key: "epx_data_combotpm0000001",
      createdAt: "2026-01-01T00:00:00Z",
      rpmLimit: 3,
      tpmLimit: 100,
    };
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      defaultProvider: "p1",
      apiKeys: [comboKey],
      providers: {
        p1: {
          adapter: "openai-responses",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-p1",
          models: ["m1"],
        },
        p2: {
          adapter: "openai-responses",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-p2",
          models: ["m2"],
        },
      },
      combos: {
        "tpm-combo": {
          strategy: "failover",
          targets: [
            { provider: "p1", model: "m1" },
            { provider: "p2", model: "m2" },
          ],
        },
      },
    };
    const fixture = await startManagementServerFixture(serverHome, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      // Exceed tpmLimit (100) via max_output_tokens reservation on combo/tpm-combo -> 429 before upstream.
      for (const [path, body] of [
        ["/v1/responses", { model: "combo/tpm-combo", input: "hello", max_output_tokens: 200, stream: false }],
        ["/v1/chat/completions", { model: "combo/tpm-combo", messages: [{ role: "user", content: "hello" }], max_tokens: 200, stream: false }],
        ["/v1/messages", { model: "combo/tpm-combo", max_tokens: 200, messages: [{ role: "user", content: "hello" }], stream: false }],
      ] as const) {
        const denied = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-easyproxy-api-key": comboKey.key,
          },
          body: JSON.stringify(body),
        });
        expect(denied.status).toBe(429);
        const json = await denied.json() as { error?: { code?: string } };
        expect(json.error?.code).toBe("tpm_limit_exceeded");
      }
      expect(upstreamHits).toBe(0);
      expect(getApiKeyBudgetHoldSnapshot(comboKey.id).rpmCurrent).toBe(0);
      expect(getApiKeyBudgetHoldSnapshot(comboKey.id).inFlightTokens).toBe(0);

      // Small combo request within tpmLimit succeeds normally (RPM wasn't burned by refusals).
      const allowed = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": comboKey.key,
        },
        body: JSON.stringify({ model: "combo/tpm-combo", input: "hi", max_output_tokens: 10, stream: false }),
      });
      expect(allowed.status).toBe(200);
      expect(upstreamHits).toBe(1);
    } finally {
      await fixture.close();
      upstream.stop(true);
      await settleServerAuthFixture(serverHome);
    }
  });
});
