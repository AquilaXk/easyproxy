import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import {
  PER_MESSAGE_EFFORT_BETA,
  resetPerMessageEffortStoreForTests,
} from "../../src/adapters/anthropic/per-message-effort";
import {
  CONFIGURATION_UPDATE_CAPABILITY_TTL_MS,
  isConfigurationUpdateUnsupportedMemoized,
  matchConfigurationUpdate400Rejection,
  rememberConfigurationUpdateUnsupported,
  resetConfigurationUpdateCapabilityMemoForTests,
} from "../../src/adapters/openai-responses/config-update-fallback";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses } from "../../src/server/responses/core";
import {
  codexWsActualSentFrame,
  isCodexWsPreOutputRefusal,
  recordCodexWsActualSentFrame,
  restoreCodexWsPreOutputRefusal,
} from "../../src/server/responses/codex-ws-wire";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { setCodexWsIncrementalUpload } from "../../src/server/responses/codex-ws-incremental";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { refusedConfigurationUpdateStrip } from "../../src/server/responses/core-opaque-recovery";
import { setCodexWsReuseAcrossTurns } from "../../src/config/codex-ws-reuse-setting";
import type { EpxConfig, EpxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const NEW_META = JSON.stringify({ history_initialization: "New" });
const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const devMsg = (text: string) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
const asstMsg = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const callItem = { type: "function_call", call_id: "call_tool_1", name: "shell", arguments: "{\"cmd\":\"pwd\"}" };
const outItem = { type: "function_call_output", call_id: "call_tool_1", output: "/tmp" };
const cfgUpdate = { type: "configuration_update", reasoning: { effort: "high" } };

const frame = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function anthropicToolCallSse(callId: string, usage: { read: number; write: number }): string {
  return [
    frame("message_start", { message: { id: "msg_tool", usage: { input_tokens: 3, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write } } }),
    frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: callId, name: "shell", input: {} } }),
    frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"pwd\"}" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
    frame("message_stop", {}),
  ].join("");
}

function anthropicTextSse(text: string, usage: { read: number; write: number }): string {
  return [
    frame("message_start", { message: { id: "msg_txt", usage: { input_tokens: 3, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write } } }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    frame("message_stop", {}),
  ].join("");
}

function responsesSseDone(text: string): string {
  return [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    })}\n\n`,
  ].join("");
}

function stripCacheControl(messages: Array<Record<string, unknown>>) {
  return messages.map(msg => ({
    ...msg,
    content: Array.isArray(msg.content)
      ? msg.content.map((b) => {
          const rec = b as Record<string, unknown>;
          const { cache_control: _cc, ...rest } = rec;
          return rest;
        })
      : msg.content,
  }));
}

function outputItemsOf(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown> };
      if (json.type === "response.output_item.done" && json.item) items.push(json.item);
    } catch { /* ignore */ }
  }
  return items;
}

describe("Phase 1-A: Anthropic prompt cache prefix array stability", () => {
  test("string user and developer messages always serialize as block arrays across moving breakpoints", async () => {
    const adapter = createAnthropicAdapter({
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
    } as EpxProviderConfig);

    const buildBody = async (input: unknown[]) => {
      const parsed = parseRequest({ model: "claude-sonnet-5-5", stream: true, input });
      const req = await adapter.buildRequest(parsed);
      return JSON.parse(String(req.body)) as { messages: Array<Record<string, unknown>> };
    };

    const t1 = await buildBody([devMsg("dev note"), userMsg("turn 1")]);
    const t2 = await buildBody([devMsg("dev note"), userMsg("turn 1"), asstMsg("reply 1"), userMsg("turn 2")]);
    const t3 = await buildBody([
      devMsg("dev note"), userMsg("turn 1"), asstMsg("reply 1"), userMsg("turn 2"), asstMsg("reply 2"), userMsg("turn 3"),
    ]);

    for (const body of [t1, t2, t3]) {
      for (const msg of body.messages) {
        if (msg.role === "user") expect(Array.isArray(msg.content)).toBe(true);
      }
    }
    // Turn 1's user/developer turn must keep identical structure (no string<->array flip) on turns 2 and 3.
    expect(stripCacheControl(t1.messages.slice(0, 1))).toEqual(stripCacheControl(t2.messages.slice(0, 1)));
    expect(stripCacheControl(t2.messages.slice(0, 3))).toEqual(stripCacheControl(t3.messages.slice(0, 3)));
  });
});

describe("Phase 1-A: perMessageEffort extensions and 400 recovery", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  let sent: Array<{ body: Record<string, any>; headers: Headers }>;
  let replies: Array<() => Response>;

  beforeEach(() => {
    resetPerMessageEffortStoreForTests();
    resetConfigurationUpdateCapabilityMemoForTests();
    releaseSpendHome = acquireOwnedSpendHome();
    sent = [];
    replies = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) });
      const next = replies.shift();
      if (!next) throw new Error("unexpected upstream send");
      return next();
    }) as typeof fetch;
  });

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  const provider = (modelOverrides: Partial<EpxProviderConfig> = {}): EpxProviderConfig & { fetch: typeof fetch } => ({
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    defaultMaxOutputTokens: 64000,
    perMessageEffort: true,
    fetch: globalThis.fetch,
    ...modelOverrides,
  });

  async function turn(config: EpxConfig, model: string, input: unknown[], effort: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    const res = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, input, stream: true, reasoning: { effort }, prompt_cache_key: "thread-p1a", ...extra }),
    }), config, { model: "", provider: "" }, {});
    return { status: res.status, text: await res.text() };
  }

  const shellTools = [{
    type: "function",
    name: "shell",
    description: "Run shell command",
    parameters: { type: "object", properties: { cmd: { type: "string" } } },
  }];

  test.each(["claude-fable-5-1", "claude-fable-5-2"])("%s supports tool-only batch boundary effort changes and preserves prefix", async (modelId) => {
    const config = { providers: { "anthropic-key": provider() } } as unknown as EpxConfig;
    replies.push(
      () => new Response(anthropicToolCallSse("call_tool_1", { read: 0, write: 1000 }), { headers: { "content-type": "text/event-stream" } }),
      () => new Response(anthropicTextSse("after tool", { read: 1000, write: 200 }), { headers: { "content-type": "text/event-stream" } }),
      () => new Response(anthropicTextSse("third", { read: 1200, write: 100 }), { headers: { "content-type": "text/event-stream" } }),
    );
    const input1 = [userMsg("check pwd")];
    const r1 = await turn(config, `anthropic-key/${modelId}`, input1, "low", { "x-codex-turn-metadata": NEW_META }, { tools: shellTools });
    expect(r1.status).toBe(200);

    const outItems1 = outputItemsOf(r1.text);
    const input2 = [...input1, ...outItems1, outItem];
    const r2 = await turn(config, `anthropic-key/${modelId}`, input2, "high", {}, { tools: shellTools });
    expect(r2.status).toBe(200);
    expect(sent[1]!.body.output_config).toEqual({ effort: "low" });
    const msgs2 = sent[1]!.body.messages as Array<Record<string, unknown>>;
    expect(msgs2.at(-2)).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
    expect(JSON.stringify(msgs2.at(-1))).toContain("tool_result");

    const input3 = [...input2, ...outputItemsOf(r2.text), userMsg("summarize")];
    const r3 = await turn(config, `anthropic-key/${modelId}`, input3, "medium", {}, { tools: shellTools });
    expect(r3.status).toBe(200);
    const msgs3 = sent[2]!.body.messages as Array<Record<string, unknown>>;
    // Earlier tool-only change point remains at exact same index in turn 3 prefix.
    expect(msgs3[msgs2.length - 2]).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
    expect(msgs3.at(-2)).toEqual({ role: "system", content: [], output_config: { effort: "medium" } });
  });

  test("pre-output Anthropic 400 rejecting per-message effort strips control, resends once, and memoizes unsupported for 1h", async () => {
    const config = { providers: { "anthropic-key": provider() } } as unknown as EpxConfig;
    replies.push(
      () => new Response(anthropicTextSse("ok 1", { read: 0, write: 1000 }), { headers: { "content-type": "text/event-stream" } }),
      () => new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "output_config.effort requires a model that supports per-turn effort; this model does not" },
      }), { status: 400, headers: { "content-type": "application/json" } }),
      () => new Response(anthropicTextSse("ok after strip", { read: 0, write: 1000 }), { headers: { "content-type": "text/event-stream" } }),
      () => new Response(anthropicTextSse("chat 2 skips beta", { read: 0, write: 1000 }), { headers: { "content-type": "text/event-stream" } }),
    );
    const input1 = [userMsg("start")];
    const r1 = await turn(config, "anthropic-key/claude-sonnet-5-5", input1, "high", { "x-codex-turn-metadata": NEW_META });
    expect(r1.status).toBe(200);

    const input2 = [...input1, ...outputItemsOf(r1.text), userMsg("lower")];
    const r2 = await turn(config, "anthropic-key/claude-sonnet-5-5", input2, "low");
    expect(r2.status).toBe(200);
    expect(sent).toHaveLength(3); // turn1 + rejected turn2 + 1 repaired resend
    expect(sent[1]!.headers.get("anthropic-beta") ?? "").toContain(PER_MESSAGE_EFFORT_BETA);
    expect(sent[2]!.headers.get("anthropic-beta") ?? "").not.toContain(PER_MESSAGE_EFFORT_BETA);
    expect(sent[2]!.body.output_config).toEqual({ effort: "low" });
    expect((sent[2]!.body.messages as Array<{ role: string }>).some(m => m.role === "system")).toBe(false);

    // Subsequent request within 1 hour skips perMessageEffort proactively.
    const r3 = await turn(config, "anthropic-key/claude-sonnet-5-5", [userMsg("new chat")], "high", { "x-codex-turn-metadata": NEW_META });
    expect(r3.status).toBe(200);
    expect(sent).toHaveLength(4);
    expect(sent[3]!.headers.get("anthropic-beta") ?? "").not.toContain(PER_MESSAGE_EFFORT_BETA);
  });

  test("OpenAI direct route input[N] configuration_update 400 strips and resends once + 1h memo, preserving effort enum downgrade", async () => {
    const config = {
      providers: {
        "openai-direct": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-openai-test",
          reasoningEfforts: ["low", "medium", "high"],
          fetch: globalThis.fetch,
        },
      },
    } as unknown as EpxConfig;

    replies.push(
      () => new Response(JSON.stringify({
        error: {
          message: "Invalid value: 'configuration_update'. Supported values are: 'message', 'function_call_output'.",
          type: "invalid_request_error",
          param: "input[1].type",
          code: "invalid_value",
        },
      }), { status: 400, headers: { "content-type": "application/json" } }),
      () => new Response(responsesSseDone("repaired direct response"), { headers: { "content-type": "text/event-stream" } }),
      () => new Response(responsesSseDone("memoized clean request"), { headers: { "content-type": "text/event-stream" } }),
    );

    const res1 = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-direct/gpt-5.6-sol",
        stream: true,
        reasoning: { effort: "high" },
        input: [userMsg("turn 1"), cfgUpdate, userMsg("turn 2")],
      }),
    }), config, { model: "", provider: "" }, {});
    expect(res1.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.input.some((i: any) => i.type === "configuration_update")).toBe(true);
    expect(sent[1]!.body.input.some((i: any) => i.type === "configuration_update")).toBe(false);
    expect(isConfigurationUpdateUnsupportedMemoized("api.openai.com", "gpt-5.6-sol")).toBe(true);

    // Next request strips configuration_update proactively within 1 hour.
    const res2 = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-direct/gpt-5.6-sol",
        stream: true,
        reasoning: { effort: "high" },
        input: [userMsg("another"), cfgUpdate, userMsg("again")],
      }),
    }), config, { model: "", provider: "" }, {});
    expect(res2.status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.body.input.some((i: any) => i.type === "configuration_update")).toBe(false);
  });

  test("WS incremental delta index, simple effort enum distinction, 1h TTL expiry, and bounded input rejection", () => {
    // Delta frame contains [cfgUpdate, userMsg] at sent indices 0 and 1 (even though full history was index 4).
    const deltaFrame = JSON.stringify({ model: "gpt-5.6-sol", input: [cfgUpdate, userMsg("latest")] });
    const refusal = new Response(JSON.stringify({
      error: { message: "Unknown item at input[0]", param: "input[0]", code: "invalid_value" },
    }), { status: 400 });
    recordCodexWsActualSentFrame(refusal, deltaFrame);

    expect(matchConfigurationUpdate400Rejection({
      status: 400,
      nonReplayable: false,
      errorText: JSON.stringify({ error: { message: "Unknown item at input[0]", param: "input[0]" } }),
      sentBodyText: codexWsActualSentFrame(refusal),
    })).toBe(true);

    // Index pointing to a non-configuration_update item fails closed.
    expect(matchConfigurationUpdate400Rejection({
      status: 400,
      nonReplayable: false,
      errorText: JSON.stringify({ error: { message: "Invalid input[1]", param: "input[1]" } }),
      sentBodyText: deltaFrame,
    })).toBe(false);

    // Simple effort value enum error MUST NOT strip configuration_update.
    expect(matchConfigurationUpdate400Rejection({
      status: 400,
      nonReplayable: false,
      errorText: JSON.stringify({
        error: {
          message: "Unsupported value: 'xhigh' for reasoning.effort. Supported values are: 'low', 'medium', 'high'.",
          param: "input[0].reasoning.effort",
          code: "unsupported_value",
        },
      }),
      sentBodyText: deltaFrame,
    })).toBe(false);

    // Malicious / oversized error body fails closed.
    expect(matchConfigurationUpdate400Rejection({
      status: 400,
      nonReplayable: false,
      errorText: `{"error":{"param":"input[0]","message":"${"a".repeat(20_000)}"}}`,
      sentBodyText: deltaFrame,
    })).toBe(false);

    // Non-replayable response never matches.
    expect(matchConfigurationUpdate400Rejection({
      status: 400,
      nonReplayable: true,
      errorText: JSON.stringify({ error: { param: "input[0]" } }),
      sentBodyText: deltaFrame,
    })).toBe(false);

    // 1-hour memo expires after TTL.
    const t0 = 1_700_000_000_000;
    rememberConfigurationUpdateUnsupported("chatgpt.com", "gpt-5.6-sol", t0);
    expect(isConfigurationUpdateUnsupportedMemoized("chatgpt.com", "gpt-5.6-sol", t0 + 1000)).toBe(true);
    expect(isConfigurationUpdateUnsupportedMemoized("chatgpt.com", "gpt-5.6-sol", t0 + CONFIGURATION_UPDATE_CAPABILITY_TTL_MS + 1)).toBe(false);
  });

  test("pre-output Anthropic perMessageEffort 400 preserves real 400 error when 1-send budget blocks resend", async () => {
    const { createRequestExecutionBudget } = await import("../../src/lib/request-execution-budget");
    const config = { providers: { "anthropic-key": provider() } } as unknown as EpxConfig;
    replies.push(
      () => new Response(anthropicTextSse("ok 1", { read: 0, write: 1000 }), { headers: { "content-type": "text/event-stream" } }),
      () => new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "output_config.effort requires a model that supports per-turn effort; this model does not" },
      }), { status: 400, headers: { "content-type": "application/json" } }),
    );
    const input1 = [userMsg("start")];
    const r1 = await turn(config, "anthropic-key/claude-sonnet-5-5", input1, "high", { "x-codex-turn-metadata": NEW_META });
    expect(r1.status).toBe(200);

    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1,
      baseSendAllowance: 1,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    }, "per-msg-effort-one-send");
    const input2 = [...input1, ...outputItemsOf(r1.text), userMsg("lower")];
    const res2 = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-key/claude-sonnet-5-5",
        input: input2,
        stream: true,
        reasoning: { effort: "low" },
        prompt_cache_key: "thread-p1a",
      }),
    }), config, { model: "", provider: "" }, { sendBudget: budget });
    const body2 = await res2.text();
    expect(sent).toHaveLength(2); // turn 1 + turn 2 only; budget refused resend
    expect(res2.status).toBe(400);
    expect(body2).toContain("per-turn effort");
    expect(body2).not.toContain("request_send_budget_exhausted");
  });
});

describe("Phase 1-A: mocked WebSocket delta frame refusal & configuration_update recovery", () => {
  const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
  const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const answerItem = { type: "message", role: "assistant", content: [{ type: "output_text", text: "ws reply 1" }] };

  async function withMockedWs<T>(
    responder: (socket: {
      frames: Array<Record<string, any>>;
      emit: (payload: unknown) => void;
    }, frame: Record<string, any>, rawText: string) => void,
    run: (sockets: Array<{ frames: Array<Record<string, any>>; texts: string[] }>) => Promise<T>,
  ): Promise<T> {
    const originalWs = globalThis.WebSocket;
    const savedEnv = Object.fromEntries(PROXY_KEYS.map(key => [key, process.env[key]]));
    for (const key of PROXY_KEYS) delete process.env[key];

    class MockSocket extends EventTarget {
      static instances: MockSocket[] = [];
      readyState = 0;
      frames: Array<Record<string, any>> = [];
      texts: string[] = [];
      constructor(_url: string, _options?: unknown) {
        super();
        MockSocket.instances.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }
      emit(payload: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
      send(text: string) {
        const parsed = JSON.parse(text) as Record<string, any>;
        this.frames.push(parsed);
        this.texts.push(text);
        queueMicrotask(() => responder(this, parsed, text));
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
      ref() {}
      unref() {}
    }

    globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
    setCodexWsIncrementalUpload(true);
    setCodexWsReuseAcrossTurns(true);
    resetConfigurationUpdateCapabilityMemoForTests();

    try {
      return await run(MockSocket.instances);
    } finally {
      codexWsPool.dispose();
      setCodexWsIncrementalUpload(false);
      setCodexWsReuseAcrossTurns(false);
      resetConfigurationUpdateCapabilityMemoForTests();
      globalThis.WebSocket = originalWs;
      for (const key of PROXY_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }
  }

  test("codexWsExchange resolveRefusal records exact sent WS delta frame and keeps 5xx refusal fail-closed against 400 config strip", async () => {
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      await withMockedWs((socket, frame) => {
        if (!frame.previous_response_id) {
          socket.emit({ type: "response.created", response: { id: "resp_ws_1", status: "in_progress", output: [] } });
          socket.emit({ type: "response.completed", response: { id: "resp_ws_1", status: "completed", output: [answerItem] } });
          return;
        }
        // Hold opened via empty response.created, then trigger resolveRefusal with a 503 overload refusal.
        socket.emit({ type: "response.created", response: { id: "resp_ws_2", status: "in_progress", output: [] } });
        socket.emit({
          type: "error",
          status: 503,
          error: { type: "server_error", code: "server_is_overloaded", message: "overloaded after empty created" },
        });
      }, async (sockets) => {
        const noFallback = (async () => { throw new Error("unexpected SSE fallback"); }) as typeof fetch;
        const makeInit = (input: unknown[], turnId: string): RequestInit => ({
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ws-fixture-token",
            "chatgpt-account-id": "ws-fixture-acct",
            "thread-id": "ws-thread-resolve-refusal",
          },
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            stream: true,
            store: false,
            reasoning: { effort: "high" },
            client_metadata: { thread_id: "ws-thread-resolve-refusal", turn_id: turnId },
            input,
          }),
        });

        const turn1Input = [userMsg("turn 1")];
        const res1 = await codexWsUpstreamFetch(
          CODEX_URL, makeInit(turn1Input, "t1"), noFallback, "1.4.4",
          undefined, undefined, undefined, undefined, undefined,
          { maxMs: 5_000, until: Number.MAX_SAFE_INTEGER },
          undefined, undefined, "principal:ws-caller", undefined, "openai",
        );
        expect(res1.status).toBe(200);
        expect(await res1.text()).toContain("response.completed");

        // Turn 2 sends a delta frame [cfgUpdate, userMsg("turn 2")] while full history has cfgUpdate at index 2.
        const turn2Input = [userMsg("turn 1"), answerItem, cfgUpdate, userMsg("turn 2")];
        const projection = await codexWsUpstreamFetch(
          CODEX_URL, makeInit(turn2Input, "t2"), noFallback, "1.4.4",
          undefined, undefined, undefined, undefined, undefined,
          { maxMs: 5_000, until: Number.MAX_SAFE_INTEGER },
          undefined, undefined, "principal:ws-caller", undefined, "openai",
        );
        expect(projection.status).toBe(503);
        expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
        const recorded = codexWsActualSentFrame(projection);
        expect(recorded).toBeDefined();
        expect(recorded).toBe(sockets[0]!.texts[1]);
        const recordedJson = JSON.parse(recorded!) as { previous_response_id?: string; input: Array<{ type: string }> };
        expect(recordedJson.previous_response_id).toBe("resp_ws_1");
        expect(recordedJson.input).toEqual([cfgUpdate, userMsg("turn 2")]);

        // 503 pre-output refusal must fail closed in refusedConfigurationUpdateStrip without setting 1h memo.
        expect(await refusedConfigurationUpdateStrip(
          projection,
          new AbortController().signal,
          { attempted: false },
          { outboundBody: JSON.stringify({ input: turn2Input }), outboundUrl: CODEX_URL, modelId: "gpt-5.6-sol" },
        )).toBe(false);
        expect(isConfigurationUpdateUnsupportedMemoized("chatgpt.com", "gpt-5.6-sol")).toBe(false);

        const restored = restoreCodexWsPreOutputRefusal(projection);
        expect(restored.status).toBe(200);
        expect(await restored.text()).toContain("server_is_overloaded");
      });
    } finally {
      releaseSpendHome();
    }
  });

  test("handleResponses recovers WS delta frame input[0] configuration_update 400, retries without it, and memoizes for Turn 3", async () => {
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      await withMockedWs((socket, frame) => {
        const items = Array.isArray(frame.input) ? frame.input as Array<Record<string, unknown>> : [];
        const cfgIdx = items.findIndex(item => item.type === "configuration_update");
        if (cfgIdx !== -1) {
          socket.emit({
            type: "error",
            status: 400,
            error: {
              message: `Invalid value: 'configuration_update' at input[${cfgIdx}].type`,
              type: "invalid_request_error",
              param: `input[${cfgIdx}].type`,
              code: "invalid_value",
            },
          });
          return;
        }
        const id = `resp_ws_${socket.frames.length}`;
        const isTurn2 = items.some(item =>
          Array.isArray(item.content)
          && item.content.some((part: any) => part?.text === "turn 2"));
        const replyText = isTurn2 ? "ws reply 2" : "ws reply 1";
        socket.emit({ type: "response.created", response: { id, status: "in_progress", output: [] } });
        socket.emit({
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: replyText }] }],
          },
        });
      }, async (sockets) => {
        const config = {
          port: 0,
          defaultProvider: "openai",
          apiKeys: [{ id: "ws-caller", name: "ws-caller", key: "epx_data_" + "d".repeat(40), createdAt: "2026-01-01T00:00:00.000Z" }],
          providers: {
            openai: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              authMode: "forward",
              codexAccountMode: "direct",
            },
          },
        } as unknown as EpxConfig;

        const sendTurn = (input: unknown[], turnId: string) => handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ws-fixture-token",
            "chatgpt-account-id": "ws-fixture-acct",
            "thread-id": "ws-thread-config-update",
          },
          body: JSON.stringify({
            model: "openai/gpt-5.6-sol",
            stream: true,
            store: false,
            reasoning: { effort: "high" },
            client_metadata: { thread_id: "ws-thread-config-update", turn_id: turnId },
            input,
          }),
        }), config, { model: "", provider: "" }, {
          codexWsRuntimeIdentity: "1.4.4",
          admission: { kind: "configured", source: "dedicated", keyId: "ws-caller", contextPrincipalId: "ws-caller" },
        });

        // Turn 1: seeds WS incremental prefix on socket 0.
        const r1 = await sendTurn([userMsg("turn 1")], "t1");
        expect(r1.status).toBe(200);
        expect(await r1.text()).toContain("response.completed");
        expect(sockets).toHaveLength(1);

        // Turn 2: full history has cfgUpdate at input[2], but WS delta frame sends [cfgUpdate, userMsg("turn 2")] so cfgUpdate is input[0].
        const turn2Input = [userMsg("turn 1"), answerItem, cfgUpdate, userMsg("turn 2")];
        const r2 = await sendTurn(turn2Input, "t2");
        expect(r2.status).toBe(200);
        expect(await r2.text()).toContain("response.completed");

        // Socket 0 got full create (turn 1) + rejected delta frame (input[0] === cfgUpdate).
        expect(sockets[0]!.frames).toHaveLength(2);
        expect(sockets[0]!.frames[1]!.previous_response_id).toBe("resp_ws_1");
        expect(sockets[0]!.frames[1]!.input).toEqual([cfgUpdate, userMsg("turn 2")]);

        // Recovery stripped cfgUpdate and succeeded on Socket 1 (full create without cfgUpdate).
        expect(sockets).toHaveLength(2);
        expect(sockets[1]!.frames).toHaveLength(1);
        expect(sockets[1]!.frames[0]!.input).toEqual([userMsg("turn 1"), answerItem, userMsg("turn 2")]);
        expect(isConfigurationUpdateUnsupportedMemoized("chatgpt.com", "gpt-5.6-sol")).toBe(true);

        // Turn 3: memoized capability strips cfgUpdate proactively, so Socket 1 stays alive and sends a clean delta!
        const answer2Item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "ws reply 2" }] };
        const turn3Input = [userMsg("turn 1"), answerItem, userMsg("turn 2"), answer2Item, cfgUpdate, userMsg("turn 3")];
        const r3 = await sendTurn(turn3Input, "t3");
        expect(r3.status).toBe(200);
        expect(await r3.text()).toContain("response.completed");
        expect(sockets).toHaveLength(2);
        expect(sockets[1]!.frames).toHaveLength(2);
        expect(sockets[1]!.frames[1]!.previous_response_id).toBe("resp_ws_1");
        expect(sockets[1]!.frames[1]!.input).toEqual([userMsg("turn 3")]);
      });
    } finally {
      releaseSpendHome();
    }
  });

  test("WS delta frame 400 targeting effort enum or non-configuration_update input[1] fails closed in refusedConfigurationUpdateStrip", async () => {
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      await withMockedWs((socket, frame) => {
        if (!frame.previous_response_id) {
          socket.emit({ type: "response.created", response: { id: "resp_ws_neg", status: "in_progress", output: [] } });
          socket.emit({ type: "response.completed", response: { id: "resp_ws_neg", status: "completed", output: [answerItem] } });
          return;
        }
        const turnId = (frame.client_metadata as { turn_id?: string } | undefined)?.turn_id;
        socket.emit({
          type: "error",
          status: 400,
          error: turnId === "t-enum"
            ? {
                type: "invalid_request_error",
                param: "input[0].reasoning.effort",
                code: "unsupported_value",
                message: "Unsupported value: 'xhigh' for reasoning.effort. Supported values are: 'low', 'medium', 'high'.",
              }
            : {
                type: "invalid_request_error",
                param: "input[1]",
                code: "invalid_value",
                message: "Invalid message item at input[1]",
              },
        });
      }, async () => {
        const noFallback = (async () => { throw new Error("unexpected SSE fallback"); }) as typeof fetch;
        const makeInit = (input: unknown[], turnId: string): RequestInit => ({
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ws-fixture-token",
            "chatgpt-account-id": "ws-fixture-acct",
            "thread-id": "ws-thread-neg",
          },
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            stream: true,
            store: false,
            reasoning: { effort: "high" },
            client_metadata: { thread_id: "ws-thread-neg", turn_id: turnId },
            input,
          }),
        });

        await (await codexWsUpstreamFetch(
          CODEX_URL, makeInit([userMsg("turn 1")], "t1"), noFallback, "1.4.4",
          undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, "principal:ws-caller", undefined, "openai",
        )).text();

        const turn2Input = [userMsg("turn 1"), answerItem, cfgUpdate, userMsg("turn 2")];
        const enumRejection = await codexWsUpstreamFetch(
          CODEX_URL, makeInit(turn2Input, "t-enum"), noFallback, "1.4.4",
          undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, "principal:ws-caller", undefined, "openai",
        );
        expect(enumRejection.status).toBe(400);
        expect(await refusedConfigurationUpdateStrip(
          enumRejection,
          new AbortController().signal,
          { attempted: false },
          { outboundBody: JSON.stringify({ input: turn2Input }), outboundUrl: CODEX_URL, modelId: "gpt-5.6-sol" },
        )).toBe(false);

        // Seed again on a fresh socket and reject input[1] (user message, not configuration_update).
        await (await codexWsUpstreamFetch(
          CODEX_URL, makeInit([userMsg("turn 1")], "t1-b"), noFallback, "1.4.4",
          undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, "principal:ws-caller", undefined, "openai",
        )).text();
        const userItemRejection = await codexWsUpstreamFetch(
          CODEX_URL, makeInit(turn2Input, "t-user"), noFallback, "1.4.4",
          undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, "principal:ws-caller", undefined, "openai",
        );
        expect(userItemRejection.status).toBe(400);
        expect(await refusedConfigurationUpdateStrip(
          userItemRejection,
          new AbortController().signal,
          { attempted: false },
          { outboundBody: JSON.stringify({ input: turn2Input }), outboundUrl: CODEX_URL, modelId: "gpt-5.6-sol" },
        )).toBe(false);
        expect(isConfigurationUpdateUnsupportedMemoized("chatgpt.com", "gpt-5.6-sol")).toBe(false);
      });
    } finally {
      releaseSpendHome();
    }
  });
});
