import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { handleGuardrailsCommand } from "../../src/cli/guardrails";
import { configuredAdminToken } from "../../src/lib/admin-secrets";
import { inspectAndApplyOutboundSecretGuard, MAX_SECRET_SCAN_DEPTH } from "../../src/lib/outbound-secret-guard";
import { cloneMutableJsonGraph } from "../../src/lib/mutable-json-copy";
import { injectPromptCacheBreakpointsInPlace } from "../../src/lib/prompt-cache-injection";
import { compressResponsesToolOutputsInPlace } from "../../src/lib/tool-output-compression";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
import type { EpxProviderTransport } from "../../src/providers/xai-transport";
import { handleAudioTranscriptions } from "../../src/server/audio-transcriptions";
import { handleClaudeCountTokens } from "../../src/server/claude-messages";
import { handleEmbeddings } from "../../src/server/embeddings";
import { handleImages } from "../../src/server/images";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import {
  applyOutboundPayloadHygiene,
  evaluateOutboundPayloadHygiene,
  prepareCompactionBodyHygiene,
  resetOutboundHygieneStatsForTests,
} from "../../src/server/outbound-payload-hygiene";
import * as requestDecompress from "../../src/server/request-decompress";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import { redactHostedImageDisplayPaths } from "../../src/server/responses-hosted-image-display";
import { handleSearch } from "../../src/server/search";
import type { WsData } from "../../src/server/ws-bridge";
import type { EpxConfig } from "../../src/types";
import { DICTS } from "../../gui/src/i18n/shared";
import {
  acknowledgeInjection,
  advertiseInjection,
  completeInjection,
  continuationFrame,
  InjectionSocket,
  waitForInjection,
  type Frame,
} from "../helpers/native-injection-fixture";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { managementHeaders, startManagementServerFixture } from "../helpers/server-auth-fixture";

const SYNTHETIC_SECRET = ["sk", "proj", `synthetic${"0".repeat(22)}`].join("-");

let previousHome: string | undefined;
const homes: string[] = [];
const spendLeases: Array<() => void> = [];

function createTempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
}

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  resetOutboundHygieneStatsForTests();
  clearRequestLogsForTests();
  resetSharedSpendLedgerForTest();
});

afterEach(() => {
  for (const release of spendLeases.splice(0)) {
    try {
      release();
    } catch {
      // Ignore already-released lease.
    }
  }
  resetOutboundHygieneStatsForTests();
  clearRequestLogsForTests();
  resetSharedSpendLedgerForTest();
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  for (const h of homes.splice(0)) {
    removeTreeWithRetry(h);
  }
});

describe("Defect 1: French i18n ttftCompact translation and GUI change-gate scripts", () => {
  test("French ux.logs.ttftCompact differs from English while preserving {ms} placeholder", () => {
    expect(DICTS.fr["ux.logs.ttftCompact"]).not.toBe(DICTS.en["ux.logs.ttftCompact"]);
    expect(DICTS.fr["ux.logs.ttftCompact"]).toContain("{ms}");
  });

  test("GUI change-detection scripts apply slash guard, origin/main ref order, and pinned execPath", () => {
    const scripts = [
      { file: "scripts/doctor-gui-if-changed.ts", dryVar: "DOCTOR_DRY_RUN", filesVar: "DOCTOR_FILES", runToken: "doctor:run", skipToken: "doctor:skip" },
      { file: "scripts/lint-gui-if-changed.ts", dryVar: "LINT_DRY_RUN", filesVar: "LINT_FILES", runToken: "lint:run", skipToken: "lint:skip" },
      { file: "scripts/typecheck-gui-if-changed.ts", dryVar: "TYPECHECK_DRY_RUN", filesVar: "TYPECHECK_FILES", runToken: "typecheck:run", skipToken: "typecheck:skip" },
    ] as const;

    for (const entry of scripts) {
      const root = repoRoot();
      const source = readFileSync(join(root, entry.file), "utf8");
      expect(source).toContain('["upstream/main", "origin/main", "main"]');
      expect(source).toContain("process.execPath");

      const runRes = spawnSync(process.execPath, [join(root, entry.file)], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, [entry.dryVar]: "1", [entry.filesVar]: "gui/src/App.tsx\n" },
      });
      expect(runRes.status).toBe(0);
      expect(runRes.stdout).toContain(entry.runToken);

      const skipRes = spawnSync(process.execPath, [join(root, entry.file)], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, [entry.dryVar]: "1", [entry.filesVar]: "gui-other/index.ts\nsrc/server.ts\n" },
      });
      expect(skipRes.status).toBe(0);
      expect(skipRes.stdout).toContain(entry.skipToken);
    }
  });
});

describe("Defects 2 & 9: Guardrails partial merge, CLI parity, and scenario-routing CORS", () => {
  test("PUT /api/gateway-guardrails merges partially without clobbering siblings and epx guardrails CLI achieves parity", async () => {
    const home = createTempHome("epx-guardrails-merge-cli-");
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "127.0.0.1",
      corsAllowOrigins: ["https://console.example.test"],
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-mock",
          models: ["gpt-5"],
        },
      },
    };

    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;

      // 1. Seed full config across all three sections.
      const seedRes = await fetch(`${base}/api/gateway-guardrails`, {
        method: "PUT",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          outboundSecretGuard: { mode: "redact" },
          toolOutputCompression: {
            enabled: true,
            minChars: 4000,
            headChars: 1000,
            tailChars: 1000,
            stripAnsi: true,
            compactJson: true,
            foldRepetitiveLines: true,
            deduplicateIdentical: true,
            dedupMinChars: 512,
          },
          promptCacheInjection: {
            enabled: true,
            ttl: "1h",
            stripVolatileSystemTimestamps: true,
          },
        }),
      });
      expect(seedRes.status).toBe(200);

      // 2. Partial PUT changing only promptCacheInjection preserves secretGuard and toolOutputCompression intact.
      const partialRes = await fetch(`${base}/api/gateway-guardrails`, {
        method: "PUT",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          promptCacheInjection: { stripVolatileSystemTimestamps: false },
          toolOutputCompression: { foldRepetitiveLines: false },
        }),
      });
      expect(partialRes.status).toBe(200);
      const partialJson = await partialRes.json() as Record<string, Record<string, unknown>>;
      expect(partialJson.outboundSecretGuard?.mode).toBe("redact");
      expect(partialJson.toolOutputCompression).toMatchObject({
        enabled: true,
        minChars: 4000,
        foldRepetitiveLines: false,
        dedupMinChars: 512,
      });
      expect(partialJson.promptCacheInjection).toEqual({
        enabled: true,
        ttl: "1h",
        stripVolatileSystemTimestamps: false,
      });

      // 3. epx guardrails CLI (`set`, `status`, `dry-run`) parity with new flags.
      const token = configuredAdminToken()!;
      const authedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.set("x-easyproxy-api-key", token);
        return fetch(input, { ...init, headers });
      }) as typeof fetch;

      const origLog = console.log;
      const outputs: string[] = [];
      console.log = (...args: unknown[]) => {
        outputs.push(args.map(a => String(a)).join(" "));
      };
      try {
        const setCode = await handleGuardrailsCommand(
          [
            "set",
            "--compact-json", "off",
            "--fold-lines", "on",
            "--dedup", "on",
            "--dedup-min-chars", "256",
            "--cache-inject", "on",
            "--cache-ttl", "1h",
            "--strip-timestamps", "on",
          ],
          { baseUrl: base, fetchImpl: authedFetch },
        );
        expect(setCode).toBe(0);

        const cliText = outputs.join("\n");
        expect(cliText).toContain("compactJson=false");
        expect(cliText).toContain("foldRepetitiveLines=true");
        expect(cliText).toContain("Prompt cache injection: enabled=true ttl=1h stripVolatileSystemTimestamps=true");

        outputs.length = 0;
        const sample = JSON.stringify({
          model: "claude-sonnet-4-5",
          system: "System rules",
          messages: [{ role: "user", content: JSON.stringify({ a: Array.from({ length: 12 }, (_, i) => i) }, null, 2) }],
        });
        const dryCode = await handleGuardrailsCommand(
          ["dry-run", "--text", sample, "--compact-json", "on", "--duplicate-pass", "--json"],
          { baseUrl: base, fetchImpl: authedFetch },
        );
        expect(dryCode).toBe(0);
        const dryJson = JSON.parse(outputs.join("\n")) as Record<string, unknown>;
        expect(dryJson.contextInspection).toBeDefined();

        outputs.length = 0;
        const bpSample = JSON.stringify({
          model: "claude-sonnet-4-5",
          system: [{ type: "text", text: "System rules", cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: "hello" }],
        });
        const dryTextCode = await handleGuardrailsCommand(
          ["dry-run", "--text", bpSample],
          { baseUrl: base, fetchImpl: authedFetch },
        );
        expect(dryTextCode).toBe(0);
        expect(outputs.join("\n")).toContain("breakpoints=1");
      } finally {
        console.log = origLog;
      }

      // 4. Defect (9): /api/routing/scenario honors CORS Origin allowlist on GET/PUT/classify/DELETE.
      const allowedOrigin = "https://console.example.test";
      const scenarioHeaders = managementHeaders({ "content-type": "application/json", origin: allowedOrigin });

      const getScenario = await fetch(`${base}/api/routing/scenario`, { headers: scenarioHeaders });
      expect(getScenario.status).toBe(200);
      expect(getScenario.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

      const putScenario = await fetch(`${base}/api/routing/scenario`, {
        method: "PUT",
        headers: scenarioHeaders,
        body: JSON.stringify({
          enabled: true,
          routes: { think: "mock/gpt-5" },
        }),
      });
      expect(putScenario.status).toBe(200);
      expect(putScenario.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

      const classifyScenario = await fetch(`${base}/api/routing/scenario/classify`, {
        method: "POST",
        headers: scenarioHeaders,
        body: JSON.stringify({ body: { reasoning: { effort: "high" } } }),
      });
      expect(classifyScenario.status).toBe(200);
      expect(classifyScenario.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

      const deleteScenario = await fetch(`${base}/api/routing/scenario`, {
        method: "DELETE",
        headers: scenarioHeaders,
      });
      expect(deleteScenario.status).toBe(200);
      expect(deleteScenario.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    } finally {
      await fixture.close();
    }
  });
});

describe("Defect 3: dry-run contextInspection hygiene, WS inject/steer & continuation recovery, and endpoint blind spots", () => {
  test("dry-run contextInspection blocks or redacts secrets and measures compressed token savings", async () => {
    const home = createTempHome("epx-dryrun-ctx-");
    const cfg: EpxConfig = {
      ...getDefaultConfig(),
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-mock",
          models: ["gpt-5"],
        },
      },
    };
    const fixture = await startManagementServerFixture(home, cfg);
    try {
      const base = `http://127.0.0.1:${fixture.server.port}`;
      const noisyOutput = `${"ok-line\n".repeat(120)}debug-marker`;
      const payloadWithSecret = JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: `${noisyOutput} leak=${SYNTHETIC_SECRET}` },
            ],
          },
        ],
      });

      // Block mode hides contextInspection completely rather than returning raw unredacted content.
      const blocked = await fetch(`${base}/api/gateway-guardrails/dry-run`, {
        method: "POST",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          text: payloadWithSecret,
          outboundSecretGuard: { mode: "block" },
          toolOutputCompression: { enabled: true, minChars: 512, headChars: 60, tailChars: 60 },
        }),
      });
      expect(blocked.status).toBe(200);
      const blockedJson = await blocked.json() as Record<string, unknown>;
      expect(blockedJson.blocked).toBe(true);
      expect(blockedJson.contextInspection).toBeUndefined();
      expect(String(blockedJson.previewText ?? "")).not.toContain(SYNTHETIC_SECRET);

      // Redact mode scrubs secrets in both preview and contextInspection and reflects compression savings.
      const uncompacted = await fetch(`${base}/api/gateway-guardrails/dry-run`, {
        method: "POST",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          text: payloadWithSecret,
          outboundSecretGuard: { mode: "redact" },
          toolOutputCompression: { enabled: false },
        }),
      });
      const uncompactedJson = await uncompacted.json() as {
        contextInspection?: { usedTokens?: number };
      };

      const compacted = await fetch(`${base}/api/gateway-guardrails/dry-run`, {
        method: "POST",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          text: payloadWithSecret,
          outboundSecretGuard: { mode: "redact" },
          toolOutputCompression: { enabled: true, minChars: 512, headChars: 60, tailChars: 60 },
        }),
      });
      expect(compacted.status).toBe(200);
      const compactedJson = await compacted.json() as {
        blocked: boolean;
        redactions: number;
        contextInspection?: { usedTokens?: number };
      };
      expect(compactedJson.blocked).toBe(false);
      expect(compactedJson.redactions).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(compactedJson)).not.toContain(SYNTHETIC_SECRET);
      expect(compactedJson.contextInspection?.usedTokens).toBeGreaterThan(0);
      expect(compactedJson.contextInspection?.usedTokens).toBeLessThan(
        uncompactedJson.contextInspection?.usedTokens ?? 0,
      );
    } finally {
      await fixture.close();
    }
  });

  test("WebSocket response.inject blocks/redacts secrets and continuation recovers from cross-batch deduplication mismatch", async () => {
    const home = createTempHome("epx-ws-hygiene-");
    process.env.EASYPROXY_HOME = home;
    const origWebSocket = globalThis.WebSocket;
    const origFetch = globalThis.fetch;
    InjectionSocket.all = [];
    InjectionSocket.suppressAutoCreated = false;
    spendLeases.push(acquireOwnedSpendHome());

    const settings: EpxConfig = {
      ...getDefaultConfig(),
      defaultProvider: "openai",
      websockets: true,
      codexNativeInjection: true,
      outboundSecretGuard: { mode: "block" },
      toolOutputCompression: {
        enabled: true,
        minChars: 20_000,
        headChars: 1000,
        tailChars: 1000,
        deduplicateIdentical: true,
        dedupMinChars: 128,
      },
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    };
    saveConfig(settings);

    const openClients: Array<ServerWebSocket<WsData>> = [];
    try {
      globalThis.WebSocket = InjectionSocket as unknown as typeof WebSocket;
      globalThis.fetch = (async () => {
        throw new Error("network disabled in isolated ws fixture");
      }) as typeof fetch;

      const openTurn = async (cfg: EpxConfig) => {
        const handler = createWebsocketHandler({ config: cfg, deps: {} } as ServeOptionsContext);
        const sent: Frame[] = [];
        const headers = new Headers({ authorization: "Bearer test", "thread-id": `ws-hygiene-${Date.now()}-${Math.random()}` });
        const ws = {
          readyState: 1,
          data: { headers } as WsData,
          send: (text: string) => {
            sent.push(JSON.parse(text));
            return 1;
          },
          close() {
            handler.close(ws, 1000, "test close");
          },
        } as unknown as ServerWebSocket<WsData>;
        openClients.push(ws);
        handler.message(ws, JSON.stringify({
          type: "response.create",
          model: "gpt-5.6-sol",
          input: "initial",
          multi_agent: { enabled: true },
          tools: [{ type: "function", name: "get_value", parameters: { type: "object", properties: {} } }],
        }));
        await waitForInjection(() => sent.some(f => f.type === "response.created"));
        const socket = InjectionSocket.all.at(-1)!;
        return { handler, ws, sent, socket, id: socket.root, send: (frame: Frame) => handler.message(ws, JSON.stringify(frame)) };
      };

      // 1. Secret block rejects response.inject before reaching upstream socket.
      const blockedTurn = await openTurn(settings);
      blockedTurn.send({
        type: "response.inject",
        response_id: blockedTurn.id,
        input: [{ type: "function_call_output", call_id: "c1", output: `secret=${SYNTHETIC_SECRET}` }],
      });
      await waitForInjection(() => blockedTurn.sent.some(f => f.type === "error"));
      expect(blockedTurn.sent.at(-1)?.error?.code).toBe("outbound_secret_guard");
      expect(blockedTurn.socket.frames).toHaveLength(1);

      // 2. Identical outputs submitted as two separate failed response.inject frames stay usable on combined continuation!
      const redactSettings: EpxConfig = { ...settings, outboundSecretGuard: { mode: "redact" } };
      const dupTurn = await openTurn(redactSettings);
      advertiseInjection(dupTurn.socket, "call-a", 0);
      advertiseInjection(dupTurn.socket, "call-b", 1);
      const longOutput = "identical-tool-output-chunk ".repeat(20);
      const item1 = { type: "function_call_output", call_id: "call-a", output: `${longOutput} ${SYNTHETIC_SECRET}` };
      const item2 = { type: "function_call_output", call_id: "call-b", output: `${longOutput} ${SYNTHETIC_SECRET}` };

      dupTurn.send({ type: "response.inject", response_id: dupTurn.id, input: [item1] });
      expect(dupTurn.socket.frames).toHaveLength(2);
      expect(JSON.stringify(dupTurn.socket.frames[1])).not.toContain(SYNTHETIC_SECRET);

      dupTurn.socket.emit({
        type: "response.inject.failed",
        response_id: dupTurn.id,
        sequence_number: 100,
        input: dupTurn.socket.frames[1].input,
        error: { code: "response_already_completed", message: "done" },
      });
      await waitForInjection(() => dupTurn.sent.filter(f => f.type === "response.inject.failed").length === 1);

      dupTurn.send({ type: "response.inject", response_id: dupTurn.id, input: [item2] });
      expect(dupTurn.socket.frames).toHaveLength(3);
      expect(JSON.stringify(dupTurn.socket.frames[2])).not.toContain(SYNTHETIC_SECRET);
      completeInjection(dupTurn.socket);
      dupTurn.socket.emit({
        type: "response.inject.failed",
        response_id: dupTurn.id,
        sequence_number: 101,
        input: dupTurn.socket.frames[2].input,
        error: { code: "response_already_completed", message: "done" },
      });
      await waitForInjection(() => dupTurn.sent.filter(f => f.type === "response.inject.failed").length === 2);

      // Resubmit combined continuation -> recovers cleanly instead of failing with invalid_injection!
      dupTurn.send(continuationFrame({
        type: "response.create",
        previous_response_id: dupTurn.id,
        input: [item1, item2],
      }));
      await waitForInjection(() => dupTurn.socket.frames.length === 4);
      expect(dupTurn.sent.some(f => f.error?.code === "invalid_injection")).toBe(false);
      expect(JSON.stringify(dupTurn.socket.frames[3])).not.toContain(SYNTHETIC_SECRET);
      dupTurn.socket.emit({ type: "response.created", response: { id: "succ", previous_response_id: dupTurn.id } });
      completeInjection(dupTurn.socket, {}, "succ");
      acknowledgeInjection(dupTurn.socket);
      await waitForInjection(() => !dupTurn.ws.data.nativeControl);
    } finally {
      for (const client of openClients) {
        try {
          client.close();
        } catch {
          // Ignore.
        }
        try {
          await waitForInjection(() => client.data.cancel === undefined && client.data.nativeControl === undefined);
        } catch {
          // Ignore timeout during teardown.
        }
      }
      for (const s of InjectionSocket.all.splice(0)) {
        try {
          s.close();
        } catch {
          // Ignore.
        }
      }
      try {
        runOptionalShutdownHooks();
      } catch {
        // Ignore.
      }
      globalThis.WebSocket = origWebSocket;
      globalThis.fetch = origFetch;
    }
  });

  test("count_tokens, embeddings, alpha/search, images, and audio/transcriptions prompt enforce outboundSecretGuard", async () => {
    const home = createTempHome("epx-endpoints-hygiene-");
    process.env.EASYPROXY_HOME = home;
    spendLeases.push(acquireOwnedSpendHome());

    let upstreamHits = 0;
    let lastImgBody: Record<string, unknown> | undefined;
    const imgServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        upstreamHits += 1;
        lastImgBody = await req.json() as Record<string, unknown>;
        return Response.json({ created: 1, data: [{ b64_json: "iVBORw0KGgo=" }] });
      },
    });
    const neverCalledFetch = (async () => {
      upstreamHits += 1;
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const cfg: EpxConfig = {
        ...getDefaultConfig(),
        outboundSecretGuard: { mode: "block" },
        images: { provider: "imgOk" },
        providers: {
          compat: {
            adapter: "openai-compatible",
            baseUrl: "https://api.example.test/v1",
            authMode: "key",
            apiKey: "sk-up",
            models: ["text-embedding-3-small", "whisper-1", "gpt-image-1"],
            fetch: neverCalledFetch,
          } as EpxProviderTransport as EpxConfig["providers"][string],
          imgOk: {
            adapter: "openai-responses",
            baseUrl: `${imgServer.url.toString().replace(/\/$/, "")}/v1`,
            authMode: "key",
            apiKey: "sk-img",
            allowPrivateNetwork: true,
            models: ["gpt-image-1"],
          },
          anth: {
            adapter: "anthropic",
            baseUrl: "https://api.anthropic.com",
            authMode: "key",
            apiKey: "sk-ant",
            models: ["claude-sonnet-4-5"],
            fetch: neverCalledFetch,
          } as EpxProviderTransport as EpxConfig["providers"][string],
        },
        webSearchSidecar: { enabled: true, backend: "anthropic" },
      };
      saveConfig(cfg);
      const loopbackAdmission = { kind: "loopback" as const, source: "loopback" as const };

      // 1. /v1/messages/count_tokens blocks secret before token counting / upstream call.
      const countRes = await handleClaudeCountTokens(
        new Request("http://127.0.0.1/v1/messages/count_tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "anth/claude-sonnet-4-5",
            messages: [{ role: "user", content: `count ${SYNTHETIC_SECRET}` }],
          }),
        }),
        cfg,
      );
      expect(countRes.status).toBe(400);

      // 2. /v1/embeddings blocks secret in input.
      const embRes = await handleEmbeddings(
        new Request("http://127.0.0.1/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "compat/text-embedding-3-small",
            input: `embed ${SYNTHETIC_SECRET}`,
          }),
        }),
        cfg,
        {},
        { requestId: "emb-block", start: Date.now() },
      );
      expect(embRes.status).toBe(400);

      // 3. /v1/alpha/search blocks secret in query.
      const searchRes = await handleSearch(
        new Request("http://127.0.0.1/v1/alpha/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: `search ${SYNTHETIC_SECRET}` }),
        }),
        cfg,
        {},
        undefined,
        loopbackAdmission,
      );
      expect(searchRes.status).toBe(400);

      // 4. /v1/audio/transcriptions blocks secret in multipart `prompt` field.
      const audioForm = new FormData();
      audioForm.append("file", new Blob(["fake-webm-bytes"], { type: "audio/webm" }), "clip.webm");
      audioForm.append("model", "compat/whisper-1");
      audioForm.append("prompt", `hint ${SYNTHETIC_SECRET}`);
      const audioRes = await handleAudioTranscriptions(
        new Request("http://127.0.0.1/v1/audio/transcriptions", { method: "POST", body: audioForm }),
        cfg,
        {},
        loopbackAdmission,
      );
      expect(audioRes.status).toBe(400);

      // 5. /v1/images/generations blocks secret inside prompt...
      const imgBlock = await handleImages(
        new Request("http://127.0.0.1/v1/images/generations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "imgOk/gpt-image-1",
            prompt: `draw ${SYNTHETIC_SECRET}`,
          }),
        }),
        cfg,
        "generations",
        {},
        undefined,
        loopbackAdmission,
      );
      expect(imgBlock.status).toBe(400);
      expect(upstreamHits).toBe(0);

      // ...while /v1/images/edits skips large inline data:image base64 blobs cleanly (including mixed/uppercase DATA:) and succeeds!
      const largeDataUrl = `data:image/png;base64,${"A".repeat(120_000)}`;
      const upperDataUrl = `  DATA:image/png;base64,${"A".repeat(120_000)}_${SYNTHETIC_SECRET}`;
      const upperArrayDataUrl = `  DATA:image/png;base64,${"B".repeat(16)}_${SYNTHETIC_SECRET}`;
      const imgSafe = await handleImages(
        new Request("http://127.0.0.1/v1/images/edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "imgOk/gpt-image-1",
            prompt: "clean portrait edit",
            image_url: upperDataUrl,
            images: [
              largeDataUrl,
              upperArrayDataUrl,
              { url: `Data:image/png;base64,${SYNTHETIC_SECRET}` },
              { image_url: `dAtA:image/png;base64,${SYNTHETIC_SECRET}` },
              { image_url: { url: `DATA:image/jpeg;base64,${SYNTHETIC_SECRET}` } },
            ],
          }),
        }),
        cfg,
        "edits",
        {},
        undefined,
        loopbackAdmission,
      );
      expect(imgSafe.status).toBe(200);
      expect(upstreamHits).toBe(1);

      // In redact mode, mixed/uppercase DATA: strings in `images` stay intact (not overwritten with "") while text/https fields redact.
      const redactCfg: EpxConfig = { ...cfg, outboundSecretGuard: { mode: "redact" } };
      saveConfig(redactCfg);
      const imgRedact = await handleImages(
        new Request("http://127.0.0.1/v1/images/edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "imgOk/gpt-image-1",
            prompt: `edit with ${SYNTHETIC_SECRET}`,
            images: [
              upperArrayDataUrl,
              `https://example.invalid/ref.png?token=${SYNTHETIC_SECRET}`,
            ],
          }),
        }),
        redactCfg,
        "edits",
        {},
        undefined,
        loopbackAdmission,
      );
      expect(imgRedact.status).toBe(200);
      expect(upstreamHits).toBe(2);
      expect(lastImgBody?.prompt).toBe("edit with [REDACTED:openai_key]");
      expect(lastImgBody?.images).toEqual([
        upperArrayDataUrl,
        "https://example.invalid/ref.png?token=[REDACTED:openai_key]",
      ]);
    } finally {
      await imgServer.stop(true);
    }
  });

  test("frozen and non-writable payloads redact, compress, and inject cache breakpoints on copies without mutating originals", async () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object") {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) {
          deepFreeze(child);
        }
      }
      return value;
    };

    const noisyLines = "ok-line\n".repeat(120);
    const frozenAnthropic = deepFreeze({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: `${"Static architectural guideline. ".repeat(90)}\nCurrent time: 2026-11-27T04:12:00Z`,
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Prompt conversation context for caching. ".repeat(70),
            },
            {
              type: "tool_result",
              tool_use_id: "tu_frozen_1",
              content: `${noisyLines} secret=${SYNTHETIC_SECRET}`,
            },
          ],
        },
      ],
    });
    const originalSnapshot = JSON.stringify(frozenAnthropic);

    const hygiene = applyOutboundPayloadHygiene(frozenAnthropic, {
      outboundSecretGuard: { mode: "redact" },
      toolOutputCompression: { enabled: true, minChars: 512, headChars: 60, tailChars: 60 },
      promptCacheInjection: { enabled: true, ttl: "1h", stripVolatileSystemTimestamps: true },
    });
    expect(hygiene.blocked).toBe(false);
    expect(hygiene.redactions).toBe(1);
    expect(hygiene.compressedItems).toBe(1);
    expect(hygiene.injectedCacheBreakpoints).toBe(2);
    // Original deeply-frozen payload remains untouched.
    expect(JSON.stringify(frozenAnthropic)).toBe(originalSnapshot);
    const sanitized = hygiene.body as typeof frozenAnthropic;
    expect(sanitized).not.toBe(frozenAnthropic);
    expect(JSON.stringify(sanitized)).not.toContain(SYNTHETIC_SECRET);
    expect(sanitized.system[0]!.text).toContain("Current time: 2026-11-27");
    expect(sanitized.system[0]!.text).not.toContain("04:12:00Z");
    expect((sanitized.system[0] as unknown as Record<string, unknown>).cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(sanitized.messages[0]!.content[1]!.content).toContain("repeated 119 more times");

    // Shallowly frozen root with mutable nested objects must NOT mutate nested objects either.
    const shallowMutableNested = { query: `find ${SYNTHETIC_SECRET}` };
    const shallowFrozen = Object.freeze({ nested: shallowMutableNested });
    const shallowResult = evaluateOutboundPayloadHygiene(shallowFrozen, {
      outboundSecretGuard: { mode: "redact" },
    });
    expect(shallowMutableNested.query).toContain(SYNTHETIC_SECRET);
    expect((shallowResult.body as typeof shallowFrozen).nested.query).toBe("find [REDACTED:openai_key]");

    // Mutable wrapper around frozen subtree + non-writable property on mutable object.
    const frozenLeaf = Object.freeze({ text: `token=${SYNTHETIC_SECRET}` });
    const nonWritableHolder: Record<string, unknown> = {};
    Object.defineProperty(nonWritableHolder, "token", {
      value: SYNTHETIC_SECRET,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    const mixed = { frozenLeaf, nonWritableHolder };
    const mixedGuard = inspectAndApplyOutboundSecretGuard(mixed, { mode: "redact" });
    expect(mixedGuard.redactions).toBe(2);
    expect(frozenLeaf.text).toContain(SYNTHETIC_SECRET);
    expect(nonWritableHolder.token).toBe(SYNTHETIC_SECRET);
    const mixedBody = mixedGuard.body as { frozenLeaf: { text: string }; nonWritableHolder: { token: string } };
    expect(mixedBody.frozenLeaf.text).toBe("token=[REDACTED:openai_key]");
    expect(mixedBody.nonWritableHolder.token).toBe("[REDACTED:openai_key]");

    // Direct calls to compression, cache-injection, and hosted-image path redaction on frozen objects.
    const frozenComp = deepFreeze({
      input: [{ type: "function_call_output", call_id: "c1", output: noisyLines }],
    });
    const compRes = compressResponsesToolOutputsInPlace(frozenComp, {
      enabled: true,
      minChars: 256,
      headChars: 40,
      tailChars: 40,
    });
    expect(compRes.compressedItems).toBe(1);
    expect(frozenComp.input[0]!.output).toBe(noisyLines);
    expect((compRes.body as typeof frozenComp).input[0]!.output).toContain("repeated 119 more times");

    const frozenCache = deepFreeze({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Static prompt ".repeat(200) }],
    });
    const cacheRes = injectPromptCacheBreakpointsInPlace(frozenCache, { enabled: true });
    expect(cacheRes.injectedBreakpoints).toBe(1);
    expect(typeof frozenCache.messages[0]!.content).toBe("string");
    expect(Array.isArray((cacheRes.body as typeof frozenCache).messages[0]!.content)).toBe(true);

    const frozenImg = deepFreeze({ input: [{ role: "assistant", content: "plain text" }] });
    expect(redactHostedImageDisplayPaths(frozenImg)).toBe(frozenImg);

    // Cyclic frozen object and sealed objects are handled without infinite loops or TypeError.
    const cyclicFrozen: Record<string, unknown> = { text: `token ${SYNTHETIC_SECRET}` };
    cyclicFrozen.self = cyclicFrozen;
    Object.freeze(cyclicFrozen);
    const cyclicGuard = inspectAndApplyOutboundSecretGuard(cyclicFrozen, { mode: "redact" });
    expect(cyclicGuard.redactions).toBe(1);
    expect(cyclicFrozen.text).toContain(SYNTHETIC_SECRET);
    const cyclicBody = cyclicGuard.body as Record<string, unknown>;
    expect(cyclicBody.text).toBe("token [REDACTED:openai_key]");
    expect(cyclicBody.self).toBe(cyclicBody);

    const sealedAnthropic = Object.seal({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: Object.seal([Object.seal({ role: "user", content: "Static prompt ".repeat(200) })]),
    });
    const sealedCache = injectPromptCacheBreakpointsInPlace(sealedAnthropic, { enabled: true });
    expect(sealedCache.injectedBreakpoints).toBe(1);
    expect(typeof sealedAnthropic.messages[0]!.content).toBe("string");
    expect(Array.isArray((sealedCache.body as typeof sealedAnthropic).messages[0]!.content)).toBe(true);

    // cloneMutableJsonGraph fails closed when node/depth bounds are exceeded.
    const deepInput = Object.freeze({ a: Object.freeze({ b: Object.freeze({ c: 1 }) }) });
    expect(cloneMutableJsonGraph(deepInput, 100, 1)).toEqual({ value: deepInput, limitExceeded: true });
    expect(cloneMutableJsonGraph(deepInput, 2, 10)).toEqual({ value: deepInput, limitExceeded: true });

    // handleSearch with frozen body returned by readJsonRequestBody under mode="redact" forwards redacted copy.
    const home = createTempHome("epx-search-frozen-");
    process.env.EASYPROXY_HOME = home;
    spendLeases.push(acquireOwnedSpendHome());
    const forwardedSearchBodies: Array<Record<string, unknown>> = [];
    const origFetch = globalThis.fetch;
    const readSpy = spyOn(requestDecompress, "readJsonRequestBody");
    try {
      const frozenSearchBody = deepFreeze({
        query: `lookup ${SYNTHETIC_SECRET}`,
        commands: { search_query: [{ q: `lookup ${SYNTHETIC_SECRET}` }] },
      });
      readSpy.mockResolvedValueOnce(frozenSearchBody);
      globalThis.fetch = (async (_input, init) => {
        forwardedSearchBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json({ results: [] }, { status: 200 });
      }) as typeof fetch;

      const searchCfg: EpxConfig = {
        ...getDefaultConfig(),
        outboundSecretGuard: { mode: "redact" },
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            codexAccountMode: "direct",
          },
        },
      };
      saveConfig(searchCfg);

      const searchRes = await handleSearch(
        new Request("http://127.0.0.1/v1/alpha/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-123" })}`,
            "chatgpt-account-id": "acct-123",
          },
          body: "{}",
        }),
        searchCfg,
        {},
        undefined,
        { kind: "loopback", source: "loopback" },
      );
      expect(searchRes.status).toBe(200);
      expect(forwardedSearchBodies).toHaveLength(1);
      expect(JSON.stringify(forwardedSearchBodies[0])).not.toContain(SYNTHETIC_SECRET);
      expect(JSON.stringify(forwardedSearchBodies[0])).toContain("[REDACTED:openai_key]");
      expect(frozenSearchBody.query).toContain(SYNTHETIC_SECRET);

      // handleResponses with frozen preparsedBody attached via attachParsedRequestBody under mode="redact".
      const forwardedRespBodies: Array<Record<string, unknown>> = [];
      const frozenResponsesBody = deepFreeze({
        model: "mock/gpt-5",
        input: [
          {
            role: "user",
            content: `answer ${SYNTHETIC_SECRET}`,
          },
        ],
      });
      const respCfg: EpxConfig = {
        ...getDefaultConfig(),
        defaultProvider: "mock",
        outboundSecretGuard: { mode: "redact" },
        providers: {
          mock: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            authMode: "key",
            apiKey: "sk-mock",
            models: ["gpt-5"],
            fetch: (async (_input, init) => {
              forwardedRespBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
              return Response.json({
                id: "chat-ok",
                object: "chat.completion",
                model: "gpt-5",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              });
            }) as typeof fetch,
          } as EpxProviderTransport as EpxConfig["providers"][string],
        },
      };
      saveConfig(respCfg);
      const respReq = new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      requestDecompress.attachParsedRequestBody(respReq, frozenResponsesBody);
      const respRes = await handleResponses(respReq, respCfg, {});
      expect(respRes.status).toBe(200);
      expect(forwardedRespBodies).toHaveLength(1);
      expect(JSON.stringify(forwardedRespBodies[0])).not.toContain(SYNTHETIC_SECRET);
      expect(JSON.stringify(forwardedRespBodies[0])).toContain("[REDACTED:openai_key]");
      expect(frozenResponsesBody.input[0]!.content).toContain(SYNTHETIC_SECRET);

      // handleResponses with frozen preparsedBody + --fast under mode="off" succeeds without TypeError or original mutation.
      const frozenFastReq = new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const frozenFastBody = deepFreeze({
        model: "mock/gpt-5--fast",
        input: [{ role: "user", content: "fast turn" }],
      });
      requestDecompress.attachParsedRequestBody(frozenFastReq, frozenFastBody);
      const fastOffCfg: EpxConfig = {
        ...respCfg,
        outboundSecretGuard: { mode: "off" },
      };
      const frozenFastRes = await handleResponses(frozenFastReq, fastOffCfg, {});
      expect(frozenFastRes.status).toBe(200);
      expect(frozenFastBody.model).toBe("mock/gpt-5--fast");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = origFetch;
    }
  });

  test("shared/aliased frozen subtrees, cycles, shallow-before-deep limits, and compaction hygiene redact every path without leaking", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object") {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) {
          deepFreeze(child);
        }
      }
      return value;
    };

    // 1. Shared frozen object referenced across multiple paths in mutable root.
    const sharedFrozen = Object.freeze({ text: `token=${SYNTHETIC_SECRET}` });
    const aliasedRes = inspectAndApplyOutboundSecretGuard(
      { first: sharedFrozen, second: sharedFrozen },
      { mode: "redact" },
    );
    expect(aliasedRes.redactions).toBe(1);
    expect(sharedFrozen.text).toContain(SYNTHETIC_SECRET);
    const aliasedOut = aliasedRes.body as { first: { text: string }; second: { text: string } };
    expect(aliasedOut.first.text).toBe("token=[REDACTED:openai_key]");
    expect(aliasedOut.second.text).toBe("token=[REDACTED:openai_key]");

    // 2. Shared mutable object referenced inside both frozen and mutable parents (both key orders).
    for (const order of ["mutable-first", "frozen-first"] as const) {
      const sharedMut = { text: `token=${SYNTHETIC_SECRET}` };
      const container = order === "mutable-first"
        ? { a: { sub: sharedMut }, b: Object.freeze({ sub: sharedMut }) }
        : { a: Object.freeze({ sub: sharedMut }), b: { sub: sharedMut } };
      const mixedRes = inspectAndApplyOutboundSecretGuard(container, { mode: "redact" });
      const mixedOut = mixedRes.body as { a: { sub: { text: string } }; b: { sub: { text: string } } };
      expect(mixedOut.a.sub.text).toBe("token=[REDACTED:openai_key]");
      expect(mixedOut.b.sub.text).toBe("token=[REDACTED:openai_key]");
    }

    // 3. Shared frozen item duplicated inside input[] during tool-output compression.
    const noisy = "ok-line\n".repeat(120);
    const sharedTool = Object.freeze({ type: "function_call_output", call_id: "c_dup", output: noisy });
    const compAlias = compressResponsesToolOutputsInPlace(
      Object.freeze({ input: Object.freeze([sharedTool, sharedTool]) }),
      { enabled: true, minChars: 256, headChars: 40, tailChars: 40 },
    );
    const compOut = compAlias.body as { input: Array<{ output: string }> };
    expect(compOut.input[0]!.output).toContain("repeated 119 more times");
    expect(compOut.input[1]!.output).toContain("repeated 119 more times");
    expect(sharedTool.output).toBe(noisy);

    // 4. Mutually cyclic frozen objects preserve cycle identity after redaction.
    const nodeA: Record<string, unknown> = {};
    const nodeB: Record<string, unknown> = { a: nodeA, secret: `key=${SYNTHETIC_SECRET}` };
    nodeA.b = nodeB;
    Object.freeze(nodeA);
    Object.freeze(nodeB);
    const mutualCyclic = inspectAndApplyOutboundSecretGuard(nodeA, { mode: "redact" });
    expect(mutualCyclic.redactions).toBe(1);
    const outA = mutualCyclic.body as { b: { a: unknown; secret: string } };
    expect(outA.b.secret).toBe("key=[REDACTED:openai_key]");
    expect(outA.b.a).toBe(outA);
    expect(nodeB.secret).toContain(SYNTHETIC_SECRET);

    // 5. Frozen object exceeding MAX_SECRET_SCAN_DEPTH still redacts shallow secrets before limit abort.
    let deepChain: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i <= MAX_SECRET_SCAN_DEPTH + 1; i += 1) {
      deepChain = { child: deepChain };
    }
    const frozenShallowPlusDeep = deepFreeze({ secret: SYNTHETIC_SECRET, deepChain });
    const shallowDeepRes = inspectAndApplyOutboundSecretGuard(frozenShallowPlusDeep, { mode: "redact" });
    expect(shallowDeepRes.limitExceeded).toBe(true);
    expect(shallowDeepRes.redactions).toBe(1);
    expect((shallowDeepRes.body as { secret: string }).secret).toBe("[REDACTED:openai_key]");
    expect(frozenShallowPlusDeep.secret).toBe(SYNTHETIC_SECRET);

    // 6. prepareCompactionBodyHygiene returns sanitized copy for frozen compaction payloads.
    const frozenCompact = deepFreeze({
      model: "gpt-5",
      input: [{ role: "user", content: `compact ${SYNTHETIC_SECRET}` }],
    });
    const compactOutcome = prepareCompactionBodyHygiene(frozenCompact, {
      outboundSecretGuard: { mode: "redact" },
    });
    expect(compactOutcome.blocked).toBe(false);
    expect(compactOutcome.redactions).toBe(1);
    expect((compactOutcome.body as typeof frozenCompact).input[0]!.content).toBe("compact [REDACTED:openai_key]");
    expect(frozenCompact.input[0]!.content).toContain(SYNTHETIC_SECRET);
  });

  test("extensible object and array with non-writable secret before writable sibling secret mask all siblings on CoW clone without mutating caller", () => {
    const secret2 = ["ghp", "9876543210abcdefghij987654"].join("_");

    // 1. Extensible record: non-writable secret1 followed by writable secret2 inside { x: shared } and aliased { a: shared, b: shared }.
    const shared: Record<string, unknown> = {};
    Object.defineProperty(shared, "secret1", {
      value: `first=${SYNTHETIC_SECRET}`,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    shared.secret2 = `second=${secret2}`;

    const objPayload = { x: shared };
    const objRes = inspectAndApplyOutboundSecretGuard(objPayload, { mode: "redact" });
    expect(objRes.blocked).toBe(false);
    expect(objRes.redactions).toBe(2);
    const objOut = objRes.body as { x: { secret1: string; secret2: string } };
    expect(objOut.x).not.toBe(shared);
    expect(objOut.x.secret1).toBe("first=[REDACTED:openai_key]");
    expect(objOut.x.secret2).toBe("second=[REDACTED:github_token]");
    expect(shared.secret1).toBe(`first=${SYNTHETIC_SECRET}`);
    expect(shared.secret2).toBe(`second=${secret2}`);

    const aliasedRes = inspectAndApplyOutboundSecretGuard({ a: shared, b: shared }, { mode: "redact" });
    expect(aliasedRes.redactions).toBe(2);
    const aliasedOut = aliasedRes.body as {
      a: { secret1: string; secret2: string };
      b: { secret1: string; secret2: string };
    };
    expect(aliasedOut.a.secret1).toBe("first=[REDACTED:openai_key]");
    expect(aliasedOut.a.secret2).toBe("second=[REDACTED:github_token]");
    expect(aliasedOut.b).toBe(aliasedOut.a);
    expect(shared.secret2).toBe(`second=${secret2}`);

    // 2. Extensible array: non-writable element 0 followed by writable element 1.
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      value: `arr0=${SYNTHETIC_SECRET}`,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    arr[1] = `arr1=${secret2}`;

    const arrRes = inspectAndApplyOutboundSecretGuard({ items: arr }, { mode: "redact" });
    expect(arrRes.blocked).toBe(false);
    expect(arrRes.redactions).toBe(2);
    const arrOut = arrRes.body as { items: string[] };
    expect(arrOut.items).not.toBe(arr);
    expect(arrOut.items[0]).toBe("arr0=[REDACTED:openai_key]");
    expect(arrOut.items[1]).toBe("arr1=[REDACTED:github_token]");
    expect(arr[0]).toBe(`arr0=${SYNTHETIC_SECRET}`);
    expect(arr[1]).toBe(`arr1=${secret2}`);

    // 3. Tool-output compression with non-writable block[0].text and writable sibling block[1].text on extensible array/object.
    const noisy1 = "step-alpha\n".repeat(120);
    const noisy2 = "step-beta\n".repeat(120);
    const part0: Record<string, unknown> = { type: "text" };
    Object.defineProperty(part0, "text", {
      value: noisy1,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    const part1: Record<string, unknown> = { type: "text", text: noisy2 };
    const blocks: unknown[] = [];
    Object.defineProperty(blocks, 0, {
      value: part0,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    blocks[1] = part1;
    const compRes = compressResponsesToolOutputsInPlace(
      { input: [{ type: "function_call_output", call_id: "c_cow", output: blocks }] },
      { enabled: true, minChars: 256, headChars: 40, tailChars: 40 },
    );
    expect(compRes.compressedItems).toBe(2);
    const compBlocks = (compRes.body as { input: Array<{ output: Array<{ text: string }> }> }).input[0]!.output;
    expect(compBlocks[0]!.text).toContain("repeated 119 more times");
    expect(compBlocks[1]!.text).toContain("repeated 119 more times");
    expect(part0.text).toBe(noisy1);
  });
});
