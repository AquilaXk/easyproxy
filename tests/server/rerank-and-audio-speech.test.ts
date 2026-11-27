import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { clearComboEwmaState, clearComboSelectionState, snapshotComboEwmaStats } from "../../src/combos";
import { resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
import type { EpxProviderTransport } from "../../src/providers/xai-transport";
import { handleAudioSpeech, resolveAudioSpeechUrl } from "../../src/server/audio-speech";
import { handleRerank, resolveRerankUrl } from "../../src/server/rerank";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { EpxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startManagementServerFixture } from "../helpers/server-auth-fixture";

const SYNTHETIC_SECRET = ["sk", "proj", `synthetic${"0".repeat(22)}`].join("-");
const SCOPED_KEY = "epx_data_rerankspeechkey001";
const TIGHT_KEY = "epx_data_tightbudgetkey01";

let previousHome: string | undefined;
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): unknown }> = [];
const activeSpendLeases: Array<() => void> = [];

function createTempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
}

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  clearComboSelectionState();
  clearComboEwmaState();
  clearRequestLogsForTests();
  resetSharedSpendLedgerForTest();
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await Promise.resolve(s.stop(true));
    } catch {
      // Already stopped.
    }
  }
  for (const release of activeSpendLeases.splice(0)) {
    try {
      release();
    } catch {
      // Ignore already released.
    }
  }
  clearComboSelectionState();
  clearComboEwmaState();
  clearRequestLogsForTests();
  resetSharedSpendLedgerForTest();
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  for (const h of homes.splice(0)) {
    removeTreeWithRetry(h);
  }
});

describe("P2-A: POST /v1/rerank and POST /v1/audio/speech data planes", () => {
  test("resolveRerankUrl and resolveAudioSpeechUrl normalize provider base paths cleanly", () => {
    expect(resolveRerankUrl({ baseUrl: "https://api.example.com" })).toBe("https://api.example.com/v1/rerank");
    expect(resolveRerankUrl({ baseUrl: "https://api.example.com/v1/embeddings/" })).toBe(
      "https://api.example.com/v1/rerank",
    );
    expect(resolveRerankUrl({ baseUrl: "https://api.example.com/v2/" })).toBe("https://api.example.com/v2/rerank");

    expect(resolveAudioSpeechUrl({ baseUrl: "https://api.example.com" })).toBe(
      "https://api.example.com/v1/audio/speech",
    );
    expect(resolveAudioSpeechUrl({ baseUrl: "https://api.example.com/v1/audio/transcriptions" })).toBe(
      "https://api.example.com/v1/audio/speech",
    );
    expect(resolveAudioSpeechUrl({ baseUrl: "https://api.example.com/v1/responses/" })).toBe(
      "https://api.example.com/v1/audio/speech",
    );
  });

  test("enforces auth 401 (rejecting x-api-key), schema bounds 400, and scoped API key 403 on live HTTP", async () => {
    const home = createTempHome("epx-rerank-speech-auth-");
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      defaultProvider: "custom",
      apiKeys: [
        {
          id: "k-scoped",
          name: "scoped",
          key: "epx_data_rerankspeechkey001",
          createdAt: "2026-01-01T00:00:00Z",
          allowedProviders: ["custom"],
          allowedModels: ["rerank-english-v3", "tts-1"],
        },
        {
          id: "k-tight-budget",
          name: "tight",
          key: "epx_data_tightbudgetkey01",
          createdAt: "2026-01-01T00:00:00Z",
          tpmLimit: 1,
        },
      ],
      providers: {
        custom: {
          adapter: "openai-compatible",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-up-1",
          models: ["rerank-english-v3", "rerank-blocked", "tts-1", "tts-1-hd"],
        },
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // 1. Unauthenticated and header-wrong x-api-key must return 401 on dedicated bearer-key endpoints.
      for (const route of ["/v1/rerank", "/v1/audio/speech"] as const) {
        const payload = route === "/v1/rerank"
          ? { model: "custom/rerank-english-v3", query: "q", documents: ["doc"] }
          : { model: "custom/tts-1", input: "hello", voice: "alloy" };
        const unauth = await fetch(`${base}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(unauth.status).toBe(401);

        const xApiKey = await fetch(`${base}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "epx_data_rerankspeechkey001" },
          body: JSON.stringify(payload),
        });
        expect(xApiKey.status).toBe(401);
      }

      const bearerHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${SCOPED_KEY}`,
      };

      // 2. Rerank schema validation bounds -> 400.
      for (const badBody of [
        "{invalid-json",
        JSON.stringify({ model: "custom/rerank-english-v3", query: "", documents: ["doc"] }),
        JSON.stringify({ model: "custom/rerank-english-v3", query: "q", documents: [] }),
        JSON.stringify({ model: "custom/rerank-english-v3", query: "q", documents: Array.from({ length: 1001 }, () => "d") }),
        JSON.stringify({ model: "custom/rerank-english-v3", query: "q", documents: ["doc"], top_n: 0 }),
        JSON.stringify({ model: "custom/rerank-english-v3", query: "q", documents: ["doc"], return_documents: "yes" }),
        JSON.stringify({ model: "custom/rerank-english-v3", query: "q", documents: ["doc"], rank_fields: [123] }),
      ]) {
        const res = await fetch(`${base}/v1/rerank`, { method: "POST", headers: bearerHeaders, body: badBody });
        expect(res.status).toBe(400);
      }

      // 3. Speech schema validation bounds -> 400.
      for (const badBody of [
        "{invalid-json",
        JSON.stringify({ model: "custom/tts-1", input: "", voice: "alloy" }),
        JSON.stringify({ model: "custom/tts-1", input: "hello", voice: "" }),
        JSON.stringify({ model: "custom/tts-1", input: "hello", voice: "alloy", response_format: "ogg" }),
        JSON.stringify({ model: "custom/tts-1", input: "hello", voice: "alloy", speed: 0.1 }),
        JSON.stringify({ model: "custom/tts-1", input: "hello", voice: "alloy", speed: 4.5 }),
        JSON.stringify({ model: "custom/tts-1", input: "hello", voice: "alloy", instructions: "a".repeat(4097) }),
      ]) {
        const res = await fetch(`${base}/v1/audio/speech`, { method: "POST", headers: bearerHeaders, body: badBody });
        expect(res.status).toBe(400);
      }

      // 4. Scoped key forbidden model -> 403.
      const forbiddenRerank = await fetch(`${base}/v1/rerank`, {
        method: "POST",
        headers: bearerHeaders,
        body: JSON.stringify({ model: "custom/rerank-blocked", query: "q", documents: ["doc"] }),
      });
      expect(forbiddenRerank.status).toBe(403);

      const forbiddenSpeech = await fetch(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: bearerHeaders,
        body: JSON.stringify({ model: "custom/tts-1-hd", input: "hello", voice: "alloy" }),
      });
      expect(forbiddenSpeech.status).toBe(403);

      // 5. Budget hold refusal over live admission returns 429 before dispatch.
      const tightHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${TIGHT_KEY}`,
      };
      const budgetRerank = await fetch(`${base}/v1/rerank`, {
        method: "POST",
        headers: tightHeaders,
        body: JSON.stringify({ model: "custom/rerank-english-v3", query: "hello world", documents: ["document text"] }),
      });
      expect(budgetRerank.status).toBe(429);

      const budgetSpeech = await fetch(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: tightHeaders,
        body: JSON.stringify({ model: "custom/tts-1", input: "hello world test speech", voice: "alloy" }),
      });
      expect(budgetSpeech.status).toBe(429);
    } finally {
      await fixture.close();
    }
  });

  test("blocks unsupported adapters, SSRF metadata/private IPs, and outbound secrets with 0 upstream calls", async () => {
    const home = createTempHome("epx-rerank-speech-guards-");
    process.env.EASYPROXY_HOME = home;
    activeSpendLeases.push(acquireOwnedSpendHome());

    let outboundCalls = 0;
    const redactionPayloads: Array<Record<string, unknown>> = [];
    const spyFetch = (async (_input: unknown, init?: RequestInit) => {
      outboundCalls += 1;
      redactionPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ results: [{ index: 0, relevance_score: 0.9 }] });
    }) as typeof fetch;

    const speechSpyFetch = (async (_input: unknown, init?: RequestInit) => {
      outboundCalls += 1;
      redactionPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x03]), {
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      outboundSecretGuard: { mode: "block" },
      apiKeys: [
        {
          id: "k-tight-budget",
          name: "tight",
          key: "epx_data_tightbudgetkey01",
          createdAt: "2026-01-01T00:00:00Z",
          tpmLimit: 1,
        },
      ],
      providers: {
        anth: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "sk-ant-1",
          models: ["claude-sonnet-4-5"],
          fetch: spyFetch,
        } as EpxProviderTransport as EpxConfig["providers"][string],
        "meta-ssrf": {
          adapter: "openai-compatible",
          baseUrl: "http://169.254.169.254/latest",
          authMode: "key",
          apiKey: "sk-1",
          models: ["m"],
          fetch: spyFetch,
        } as EpxProviderTransport as EpxConfig["providers"][string],
        "priv-ssrf": {
          adapter: "openai-compatible",
          baseUrl: "http://10.0.0.5/v1",
          authMode: "key",
          apiKey: "sk-2",
          models: ["m"],
          fetch: spyFetch,
        } as EpxProviderTransport as EpxConfig["providers"][string],
        good: {
          adapter: "openai-compatible",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-3",
          models: ["rerank-english-v3", "tts-1"],
          fetch: spyFetch,
        } as EpxProviderTransport as EpxConfig["providers"][string],
      },
    };

    // 1. Unsupported adapter & SSRF rejections hit zero upstream fetches.
    for (const model of ["anth/claude-sonnet-4-5", "meta-ssrf/m", "priv-ssrf/m"]) {
      const r1 = await handleRerank(
        new Request("http://127.0.0.1/v1/rerank", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, query: "test", documents: ["doc"] }),
        }),
        cfg,
        {},
        { requestId: `r-ssrf-${model}`, start: Date.now() },
      );
      expect(r1.status).toBe(400);

      const r2 = await handleAudioSpeech(
        new Request("http://127.0.0.1/v1/audio/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: "say hello", voice: "alloy" }),
        }),
        cfg,
        {},
        { requestId: `s-ssrf-${model}`, start: Date.now() },
      );
      expect(r2.status).toBe(400);
    }

    // 2. outboundSecretGuard block mode blocks secrets in rerank query/documents and speech input/instructions.
    const blockedRerank = await handleRerank(
      new Request("http://127.0.0.1/v1/rerank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "good/rerank-english-v3",
          query: `check ${SYNTHETIC_SECRET}`,
          documents: ["clean doc"],
        }),
      }),
      cfg,
      {},
      { requestId: "r-secret-block", start: Date.now() },
    );
    expect(blockedRerank.status).toBe(400);

    const blockedSpeech = await handleAudioSpeech(
      new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "good/tts-1",
          input: "hello",
          voice: "alloy",
          instructions: `do not leak ${SYNTHETIC_SECRET}`,
        }),
      }),
      cfg,
      {},
      { requestId: "s-secret-block", start: Date.now() },
    );
    expect(blockedSpeech.status).toBe(400);

    // 3. Redact mode scrubs secrets in-place before dispatching upstream.
    expect(outboundCalls).toBe(0);

    const redactCfg: EpxConfig = {
      ...cfg,
      outboundSecretGuard: { mode: "redact" },
      providers: {
        ...cfg.providers,
        speechGood: {
          adapter: "openai-compatible",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-4",
          models: ["tts-1"],
          fetch: speechSpyFetch,
        } as EpxProviderTransport as EpxConfig["providers"][string],
      },
    };
    const rRedact = await handleRerank(
      new Request("http://127.0.0.1/v1/rerank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "good/rerank-english-v3",
          query: "normal query",
          documents: [`doc with ${SYNTHETIC_SECRET}`],
        }),
      }),
      redactCfg,
      {},
      { requestId: "r-secret-redact", start: Date.now() },
    );
    expect(rRedact.status).toBe(200);
    expect(JSON.stringify(redactionPayloads[0])).not.toContain(SYNTHETIC_SECRET);

    const sRedact = await handleAudioSpeech(
      new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "speechGood/tts-1",
          input: `read ${SYNTHETIC_SECRET}`,
          voice: "alloy",
        }),
      }),
      redactCfg,
      {},
      { requestId: "s-secret-redact", start: Date.now() },
    );
    expect(sRedact.status).toBe(200);
    expect(JSON.stringify(redactionPayloads[1])).not.toContain(SYNTHETIC_SECRET);
  });

  test("handles combo failover, non-audio 502 guard, binary audio MIME delivery, and usage logging", async () => {
    const home = createTempHome("epx-rerank-speech-combo-");
    process.env.EASYPROXY_HOME = home;
    activeSpendLeases.push(acquireOwnedSpendHome());

    const hits: string[] = [];
    const badProvider: EpxProviderTransport = {
      adapter: "openai-compatible",
      baseUrl: "https://bad.example.test/v1",
      authMode: "key",
      apiKey: "sk-bad",
      models: ["m-bad"],
      fetch: async (input) => {
        const url = String(input);
        hits.push(`bad:${url}`);
        if (url.endsWith("/audio/speech")) {
          // Returning text/html on audio/speech must trigger failover/502, never pass through HTML.
          return new Response("<html>error</html>", { status: 200, headers: { "content-type": "text/html" } });
        }
        return Response.json({ error: { message: "transient error" } }, { status: 502 });
      },
    };
    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]);
    const okProvider: EpxProviderTransport = {
      adapter: "openai-compatible",
      baseUrl: "https://good.example.test/v1",
      authMode: "key",
      apiKey: "sk-good",
      models: ["m-good"],
      fetch: async (input) => {
        const url = String(input);
        hits.push(`good:${url}`);
        if (url.endsWith("/audio/speech")) {
          return new Response(audioBytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json({
          id: "rr_1",
          results: [{ index: 0, relevance_score: 0.98 }],
          meta: { billed_units: { search_units: 1 } },
          usage: { total_tokens: 33 },
        });
      },
    };

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      providers: {
        bad: badProvider as EpxConfig["providers"][string],
        good: okProvider as EpxConfig["providers"][string],
      },
      combos: {
        "data-plane-combo": {
          strategy: "ewma-latency",
          ewmaLatency: { alpha: 0.5, minSamples: 1, errorPenaltyMs: 20_000 },
          targets: [
            { provider: "bad", model: "m-bad" },
            { provider: "good", model: "m-good" },
          ],
        },
        "html-only-speech": {
          strategy: "priority",
          targets: [{ provider: "bad", model: "m-bad" }],
        },
      },
    };

    // 1. Rerank combo failover records EWMA failure on bad and logs usage from good.
    const rrLog: RequestLogContext = { model: "unknown", provider: "unknown" };
    const rerankRes = await handleRerank(
      new Request("http://127.0.0.1/v1/rerank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/data-plane-combo", query: "latency", documents: ["doc a", "doc b"] }),
      }),
      cfg,
      rrLog,
      { requestId: "rr-combo-1", start: Date.now() },
    );
    expect(rerankRes.status).toBe(200);
    const rrBody = await rerankRes.json() as { results: Array<{ relevance_score: number }> };
    expect(rrBody.results[0]!.relevance_score).toBe(0.98);
    expect(snapshotComboEwmaStats("data-plane-combo")["bad/m-bad"]?.consecutiveFailures).toBe(1);

    // 2. Single-target text/html speech response must fail closed with 502.
    const htmlSpeech = await handleAudioSpeech(
      new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/html-only-speech", input: "hello", voice: "alloy" }),
      }),
      cfg,
      {},
      { requestId: "sp-html-502", start: Date.now() },
    );
    expect(htmlSpeech.status).toBe(502);

    // 3. Combo speech failover turns application/octet-stream into audio/wav and returns exact binary bytes.
    const speechRes = await handleAudioSpeech(
      new Request("http://127.0.0.1/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/data-plane-combo",
          input: "hello wav",
          voice: "alloy",
          response_format: "wav",
        }),
      }),
      cfg,
      {},
      { requestId: "sp-combo-1", start: Date.now() },
    );
    expect(speechRes.status).toBe(200);
    expect(speechRes.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await speechRes.arrayBuffer())).toEqual(audioBytes);
    expect(hits).toEqual([
      "bad:https://bad.example.test/v1/rerank",
      "good:https://good.example.test/v1/rerank",
      "bad:https://bad.example.test/v1/audio/speech",
      "good:https://good.example.test/v1/audio/speech",
    ]);

    const entries = getRequestLogEntries();
    expect(entries.some(e => e.requestId === "rr-combo-1" && e.status === 200 && e.totalTokens === 33)).toBe(true);
    expect(entries.some(e => e.requestId === "sp-combo-1" && e.status === 200 && (e.usage?.inputTokens ?? 0) > 0)).toBe(true);
  });
});
