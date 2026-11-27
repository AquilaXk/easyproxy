import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { clearComboEwmaState, clearComboSelectionState, snapshotComboEwmaStats } from "../../src/combos";
import type { EpxProviderTransport } from "../../src/providers/xai-transport";
import { resetApiKeyBudgetsForTests, getApiKeyBudgetSnapshot } from "../../src/server/api-key-budget";
import { handleEmbeddings, resolveEmbeddingsUrl } from "../../src/server/embeddings";
import { clearRequestLogsForTests, getRequestLogEntries, type RequestLogContext } from "../../src/server/request-log";
import { resetOtlpTracingForTests } from "../../src/telemetry/otlp";
import type { EpxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { settleServerAuthFixture, startManagementServerFixture } from "../helpers/server-auth-fixture";

describe("POST /v1/embeddings data-plane endpoint", () => {
  const homes: string[] = [];
  const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
  const origHome = process.env.EASYPROXY_HOME;

  afterEach(async () => {
    while (servers.length > 0) {
      servers.pop()!.stop(true);
    }
    resetOtlpTracingForTests();
    resetApiKeyBudgetsForTests();
    clearComboEwmaState();
    clearComboSelectionState();
    clearRequestLogsForTests();
    if (origHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = origHome;
    while (homes.length > 0) {
      const dir = homes.pop()!;
      await settleServerAuthFixture(dir);
      removeTreeWithRetry(dir);
    }
  });

  test("resolves /v1/embeddings URLs cleanly across provider baseUrl shapes", () => {
    expect(resolveEmbeddingsUrl({ baseUrl: "https://api.openai.com/v1" })).toBe("https://api.openai.com/v1/embeddings");
    expect(resolveEmbeddingsUrl({ baseUrl: "https://api.openai.com" })).toBe("https://api.openai.com/v1/embeddings");
    expect(resolveEmbeddingsUrl({ baseUrl: "https://gw.example.com/v1/responses" })).toBe("https://gw.example.com/v1/embeddings");
    expect(resolveEmbeddingsUrl({ baseUrl: "https://gw.example.com/openai/v1/chat/completions" })).toBe("https://gw.example.com/openai/v1/embeddings");
    expect(resolveEmbeddingsUrl({ baseUrl: "https://gw.example.com/v1/embeddings" })).toBe("https://gw.example.com/v1/embeddings");
  });

  test("enforces auth 401, scope 403, request validation 400, unsupported adapter 400, and SSRF destination block 400", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-emb-guards-"));
    homes.push(home);

    let outboundCalls = 0;
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      defaultProvider: "openai-custom",
      apiKeys: [
        {
          id: "k-scoped",
          name: "scoped",
          key: "epx_data_embscopedkey0001",
          createdAt: "2026-01-01T00:00:00Z",
          allowedProviders: ["openai-custom"],
          allowedModels: ["text-embedding-3-small"],
        },
      ],
      providers: {
        "openai-custom": {
          adapter: "openai-chat",
          baseUrl: "https://api.example.com/v1",
          authMode: "key",
          apiKey: "sk-up-1",
          models: ["text-embedding-3-small", "text-embedding-3-large"],
        },
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // 1. Unauthenticated -> 401
      const unauth = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: "hi" }),
      });
      expect(unauth.status).toBe(401);

      const authHeader = {
        "content-type": "application/json",
        "x-easyproxy-api-key": "epx_data_embscopedkey0001",
      };

      // 2. Bad inputs -> 400
      for (const badBody of [
        "{not-json",
        JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: "" }),
        JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: [] }),
        JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: Array.from({ length: 2049 }, () => "x") }),
        JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: "ok", encoding_format: "hex" }),
        JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: "ok", dimensions: -5 }),
        JSON.stringify({ model: "openai-custom/text-embedding-3-small", input: "ok", dimensions: 1.5 }),
      ]) {
        const res = await fetch(`${base}/v1/embeddings`, { method: "POST", headers: authHeader, body: badBody });
        expect(res.status).toBe(400);
      }

      // 3. Scoped key asking for forbidden model -> 403
      const forbidden = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({ model: "openai-custom/text-embedding-3-large", input: "hi" }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await fixture.close();
    }

    // 4. Direct handler verification for unsupported adapter & SSRF block without outbound network calls.
    const spyFetch = (async () => {
      outboundCalls += 1;
      return new Response("should not be reached", { status: 200 });
    }) as typeof globalThis.fetch;

    const unitCfg: EpxConfig = {
      ...cfg,
      providers: {
        ...cfg.providers,
        anth: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "sk-ant-1",
          models: ["claude-sonnet-4-6"],
          fetch: spyFetch,
        } as EpxConfig["providers"][string],
        "meta-ssrf": {
          adapter: "openai-chat",
          baseUrl: "http://169.254.169.254/latest",
          authMode: "key",
          apiKey: "sk-up-2",
          models: ["ssrf-embed"],
          fetch: spyFetch,
        } as EpxConfig["providers"][string],
        "priv-ssrf": {
          adapter: "openai-chat",
          baseUrl: "http://10.0.0.8/v1",
          authMode: "key",
          apiKey: "sk-up-3",
          models: ["priv-embed"],
          fetch: spyFetch,
        } as EpxConfig["providers"][string],
      },
    };

    for (const [model, expectedStatus] of [
      ["anth/claude-sonnet-4-6", 400],
      ["meta-ssrf/ssrf-embed", 400],
      ["priv-ssrf/priv-embed", 400],
    ] as const) {
      const logCtx: RequestLogContext = { model: "unknown", provider: "unknown" };
      const res = await handleEmbeddings(
        new Request("http://127.0.0.1/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: "embed test" }),
        }),
        unitCfg,
        logCtx,
        { requestId: `emb-${model}`, start: Date.now() },
      );
      expect(res.status).toBe(expectedStatus);
    }
    expect(outboundCalls).toBe(0);
  });

  test("forwards embeddings over live HTTP, supports combo failover, settles budget tokens, and propagates traceparent only when OTLP enabled", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-emb-live-"));
    homes.push(home);

    const primaryHeaders: Array<Record<string, string>> = [];
    const secondaryBodies: Array<Record<string, unknown>> = [];
    const secondaryHeaders: Array<Record<string, string>> = [];

    const failUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const hdrs: Record<string, string> = {};
        req.headers.forEach((v, k) => { hdrs[k] = v; });
        primaryHeaders.push(hdrs);
        return Response.json({ error: { message: "transient 502" } }, { status: 502 });
      },
    });
    servers.push(failUpstream);

    const okUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const hdrs: Record<string, string> = {};
        req.headers.forEach((v, k) => { hdrs[k] = v; });
        secondaryHeaders.push(hdrs);
        secondaryBodies.push((await req.json()) as Record<string, unknown>);
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 42, total_tokens: 42 },
        });
      },
    });
    servers.push(okUpstream);

    const collector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("{}", { status: 200 });
      },
    });
    servers.push(collector);

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      defaultProvider: "p2",
      apiKeys: [
        {
          id: "k-emb-ok",
          name: "emb-ok",
          key: "epx_data_embokkey00000001",
          createdAt: "2026-01-01T00:00:00Z",
          tpmLimit: 1000,
          dailyTokenLimit: 5000,
        },
      ],
      providers: {
        p1: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${failUpstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-p1",
          models: ["text-embedding-3-small"],
        },
        p2: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${okUpstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-p2",
          models: ["text-embedding-3-small"],
        },
      },
      combos: {
        "embed-combo": {
          strategy: "failover",
          targets: [
            { provider: "p1", model: "text-embedding-3-small" },
            { provider: "p2", model: "text-embedding-3-small" },
          ],
        },
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // First call with OTLP disabled: succeeds via p2 failover, records 42 tokens, sends NO traceparent.
      const res1 = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": "epx_data_embokkey00000001",
        },
        body: JSON.stringify({
          model: "combo/embed-combo",
          input: ["alpha", "beta"],
          encoding_format: "float",
          dimensions: 3,
        }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json() as { data?: Array<{ embedding: number[] }>; usage?: { total_tokens: number } };
      expect(body1.data?.[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(body1.usage?.total_tokens).toBe(42);
      expect(primaryHeaders).toHaveLength(1);
      expect(secondaryHeaders).toHaveLength(1);
      expect(secondaryHeaders[0]?.traceparent).toBeUndefined();
      expect(secondaryHeaders[0]?.authorization).toBe("Bearer sk-p2");
      expect(secondaryBodies[0]).toMatchObject({
        model: "text-embedding-3-small",
        input: ["alpha", "beta"],
        encoding_format: "float",
        dimensions: 3,
      });

      expect(getApiKeyBudgetSnapshot("k-emb-ok").dailyTokensUsed).toBe(42);
      expect(getRequestLogEntries().some(e => e.provider === "p2" && e.status === 200 && e.usage?.inputTokens === 42)).toBe(true);

      // Enable OTLP via management API and verify outbound traceparent is attached to embeddings request.
      const { configuredAdminToken } = await import("../../src/lib/admin-secrets");
      const putOtlp = await fetch(`${base}/api/telemetry/otlp`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": configuredAdminToken()!,
        },
        body: JSON.stringify({
          enabled: true,
          endpoint: `http://127.0.0.1:${collector.port}/v1/traces`,
        }),
      });
      expect(putOtlp.status).toBe(200);

      const res2 = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": "epx_data_embokkey00000001",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        },
        body: JSON.stringify({ model: "p2/text-embedding-3-small", input: "traced text" }),
      });
      expect(res2.status).toBe(200);
      expect(secondaryHeaders.at(-1)?.traceparent).toMatch(/^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/);
    } finally {
      await fixture.close();
    }
  });

  test("supports 1D token input, preserves query params in baseUrl, respects round-robin combos, refuses paused keys, and refunds unused budget on local errors", async () => {
    expect(resolveEmbeddingsUrl({ baseUrl: "https://azure.example.com/openai/deployments/emb?api-version=2024-02-01" }))
      .toBe("https://azure.example.com/openai/deployments/emb/v1/embeddings?api-version=2024-02-01");
    expect(resolveEmbeddingsUrl({ baseUrl: "https://gw.example.com/v1?tenant=a" }))
      .toBe("https://gw.example.com/v1/embeddings?tenant=a");

    const home = mkdtempSync(join(tmpdir(), "epx-emb-fixes-"));
    homes.push(home);

    const seenTargets: string[] = [];
    const srvA = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        seenTargets.push("a");
        return Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }], model: "m-a", usage: { prompt_tokens: 3, total_tokens: 3 } });
      },
    });
    const srvB = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        seenTargets.push("b");
        return Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.2] }], model: "m-b", usage: { prompt_tokens: 3, total_tokens: 3 } });
      },
    });
    servers.push(srvA, srvB);

    const keyId = "k-emb-refund";
    const keySecret = "epx_data_embrefund00000001";
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      defaultProvider: "pa",
      apiKeys: [
        {
          id: keyId,
          name: "emb-refund",
          key: keySecret,
          createdAt: "2026-01-01T00:00:00Z",
          rpmLimit: 3,
          maxDailyRequests: 3,
        },
      ],
      providers: {
        pa: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${srvA.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-pa",
          models: ["m-a"],
        },
        pb: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${srvB.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-pb",
          models: ["m-b"],
        },
        pausedProv: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${srvA.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-paused-secret",
          apiKeyPool: [{ id: "k1", key: "sk-paused-secret", disabled: true }],
          models: ["m-paused"],
        },
        disabledProv: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${srvA.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-dis",
          disabled: true,
          models: ["m-dis"],
        },
      },
      combos: {
        rr: {
          strategy: "round-robin",
          targets: [
            { provider: "pa", model: "m-a" },
            { provider: "pb", model: "m-b" },
          ],
        },
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // 1. 1D integer token array input + round-robin alternates across providers.
      const r1 = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": keySecret },
        body: JSON.stringify({ model: "combo/rr", input: [101, 202, 303] }),
      });
      expect(r1.status).toBe(200);
      const r2 = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": keySecret },
        body: JSON.stringify({ model: "combo/rr", input: [404, 505] }),
      });
      expect(r2.status).toBe(200);
      expect(seenTargets).toEqual(["a", "b"]);

      // 2. Local refusals (400 invalid input, 404 disabled provider, 403 paused provider key) do NOT burn RPM/daily quota.
      const countBeforeRefusals = seenTargets.length;
      for (const [badReq, expectedStatus] of [
        [{ model: "pa/m-a", input: [] }, 400],
        [{ model: "disabledProv/m-dis", input: "x" }, 404],
        [{ model: "pausedProv/m-paused", input: "x" }, 403],
      ] as const) {
        const res = await fetch(`${base}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-easyproxy-api-key": keySecret },
          body: JSON.stringify(badReq),
        });
        expect(res.status).toBe(expectedStatus);
      }
      expect(seenTargets.length).toBe(countBeforeRefusals);
      const snap = getApiKeyBudgetSnapshot(keyId);
      expect(snap.rpmCurrent).toBe(2);
      expect(snap.dailyRequestsUsed).toBe(2);

      // The 3rd real request is still admitted (limit=3 wasn't burned by the 3 local refusals).
      const r3 = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": keySecret },
        body: JSON.stringify({ model: "pa/m-a", input: "third real" }),
      });
      expect(r3.status).toBe(200);
    } finally {
      await fixture.close();
    }
  });

  test("converges ewma-latency combos over /v1/embeddings and penalizes oversized, invalid-JSON, and non-object upstream failures", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-emb-ewma-"));
    homes.push(home);
    clearComboEwmaState();
    clearComboSelectionState();

    const hits: string[] = [];
    const slowSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        hits.push("slow");
        await Bun.sleep(65);
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1] }],
          model: "emb-slow",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      },
    });
    servers.push(slowSrv);

    const fastSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits.push("fast");
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.2] }],
          model: "emb-fast",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      },
    });
    servers.push(fastSrv);

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "127.0.0.1",
      defaultProvider: "fast",
      providers: {
        slow: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${slowSrv.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-slow",
          models: ["emb-slow"],
        },
        fast: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${fastSrv.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-fast",
          models: ["emb-fast"],
        },
      },
      combos: {
        "emb-ewma": {
          strategy: "ewma-latency",
          ewmaLatency: { alpha: 0.5, minSamples: 1, errorPenaltyMs: 15_000 },
          targets: [
            { provider: "slow", model: "emb-slow" },
            { provider: "fast", model: "emb-fast" },
          ],
        },
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      // Cold start explores slow then fast, then exploits fast on subsequent calls.
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/emb-ewma", input: `probe-${i}` }),
        });
        expect(res.status).toBe(200);
      }
      expect(hits.slice(0, 2)).toEqual(["slow", "fast"]);
      expect(hits.slice(2)).toEqual(["fast", "fast", "fast"]);

      const ewmaStats = snapshotComboEwmaStats("emb-ewma");
      expect(ewmaStats["slow/emb-slow"]?.samples).toBe(1);
      expect(ewmaStats["fast/emb-fast"]?.samples).toBe(4);
      expect((ewmaStats["slow/emb-slow"]?.ewmaMs ?? 0)).toBeGreaterThan((ewmaStats["fast/emb-fast"]?.ewmaMs ?? 0));
    } finally {
      await fixture.close();
    }

    // Exercise oversized body, invalid JSON, and non-object JSON failover + EWMA failure penalties directly.
    clearComboEwmaState();
    clearComboSelectionState();
    const modes: Array<"oversized" | "invalid-json" | "non-object"> = ["oversized", "invalid-json", "non-object"];
    let badAttempt = 0;
    const oneMbChunk = new Uint8Array(1024 * 1024);

    const badProvider: EpxProviderTransport = {
      adapter: "openai-chat",
      baseUrl: "https://bad.example.com/v1",
      authMode: "key",
      apiKey: "sk-bad",
      models: ["m-bad"],
      fetch: async () => {
        const mode = modes[Math.min(badAttempt, modes.length - 1)]!;
        badAttempt += 1;
        if (mode === "oversized") {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let c = 0; c < 33; c += 1) {
                controller.enqueue(oneMbChunk);
              }
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
        }
        if (mode === "invalid-json") {
          return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("42", { status: 200, headers: { "content-type": "application/json" } });
      },
    };

    const goodHits: number[] = [];
    const goodProvider: EpxProviderTransport = {
      adapter: "openai-chat",
      baseUrl: "https://good.example.com/v1",
      authMode: "key",
      apiKey: "sk-good",
      models: ["m-good"],
      fetch: async () => {
        goodHits.push(1);
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.9] }],
          model: "m-good",
          usage: { prompt_tokens: 4, total_tokens: 4 },
        });
      },
    };

    const failCfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: {
        bad: badProvider,
        good: goodProvider,
      },
      combos: {
        "emb-fail": {
          strategy: "ewma-latency",
          ewmaLatency: { alpha: 0.5, minSamples: 1, errorPenaltyMs: 25_000 },
          targets: [
            { provider: "bad", model: "m-bad" },
            { provider: "good", model: "m-good" },
          ],
        },
      },
    };

    // Call 1: bad returns >32 MiB oversized response -> fails over to good and records EWMA failure on bad.
    const makeCtx = (): RequestLogContext => ({ start: Date.now(), method: "POST", path: "/v1/embeddings" });
    const req1 = new Request("http://127.0.0.1/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/emb-fail", input: "hello" }),
    });
    const res1 = await handleEmbeddings(req1, failCfg, makeCtx(), { requestId: "emb-ov-1", start: Date.now() });
    expect(res1.status).toBe(200);
    expect(badAttempt).toBe(1);
    expect(goodHits.length).toBe(1);
    expect(snapshotComboEwmaStats("emb-fail")["bad/m-bad"]?.consecutiveFailures).toBe(1);

    // Clear good's cold-start by verifying single-target fail behavior records failures for invalid JSON and non-object JSON too.
    const singleBadCfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: { bad: badProvider },
      combos: {
        "emb-single-fail": {
          strategy: "ewma-latency",
          ewmaLatency: { alpha: 0.5, minSamples: 1, errorPenaltyMs: 25_000 },
          targets: [{ provider: "bad", model: "m-bad" }],
        },
      },
    };

    const req2 = new Request("http://127.0.0.1/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/emb-single-fail", input: "invalid json" }),
    });
    const res2 = await handleEmbeddings(req2, singleBadCfg, makeCtx(), { requestId: "emb-ij-2", start: Date.now() });
    expect(res2.status).toBe(502);
    expect(snapshotComboEwmaStats("emb-single-fail")["bad/m-bad"]?.consecutiveFailures).toBe(1);

    const req3 = new Request("http://127.0.0.1/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/emb-single-fail", input: "non object json" }),
    });
    const res3 = await handleEmbeddings(req3, singleBadCfg, makeCtx(), { requestId: "emb-no-3", start: Date.now() });
    expect(res3.status).toBe(502);
    expect(snapshotComboEwmaStats("emb-single-fail")["bad/m-bad"]?.consecutiveFailures).toBe(2);
  });

  test("fails over on 429/401, skips non-embedding failover targets, and tracks EWMA stats for aliased combo targets", async () => {
    clearComboEwmaState();
    clearComboSelectionState();

    const hits: string[] = [];
    let failStatus = 429;
    const badAliasProvider: EpxProviderTransport = {
      adapter: "openai-chat",
      alias: "emb-alias",
      baseUrl: "https://bad-alias.example.com/v1",
      authMode: "key",
      apiKey: "sk-bad",
      models: ["m-bad"],
      fetch: async () => {
        hits.push(`bad:${failStatus}`);
        return Response.json({ error: { message: `status ${failStatus}` } }, { status: failStatus });
      },
    };
    const anthProvider: EpxProviderTransport = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "key",
      apiKey: "sk-ant",
      models: ["claude-sonnet-4-6"],
      fetch: async () => {
        hits.push("anth-should-not-run");
        return new Response("unexpected", { status: 500 });
      },
    };
    const goodProvider: EpxProviderTransport = {
      adapter: "openai-chat",
      baseUrl: "https://good-emb.example.com/v1",
      authMode: "key",
      apiKey: "sk-good",
      models: ["m-good"],
      fetch: async () => {
        hits.push("good");
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.5] }],
          model: "m-good",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
    };

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: {
        "bad-real": badAliasProvider,
        anth: anthProvider,
        good: goodProvider,
      },
      combos: {
        "emb-alias-ewma": {
          strategy: "ewma-latency",
          ewmaLatency: { alpha: 0.5, minSamples: 1, errorPenaltyMs: 20_000 },
          targets: [
            { provider: "bad-real", model: "m-bad" },
            { provider: "anth", model: "claude-sonnet-4-6" },
            { provider: "good", model: "m-good" },
          ],
        },
      },
    };

    const makeCtx = (): RequestLogContext => ({ model: "unknown", provider: "unknown" });
    // 1. Primary returns 429 -> skips anthropic target -> fails over to good -> succeeds 200 and records bad-real failure.
    failStatus = 429;
    const res429 = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/emb-alias-ewma", input: "rate limited primary" }),
      }),
      cfg,
      makeCtx(),
      { requestId: "emb-429-1", start: Date.now() },
    );
    expect(res429.status).toBe(200);
    expect(hits).toEqual(["bad:429", "good"]);
    const stats1 = snapshotComboEwmaStats("emb-alias-ewma");
    expect(stats1["bad-real/m-bad"]?.consecutiveFailures).toBe(1);
    expect(stats1["good/m-good"]?.samples).toBe(1);

    // 2. Single-target 401 records EWMA failure cleanly.
    const single401Cfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: { "bad-real": badAliasProvider },
      combos: {
        "emb-401-only": {
          strategy: "ewma-latency",
          ewmaLatency: { alpha: 0.5, minSamples: 1, errorPenaltyMs: 20_000 },
          targets: [{ provider: "bad-real", model: "m-bad" }],
        },
      },
    };
    failStatus = 401;
    const res401 = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/emb-401-only", input: "auth fail" }),
      }),
      single401Cfg,
      makeCtx(),
      { requestId: "emb-401-1", start: Date.now() },
    );
    expect(res401.status).toBe(401);
    expect(snapshotComboEwmaStats("emb-401-only")["bad-real/m-bad"]?.consecutiveFailures).toBe(1);
  });

  test("Item 11: decouples connectTimeoutMs from body deadline, forwards caller bearer, and redacts fetch exception secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-emb-item11-"));
    homes.push(home);

    let mode: "slow-headers" | "slow-body" | "echo-auth" = "slow-headers";
    const observedAuths: Array<string | null> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        observedAuths.push(req.headers.get("authorization"));
        if (mode === "slow-headers") {
          await new Promise(resolve => setTimeout(resolve, 140));
          return Response.json({ object: "list", data: [], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } });
        }
        if (mode === "slow-body") {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const payload = JSON.stringify({
                object: "list",
                data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
                model: "text-embedding-3-small",
                usage: { prompt_tokens: 2, total_tokens: 2 },
              });
              const mid = Math.floor(payload.length / 2);
              controller.enqueue(new TextEncoder().encode(payload.slice(0, mid)));
              await new Promise(resolve => setTimeout(resolve, 110));
              controller.enqueue(new TextEncoder().encode(payload.slice(mid)));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
        }
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.5] }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      },
    });
    servers.push(upstream);

    const secretLeak = ["sk", "proj", `embLeak${"0".repeat(22)}`].join("-");
    const leakyFetch = (async () => {
      throw new Error(`connect failure Authorization: Bearer ${secretLeak}`);
    }) as typeof fetch;

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: {
        tight: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          authMode: "key",
          apiKey: "sk-emb-key",
          allowPrivateNetwork: true,
          connectTimeoutMs: 40,
          models: ["text-embedding-3-small"],
        },
        fwd: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          authMode: "forward",
          allowPrivateNetwork: true,
          models: ["text-embedding-3-small"],
        },
        leaky: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-emb-leaky",
          models: ["text-embedding-3-small"],
          fetch: leakyFetch,
        } as EpxProviderTransport as EpxConfig["providers"][string],
      },
    };

    const makeCtx = (): RequestLogContext => ({ model: "unknown", provider: "unknown" });

    // 1. Slow header exceeds connectTimeoutMs (40ms) -> 502
    mode = "slow-headers";
    const hdrTimeout = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "tight/text-embedding-3-small", input: "hello" }),
      }),
      cfg,
      makeCtx(),
      { requestId: "emb-hdr-timeout", start: Date.now() },
    );
    expect(hdrTimeout.status).toBe(502);

    // 2. Fast header + slow body (>110ms > 40ms connectTimeoutMs) -> 200 OK
    mode = "slow-body";
    const slowBody = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "tight/text-embedding-3-small", input: "hello" }),
      }),
      cfg,
      makeCtx(),
      { requestId: "emb-slow-body", start: Date.now() },
    );
    expect(slowBody.status).toBe(200);

    // 3. authMode=forward sends caller bearer and refuses proxy admission secret
    mode = "echo-auth";
    observedAuths.length = 0;
    const fwdOk = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-caller-emb-1" },
        body: JSON.stringify({ model: "fwd/text-embedding-3-small", input: "hello" }),
      }),
      cfg,
      makeCtx(),
      { requestId: "emb-fwd-ok", start: Date.now() },
    );
    expect(fwdOk.status).toBe(200);
    expect(observedAuths).toEqual(["Bearer sk-caller-emb-1"]);

    const fwdProxyBlocked = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${["epx_data", "proxy_secret_refuse"].join("_")}`,
        },
        body: JSON.stringify({ model: "fwd/text-embedding-3-small", input: "hello" }),
      }),
      cfg,
      makeCtx(),
      { requestId: "emb-fwd-proxy", start: Date.now() },
    );
    expect(fwdProxyBlocked.status).toBe(401);
    expect(observedAuths).toHaveLength(1);

    // 4. Upstream fetch exception redacts secret
    const errRes = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "leaky/text-embedding-3-small", input: "hello" }),
      }),
      cfg,
      makeCtx(),
      { requestId: "emb-leak-redact", start: Date.now() },
    );
    expect(errRes.status).toBe(502);
    const errText = await errRes.text();
    expect(errText).toContain("[REDACTED]");
    expect(errText).not.toContain(secretLeak);
  });

  test("rejects removed openai-compatible adapter on auxiliary endpoints", async () => {
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: {
        deadcompat: {
          adapter: "openai-compatible" as unknown as EpxConfig["providers"][string]["adapter"],
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-dead",
          models: ["text-embedding-3-small"],
        },
      },
    };
    const res = await handleEmbeddings(
      new Request("http://127.0.0.1/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deadcompat/text-embedding-3-small", input: "hello" }),
      }),
      cfg,
      { model: "unknown", provider: "unknown" },
      { requestId: "emb-dead-compat", start: Date.now() },
    );
    expect(res.status).toBe(400);
  });
});
