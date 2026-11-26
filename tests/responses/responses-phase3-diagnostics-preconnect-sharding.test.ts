import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import {
  MAX_PROMPT_CACHE_KEY_SHARD_CACHE,
  getPromptCacheKeyShardCacheSizeForTests,
  resetPromptCacheKeyShardCacheForTests,
  shardOutboundPromptCacheKey,
} from "../../src/adapters/openai-responses/prompt-cache";
import { getDefaultConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { routedProviderConfig } from "../../src/providers/routed-config";
import {
  evaluateSafePreconnectOrigin,
  maybePreconnectIdleOrigin,
  providerFetch,
  resetPreconnectOriginStatesForTests,
} from "../../src/server/responses/fetch-helpers";
import {
  estimateInputTokenBreakdown,
  estimateInputTokens,
} from "../../src/server/responses/input-admission";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import type { EpxConfig, EpxParsedRequest, EpxProviderConfig } from "../../src/types";
import { cacheDiagnosticPath } from "../../src/usage/cache-diagnostic";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { settleServerAuthFixture, startManagementServerFixture } from "../helpers/server-auth-fixture";

describe("Phase 3: cache context breakdown, 4-gate preconnect, and prompt_cache_key lane sharding", () => {
  const homes: string[] = [];
  const cleanups: Array<() => void> = [];
  const origHome = process.env.EASYPROXY_HOME;
  const origDebug = process.env.EASYPROXY_CACHE_DEBUG;
  const origFresh = process.env.EPX_FRESH_CONNECTION_HOSTS;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "epx-phase3-"));
    homes.push(home);
    process.env.EASYPROXY_HOME = home;
    clearRequestLogsForTests();
    resetPreconnectOriginStatesForTests();
    resetPromptCacheKeyShardCacheForTests();
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    clearRequestLogsForTests();
    resetPreconnectOriginStatesForTests();
    resetPromptCacheKeyShardCacheForTests();
    if (origHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = origHome;
    if (origDebug === undefined) delete process.env.EASYPROXY_CACHE_DEBUG;
    else process.env.EASYPROXY_CACHE_DEBUG = origDebug;
    if (origFresh === undefined) delete process.env.EPX_FRESH_CONNECTION_HOSTS;
    else process.env.EPX_FRESH_CONNECTION_HOSTS = origFresh;
    while (homes.length > 0) removeTreeWithRetry(homes.pop()!);
  });

  test("estimateInputTokenBreakdown partitions all 7 scalar categories summing cleanly to estimateInputTokens", () => {
    const parsed = {
      modelId: "claude-sonnet-4-6",
      stream: false,
      context: {
        systemPrompt: ["System policy rules and constraints."],
        messages: [
          { role: "developer", timestamp: 0, content: "Developer formatting override." },
          {
            role: "user",
            timestamp: 1,
            content: [
              { type: "text", text: "Please analyze the screenshot and run lookup." },
              { type: "image", imageUrl: `data:image/png;base64,${"A".repeat(4000)}` },
            ],
          },
          {
            role: "assistant",
            timestamp: 2,
            content: [
              { type: "thinking", thinking: "Internal deliberation steps before calling lookup tool." },
              { type: "text", text: "Let me look that up." },
              { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "status" } },
            ],
            kiroRedactedReasoning: "opaque-redacted-reasoning",
          },
          {
            role: "toolResult",
            timestamp: 3,
            toolCallId: "call_1",
            toolName: "lookup",
            isError: false,
            content: [
              { type: "text", text: "Lookup returned healthy metrics." },
              { type: "audio", format: "wav", data: "B".repeat(2048), text: "[audio: wav]" },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Query live service status",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      },
      options: {},
    } as unknown as EpxParsedRequest;

    const provider: EpxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    };

    const breakdown = estimateInputTokenBreakdown(parsed, "claude-sonnet-4-6", provider);
    expect(breakdown.system).toBeGreaterThan(0);
    expect(breakdown.toolSchemas).toBeGreaterThan(0);
    expect(breakdown.userText).toBeGreaterThan(0);
    expect(breakdown.assistantText).toBeGreaterThan(0);
    expect(breakdown.toolResults).toBeGreaterThan(0);
    expect(breakdown.media).toBeGreaterThan(0);
    expect(breakdown.reasoning).toBeGreaterThan(0);

    const sum = breakdown.system
      + breakdown.toolSchemas
      + breakdown.userText
      + breakdown.assistantText
      + breakdown.toolResults
      + breakdown.media
      + breakdown.reasoning;
    expect(sum).toBe(estimateInputTokens(parsed, "claude-sonnet-4-6", provider));
  });

  test("cache diagnostic records content-free scalar contextTokens only when EASYPROXY_CACHE_DEBUG=1", async () => {
    const SECRET_SYS = "UNIQUE_CONFIDENTIAL_SYSTEM_PROMPT_TEXT";
    const SECRET_USER = "UNIQUE_CONFIDENTIAL_USER_QUESTION_TEXT";
    const SECRET_TOOL = "UNIQUE_CONFIDENTIAL_TOOL_OUTPUT_TEXT";
    const serverHome = mkdtempSync(join(tmpdir(), "epx-phase3-diag-"));
    homes.push(serverHome);
    process.env.EASYPROXY_HOME = serverHome;

    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({
        id: "resp_diag",
        object: "response",
        status: "completed",
        usage: { input_tokens: 40, output_tokens: 5 },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }),
    });

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "127.0.0.1",
      defaultProvider: "p1",
      providers: {
        p1: {
          adapter: "openai-responses",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-diag",
          models: ["gpt-5"],
        },
      },
    };

    const fixture = await startManagementServerFixture(serverHome, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      const sendTurn = () => fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "p1/gpt-5",
          instructions: SECRET_SYS,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: SECRET_USER }] },
            { type: "function_call", call_id: "c1", name: "fetch_data", arguments: "{\"q\":\"test\"}" },
            { type: "function_call_output", call_id: "c1", output: SECRET_TOOL },
          ],
          tools: [{ type: "function", name: "fetch_data", description: "Fetches data", parameters: { type: "object" } }],
          stream: false,
        }),
      });

      // When disabled: zero diagnostic file written.
      delete process.env.EASYPROXY_CACHE_DEBUG;
      const resOff = await sendTurn();
      expect(resOff.status).toBe(200);
      expect(existsSync(cacheDiagnosticPath())).toBe(false);

      // When enabled: diagnostic JSONL captures numeric breakdown without storing raw text.
      process.env.EASYPROXY_CACHE_DEBUG = "1";
      const resOn = await sendTurn();
      expect(resOn.status).toBe(200);
      expect(existsSync(cacheDiagnosticPath())).toBe(true);

      const rawLog = readFileSync(cacheDiagnosticPath(), "utf8");
      expect(rawLog).not.toContain(SECRET_SYS);
      expect(rawLog).not.toContain(SECRET_USER);
      expect(rawLog).not.toContain(SECRET_TOOL);

      const rows = rawLog.trim().split("\n").map(line => JSON.parse(line));
      expect(rows.length).toBe(1);
      const ctx = rows[0].contextTokens;
      expect(ctx).toBeDefined();
      expect(Object.keys(ctx).sort()).toEqual([
        "assistantText",
        "media",
        "reasoning",
        "system",
        "toolResults",
        "toolSchemas",
        "userText",
      ]);
      expect(ctx.system).toBeGreaterThan(0);
      expect(ctx.userText).toBeGreaterThan(0);
      expect(ctx.assistantText).toBeGreaterThan(0);
      expect(ctx.toolResults).toBeGreaterThan(0);
      expect(ctx.toolSchemas).toBeGreaterThan(0);
      expect(ctx.media).toBe(0);
      expect(ctx.reasoning).toBe(0);
    } finally {
      await fixture.close();
      upstream.stop(true);
      await settleServerAuthFixture(serverHome);
    }
  });

  test("4-gate preconnect guard blocks proxies, tlsProfile, fresh hosts, and non-public/HTTP origins", () => {
    const baseProvider: EpxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "sk-test",
    };

    // Valid public HTTPS origin with all 4 gates clear passes.
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: baseProvider,
      proxyEnv: {},
      hostsEnv: "",
    })).toEqual({ ok: true, origin: "https://api.openai.com" });

    // Gate 1: Provider proxy or env proxy blocks preconnect.
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: { ...baseProvider, proxy: "http://proxy.internal:8080" },
      proxyEnv: {},
    })).toEqual({ ok: false, reason: "provider-proxy" });
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: baseProvider,
      proxyEnv: { HTTPS_PROXY: "http://proxy.internal:8080" },
    })).toEqual({ ok: false, reason: "env-proxy" });
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: baseProvider,
      proxyEnv: { ALL_PROXY: "socks5://127.0.0.1:1080" },
    })).toEqual({ ok: false, reason: "env-proxy" });

    // Gate 2: tlsProfile blocks Bun preconnect.
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: { ...baseProvider, tlsProfile: "antigravity-browser" },
      proxyEnv: {},
    })).toEqual({ ok: false, reason: "tls-profile" });
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: baseProvider,
      hasTlsProfileTransport: true,
      proxyEnv: {},
    })).toEqual({ ok: false, reason: "tls-profile" });

    // Gate 3: EPX_FRESH_CONNECTION_HOSTS blocks preconnect.
    expect(evaluateSafePreconnectOrigin("https://api.openai.com/v1/responses", {
      provider: baseProvider,
      proxyEnv: {},
      hostsEnv: ".openai.com",
    })).toEqual({ ok: false, reason: "fresh-connection-host" });

    // Gate 4: Non-HTTPS, credentials-in-URL, loopback, private IP, metadata, or internal names fail closed.
    for (const bad of [
      "http://api.openai.com/v1",
      "https://user:pass@example.test/v1",
      "https://127.0.0.1/v1",
      "https://localhost/v1",
      "https://10.0.0.5/v1",
      "https://100.64.0.1/v1",
      "https://169.254.169.254/latest",
      "https://[::1]/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://[::ffff:0:127.0.0.1]/v1",
      "https://[64:ff9b::10.0.0.1]/v1",
      "https://[2002:7f00:1::1]/v1",
      "https://[2001:0::1]/v1",
      "https://[2001:2::1]/v1",
      "https://[2001:10::1]/v1",
      "https://[2001:db8::1]/v1",
      "https://[fe80::1]/v1",
      "https://[fc00::1]/v1",
      "https://upstream.local/v1",
      "https://internal-gateway/v1",
      "https://fixture.invalid/v1",
      "::invalid-url::",
    ]) {
      const gate = evaluateSafePreconnectOrigin(bad, {
        provider: { ...baseProvider, allowPrivateNetwork: true },
        proxyEnv: {},
        hostsEnv: "",
      });
      expect(gate.ok).toBe(false);
    }
  });

  test("idle gate and bounded LRU control live providerFetch preconnect frequency and cap memory", () => {
    const preconnected: string[] = [];
    const custom = Object.assign(
      async () => new Response("ok", { status: 200 }),
      {
        preconnect: (url: string | URL) => {
          preconnected.push(String(url));
        },
      },
    ) as typeof fetch;

    const provider: EpxProviderConfig & { fetch: typeof fetch } = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      fetch: custom,
    };

    const fetcher = providerFetch(provider, undefined, { providerName: "p-idle" });
    // Direct fetcher.preconnect skips unsafe targets and runs once per cooldown on safe HTTPS.
    fetcher.preconnect("https://127.0.0.1/v1");
    expect(preconnected).toEqual([]);
    fetcher.preconnect("https://api.openai.com/v1/responses");
    expect(preconnected).toEqual(["https://api.openai.com"]);
    fetcher.preconnect("https://api.openai.com/v1/responses");
    expect(preconnected).toEqual(["https://api.openai.com"]);

    resetPreconnectOriginStatesForTests();
    preconnected.length = 0;

    // Idle-window progression: first request seeds, warm request <30s skips, >=30s triggers once.
    const t0 = 1_000_000;
    expect(maybePreconnectIdleOrigin("https://api.anthropic.com/v1/messages", custom.preconnect, {
      provider,
      proxyEnv: {},
      hostsEnv: "",
      now: t0,
      requireIdleWindow: true,
    })).toBe(false);
    expect(maybePreconnectIdleOrigin("https://api.anthropic.com/v1/messages", custom.preconnect, {
      provider,
      proxyEnv: {},
      hostsEnv: "",
      now: t0 + 10_000,
      requireIdleWindow: true,
    })).toBe(false);
    expect(maybePreconnectIdleOrigin("https://api.anthropic.com/v1/messages", custom.preconnect, {
      provider,
      proxyEnv: {},
      hostsEnv: "",
      now: t0 + 45_000,
      requireIdleWindow: true,
    })).toBe(true);
    expect(preconnected).toEqual(["https://api.anthropic.com"]);

    // Bounded origin LRU evicts cleanly above 256 unique origins.
    for (let i = 0; i < 300; i++) {
      maybePreconnectIdleOrigin(`https://origin-${i}.example.org/v1`, custom.preconnect, {
        provider,
        proxyEnv: {},
        hostsEnv: "",
        now: t0 + i,
        requireIdleWindow: true,
      });
    }
    expect(preconnected.length).toBe(1);
  });

  test("promptCacheKeyLaneSharding shards deterministically per credential after affinity with bounded 4096 LRU", () => {
    // Config schema validation preserves opt-in boolean cleanly.
    const cfgParsed = configSchema.safeParse({
      defaultProvider: "sharded",
      providers: {
        sharded: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          promptCacheKeyLaneSharding: true,
        },
      },
    });
    expect(cfgParsed.success).toBe(true);
    if (!cfgParsed.success) return;
    expect(routedProviderConfig("sharded", cfgParsed.data.providers.sharded!).promptCacheKeyLaneSharding).toBe(true);

    const adapterOff = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "sk-1",
    });
    const makeParsed = (promptCacheKey?: string) => ({
      modelId: "gpt-5",
      stream: false,
      context: { messages: [] },
      options: { ...(promptCacheKey !== undefined ? { promptCacheKey } : {}) },
      _rawBody: {
        model: "gpt-5",
        input: "hello",
        ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
      },
    }) as unknown as EpxParsedRequest;

    const offReq = adapterOff.buildRequest(makeParsed("sess-alpha"), {
      headers: new Headers(),
      translatorBudget: createTranslatorBudget(),
      providerName: "p1",
    });
    expect(JSON.parse(String(offReq.body)).prompt_cache_key).toBe("sess-alpha");

    // With opt-in + distinct post-affinity pool credentials, lanes are deterministic and separated.
    const provAccA: EpxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "sk-acc-a",
      promptCacheKeyLaneSharding: true,
      _apiKeyAttempt: { entryId: "entry-a", reference: "ref-a", cacheAffinity: true },
    };
    const provAccB: EpxProviderConfig = {
      ...provAccA,
      apiKey: "sk-acc-b",
      _apiKeyAttempt: { entryId: "entry-b", reference: "ref-b", cacheAffinity: true },
    };

    const reqA1 = JSON.parse(String(createResponsesPassthroughAdapter(provAccA).buildRequest(makeParsed("sess-alpha"), {
      headers: new Headers(),
      translatorBudget: createTranslatorBudget(),
      providerName: "p1",
    }).body)).prompt_cache_key;
    const reqA2 = JSON.parse(String(createResponsesPassthroughAdapter(provAccA).buildRequest(makeParsed("sess-alpha"), {
      headers: new Headers(),
      translatorBudget: createTranslatorBudget(),
      providerName: "p1",
    }).body)).prompt_cache_key;
    const reqB = JSON.parse(String(createResponsesPassthroughAdapter(provAccB).buildRequest(makeParsed("sess-alpha"), {
      headers: new Headers(),
      translatorBudget: createTranslatorBudget(),
      providerName: "p1",
    }).body)).prompt_cache_key;

    expect(reqA1).toBe(reqA2);
    expect(reqA1).not.toBe("sess-alpha");
    expect(reqA1).not.toBe(reqB);
    expect(reqA1.length).toBeLessThanOrEqual(64);
    expect(reqB.length).toBeLessThanOrEqual(64);

    // Non-ASCII or oversized (>51 char) prompt_cache_key compresses safely <= 64 chars, and >16KiB fails safe.
    const longSharded = shardOutboundPromptCacheKey("x".repeat(200), {
      provider: provAccA,
      providerName: "p1",
      url: "https://api.openai.com/v1/responses",
    });
    expect(longSharded).toBeDefined();
    expect(longSharded!.length).toBeLessThanOrEqual(64);
    expect(shardOutboundPromptCacheKey("x".repeat(20_000), {
      provider: provAccA,
      providerName: "p1",
      url: "https://api.openai.com/v1/responses",
    })).toBeUndefined();

    // Bounded 4,096 LRU evicts stale entries while keeping determinism post-eviction.
    resetPromptCacheKeyShardCacheForTests();
    const firstKey = shardOutboundPromptCacheKey("evict-me-0", {
      provider: provAccA,
      providerName: "p1",
      url: "https://api.openai.com/v1/responses",
    });
    for (let i = 1; i <= MAX_PROMPT_CACHE_KEY_SHARD_CACHE + 100; i++) {
      shardOutboundPromptCacheKey(`key-${i}`, {
        provider: provAccA,
        providerName: "p1",
        url: "https://api.openai.com/v1/responses",
      });
    }
    expect(getPromptCacheKeyShardCacheSizeForTests()).toBe(MAX_PROMPT_CACHE_KEY_SHARD_CACHE);
    expect(shardOutboundPromptCacheKey("evict-me-0", {
      provider: provAccA,
      providerName: "p1",
      url: "https://api.openai.com/v1/responses",
    })).toBe(firstKey);
  });

  test("live HTTP pool affinity decides credential before deterministic outbound prompt_cache_key sharding", async () => {
    const { clearProviderCacheAffinityForTests } = await import("../../src/providers/cache-affinity");
    const { clearKeyCooldowns, setKeyCooldown } = await import("../../src/providers/api-key-cooldowns");
    const { forgetApiKeyRotationCursor } = await import("../../src/providers/key-failover");
    clearProviderCacheAffinityForTests();
    clearKeyCooldowns();
    forgetApiKeyRotationCursor("pool-prov");

    const serverHome = mkdtempSync(join(tmpdir(), "epx-phase3-shard-srv-"));
    homes.push(serverHome);
    process.env.EASYPROXY_HOME = serverHome;

    const observed: Array<{ auth: string | null; cacheKey: string | undefined }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body = await req.json() as { prompt_cache_key?: string };
        observed.push({
          auth: req.headers.get("authorization"),
          cacheKey: body.prompt_cache_key,
        });
        return Response.json({
          id: "resp_shard",
          object: "response",
          status: "completed",
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
          },
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        });
      },
    });

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "127.0.0.1",
      defaultProvider: "pool-prov",
      providers: {
        "pool-prov": {
          adapter: "openai-responses",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-key-a",
          apiKeyPoolStrategy: "round-robin",
          apiKeyPool: [
            { id: "key-a", key: "sk-key-a" },
            { id: "key-b", key: "sk-key-b" },
          ],
          cacheAffinity: "session",
          promptCacheKeyLaneSharding: true,
          models: ["gpt-5"],
        },
      },
    };

    const fixture = await startManagementServerFixture(serverHome, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      const send = (promptCacheKey: string) => fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pool-prov/gpt-5",
          prompt_cache_key: promptCacheKey,
          input: "hello",
          stream: false,
        }),
      });

      const r1 = await send("sess-sticky-1");
      expect(r1.status).toBe(200);
      const r2 = await send("sess-sticky-1");
      expect(r2.status).toBe(200);

      // Simulate key-a entering cooldown -> next request shifts to key-b & gets a distinct sharded lane.
      setKeyCooldown("pool-prov", "key-a", Date.now() + 60_000);
      const r3 = await send("sess-sticky-1");
      expect(r3.status).toBe(200);

      expect(observed).toHaveLength(3);
      // Session affinity keeps turns 1 & 2 on the same credential & identical sharded cache lane.
      expect(observed[0]!.auth).toBe(observed[1]!.auth);
      expect(observed[0]!.cacheKey).toBe(observed[1]!.cacheKey);
      expect(observed[0]!.cacheKey).toBeDefined();
      expect(observed[0]!.cacheKey).not.toBe("sess-sticky-1");
      expect(observed[0]!.cacheKey!.length).toBeLessThanOrEqual(64);
      // After key-a cools, traffic moves to key-b and shifts to key-b's deterministic lane.
      expect(observed[2]!.auth).not.toBe(observed[0]!.auth);
      expect(observed[2]!.cacheKey).not.toBe(observed[0]!.cacheKey);
    } finally {
      clearProviderCacheAffinityForTests();
      clearKeyCooldowns();
      forgetApiKeyRotationCursor("pool-prov");
      await fixture.close();
      upstream.stop(true);
      await settleServerAuthFixture(serverHome);
    }
  });
});
