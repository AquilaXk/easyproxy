import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { loadCodexAccountStore, peekCodexAccountRecordSnapshot, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { serializedJsonByteLength } from "../../src/server/json-serialized-bytes";
import { compressToolOutputText } from "../../src/lib/tool-output-compression";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { startServer } from "../../src/server";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { RequestLogContext } from "../../src/server/request-log";
import { createResponsesFieldBackfillBlockRewrite } from "../../src/server/responses/responses-field-backfill";
import { createOutboundCredentialMask, createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { BoundedSseFrameBuffer } from "../../src/server/sse-frame-buffer";
import type { EpxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const AUTH_TOKEN = "hotpath-test-secret";

let testDir = "";
let previousHome: string | undefined;
let previousToken: string | undefined;
const originalFetch = globalThis.fetch;

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const payload = events
    .map(item => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
    .join("");
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function responsesOkSse(): Response {
  return sseResponse([
    { event: "response.created", data: { type: "response.created", response: { id: "resp_hp", object: "response", status: "in_progress", output: [] } } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } } },
    { event: "response.content_part.added", data: { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" } },
    { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } } },
    { event: "response.completed", data: { type: "response.completed", response: { id: "resp_hp", object: "response", status: "completed", output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } },
  ]);
}

function responsesOkJson(): Response {
  return Response.json({
    id: "resp_hp_json",
    object: "response",
    status: "completed",
    output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

function baseConfig(upstreamBaseUrl: string): EpxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-responses",
        baseUrl: upstreamBaseUrl,
        apiKey: "sk-upstream-fixture",
        allowPrivateNetwork: true,
        models: ["mock-model"],
      },
    },
    clientIntegrations: { codex: false },
    webSearchSidecar: { enabled: false },
  } as EpxConfig;
}

describe("gateway hotpath & protocol hygiene", () => {
  beforeEach(() => {
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    testDir = mkdtempSync(join(tmpdir(), "epx-hotpath-"));
    previousHome = process.env.EASYPROXY_HOME;
    previousToken = process.env.EASYPROXY_API_AUTH_TOKEN;
    process.env.EASYPROXY_HOME = testDir;
    process.env.EASYPROXY_API_AUTH_TOKEN = AUTH_TOKEN;
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = previousHome;
    if (previousToken === undefined) delete process.env.EASYPROXY_API_AUTH_TOKEN;
    else process.env.EASYPROXY_API_AUTH_TOKEN = previousToken;
    if (testDir) removeTreeWithRetry(testDir);
    testDir = "";
  });

  test("pre-auth and invalid /v1/messages & /v1/chat/completions keep request timeout active; admitted responses omit Connection: keep-alive", async () => {
    let returnJson = false;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return returnJson ? responsesOkJson() : responsesOkSse();
      },
    });
    saveConfig(baseConfig(`http://127.0.0.1:${upstream.port}/v1`));
    const server = startServer(0);
    const timeoutSpy = spyOn(server, "timeout");
    try {
      const chatUrl = new URL("/v1/chat/completions", server.url).toString();
      const messagesUrl = new URL("/v1/messages", server.url).toString();
      const validBody = (stream: boolean) => JSON.stringify({
        model: "mock/mock-model",
        max_tokens: 16,
        stream,
        messages: [{ role: "user", content: "hi" }],
      });

      // Unauthenticated 401 on both endpoints must NOT disable idle timeout.
      const unauthChat = await originalFetch(chatUrl, { method: "POST", headers: { "content-type": "application/json" }, body: validBody(true) });
      await unauthChat.text();
      expect(unauthChat.status).toBe(401);

      const unauthMsg = await originalFetch(messagesUrl, { method: "POST", headers: { "content-type": "application/json" }, body: validBody(true) });
      await unauthMsg.text();
      expect(unauthMsg.status).toBe(401);

      // Disallowed Origin 403 must NOT disable idle timeout.
      const originChat = await originalFetch(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN, origin: "https://evil.example" },
        body: validBody(true),
      });
      await originChat.text();
      expect(originChat.status).toBe(403);

      const originMsg = await originalFetch(messagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN, origin: "https://evil.example" },
        body: validBody(true),
      });
      await originMsg.text();
      expect(originMsg.status).toBe(403);

      // Malformed JSON 400 must NOT invoke onRequestBodyRead / disable idle timeout.
      const badChat = await originalFetch(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN },
        body: "{bad",
      });
      await badChat.text();
      expect(badChat.status).toBe(400);

      const badMsg = await originalFetch(messagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN },
        body: "{bad",
      });
      await badMsg.text();
      expect(badMsg.status).toBe(400);

      expect(timeoutSpy).toHaveBeenCalledTimes(0);

      // Authenticated streaming requests disable timeout only after bounded body parse succeeds,
      // and omit hop-by-hop `Connection: keep-alive` headers.
      const okChatSse = await originalFetch(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN },
        body: validBody(true),
      });
      const chatText = await okChatSse.text();
      expect(okChatSse.status).toBe(200);
      expect(chatText).toContain("data: [DONE]");
      expect(okChatSse.headers.get("connection")).toBeNull();
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy.mock.calls[0]?.[1]).toBe(0);

      const okMsgSse = await originalFetch(messagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN },
        body: validBody(true),
      });
      const msgText = await okMsgSse.text();
      expect(okMsgSse.status).toBe(200);
      expect(msgText).toContain("message_stop");
      expect(okMsgSse.headers.get("connection")).toBeNull();
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy.mock.calls[1]?.[1]).toBe(0);

      // Synthesized SSE from upstream JSON also omits `Connection: keep-alive`.
      returnJson = true;
      const okChatSynth = await originalFetch(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN },
        body: validBody(true),
      });
      await okChatSynth.text();
      expect(okChatSynth.status).toBe(200);
      expect(okChatSynth.headers.get("connection")).toBeNull();

      const okMsgSynth = await originalFetch(messagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-easyproxy-api-key": AUTH_TOKEN },
        body: validBody(true),
      });
      await okMsgSynth.text();
      expect(okMsgSynth.status).toBe(200);
      expect(okMsgSynth.headers.get("connection")).toBeNull();
    } finally {
      timeoutSpy.mockRestore();
      await server.stop(true);
      upstream.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("inbound chat & messages zero-reserialization bridge fires onRequestBodyRead only on parsed bodies and preserves 413 budget", async () => {
    let seenUpstreamModel: unknown;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const parsed = await req.json() as { model?: unknown };
        seenUpstreamModel = parsed.model;
        return responsesOkJson();
      },
    });
    const config = baseConfig(`http://127.0.0.1:${upstream.port}/v1`);
    saveConfig(config);
    const releaseSpendHome = acquireOwnedSpendHome();

    try {
      let chatHookCalls = 0;
      const chatRes = await handleChatCompletions(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "mock/mock-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
        }),
        config,
        { model: "", provider: "" } as RequestLogContext,
        { requestId: "req-chat-1", start: Date.now(), onRequestBodyRead: () => { chatHookCalls += 1; } },
      );
      expect(chatRes.status).toBe(200);
      expect(chatHookCalls).toBe(1);
      expect(seenUpstreamModel).toBe("mock-model");

      seenUpstreamModel = undefined;
      let msgHookCalls = 0;
      const msgRes = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "mock/mock-model", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hello" }] }),
        }),
        config,
        { model: "", provider: "" } as RequestLogContext,
        { requestId: "req-msg-1", start: Date.now(), onRequestBodyRead: () => { msgHookCalls += 1; } },
      );
      expect(msgRes.status).toBe(200);
      expect(msgHookCalls).toBe(1);
      expect(seenUpstreamModel).toBe("mock-model");

      // Invalid bodies must never trigger onRequestBodyRead.
      let invalidHooks = 0;
      const badChat = await handleChatCompletions(
        new Request("http://localhost/v1/chat/completions", { method: "POST", body: "{bad" }),
        config,
        { model: "", provider: "" } as RequestLogContext,
        { requestId: "req-bad-chat", start: Date.now(), onRequestBodyRead: () => { invalidHooks += 1; } },
      );
      const badMsg = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", { method: "POST", body: "{bad" }),
        config,
        { model: "", provider: "" } as RequestLogContext,
        { requestId: "req-bad-msg", start: Date.now(), onRequestBodyRead: () => { invalidHooks += 1; } },
      );
      expect(badChat.status).toBe(400);
      expect(badMsg.status).toBe(400);
      expect(invalidHooks).toBe(0);

      // Over-budget converted internalBody (> 32 MiB turn cap) trips
      // translatorBudget.chargeRetained(jsonUtf8Bytes(internalBody)) -> 413 without hitting upstream.
      const largePart = "a".repeat(17 * 1024 * 1024);
      const largeMessages = [
        { role: "user", content: largePart },
        { role: "assistant", content: "ok" },
        { role: "user", content: largePart },
      ];
      const overBudgetChat = await handleChatCompletions(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "mock/mock-model",
            stream: false,
            messages: largeMessages,
          }),
        }),
        config,
        { model: "", provider: "" } as RequestLogContext,
      );
      expect(overBudgetChat.status).toBe(413);
      expect((await overBudgetChat.json() as { error?: { code?: string } }).error?.code).toBe("translation_buffer_limit");

      const overBudgetMsg = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "mock/mock-model",
            max_tokens: 16,
            stream: false,
            messages: largeMessages,
          }),
        }),
        config,
        { model: "", provider: "" } as RequestLogContext,
      );
      expect(overBudgetMsg.status).toBe(413);
      expect((await overBudgetMsg.json() as { error?: { code?: string } }).error?.code).toBe("translation_buffer_limit");
    } finally {
      releaseSpendHome();
      upstream.stop(true);
    }
  });

  test("createResponsesFieldBackfillBlockRewrite skips delta JSON.parse cleanly while preserving backfill and \\u escape correctness", () => {
    const rewrite = createResponsesFieldBackfillBlockRewrite();

    // Pure delta frame hits fast-path and keeps identical block reference.
    const deltaBlock = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}';
    const deltaOut = rewrite(deltaBlock);
    expect(deltaOut).toEqual([deltaBlock]);
    expect(deltaOut[0]).toBe(deltaBlock);

    // response.output_item.added without a `"response"` envelope key must NOT be skipped.
    const addedItem = `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    })}`;
    const addedParsed = JSON.parse(rewrite(addedItem)[0]!.split("\ndata: ")[1]!) as { item: Record<string, unknown> };
    expect(typeof addedParsed.item.id).toBe("string");
    expect(addedParsed.item.status).toBe("in_progress");

    // response.content_part.added without `"response"` envelope key backfills missing annotations.
    const partAdded = `event: response.content_part.added\ndata: ${JSON.stringify({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "hi" },
    })}`;
    const partParsed = JSON.parse(rewrite(partAdded)[0]!.split("\ndata: ")[1]!) as { part: Record<string, unknown> };
    expect(partParsed.part.annotations).toEqual([]);

    // Unicode-escaped key (`\u0072esponse` == `response`) bypasses fast-path and still backfills.
    const escapedCompleted = 'event: response.completed\ndata: {"type":"response.completed","\\u0072esponse":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"u"}]}]}}';
    const escapedParsed = JSON.parse(rewrite(escapedCompleted)[0]!.split("\ndata: ")[1]!) as {
      response: { output: Array<Record<string, unknown>> };
    };
    expect(typeof escapedParsed.response.output[0]!.id).toBe("string");
    expect(escapedParsed.response.output[0]!.status).toBe("completed");
  });

  test("createTerminalErrorRedactionBlockRewrite preserves redaction across failed, incomplete, and \\u-escaped frames", () => {
    const secret = ["sk", "hotpath", "fixture", "credential", "999"].join("-");
    const headers = { authorization: `Bearer ${secret}` };
    const rewrite = createTerminalErrorRedactionBlockRewrite(headers, createOutboundCredentialMask(headers));

    // Normal delta skips parse safely and preserves reference.
    const normalDelta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"normal text"}';
    const normalOut = rewrite(normalDelta);
    expect(normalOut).toEqual([normalDelta]);
    expect(normalOut[0]).toBe(normalDelta);

    // event: response.failed frame redacts credential.
    const failedFrame = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: `bad ${secret}` } } })}`;
    expect(rewrite(failedFrame).join("\n")).not.toContain(secret);

    // data-only response.incomplete frame redacts credential.
    const incompleteFrame = `data: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: `limit ${secret}` } } })}`;
    expect(rewrite(incompleteFrame).join("\n")).not.toContain(secret);

    // Unicode-escaped terminal frame bypasses fast-path and redacts credential.
    const escapedFailed = `data: {"type":"\\u0072esponse.failed","response":{"status":"failed","error":{"message":"denied ${secret}"}}}`;
    expect(rewrite(escapedFailed).join("\n")).not.toContain(secret);
  });

  test("BoundedSseFrameBuffer retains <=16 KiB scratch buffer across frames and drops oversized >16 KiB buffers", () => {
    const enc = new TextEncoder();
    const framer = new BoundedSseFrameBuffer();
    const internal = framer as unknown as { candidate: Uint8Array; candidateBytes: number };

    const f1 = enc.encode(`data: ${"x".repeat(4096)}\n\n`);
    const out1 = framer.feed(f1);
    expect(out1).toHaveLength(1);
    expect(out1[0]!.block.byteLength).toBe(f1.byteLength - 2);
    const scratchAfter1 = internal.candidate;
    expect(scratchAfter1.byteLength).toBeGreaterThan(0);
    expect(scratchAfter1.byteLength).toBeLessThanOrEqual(16 * 1024);

    const f2 = enc.encode(`data: ${"y".repeat(4096)}\n\n`);
    const out2 = framer.feed(f2);
    expect(out2).toHaveLength(1);
    expect(out2[0]!.block).not.toBe(out1[0]!.block);
    expect(internal.candidate).toBe(scratchAfter1);

    // Oversized frame (> 16 KiB) emits intact and resets internal scratch to EMPTY_BYTES.
    const fLarge = enc.encode(`data: ${"z".repeat(20 * 1024)}\n\n`);
    const outLarge = framer.feed(fLarge);
    expect(outLarge).toHaveLength(1);
    expect(outLarge[0]!.block.byteLength).toBe(fLarge.byteLength - 2);
    expect(internal.candidate.byteLength).toBe(0);

    // clear() still drops a retained small scratch buffer.
    framer.feed(f1);
    expect(internal.candidate.byteLength).toBeGreaterThan(0);
    framer.clear();
    expect(internal.candidate.byteLength).toBe(0);
  });

  test("loadCodexAccountStore reuses stat-guarded cache across repeated reads and invalidates on persist or disk change", () => {
    saveCodexAccountCredential("cached-a", {
      accessToken: "tk-1",
      refreshToken: "rf-1",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "acct-1",
    });

    const accountsPath = join(testDir, "codex-accounts.json");
    const realRead = fs.readFileSync as (...args: unknown[]) => unknown;
    let diskReads = 0;
    const readSpy = spyOn(fs, "readFileSync");
    readSpy.mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0] === accountsPath) diskReads += 1;
      return realRead(...args);
    }) as unknown as typeof fs.readFileSync);

    try {
      const first = loadCodexAccountStore();
      expect(first["cached-a"]?.accessToken).toBe("tk-1");
      expect(diskReads).toBe(1);

      // Mutating caller-returned copy must not corrupt cached snapshot.
      first["cached-a"]!.accessToken = "mutated-in-caller";

      const second = readCodexAccountRecord("cached-a");
      expect(second?.credential?.accessToken).toBe("tk-1");
      expect(diskReads).toBe(1);

      // persist() invalidates cache.
      saveCodexAccountCredential("cached-a", {
        accessToken: "tk-2",
        refreshToken: "rf-2",
        expiresAt: Date.now() + 60_000,
        chatgptAccountId: "acct-1",
      });
      const third = loadCodexAccountStore();
      expect(third["cached-a"]?.accessToken).toBe("tk-2");
      expect(diskReads).toBe(2);

      // External overwrite invalidates via BigIntStats mismatch (read directly via realRead).
      const diskObj = JSON.parse(realRead(accountsPath, "utf8") as string) as Record<string, { credential: { accessToken: string } }>;
      diskObj["cached-a"]!.credential.accessToken = "tk-external-99999";
      writeFileSync(accountsPath, JSON.stringify(diskObj));
      expect(loadCodexAccountStore()["cached-a"]?.accessToken).toBe("tk-external-99999");
      expect(diskReads).toBe(3);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("serializedJsonByteLength matches Buffer.byteLength(JSON.stringify) across escapes, surrogates, and edge scalars", () => {
    const controlChars = Array.from({ length: 32 }, (_, idx) => String.fromCharCode(idx)).join("");
    const toJsonThrowObj = { toJSON: () => ({ ok: true, msg: "한글 🚀\n\t\"\\" }) };
    const samples: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      123456789,
      -9876.54321,
      NaN,
      Infinity,
      -Infinity,
      "",
      `ascii "quote" \\slash/ ${controlChars}`,
      "한글 é ç Ω ∞ 🚀🔥",
      "\uD800",
      "\uDC00",
      "prefix\uD800middle\uDC00suffix",
      "pair\uD83D\uDE80end",
      [undefined, () => 1, Symbol("s"), -0, NaN, Infinity, "🚀", "\uD800"],
      {
        a: 1,
        omitUndef: undefined,
        omitFn: () => 2,
        [Symbol("sym")]: "hidden",
        nested: { text: "line1\r\nline2\b\f\t", surrogates: "x\uDC01\uD801y" },
      },
      toJsonThrowObj,
      { toJSON: () => undefined },
    ];

    for (const sample of samples) {
      const encoded = JSON.stringify(sample);
      const expected = encoded === undefined ? 0 : Buffer.byteLength(encoded, "utf8");
      expect(serializedJsonByteLength(sample)).toBe(expected);
    }
  });

  test("BoundedSseFrameBuffer retains \\u-escaped terminal frame on overflow and compressToolOutputText preserves formatting", () => {
    const enc = new TextEncoder();
    const framer = new BoundedSseFrameBuffer(256);
    const escapedCompleted = enc.encode('event: response.completed\ndata: {"type":"\\u0072esponse.completed","response":{"id":"r1"}}\n\n');
    const oversizedTail = enc.encode(`data: ${"x".repeat(512)}\n\n`);
    const combined = new Uint8Array(escapedCompleted.byteLength + oversizedTail.byteLength);
    combined.set(escapedCompleted, 0);
    combined.set(oversizedTail, escapedCompleted.byteLength);

    const retained = framer.feed(combined);
    expect(retained).toHaveLength(1);
    expect(new TextDecoder().decode(retained[0]!.block)).toContain("\\u0072esponse.completed");

    const lines = Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0 ? `\x1b[32mline-${i}\x1b[0m` : `detail-${i}`
    );
    const rawLog = `${lines.slice(0, 60).join("\r\n")}\r\n\r\n\r\n\r\n\r\n${lines.slice(60).join("\r\n")}`;
    const compressed = compressToolOutputText(rawLog, {
      enabled: true,
      minChars: 200,
      headChars: 120,
      tailChars: 120,
      stripAnsi: true,
    });
    expect(compressed).not.toContain("\x1b[");
    expect(compressed).not.toContain("\r\n");
    expect(compressed).not.toContain("\n\n\n\n");
    expect(compressed).toContain("line-0");
    expect(compressed).toContain("detail-119");
  });

  test("peekCodexAccountRecordSnapshot reuses cached snapshot without redundant reads or chmods on 0600 stores", () => {
    saveCodexAccountCredential("peek-a", {
      accessToken: "tk-peek-1",
      refreshToken: "rf-peek-1",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "acct-peek-1",
    });

    const accountsPath = join(testDir, "codex-accounts.json");
    const realRead = fs.readFileSync as (...args: unknown[]) => unknown;
    const realChmod = fs.chmodSync as (...args: unknown[]) => unknown;
    let diskReads = 0;
    let chmodCalls = 0;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0] === accountsPath) diskReads += 1;
      return realRead(...args);
    }) as unknown as typeof fs.readFileSync);
    const chmodSpy = spyOn(fs, "chmodSync").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0] === accountsPath) chmodCalls += 1;
      return realChmod(...args);
    }) as unknown as typeof fs.chmodSync);

    try {
      const first = peekCodexAccountRecordSnapshot();
      const second = peekCodexAccountRecordSnapshot();
      expect(first["peek-a"]?.credential?.accessToken).toBe("tk-peek-1");
      expect(second).toBe(first);
      expect(diskReads).toBe(1);
      expect(chmodCalls).toBe(0);
    } finally {
      readSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });
});
