import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeApiKeyBudget,
  getApiKeyBudgetSnapshot,
  MAX_TRACKED_API_KEYS,
  peekApiKeyBudgetUsage,
  recordApiKeyTokens,
  resetApiKeyBudgetsForTests,
} from "../../src/server/api-key-budget";
import { Float64RingBuffer } from "../../src/lib/ring-buffer";
import { applyApiKeyBudgetPatch, projectApiKeyBudgetDto } from "../../src/server/management/api-key-budget-dto";
import { createAdmittedHttpTurn } from "../../src/server/admitted-http-turn";
import { saveConfig, getDefaultConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { MAX_CONFIGURABLE_INBOUND_BODY_BYTES } from "../../src/server/request-decompress";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";

afterEach(() => {
  resetApiKeyBudgetsForTests();
  clearRequestLogsForTests();
});

describe("api-key-budget", () => {
  test("enforces rpmLimit and computes Retry-After without consuming denied slots", () => {
    const t0 = Date.UTC(2026, 10, 21, 12, 0, 0);
    const entry = { id: "key-rpm", rpmLimit: 2 };

    expect(consumeApiKeyBudget(entry, t0)).toEqual({ allowed: true });
    expect(consumeApiKeyBudget(entry, t0 + 10_000)).toEqual({ allowed: true });

    const denied = consumeApiKeyBudget(entry, t0 + 20_000);
    expect(denied).toEqual({ allowed: false, reason: "rpm_limit_exceeded", retryAfterSec: 40 });
    expect(peekApiKeyBudgetUsage("key-rpm", t0 + 20_000).minuteCount).toBe(2);

    // Once the first request's 60s window expires, another slot opens cleanly.
    expect(consumeApiKeyBudget(entry, t0 + 60_001)).toEqual({ allowed: true });
  });

  test("enforces UTC maxDailyRequests and resets at next UTC midnight", () => {
    const beforeMidnight = Date.UTC(2026, 10, 21, 23, 59, 45);
    const afterMidnight = Date.UTC(2026, 10, 22, 0, 0, 1);
    const entry = { id: "key-day", maxDailyRequests: 2 };

    expect(consumeApiKeyBudget(entry, beforeMidnight)).toEqual({ allowed: true });
    expect(consumeApiKeyBudget(entry, beforeMidnight + 1_000)).toEqual({ allowed: true });
    const denied = consumeApiKeyBudget(entry, beforeMidnight + 2_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("daily_limit_exceeded");
      expect(denied.retryAfterSec).toBe(13);
    }

    expect(consumeApiKeyBudget(entry, afterMidnight)).toEqual({ allowed: true });
  });

  test("bounds tracked key states with LRU eviction at MAX_TRACKED_API_KEYS", () => {
    const now = Date.UTC(2026, 10, 21, 10, 0, 0);
    for (let i = 0; i < MAX_TRACKED_API_KEYS + 5; i += 1) {
      expect(consumeApiKeyBudget({ id: `k-${i}`, rpmLimit: 5 }, now)).toEqual({ allowed: true });
    }
    // Oldest keys were evicted when capacity overflowed.
    expect(peekApiKeyBudgetUsage("k-0", now).minuteCount).toBe(0);
    expect(peekApiKeyBudgetUsage(`k-${MAX_TRACKED_API_KEYS + 4}`, now).minuteCount).toBe(1);
  });

  test("returns HTTP 429 with Retry-After and records refusal log inside createAdmittedHttpTurn", async () => {
    const config = getDefaultConfig();
    const policy = {
      ...config,
      apiKeys: [
        {
          id: "key-http-1",
          name: "ci-runner",
          key: "epx_data_testsecretvalue0001",
          createdAt: new Date().toISOString(),
          rpmLimit: 1,
        },
      ],
    };
    const run = createAdmittedHttpTurn(
      () => MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
      () => new Response("busy", { status: 503 }),
    );
    const makeReq = () => new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "x-easyproxy-api-key": "epx_data_testsecretvalue0001" },
      body: "{}",
    });

    const first = await run(makeReq(), policy, async () => new Response("ok", { status: 200 }), {
      requestId: "req-1",
      start: Date.now(),
      logCtx: { model: "unknown", provider: "unknown", apiKeyId: "key-http-1" },
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("ok");

    let loggedCount = 0;
    const second = await run(makeReq(), policy, async () => new Response("should-not-run", { status: 200 }), {
      requestId: "req-2",
      start: Date.now(),
      logCtx: { model: "unknown", provider: "unknown", apiKeyId: "key-http-1" },
      onLogged: () => { loggedCount += 1; },
    });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const json = await second.json() as { error?: { code?: string; type?: string } };
    expect(json.error?.type).toBe("rate_limit_error");
    expect(json.error?.code).toBe("rpm_limit_exceeded");
    expect(loggedCount).toBe(1);
    expect(getRequestLogEntries().some((r) => r.requestId === "req-2" && r.status === 429)).toBe(true);
  });

  test("preserves counts when hot-reloading across EXACT_RPM_RING_THRESHOLD and fails closed on invalid limits", () => {
    const t0 = Date.UTC(2026, 10, 21, 14, 0, 10);
    for (let i = 0; i < 1_020; i += 1) {
      expect(consumeApiKeyBudget({ id: "key-hot", rpmLimit: 1_500 }, t0 + i)).toEqual({ allowed: true });
    }
    // Shrinking limit below 1,024 in the same minute keeps the 1,020 requests observed so far.
    expect(consumeApiKeyBudget({ id: "key-hot", rpmLimit: 100 }, t0 + 2_000)).toEqual({
      allowed: false,
      reason: "rpm_limit_exceeded",
      retryAfterSec: 48,
    });

    // Reverse transition: <= 1,024 into > 1,024 retains counts in the same UTC minute.
    for (let i = 0; i < 1_024; i += 1) {
      expect(consumeApiKeyBudget({ id: "key-hot-up", rpmLimit: 1_024 }, t0 + i)).toEqual({ allowed: true });
    }
    expect(consumeApiKeyBudget({ id: "key-hot-up", rpmLimit: 1_024 }, t0 + 2_000)).toEqual({
      allowed: false,
      reason: "rpm_limit_exceeded",
      retryAfterSec: 58,
    });

    // Shrunk <= 1,024 limit computes Retry-After from (length - rpmLimit) oldest blocking slot.
    expect(consumeApiKeyBudget({ id: "key-shrink", rpmLimit: 4 }, t0)).toEqual({ allowed: true });
    expect(consumeApiKeyBudget({ id: "key-shrink", rpmLimit: 4 }, t0 + 10_000)).toEqual({ allowed: true });
    expect(consumeApiKeyBudget({ id: "key-shrink", rpmLimit: 4 }, t0 + 20_000)).toEqual({ allowed: true });
    expect(consumeApiKeyBudget({ id: "key-shrink", rpmLimit: 4 }, t0 + 30_000)).toEqual({ allowed: true });
    // Now shrink rpmLimit to 2 at t0 + 35s: 2 newest slots remain active until t0+20s+60s -> WaitMs = 45s.
    expect(consumeApiKeyBudget({ id: "key-shrink", rpmLimit: 2 }, t0 + 35_000)).toEqual({
      allowed: false,
      reason: "rpm_limit_exceeded",
      retryAfterSec: 45,
    });

    // Non-positive, fractional, or non-finite runtime limits fail closed instead of allowing unlimited requests.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(consumeApiKeyBudget({ id: "key-bad", rpmLimit: bad }, t0)).toEqual({
        allowed: false,
        reason: "invalid_budget_limit",
        retryAfterSec: 60,
      });
      expect(consumeApiKeyBudget({ id: "key-bad", maxDailyRequests: bad }, t0)).toEqual({
        allowed: false,
        reason: "invalid_budget_limit",
        retryAfterSec: 60,
      });
    }
  });

  test("formats /v1/messages 429 refusals with Anthropic top-level type=error", async () => {
    const config = getDefaultConfig();
    const policy = {
      ...config,
      apiKeys: [
        {
          id: "key-msg-1",
          name: "claude-runner",
          key: "epx_data_msgsecret0001",
          createdAt: new Date().toISOString(),
          rpmLimit: 1,
        },
      ],
    };
    const run = createAdmittedHttpTurn(
      () => MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
      () => new Response("busy", { status: 503 }),
    );
    const makeReq = () => new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "epx_data_msgsecret0001" },
      body: "{}",
    });

    const ok = await run(makeReq(), policy, async () => new Response("ok", { status: 200 }), {
      requestId: "msg-1",
      start: Date.now(),
      logCtx: { model: "unknown", provider: "unknown", apiKeyId: "key-msg-1" },
    });
    expect(await ok.text()).toBe("ok");

    const blocked = await run(makeReq(), policy, async () => new Response("should-not-run"), {
      requestId: "msg-2",
      start: Date.now(),
      logCtx: { model: "unknown", provider: "unknown", apiKeyId: "key-msg-1" },
    });
    expect(blocked.status).toBe(429);
    const payload = await blocked.json() as { type?: string; error?: { type?: string } };
    expect(payload.type).toBe("error");
    expect(payload.error?.type).toBe("rate_limit_error");
  });

  test("Float64RingBuffer wraps cleanly with bitmask index and prunes leading entries", () => {
    const ring = new Float64RingBuffer(4);
    for (let i = 1; i <= 6; i++) ring.push(i * 10);
    expect(ring.length).toBe(4);
    expect([ring.at(0), ring.at(1), ring.at(2), ring.at(3)]).toEqual([30, 40, 50, 60]);
    expect(ring.at(4)).toBeUndefined();
    expect(ring.pruneLeq(40)).toBe(2);
    expect(ring.length).toBe(2);
    expect([ring.at(0), ring.at(1)]).toEqual([50, 60]);
  });

  test("enforces UTC dailyTokenLimit, records committed tokens, and resets at UTC midnight", () => {
    const t0 = Date.UTC(2026, 10, 21, 23, 59, 50);
    const nextDay = Date.UTC(2026, 10, 22, 0, 0, 5);
    const entry = { id: "key-tok", maxDailyRequests: 10, dailyTokenLimit: 1_000 };

    expect(consumeApiKeyBudget(entry, t0)).toEqual({ allowed: true });
    recordApiKeyTokens("key-tok", 650, t0);
    expect(getApiKeyBudgetSnapshot("key-tok", t0 + 100)).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 1,
      dailyTokensUsed: 650,
    });
    expect(consumeApiKeyBudget(entry, t0 + 200)).toEqual({ allowed: true });

    recordApiKeyTokens("key-tok", 400, t0 + 500);
    const denied = consumeApiKeyBudget(entry, t0 + 1_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("daily_token_limit_exceeded");
      expect(denied.retryAfterSec).toBe(9);
    }

    // Next UTC day clears both request and token daily accumulators, and late completions from t0 cannot rewind state.
    expect(consumeApiKeyBudget(entry, nextDay)).toEqual({ allowed: true });
    recordApiKeyTokens("key-tok", 200, nextDay);
    recordApiKeyTokens("key-tok", 500, t0);
    expect(getApiKeyBudgetSnapshot("key-tok", nextDay)).toEqual({
      rpmCurrent: 0,
      dailyRequestsUsed: 1,
      dailyTokensUsed: 200,
    });
  });

  test("GET and PATCH /api/keys expose and validate per-key budget limits and snapshots", async () => {
    const prevHome = process.env.EASYPROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "epx-budget-routes-"));
    process.env.EASYPROXY_HOME = home;
    try {
      const cfg = {
        ...getDefaultConfig(),
        apiKeys: [{
          id: "key-route-1",
          name: "alpha",
          key: "epx_data_0123456789abcdef01234567",
          createdAt: "2026-11-21T00:00:00.000Z",
          rpmLimit: 30,
        }],
      };
      saveConfig(cfg);
      recordApiKeyTokens("key-route-1", 420, Date.now());

      const getRes = await handleManagementAPI(new ManagementRequest("http://127.0.0.1/api/keys"), new URL("http://127.0.0.1/api/keys"), cfg);
      expect(getRes?.status).toBe(200);
      const getBody = await getRes!.json() as { keys: Array<Record<string, unknown>> };
      expect(getBody.keys[0]).toMatchObject({
        id: "key-route-1",
        rpmLimit: 30,
        budgetUsage: { rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 420 },
      });

      const patchBad = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/keys", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "key-route-1", dailyTokenLimit: 0 }),
        }),
        new URL("http://127.0.0.1/api/keys"),
        cfg,
      );
      expect(patchBad?.status).toBe(400);

      const patchOk = await handleManagementAPI(
        new ManagementRequest("http://127.0.0.1/api/keys", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "key-route-1", rpmLimit: null, maxDailyRequests: 500, dailyTokenLimit: 250_000 }),
        }),
        new URL("http://127.0.0.1/api/keys"),
        cfg,
      );
      expect(patchOk?.status).toBe(200);
      const patched = await patchOk!.json() as Record<string, unknown>;
      expect(patched.rpmLimit).toBeUndefined();
      expect(patched.maxDailyRequests).toBe(500);
      expect(patched.dailyTokenLimit).toBe(250_000);
      expect(projectApiKeyBudgetDto(cfg.apiKeys[0]!).maxDailyRequests).toBe(500);
      expect(applyApiKeyBudgetPatch({ ...cfg.apiKeys[0]! }, { dailyTokenLimit: -1 }).ok).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.EASYPROXY_HOME;
      else process.env.EASYPROXY_HOME = prevHome;
      removeTreeWithRetry(home);
    }
  });
});
