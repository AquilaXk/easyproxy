import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTelemetryCommand } from "../../src/cli/telemetry";
import { getDefaultConfig, loadConfig } from "../../src/config";
import { configuredAdminToken } from "../../src/lib/admin-secrets";
import {
  flushOtlpSpans,
  getOtlpTracingStatsForTests,
  isOtlpTracingEnabled,
  parseW3cTraceparent,
  resetOtlpTracingForTests,
  setOtlpExporterFetchForTests,
  startOtlpRequestSpan,
} from "../../src/telemetry/otlp";
import type { EpxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { settleServerAuthFixture, startManagementServerFixture } from "../helpers/server-auth-fixture";

describe("optional OTLP tracing", () => {
  const homes: string[] = [];
  const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
  const origHome = process.env.EASYPROXY_HOME;

  afterEach(async () => {
    while (servers.length > 0) servers.pop()!.stop(true);
    resetOtlpTracingForTests();
    if (origHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = origHome;
    while (homes.length > 0) {
      const dir = homes.pop()!;
      await settleServerAuthFixture(dir);
      removeTreeWithRetry(dir);
    }
  });

  test("default disabled config has zero overhead and never enqueues spans", async () => {
    const cfg = getDefaultConfig();
    expect(isOtlpTracingEnabled(cfg)).toBe(false);
    let fetchCalled = 0;
    setOtlpExporterFetchForTests((async () => {
      fetchCalled += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    const span = startOtlpRequestSpan(new Request("http://127.0.0.1/v1/responses", { method: "POST" }), cfg, {
      method: "POST",
      pathname: "/v1/responses",
      protocol: "responses",
    });
    expect(span).toBeUndefined();
    await flushOtlpSpans(500);
    expect(getOtlpTracingStatsForTests().enqueuedSpans).toBe(0);
    expect(fetchCalled).toBe(0);
  });

  test("validates W3C traceparent headers strictly and drops invalid or zero IDs", () => {
    expect(parseW3cTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      sampled: true,
    });
    expect(parseW3cTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      sampled: false,
    });
    expect(parseW3cTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseW3cTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
    expect(parseW3cTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
    expect(parseW3cTraceparent("malformed")).toBeNull();
    expect(parseW3cTraceparent(null)).toBeNull();
  });

  test("captures live /v1/responses and /v1/embeddings spans, propagates traceparent outbound, redacts secrets, and flushes to live OTLP collector", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-otlp-live-"));
    homes.push(home);

    const collectedBodies: string[] = [];
    const collectedHeaders: Array<Record<string, string>> = [];
    const collector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const hdrs: Record<string, string> = {};
        req.headers.forEach((v, k) => { hdrs[k] = v; });
        collectedHeaders.push(hdrs);
        collectedBodies.push(await req.text());
        return Response.json({ partialSuccess: {} });
      },
    });
    servers.push(collector);

    const upstreamHeaders: Array<Record<string, string>> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const hdrs: Record<string, string> = {};
        req.headers.forEach((v, k) => { hdrs[k] = v; });
        upstreamHeaders.push(hdrs);
        const url = new URL(req.url);
        if (url.pathname.endsWith("/embeddings")) {
          return Response.json({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [1, 2] }],
            model: "test-model",
            usage: { prompt_tokens: 9, total_tokens: 9 },
          });
        }
        return Response.json({
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "test-model",
          output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
        });
      },
    });
    servers.push(upstream);

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "0.0.0.0",
      defaultProvider: "custom",
      apiKeys: [
        {
          id: "k-otlp-key",
          name: "otlp-client",
          key: "epx_data_otlpclientsecret01",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "sk-test-900upstream",
          models: ["test-model"],
        },
      },
      otlp: {
        enabled: true,
        endpoint: `http://127.0.0.1:${collector.port}/v1/traces`,
        headers: { "x-otlp-secret": "collector-token-xyz" },
        serviceName: "epx-test-service",
        sampleRate: 1,
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // 1. /v1/responses with inbound traceparent & sensitive prompt/query
      const resResp = await fetch(`${base}/v1/responses?secretQuery=dontleak`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": "epx_data_otlpclientsecret01",
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        },
        body: JSON.stringify({
          model: "custom/test-model",
          input: "PRIVATE PROMPT TEXT MUST NOT EXPORT",
          stream: false,
        }),
      });
      expect(resResp.status).toBe(200);

      // 2. /v1/embeddings without inbound traceparent (generates root trace)
      const resEmb = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": "epx_data_otlpclientsecret01",
        },
        body: JSON.stringify({
          model: "custom/test-model",
          input: "PRIVATE EMBEDDING PROMPT",
        }),
      });
      expect(resEmb.status).toBe(200);

      await flushOtlpSpans(5_000);
      expect(collectedBodies.length).toBeGreaterThanOrEqual(1);
      const joinedRaw = collectedBodies.join("\n");

      // Strict redaction guarantees: prompts, upstream/client keys, and query parameters never appear in OTLP body.
      expect(joinedRaw).not.toContain("PRIVATE PROMPT TEXT MUST NOT EXPORT");
      expect(joinedRaw).not.toContain("PRIVATE EMBEDDING PROMPT");
      expect(joinedRaw).not.toContain("sk-test-900upstream");
      expect(joinedRaw).not.toContain("epx_data_otlpclientsecret01");
      expect(joinedRaw).not.toContain("secretQuery");
      expect(joinedRaw).not.toContain("dontleak");

      // Auth header sent to collector
      expect(collectedHeaders[0]?.["x-otlp-secret"]).toBe("collector-token-xyz");
      expect(collectedHeaders[0]?.["content-type"]).toBe("application/json");

      const spans = collectedBodies.flatMap(raw => {
        const parsed = JSON.parse(raw) as {
          resourceSpans: Array<{
            resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
            scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
          }>;
        };
        expect(parsed.resourceSpans[0]?.resource.attributes.some(a =>
          a.key === "service.name" && a.value.stringValue === "epx-test-service")).toBe(true);
        return parsed.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans));
      });

      const respSpan = spans.find(s => s.traceId === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(respSpan).toBeDefined();
      expect(respSpan?.parentSpanId).toBe("bbbbbbbbbbbbbbbb");
      expect(respSpan?.name).toBe("POST /v1/responses");

      const embSpan = spans.find(s => s.name === "POST /v1/embeddings");
      expect(embSpan).toBeDefined();

      // Outbound traceparent reached upstream on both protocols
      expect(upstreamHeaders[0]?.traceparent).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/);
      expect(upstreamHeaders[1]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    } finally {
      await fixture.close();
    }
  });

  test("bounded queue drops oldest spans on overflow without crashing", async () => {
    const exportedBatches: number[] = [];
    setOtlpExporterFetchForTests((async (_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
      exportedBatches.push(parsed.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0);
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    const cfg: Pick<EpxConfig, "otlp"> = {
      otlp: {
        enabled: true,
        endpoint: "http://127.0.0.1:4318/v1/traces",
        maxQueueSize: 16,
        batchSize: 64,
        sampleRate: 1,
      },
    };
    for (let i = 0; i < 25; i += 1) {
      const span = startOtlpRequestSpan(new Request("http://127.0.0.1/v1/responses", { method: "POST" }), cfg, {
        method: "POST",
        pathname: "/v1/responses",
        protocol: "responses",
      });
      span?.finish({ status: 200 });
    }
    const preFlush = getOtlpTracingStatsForTests();
    expect(preFlush.queuedSpans).toBe(16);
    expect(preFlush.droppedSpans).toBe(9);
    await flushOtlpSpans(5_000);
    expect(getOtlpTracingStatsForTests().exportedSpans).toBe(16);
    expect(exportedBatches.reduce((a, b) => a + b, 0)).toBe(16);
  });

  test("management /api/telemetry/otlp validates SSRF, masks headers, and matches CLI epx telemetry otlp status/set/clear", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-otlp-mgmt-"));
    homes.push(home);

    const fixture = await startManagementServerFixture(home, getDefaultConfig());
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      const admin = configuredAdminToken()!;
      const headers = { "content-type": "application/json", "x-easyproxy-api-key": admin };

      // 1. Validation rejections (400): metadata IP, non-loopback plain HTTP, too many headers
      for (const invalid of [
        { enabled: true, endpoint: "http://169.254.169.254/v1/traces" },
        { enabled: true, endpoint: "http://collector.example.com/v1/traces" },
        {
          enabled: true,
          endpoint: "https://collector.example.com/v1/traces",
          headers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`x-h-${i}`, "v"])),
        },
        { enabled: true },
      ]) {
        const res = await fetch(`${base}/api/telemetry/otlp`, {
          method: "PUT",
          headers,
          body: JSON.stringify(invalid),
        });
        expect(res.status).toBe(400);
      }

      // 2. PUT valid HTTPS collector with secret headers -> GET returns masked projection only
      const putOk = await fetch(`${base}/api/telemetry/otlp`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          enabled: true,
          endpoint: "https://otel.example.com/v1/traces",
          headers: { authorization: "Bearer access-token-value-otlp01" },
          serviceName: "prod-epx",
          sampleRate: 0.5,
        }),
      });
      expect(putOk.status).toBe(200);
      const putJson = await putOk.json() as Record<string, unknown>;
      expect(putJson.headerKeys).toEqual(["authorization"]);
      expect(putJson.headersConfigured).toBe(true);
      expect(putJson.headers).toBeUndefined();
      expect(JSON.stringify(putJson)).not.toContain("access-token-value-otlp01");

      const getRes = await fetch(`${base}/api/telemetry/otlp`, { headers });
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json() as Record<string, unknown>;
      expect(getJson).toMatchObject({
        enabled: true,
        endpoint: "https://otel.example.com/v1/traces",
        headerKeys: ["authorization"],
        headersConfigured: true,
        serviceName: "prod-epx",
        sampleRate: 0.5,
      });
      expect(JSON.stringify(getJson)).not.toContain("access-token-value-otlp01");

      // 3. CLI `epx telemetry otlp set|status|clear` against live fixture management API
      const cliDeps = { baseUrl: base };
      expect(await handleTelemetryCommand([
        "otlp", "set",
        "--enabled", "true",
        "--endpoint", "http://127.0.0.1:4318/v1/traces",
        "--service-name", "cli-svc",
        "--sample-rate", "0.25",
        "--json",
      ], cliDeps)).toBe(0);
      expect(loadConfig().otlp).toMatchObject({
        enabled: true,
        endpoint: "http://127.0.0.1:4318/v1/traces",
        serviceName: "cli-svc",
        sampleRate: 0.25,
      });

      expect(await handleTelemetryCommand(["otlp", "status", "--json"], cliDeps)).toBe(0);
      expect(await handleTelemetryCommand(["otlp", "clear", "--json"], cliDeps)).toBe(0);
      expect(loadConfig().otlp).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  test("rejects oversized PUT /api/telemetry/otlp bodies (413), enforces un-mocked DNS SSRF protection, and isolates batch headers/privacy", async () => {
    const home = mkdtempSync(join(tmpdir(), "epx-otlp-hardening-"));
    homes.push(home);
    const cfg = getDefaultConfig();
    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      const oversized = JSON.stringify({
        enabled: true,
        endpoint: "http://127.0.0.1:4318/v1/traces",
        serviceName: "x".repeat(70 * 1024),
      });
      const res413 = await fetch(`${base}/api/telemetry/otlp`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-easyproxy-api-key": configuredAdminToken()!,
        },
        body: oversized,
      });
      expect(res413.status).toBe(413);
    } finally {
      await fixture.close();
    }

    // Un-mocked exportBatch fails closed when collector hostname does not resolve cleanly.
    setOtlpExporterFetchForTests(null);
    const unreachableCfg: Pick<EpxConfig, "otlp"> = {
      otlp: {
        enabled: true,
        endpoint: "https://nonexistent.collector.invalid/v1/traces",
        sampleRate: 1,
      },
    };
    const span = startOtlpRequestSpan(new Request("http://127.0.0.1/v1/responses", { method: "POST" }), unreachableCfg, {
      method: "POST",
      pathname: "/v1/responses",
      protocol: "responses",
    });
    span?.finish({ status: 200 });
    await flushOtlpSpans(1_500);
    expect(getOtlpTracingStatsForTests().exportFailures).toBe(1);
    expect(getOtlpTracingStatsForTests().exportedSpans).toBe(0);

    // Spans with distinct headers or allowPrivateNetwork do not coalesce into the same batch.
    resetOtlpTracingForTests();
    const sentAuths: Array<string | undefined> = [];
    setOtlpExporterFetchForTests((async (_url, init) => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      sentAuths.push(hdrs.authorization);
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    const cfgA: Pick<EpxConfig, "otlp"> = {
      otlp: { enabled: true, endpoint: "https://collector.invalid/v1/traces", headers: { authorization: "Bearer a" }, sampleRate: 1 },
    };
    const cfgB: Pick<EpxConfig, "otlp"> = {
      otlp: { enabled: true, endpoint: "https://collector.invalid/v1/traces", headers: { authorization: "Bearer b" }, sampleRate: 1 },
    };
    startOtlpRequestSpan(new Request("http://127.0.0.1/v1/responses", { method: "POST" }), cfgA, {
      method: "POST", pathname: "/v1/responses", protocol: "responses",
    })?.finish({ status: 200 });
    startOtlpRequestSpan(new Request("http://127.0.0.1/v1/responses", { method: "POST" }), cfgB, {
      method: "POST", pathname: "/v1/responses", protocol: "responses",
    })?.finish({ status: 200 });
    await flushOtlpSpans(1_500);
    expect(sentAuths).toEqual(["Bearer a", "Bearer b"]);
  });

  test("forwards OTLP traceparent on /v1/messages native passthrough", async () => {
    const { handleClaudeMessages } = await import("../../src/server/claude-messages");
    const seenTraceparents: Array<string | undefined> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seenTraceparents.push(req.headers.get("traceparent") ?? undefined);
        return Response.json({
          id: "msg_native_otlp",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 2 },
        });
      },
    });
    servers.push(upstream);

    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      claudeCode: { nativePassthrough: true, anthropicBaseUrl: `http://127.0.0.1:${upstream.port}` },
      otlp: { enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces", sampleRate: 1 },
    };
    const req = new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-native-fixture",
        traceparent: "00-22222222222222222222222222222222-3333333333333333-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const span = startOtlpRequestSpan(req, cfg, { method: "POST", pathname: "/v1/messages", protocol: "messages" });
    const res = await handleClaudeMessages(req, cfg, { model: "unknown", provider: "unknown", otlpSpan: span });
    expect(res.status).toBe(200);
    expect(seenTraceparents).toHaveLength(1);
    expect(seenTraceparents[0]).toBe(span?.traceparent);
    expect(seenTraceparents[0]).toMatch(/^00-22222222222222222222222222222222-[0-9a-f]{16}-01$/);
    expect(seenTraceparents[0]).not.toBe("00-22222222222222222222222222222222-3333333333333333-01");
  });
});
