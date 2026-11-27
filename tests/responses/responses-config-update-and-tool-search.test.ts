import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
import { clearResponseStateForTests } from "../../src/responses/state";
import { parseRequest } from "../../src/responses/parser";
import {
  applyOpenAIResponsesPerMessageEffort,
  MAX_OPENAI_EFFORT_SESSIONS,
  MAX_OPENAI_EFFORT_TRANSITIONS,
  openAIEffortControlStoreSizeForTests,
  planStableOpenAIEffort,
  resetOpenAIEffortControlStoreForTests,
  type OpenAIEffortControlState,
} from "../../src/adapters/openai-responses/per-message-effort";
import {
  rememberConfigurationUpdateUnsupported,
  resetConfigurationUpdateCapabilityMemoForTests,
} from "../../src/adapters/openai-responses/config-update-fallback";
import {
  GATEWAY_TOOL_SEARCH_MAX_TURNS,
  GATEWAY_TOOL_SEARCH_TOOL_NAME,
  installGatewayToolSearchEmulation,
  isGatewayToolSearchCandidate,
  searchDeferredTools,
} from "../../src/responses/gateway-tool-search";
import { handleResponses } from "../../src/server/responses";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import type { EpxConfig, EpxProviderConfig, EpxTool } from "../../src/types";

let originalHome: string | undefined;
let tempHome: string | undefined;
let releaseSpend: (() => void) | undefined;
let servers: Array<{ stop(closeActiveConnections?: boolean): unknown }> = [];

beforeEach(() => {
  originalHome = process.env.EASYPROXY_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "epx-resp-effort-toolsearch-"));
  process.env.EASYPROXY_HOME = tempHome;
  resetOpenAIEffortControlStoreForTests();
  resetConfigurationUpdateCapabilityMemoForTests();
  clearResponseStateForTests();
  clearRequestLogsForTests();
  resetSharedSpendLedgerForTest();
  releaseSpend = acquireOwnedSpendHome();
});

afterEach(async () => {
  for (const s of servers) {
    try {
      await Promise.resolve(s.stop(true));
    } catch {
      // Ignore already-stopped server.
    }
  }
  servers = [];
  resetOpenAIEffortControlStoreForTests();
  resetConfigurationUpdateCapabilityMemoForTests();
  clearResponseStateForTests();
  clearRequestLogsForTests();
  try {
    releaseSpend?.();
  } finally {
    releaseSpend = undefined;
    if (originalHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = originalHome;
    if (tempHome) removeTreeWithRetry(tempHome);
    tempHome = undefined;
  }
});

function openAIProvider(overrides: Partial<EpxProviderConfig> = {}): EpxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "key",
    apiKey: "sk-openai-synthetic",
    models: ["gpt-5.4"],
    perMessageEffort: true,
    ...overrides,
  };
}

function minimalParsed(overrides: Record<string, unknown> = {}) {
  return parseRequest({
    model: "openai-api/gpt-5.4",
    input: [{ role: "user", content: "hello" }],
    ...overrides,
  });
}

describe("Defect 8: /v1/responses/compact strips configuration_update on OpenAI-operated targets", () => {
  test("strips configuration_update items from compact input even when targeting api.openai.com", async () => {
    const sentBodies: Array<Record<string, unknown>> = [];
    const upstreamFetch = (async (_input: unknown, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        id: "cmp_synthetic",
        object: "response.compaction",
        created_at: 1_767_225_600,
        output: [{ type: "compaction", encrypted_content: "opaque-blob" }],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      });
    }) as typeof fetch;

    const config: EpxConfig = {
      port: 0,
      defaultProvider: "openai-api",
      providers: {
        "openai-api": {
          ...openAIProvider({ fetch: upstreamFetch }),
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    saveConfig(config);

    const req = new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-api/gpt-5.4",
        input: [
          { role: "user", content: "First message" },
          { type: "configuration_update", reasoning: { effort: "high" } },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Compact please" },
        ],
      }),
    });

    const res = await handleResponsesCompact(req, config, {} as RequestLogContext);
    expect(res.status).toBe(200);
    expect(sentBodies).toHaveLength(1);
    const forwardedInput = sentBodies[0]!.input as Array<Record<string, unknown>>;
    expect(forwardedInput.some(item => item.type === "configuration_update")).toBe(false);
    expect(forwardedInput).toHaveLength(4);
    expect(forwardedInput[0]).toEqual({ role: "user", content: "First message" });
    expect(forwardedInput[1]).toEqual({ role: "assistant", content: "First answer" });
    expect(forwardedInput[2]).toEqual({ role: "user", content: "Compact please" });
  });
});

describe("P1-B: OpenAI Responses cache-preserving configuration_update per-message effort", () => {
  test("pins initial request-level reasoning.effort and injects configuration_update before user transition while ignoring item id/status", () => {
    const provider = openAIProvider();
    const url = "https://api.openai.com/v1/responses";
    const incoming = {
      providerName: "openai-api",
      headers: new Headers({ session_id: "sess-effort-1" }),
    };

    const user1 = { role: "user", content: "Step 1" };
    const assistant1Live = { id: "msg_live_1", status: "completed", role: "assistant", content: "Done 1" };
    const assistant1Replay = { id: "msg_replayed_different", status: "in_progress", role: "assistant", content: "Done 1" };
    const user2 = { role: "user", content: "Step 2 deep" };

    // Turn 1: medium effort establishes baseline anchor.
    const body1 = {
      model: "gpt-5.4",
      input: [user1],
      reasoning: { effort: "medium" },
    };
    const out1 = applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: minimalParsed({ reasoning: { effort: "medium" } }),
      incoming,
      body: body1,
      url,
    });
    expect((out1.reasoning as Record<string, unknown>).effort).toBe("medium");
    expect(out1.input).toEqual([user1]);

    // Turn 2: caller raises effort to high; prefix anchor stays "medium" while configuration_update is spliced before user2.
    const body2 = {
      model: "gpt-5.4",
      input: [user1, assistant1Live, user2],
      reasoning: { effort: "high" },
    };
    const out2 = applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: minimalParsed({ reasoning: { effort: "high" } }),
      incoming,
      body: body2,
      url,
    });
    expect((out2.reasoning as Record<string, unknown>).effort).toBe("medium");
    expect(out2.input).toEqual([
      user1,
      assistant1Live,
      { type: "configuration_update", reasoning: { effort: "high" } },
      user2,
    ]);

    // Turn 3: replay with sanitized history (different id & status) matches the exact prefix anchor and preserves transition.
    const user3 = { role: "user", content: "Step 3 still high" };
    const body3 = {
      model: "gpt-5.4",
      input: [user1, assistant1Replay, user2, { role: "assistant", content: "Done 2" }, user3],
      reasoning: { effort: "high" },
    };
    const out3 = applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: minimalParsed({ reasoning: { effort: "high" } }),
      incoming,
      body: body3,
      url,
    });
    expect((out3.reasoning as Record<string, unknown>).effort).toBe("medium");
    expect(out3.input).toEqual([
      user1,
      assistant1Replay,
      { type: "configuration_update", reasoning: { effort: "high" } },
      user2,
      { role: "assistant", content: "Done 2" },
      user3,
    ]);
  });

  test("skips caller configuration_update, previous_response_id, compaction, and memoized unsupported destinations; enforces LRU and transition caps", () => {
    const provider = openAIProvider();
    const url = "https://api.openai.com/v1/responses";
    const incoming = { providerName: "openai-api", headers: new Headers({ session_id: "sess-skip" }) };

    // Bypass paths leave body identical by reference.
    const withCallerUpdate = {
      model: "gpt-5.4",
      input: [{ type: "configuration_update", reasoning: { effort: "low" } }, { role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    };
    expect(applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: minimalParsed(),
      incoming,
      body: withCallerUpdate,
      url,
    })).toBe(withCallerUpdate);

    const withPrevResp = {
      model: "gpt-5.4",
      previous_response_id: "resp_123",
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    };
    expect(applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: minimalParsed(),
      incoming,
      body: withPrevResp,
      url,
    })).toBe(withPrevResp);

    const compactionBody = {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    };
    const compactParsed = minimalParsed();
    compactParsed._compactionRequest = true;
    expect(applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: compactParsed,
      incoming,
      body: compactionBody,
      url,
    })).toBe(compactionBody);

    // Unsupported destination capability memo disables injection cleanly.
    rememberConfigurationUpdateUnsupported("api.openai.com", "gpt-5.4");
    expect(applyOpenAIResponsesPerMessageEffort({
      provider,
      parsed: minimalParsed(),
      incoming,
      body: compactionBody,
      url,
    })).toBe(compactionBody);
    resetConfigurationUpdateCapabilityMemoForTests();

    // Session store stays capped at MAX_OPENAI_EFFORT_SESSIONS (128).
    for (let i = 0; i < MAX_OPENAI_EFFORT_SESSIONS + 25; i++) {
      applyOpenAIResponsesPerMessageEffort({
        provider,
        parsed: minimalParsed(),
        incoming: { providerName: "openai-api", headers: new Headers({ session_id: `lru-${i}` }) },
        body: { model: "gpt-5.4", input: [{ role: "user", content: `turn ${i}` }], reasoning: { effort: "medium" } },
        url,
      });
    }
    expect(openAIEffortControlStoreSizeForTests()).toBe(MAX_OPENAI_EFFORT_SESSIONS);

    // Transition table rebases cleanly once MAX_OPENAI_EFFORT_TRANSITIONS is exhausted.
    const state: OpenAIEffortControlState = {
      sessionId: "cap-test",
      baseEffort: undefined,
      currentEffort: undefined,
      transitions: [],
      updatedAt: Date.now(),
    };
    const input: Array<unknown> = [];
    planStableOpenAIEffort(state, [{ role: "user", content: "u0" }], "low");
    for (let i = 1; i <= MAX_OPENAI_EFFORT_TRANSITIONS + 1; i++) {
      input.push({ role: "assistant", content: `a${i - 1}` }, { role: "user", content: `u${i}` });
      const reqEffort = i % 2 === 1 ? "high" : "low";
      const working = [...input];
      const base = planStableOpenAIEffort(state, working, reqEffort);
      if (i > MAX_OPENAI_EFFORT_TRANSITIONS) {
        expect(state.transitions).toHaveLength(0);
        expect(base).toBe(reqEffort);
      }
    }
  });
});

describe("P1-D(b): Opt-in gateway defer_loading (epx_tool_search) emulation", () => {
  function sampleTools(): EpxTool[] {
    return [
      {
        name: "clock_now",
        description: "Return current UTC timestamp",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "invoice_lookup",
        description: "Fetch billing invoice details by account id",
        parameters: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
        deferLoading: true,
      },
      {
        name: "camelCaseSearchRepo",
        description: "Search git repository files and commits",
        parameters: { type: "object", properties: { pattern: { type: "string" } } },
        deferLoading: true,
      },
    ];
  }

  test("searchDeferredTools supports select:, BM25 camelCase/snake_case matching, and ReDoS-safe fallback; candidate gating excludes Anthropic & stateful callers", () => {
    const deferred = sampleTools().filter(t => t.deferLoading);
    expect(searchDeferredTools(deferred, "select:invoice_lookup").map(t => t.name)).toEqual(["invoice_lookup"]);
    expect(searchDeferredTools(deferred, "billing invoice").map(t => t.name)).toEqual(["invoice_lookup"]);
    expect(searchDeferredTools(deferred, "camel case repo").map(t => t.name)).toEqual(["camelCaseSearchRepo"]);
    // Evil nested quantifier patterns never compile RegExp and return cleanly via literal substring match (< 10ms).
    const repeatDescTool: EpxTool = {
      name: "repeat_desc",
      description: "a".repeat(32),
      parameters: { type: "object", properties: {} },
      deferLoading: true,
    };
    const literalExprTool: EpxTool = {
      name: "literal_expr_tool",
      description: "Matches literal (.*)+! and (a+)+! markers cleanly",
      parameters: { type: "object", properties: {} },
      deferLoading: true,
    };
    const nestedEvilQuery = `${"(".repeat(200)}a+${")".repeat(200)}`;
    for (const evilQuery of ["(.*)+!", "(a+)+!", "(a+)+$", "(x+x+)+y", nestedEvilQuery]) {
      const startNs = Bun.nanoseconds();
      const hits = searchDeferredTools([...deferred, repeatDescTool], evilQuery);
      const elapsedMs = (Bun.nanoseconds() - startNs) / 1e6;
      expect(elapsedMs).toBeLessThan(10);
      expect(hits).toEqual([]);
    }
    const literalStartNs = Bun.nanoseconds();
    // Query with zero alphanumeric tokens bypasses BM25 and exercises the literal substring fallback directly.
    const literalHits = searchDeferredTools([repeatDescTool, literalExprTool], "(.*)+!");
    expect((Bun.nanoseconds() - literalStartNs) / 1e6).toBeLessThan(10);
    expect(literalHits.map(t => t.name)).toEqual(["literal_expr_tool"]);

    const parsedWithDeferred = parseRequest({
      model: "mock/gpt-5-mini",
      input: "hi",
      tools: [
        { type: "function", name: "clock_now", parameters: { type: "object", properties: {} } },
        { type: "function", name: "invoice_lookup", description: "Fetch billing invoice", defer_loading: true, parameters: { type: "object", properties: {} } },
      ],
    });
    expect(isGatewayToolSearchCandidate(parsedWithDeferred, { adapter: "openai-chat", gatewayToolSearch: true })).toBe(true);
    expect(isGatewayToolSearchCandidate(parsedWithDeferred, { adapter: "openai-chat", gatewayToolSearch: false })).toBe(false);
    expect(isGatewayToolSearchCandidate(parsedWithDeferred, { adapter: "anthropic", gatewayToolSearch: true })).toBe(false);

    const withPrev = parseRequest({
      model: "mock/gpt-5-mini",
      input: "hi",
      previous_response_id: "resp_prev",
      tools: [
        { type: "function", name: "invoice_lookup", defer_loading: true, parameters: { type: "object", properties: {} } },
      ],
    });
    expect(isGatewayToolSearchCandidate(withPrev, { adapter: "openai-chat", gatewayToolSearch: true })).toBe(false);

    const cloned = structuredClone(parsedWithDeferred);
    expect(installGatewayToolSearchEmulation(cloned, { adapter: "openai-chat", gatewayToolSearch: true })).toBe(true);
    expect(cloned.context.tools?.map(t => t.name)).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
  });

  function mockToolSearchChatUpstream(alwaysSearchLoop = false, extraHeaders: Record<string, string> = {}) {
    const requests: Array<{ toolNames: string[]; messages: unknown[] }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as {
          stream?: boolean;
          tools?: Array<{ function?: { name?: string } }>;
          messages: unknown[];
        };
        const toolNames = (body.tools ?? []).map(t => t.function?.name ?? "").filter(Boolean);
        requests.push({ toolNames, messages: body.messages });
        const turnIndex = requests.length - 1;

        const sendToolCall = (id: string, name: string, args: string) => {
          if (!body.stream) {
            return Response.json({
              id: `chatcmpl_${turnIndex}`,
              object: "chat.completion",
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
                },
                finish_reason: "tool_calls",
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }, { headers: extraHeaders });
          }
          const frames = [
            `data: ${JSON.stringify({
              id: `chatcmpl_${turnIndex}`,
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
                },
              }],
            })}\n\n`,
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })}\n\n`,
            "data: [DONE]\n\n",
          ];
          return new Response(frames.join(""), { headers: { "content-type": "text/event-stream", ...extraHeaders } });
        };

        if (alwaysSearchLoop) {
          if (toolNames.includes(GATEWAY_TOOL_SEARCH_TOOL_NAME)) {
            return sendToolCall(`call_search_${turnIndex}`, GATEWAY_TOOL_SEARCH_TOOL_NAME, JSON.stringify({ query: "no_match_keep_searching" }));
          }
          return Response.json({
            id: `chatcmpl_${turnIndex}`,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "search-exhausted-fallback" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          });
        }

        if (turnIndex === 0) {
          return sendToolCall("call_search_0", GATEWAY_TOOL_SEARCH_TOOL_NAME, JSON.stringify({ query: "billing invoice" }));
        }
        return sendToolCall("call_loaded_1", "invoice_lookup", JSON.stringify({ invoice_id: "inv_42" }));
      },
    });
    servers.push(server);
    return { server, requests };
  }

  test("handleResponses loads deferred tools across turns in both streaming and buffered modes without undeclared-tool rejection", async () => {
    for (const stream of [false, true]) {
      const { server, requests } = mockToolSearchChatUpstream(false);
      const config: EpxConfig = {
        port: 0,
        defaultProvider: "mock",
        providers: {
          mock: {
            adapter: "openai-chat",
            baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
            apiKey: "k",
            allowPrivateNetwork: true,
            gatewayToolSearch: true,
          },
        },
      };
      saveConfig(config);

      const res = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "mock/gpt-4o-mini",
            stream,
            input: "Look up invoice inv_42",
            tools: [
              { type: "function", name: "clock_now", description: "Now", parameters: { type: "object", properties: {} } },
              {
                type: "function",
                name: "invoice_lookup",
                description: "Fetch billing invoice details",
                defer_loading: true,
                parameters: { type: "object", properties: { invoice_id: { type: "string" } } },
              },
            ],
          }),
        }),
        config,
        {} as RequestLogContext,
      );

      expect(res.status).toBe(200);
      if (!stream) {
        const json = await res.json() as { output: Array<{ type: string; name?: string; arguments?: string }> };
        expect(requests).toHaveLength(2);
        expect(requests[0]!.toolNames).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
        expect(requests[1]!.toolNames).toContain("invoice_lookup");
        const fnCall = json.output.find(item => item.type === "function_call");
        expect(fnCall?.name).toBe("invoice_lookup");
        expect(JSON.parse(fnCall!.arguments!)).toEqual({ invoice_id: "inv_42" });
      } else {
        const sse = await res.text();
        expect(requests).toHaveLength(2);
        expect(requests[0]!.toolNames).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
        expect(requests[1]!.toolNames).toContain("invoice_lookup");
        expect(sse).toContain("invoice_lookup");
        expect(sse).toContain("inv_42");
        expect(sse).not.toContain("epx_tool_search");
      }
    }
  });

  test("enforces GATEWAY_TOOL_SEARCH_MAX_TURNS cap by removing epx_tool_search after max loops", async () => {
    const { server, requests } = mockToolSearchChatUpstream(true);
    const config: EpxConfig = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
          apiKey: "k",
          allowPrivateNetwork: true,
          gatewayToolSearch: true,
        },
      },
    };
    saveConfig(config);

    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock/gpt-4o-mini",
          stream: false,
          input: "Search forever",
          tools: [
            {
              type: "function",
              name: "invoice_lookup",
              description: "Fetch billing invoice details",
              defer_loading: true,
              parameters: { type: "object", properties: { invoice_id: { type: "string" } } },
            },
          ],
        }),
      }),
      config,
      {} as RequestLogContext,
    );

    await res.text();
    expect(res.status).toBe(200);
    expect(requests.length).toBe(GATEWAY_TOOL_SEARCH_MAX_TURNS + 1);
    expect(requests[GATEWAY_TOOL_SEARCH_MAX_TURNS]!.toolNames).not.toContain(GATEWAY_TOOL_SEARCH_TOOL_NAME);
  });

  test("streaming block-stop-v1 upstream headers cannot bypass _gatewayToolSearchGuard", async () => {
    const { server, requests } = mockToolSearchChatUpstream(false, {
      "x-easyproxy-tool-completion": "block-stop-v1",
    });
    const config: EpxConfig = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
          apiKey: "k",
          allowPrivateNetwork: true,
          gatewayToolSearch: true,
        },
      },
    };
    saveConfig(config);

    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock/gpt-4o-mini",
          stream: true,
          input: "Look up invoice inv_42",
          tools: [
            {
              type: "function",
              name: "invoice_lookup",
              description: "Fetch billing invoice details",
              defer_loading: true,
              parameters: { type: "object", properties: { invoice_id: { type: "string" } } },
            },
          ],
        }),
      }),
      config,
      {} as RequestLogContext,
    );

    const sse = await res.text();
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(sse).toContain("invoice_lookup");
    expect(sse).not.toContain("epx_tool_search");
  });

  test("keeps epx_tool_search description static, appends loaded tools cache-friendly, and preloads namespaced history calls", async () => {
    const parsedMulti = parseRequest({
      model: "mock/gpt-4o-mini",
      input: [
        { type: "function_call", call_id: "c_prev", namespace: "crm", name: "contact_get", arguments: "{}" },
        { type: "function_call_output", call_id: "c_prev", output: '{"ok":true}' },
        { role: "user", content: "Now look up invoice and ledger" },
      ],
      tools: [
        { type: "function", name: "clock_now", parameters: { type: "object", properties: {} } },
        {
          type: "namespace",
          name: "crm",
          tools: [
            { type: "function", name: "contact_get", description: "Read CRM contact", defer_loading: true, parameters: { type: "object", properties: {} } },
          ],
        },
        { type: "function", name: "alpha_ledger", description: "Read accounting ledger", defer_loading: true, parameters: { type: "object", properties: {} } },
        { type: "function", name: "zeta_invoice", description: "Fetch billing invoice", defer_loading: true, parameters: { type: "object", properties: {} } },
      ],
    });
    expect(installGatewayToolSearchEmulation(parsedMulti, { adapter: "openai-chat", gatewayToolSearch: true })).toBe(true);
    // Namespaced history call must preload crm__contact_get in active catalog before first turn,
    // and epx_tool_search sits right after eager tools so subsequent loads append without shifting it.
    expect(parsedMulti.context.tools?.map(t => `${t.namespace ? `${t.namespace}__` : ""}${t.name}`)).toEqual([
      "clock_now",
      GATEWAY_TOOL_SEARCH_TOOL_NAME,
      "crm__contact_get",
    ]);

    // Multi-hop execution verifies static description across turns + append-only loaded order [eager, epx_tool_search, zeta_invoice].
    const capturedBodies: Array<{ tools: Array<{ function: { name: string; description?: string } }> }> = [];
    let hop = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { tools: Array<{ function: { name: string; description?: string } }> };
        capturedBodies.push(body);
        const turn = hop++;
        if (turn === 0) {
          return Response.json({
            id: "c0",
            object: "chat.completion",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "cs0", type: "function", function: { name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: '{"query":"select:zeta_invoice"}' } }],
              },
              finish_reason: "tool_calls",
            }],
          });
        }
        return Response.json({
          id: "c1",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          }],
        });
      },
    });
    servers.push(server);

    const cfg: EpxConfig = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: { adapter: "openai-chat", baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`, apiKey: "k", allowPrivateNetwork: true, gatewayToolSearch: true },
      },
    };
    saveConfig(cfg);
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock/gpt-4o-mini",
          stream: false,
          input: "Check invoice",
          tools: [
            { type: "function", name: "clock_now", parameters: { type: "object", properties: {} } },
            { type: "function", name: "alpha_ledger", description: "Accounting", defer_loading: true, parameters: { type: "object", properties: {} } },
            { type: "function", name: "zeta_invoice", description: "Billing invoice", defer_loading: true, parameters: { type: "object", properties: {} } },
          ],
        }),
      }),
      cfg,
      {} as RequestLogContext,
    );
    expect(res.status).toBe(200);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0]!.tools.map(t => t.function.name)).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
    expect(capturedBodies[1]!.tools.map(t => t.function.name)).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME, "zeta_invoice"]);
    expect(capturedBodies[1]!.tools[1]!.function.description).toBe(capturedBodies[0]!.tools[1]!.function.description);
  });

  test("preserves defer_loading across /v1/messages, /v1/chat/completions, and openai-responses passthrough with strict client-ToolSearch exclusion", async () => {
    for (const adapter of ["openai-responses", "openai-chat"] as const) {
      const seenToolsPerRequest: string[][] = [];
      let upstreamCall = 0;
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const body = await req.json() as { stream?: boolean; tools?: Array<{ name?: string; function?: { name?: string }; defer_loading?: boolean }> };
          const names = (body.tools ?? []).map(t => t.name ?? t.function?.name ?? "");
          seenToolsPerRequest.push(names);
          const idx = upstreamCall++;
          if (adapter === "openai-responses") {
            const callItem = idx === 0
              ? { type: "function_call", call_id: "r_s0", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: '{"query":"invoice"}' }
              : { type: "function_call", call_id: "r_i1", name: "invoice_lookup", arguments: '{"id":"1"}' };
            if (!body.stream) {
              return Response.json({ id: `r${idx}`, object: "response", status: "completed", output: [callItem] });
            }
            return new Response([
              `data: ${JSON.stringify({ type: "response.output_item.done", item: callItem })}\n\n`,
              `data: ${JSON.stringify({ type: "response.completed", response: { id: `r${idx}`, status: "completed", output: [callItem] } })}\n\n`,
            ].join(""), { headers: { "content-type": "text/event-stream" } });
          }
          const tc = idx === 0
            ? { id: "c_s0", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, args: '{"query":"invoice"}' }
            : { id: "c_i1", name: "invoice_lookup", args: '{"id":"1"}' };
          if (!body.stream) {
            return Response.json({
              id: `c${idx}`,
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }] }, finish_reason: "tool_calls" }],
            });
          }
          return new Response([
            `data: ${JSON.stringify({ id: `c${idx}`, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }] } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""), { headers: { "content-type": "text/event-stream" } });
        },
      });
      servers.push(server);

      const cfg: EpxConfig = {
        port: 0,
        defaultProvider: "gw",
        providers: {
          gw: { adapter, baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`, apiKey: "k", allowPrivateNetwork: true, gatewayToolSearch: true, models: ["m"] },
        },
      };
      saveConfig(cfg);

      // 1. /v1/messages preserves defer_loading -> triggers epx_tool_search
      upstreamCall = 0;
      seenToolsPerRequest.length = 0;
      const msgRes = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gw/m",
          max_tokens: 128,
          stream: false,
          tools: [
            { name: "clock_now", input_schema: { type: "object", properties: {} } },
            { name: "invoice_lookup", description: "Fetch billing invoice", defer_loading: true, input_schema: { type: "object", properties: { id: { type: "string" } } } },
          ],
          messages: [{ role: "user", content: "lookup invoice 1" }],
        }),
      }), cfg, {} as RequestLogContext);
      expect(msgRes.status).toBe(200);
      expect(seenToolsPerRequest).toHaveLength(2);
      expect(seenToolsPerRequest[0]).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
      expect(seenToolsPerRequest[1]).toContain("invoice_lookup");

      // 2. /v1/chat/completions preserves defer_loading (including nested function.defer_loading) -> triggers epx_tool_search
      upstreamCall = 0;
      seenToolsPerRequest.length = 0;
      const chatRes = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gw/m",
          stream: false,
          tools: [
            { type: "function", function: { name: "clock_now", parameters: { type: "object", properties: {} } } },
            { type: "function", function: { name: "invoice_lookup", description: "Fetch billing invoice", defer_loading: true, parameters: { type: "object", properties: { id: { type: "string" } } } } },
          ],
          messages: [{ role: "user", content: "lookup invoice 1" }],
        }),
      }), cfg, {} as RequestLogContext);
      expect(chatRes.status).toBe(200);
      expect(seenToolsPerRequest).toHaveLength(2);
      expect(seenToolsPerRequest[0]).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
      expect(seenToolsPerRequest[1]).toContain("invoice_lookup");

      // 3. openai-responses passthrough directly supports gatewayToolSearch when adapter === "openai-responses"
      if (adapter === "openai-responses") {
        upstreamCall = 0;
        seenToolsPerRequest.length = 0;
        const respRes = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gw/m",
            stream: false,
            input: "lookup invoice 1",
            tools: [
              { type: "function", name: "clock_now", parameters: { type: "object", properties: {} } },
              { type: "function", name: "invoice_lookup", description: "Fetch billing invoice", defer_loading: true, parameters: { type: "object", properties: { id: { type: "string" } } } },
            ],
          }),
        }), cfg, {} as RequestLogContext);
        expect(respRes.status).toBe(200);
        expect(seenToolsPerRequest).toHaveLength(2);
        expect(seenToolsPerRequest[0]).toEqual(["clock_now", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
        expect(seenToolsPerRequest[1]).toContain("invoice_lookup");
      }
    }

    // 4. Strict mutual exclusion: client-side ToolSearch or appendOnlyToolLoadingModels/chatToolDispatchModels disables gatewayToolSearch
    const withToolSearchFn = parseRequest({
      model: "mock/gpt-5",
      input: "hi",
      tools: [
        { type: "function", name: "ToolSearch", parameters: { type: "object", properties: {} } },
        { type: "function", name: "invoice_lookup", defer_loading: true, parameters: { type: "object", properties: {} } },
      ],
    });
    expect(isGatewayToolSearchCandidate(withToolSearchFn, { adapter: "openai-chat", gatewayToolSearch: true })).toBe(false);

    const seenWithAppendOnly: string[][] = [];
    const appendOnlyServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { tools?: Array<{ name?: string }> };
        seenWithAppendOnly.push((body.tools ?? []).map(t => t.name ?? ""));
        return Response.json({
          id: "resp_append_only",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        });
      },
    });
    servers.push(appendOnlyServer);
    const appendOnlyCfg: EpxConfig = {
      port: 0,
      defaultProvider: "gw",
      providers: {
        gw: { adapter: "openai-responses", baseUrl: `${appendOnlyServer.url.toString().replace(/\/$/, "")}/v1`, apiKey: "k", allowPrivateNetwork: true, gatewayToolSearch: true, models: ["m"] },
      },
      claudeCode: { appendOnlyToolLoadingModels: ["gw/m"] },
    };
    saveConfig(appendOnlyCfg);
    const appendOnlyRes = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gw/m",
        max_tokens: 64,
        stream: false,
        metadata: { user_id: "session_append_only" },
        tools: [
          { name: "clock_now", input_schema: { type: "object", properties: {} } },
          { name: "invoice_lookup", defer_loading: true, input_schema: { type: "object", properties: {} } },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    }), appendOnlyCfg, {} as RequestLogContext);
    expect(appendOnlyRes.status).toBe(200);
    expect(seenWithAppendOnly).toHaveLength(1);
    expect(seenWithAppendOnly[0]).not.toContain(GATEWAY_TOOL_SEARCH_TOOL_NAME);
  });

  test("preserves prefix cache after all deferred tools load, flattens namespace=functions, and correlates output_item.added without call_id", async () => {
    // 1. namespace="functions" children flatten to top-level wire keys when projecting raw wire tools.
    const rawNsBody = {
      model: "mock/gpt-5",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [
            {
              type: "function",
              name: "ns_eager",
              strict: true,
              parameters: { type: "object", properties: { tag: { type: "string" } }, additionalProperties: false },
            },
            { type: "function", name: "ns_deferred", defer_loading: true, parameters: { type: "object", properties: {} } },
          ],
        },
      ],
    };
    const parsedNs = parseRequest(rawNsBody);
    expect(installGatewayToolSearchEmulation(parsedNs, { adapter: "openai-responses", gatewayToolSearch: true })).toBe(true);
    const projectedNs = parsedNs._gatewayToolSearchProjectBody!(rawNsBody, parsedNs) as {
      tools?: Array<{ name?: string; strict?: unknown; defer_loading?: unknown }>;
    };
    expect((projectedNs.tools ?? []).map(t => t.name)).toEqual(["ns_eager", GATEWAY_TOOL_SEARCH_TOOL_NAME]);
    expect(projectedNs.tools?.[0]?.strict).toBe(true);

    // 2. Streaming output_item.added without call_id + output_item.done with call_id correlates, and
    // loading ALL deferred tools keeps epx_tool_search in [ping, epx_tool_search, invoice_lookup] for prefix caching.
    let turn = 0;
    const seenToolNames: string[][] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        turn += 1;
        const body = await req.json() as { tools?: Array<{ name?: string }> };
        seenToolNames.push((body.tools ?? []).map(t => t.name ?? ""));
        if (turn === 1) {
          const sse = [
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stream_1", object: "response", status: "in_progress", model: "gpt-5.4", output: [] } })}`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "fc_item_1", type: "function_call", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: "" } })}`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_item_1", output_index: 0, delta: "{\"query\":\"invoice\"}" })}`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "fc_item_1", call_id: "call_stream_1", type: "function_call", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: "{\"query\":\"invoice\"}" } })}`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_stream_1", object: "response", status: "completed", model: "gpt-5.4", output: [{ id: "fc_item_1", call_id: "call_stream_1", type: "function_call", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: "{\"query\":\"invoice\"}" }], usage: { input_tokens: 10, output_tokens: 5 } } })}`,
          ].join("\n\n") + "\n\n";
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        const finalSse = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stream_2", object: "response", status: "in_progress", model: "gpt-5.4", output: [] } })}`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "done" })}`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_stream_2", object: "response", status: "completed", model: "gpt-5.4", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 10, output_tokens: 4 } } })}`,
        ].join("\n\n") + "\n\n";
        return new Response(finalSse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(upstream);

    const cfg: EpxConfig = {
      port: 0,
      defaultProvider: "gw",
      providers: {
        gw: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          apiKey: "sk-gw",
          allowPrivateNetwork: true,
          gatewayToolSearch: true,
          models: ["gpt-5.4"],
        },
      },
    };
    saveConfig(cfg);
    const res = await handleResponses(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gw/gpt-5.4",
          stream: true,
          input: "lookup invoice",
          tools: [
            { type: "function", name: "ping", parameters: { type: "object", properties: {} } },
            { type: "function", name: "invoice_lookup", defer_loading: true, parameters: { type: "object", properties: {} } },
          ],
        }),
      }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).toContain("done");
    expect(turn).toBe(2);
    expect(seenToolNames[1]).toEqual(["ping", GATEWAY_TOOL_SEARCH_TOOL_NAME, "invoice_lookup"]);
  });

  test("passthrough parseStream correlates item.id across completed without output_item.done and emits incremental text & incomplete chunks without compaction buffering", async () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-test",
      authMode: "key",
    });

    // 1. response.completed correlates item.id to existing toolCall without duplicating start/delta/end
    {
      const budget = createTranslatorBudget();
      try {
        const sse = [
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "fc_item_only", type: "function_call", name: "lookup_order", arguments: "" } })}`,
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_item_only", output_index: 0, delta: "{\"id\":\"ord_1\"}" })}`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fc_only", object: "response", status: "completed", model: "gpt-5.4", output: [{ id: "fc_item_only", call_id: "call_final_1", type: "function_call", name: "lookup_order", arguments: "{\"id\":\"ord_1\"}" }], usage: { input_tokens: 10, output_tokens: 5 } } })}`,
        ].join("\n\n") + "\n\n";
        const events = [];
        for await (const ev of adapter.parseStream(
          new Response(sse, { headers: { "content-type": "text/event-stream" } }),
          budget,
          undefined,
          { routedCompaction: false },
        )) {
          events.push(ev);
        }
        expect(events.filter(e => e.type === "tool_call_start")).toEqual([
          { type: "tool_call_start", id: "fc_item_only", name: "lookup_order" },
        ]);
        expect(events.filter(e => e.type === "tool_call_delta")).toEqual([
          { type: "tool_call_delta", arguments: "{\"id\":\"ord_1\"}" },
        ]);
        expect(events.filter(e => e.type === "tool_call_end")).toEqual([{ type: "tool_call_end" }]);
      } finally {
        budget.dispose();
      }
    }

    // 2. Non-compaction parseStream emits incremental text_delta BEFORE response.completed arrives and avoids duplicate emission
    {
      const budget = createTranslatorBudget();
      const encoder = new TextEncoder();
      let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          streamCtrl = ctrl;
        },
      });
      const iter = adapter.parseStream(
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        budget,
        undefined,
        { routedCompaction: false },
      );
      try {
        streamCtrl.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}\n\n`));
        const first = await iter.next();
        expect(first.done).toBe(false);
        expect(first.value).toEqual({ type: "text_delta", text: "Hel" });

        streamCtrl.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`));
        const second = await iter.next();
        expect(second.done).toBe(false);
        expect(second.value).toEqual({ type: "text_delta", text: "lo" });

        streamCtrl.enqueue(encoder.encode(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_inc_done", status: "completed", model: "gpt-5.4", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] }], usage: { input_tokens: 4, output_tokens: 2 } } })}\n\n`,
        ));
        streamCtrl.close();

        const tail = [];
        for (let step = await iter.next(); !step.done; step = await iter.next()) {
          tail.push(step.value);
        }
        // Only the un-streamed trailing "!" is emitted once; no heartbeat or duplicate "Hello".
        expect(tail).toEqual([
          { type: "text_delta", text: "!" },
          expect.objectContaining({ type: "done" }),
        ]);
      } finally {
        budget.dispose();
      }
    }

    // 3. response.incomplete (max_output_tokens) preserves deltas + snapshot remainder before incomplete, without duplicating streamed text
    {
      const budgetA = createTranslatorBudget();
      const budgetB = createTranslatorBudget();
      const budgetC = createTranslatorBudget();
      try {
        // 3a: deltas + snapshot remainder
        const sseDeltaSnap = [
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial " })}`,
          `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial cutoff" }] }] } })}`,
        ].join("\n\n") + "\n\n";
        const evA = [];
        for await (const ev of adapter.parseStream(new Response(sseDeltaSnap, { headers: { "content-type": "text/event-stream" } }), budgetA, undefined, { routedCompaction: false })) {
          evA.push(ev);
        }
        expect(evA).toEqual([
          { type: "text_delta", text: "Partial " },
          { type: "text_delta", text: "cutoff" },
          { type: "incomplete", reason: "max_output_tokens" },
        ]);

        // 3b: snapshot-only incomplete
        const sseSnapOnly = [
          `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Snapshot only" }] }] } })}`,
        ].join("\n\n") + "\n\n";
        const evB = [];
        for await (const ev of adapter.parseStream(new Response(sseSnapOnly, { headers: { "content-type": "text/event-stream" } }), budgetB, undefined, { routedCompaction: false })) {
          evB.push(ev);
        }
        expect(evB).toEqual([
          { type: "text_delta", text: "Snapshot only" },
          { type: "incomplete", reason: "max_output_tokens" },
        ]);

        // 3c: compaction mode ({ routedCompaction: true }) still buffers as heartbeat and drops text on incomplete
        const evC = [];
        for await (const ev of adapter.parseStream(new Response(sseDeltaSnap, { headers: { "content-type": "text/event-stream" } }), budgetC, undefined, { routedCompaction: true })) {
          evC.push(ev);
        }
        expect(evC).toEqual([
          { type: "heartbeat" },
          { type: "incomplete", reason: "max_output_tokens" },
        ]);
      } finally {
        budgetA.dispose();
        budgetB.dispose();
        budgetC.dispose();
      }
    }

    // 4. End-to-end handleResponses (stream: true, gatewayToolSearch) omits output_item.done and delivers incremental output_text.delta before completion
    {
      let turn = 0;
      const encoder = new TextEncoder();
      let secondTurnCtrl!: ReadableStreamDefaultController<Uint8Array>;
      const upstream = Bun.serve({
        port: 0,
        async fetch() {
          turn += 1;
          if (turn === 1) {
            const sse = [
              `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_no_done_1", status: "in_progress", model: "gpt-5.4", output: [] } })}`,
              `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "fc_e2e_1", type: "function_call", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: "" } })}`,
              `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_e2e_1", output_index: 0, delta: "{\"query\":\"invoice\"}" })}`,
              `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_no_done_1", status: "completed", model: "gpt-5.4", output: [{ id: "fc_e2e_1", call_id: "call_e2e_final", type: "function_call", name: GATEWAY_TOOL_SEARCH_TOOL_NAME, arguments: "{\"query\":\"invoice\"}" }], usage: { input_tokens: 10, output_tokens: 5 } } })}`,
            ].join("\n\n") + "\n\n";
            return new Response(sse, { headers: { "content-type": "text/event-stream" } });
          }
          const bodyStream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              secondTurnCtrl = ctrl;
              ctrl.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "chunk1 " })}\n\n`));
            },
          });
          return new Response(bodyStream, { headers: { "content-type": "text/event-stream" } });
        },
      });
      servers.push(upstream);

      const cfg: EpxConfig = {
        port: 0,
        defaultProvider: "gw-live",
        providers: {
          "gw-live": {
            adapter: "openai-responses",
            baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
            apiKey: "sk-gw-live",
            allowPrivateNetwork: true,
            gatewayToolSearch: true,
            models: ["gpt-5.4"],
          },
        },
      };
      saveConfig(cfg);
      const res = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gw-live/gpt-5.4",
            stream: true,
            input: "lookup invoice",
            tools: [
              { type: "function", name: "invoice_lookup", defer_loading: true, parameters: { type: "object", properties: {} } },
            ],
          }),
        }),
        cfg,
        { model: "", provider: "" } as RequestLogContext,
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seenUntilFirstDelta = "";
      while (!seenUntilFirstDelta.includes("\"chunk1 \"")) {
        const { done, value } = await reader.read();
        if (done) break;
        seenUntilFirstDelta += decoder.decode(value, { stream: true });
      }
      expect(seenUntilFirstDelta).toContain("response.output_text.delta");
      expect(seenUntilFirstDelta).toContain("\"chunk1 \"");
      secondTurnCtrl.enqueue(encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_no_done_2", status: "completed", model: "gpt-5.4", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "chunk1 chunk2" }] }], usage: { input_tokens: 10, output_tokens: 4 } } })}\n\n`,
      ));
      secondTurnCtrl.close();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
      }
      const fullSse = seenUntilFirstDelta + rest;
      expect(fullSse).toContain("\"chunk2\"");
      expect(fullSse).toContain("response.completed");
      // Exactly one chunk1 delta + one chunk2 delta, never duplicated as "chunk1 chunk2".
      expect(fullSse.match(/^event: response\.output_text\.delta$/gm)?.length).toBe(2);
    }

    // 5. response.incomplete with truncated function_call args (status: "in_progress" or omitted from output) marks tool_call_end incomplete instead of failing as malformed JSON
    {
      const budgetD = createTranslatorBudget();
      const budgetE = createTranslatorBudget();
      try {
        const sseInProgressCall = [
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "fc_trunc_1", type: "function_call", name: "lookup_order", arguments: "" } })}`,
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_trunc_1", output_index: 0, delta: "{\"id\":" })}`,
          `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ id: "fc_trunc_1", call_id: "call_trunc_1", type: "function_call", name: "lookup_order", status: "in_progress", arguments: "{\"id\":" }] } })}`,
        ].join("\n\n") + "\n\n";
        const evD = [];
        for await (const ev of adapter.parseStream(new Response(sseInProgressCall, { headers: { "content-type": "text/event-stream" } }), budgetD, undefined, { routedCompaction: false })) {
          evD.push(ev);
        }
        expect(evD).toEqual([
          { type: "tool_call_start", id: "fc_trunc_1", name: "lookup_order" },
          { type: "tool_call_delta", arguments: "{\"id\":" },
          { type: "tool_call_end", incomplete: true },
          { type: "incomplete", reason: "max_output_tokens" },
        ]);

        const sseOmittedCall = [
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "fc_trunc_2", type: "function_call", name: "lookup_order", arguments: "" } })}`,
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_trunc_2", output_index: 0, delta: "{\"id\":" })}`,
          `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } })}`,
        ].join("\n\n") + "\n\n";
        const evE = [];
        for await (const ev of adapter.parseStream(new Response(sseOmittedCall, { headers: { "content-type": "text/event-stream" } }), budgetE, undefined, { routedCompaction: false })) {
          evE.push(ev);
        }
        expect(evE).toEqual([
          { type: "tool_call_start", id: "fc_trunc_2", name: "lookup_order" },
          { type: "tool_call_delta", arguments: "{\"id\":" },
          { type: "tool_call_end", incomplete: true },
          { type: "incomplete", reason: "max_output_tokens" },
        ]);
      } finally {
        budgetD.dispose();
        budgetE.dispose();
      }
    }

    // 6. End-to-end handleResponses (stream: true, gatewayToolSearch) preserves partial text and truncated tool call on response.incomplete
    {
      const upstream = Bun.serve({
        port: 0,
        async fetch() {
          const sse = [
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_inc_gw", status: "in_progress", model: "gpt-5.4", output: [] } })}`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial answer " })}`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { id: "fc_inc_gw", type: "function_call", name: "invoice_lookup", arguments: "" } })}`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_inc_gw", output_index: 1, delta: "{\"id\":" })}`,
            `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { id: "resp_inc_gw", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial answer tail" }] }, { id: "fc_inc_gw", call_id: "call_inc_gw", type: "function_call", name: "invoice_lookup", status: "in_progress", arguments: "{\"id\":" }] } })}`,
          ].join("\n\n") + "\n\n";
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        },
      });
      servers.push(upstream);

      const cfg: EpxConfig = {
        port: 0,
        defaultProvider: "gw-inc",
        providers: {
          "gw-inc": {
            adapter: "openai-responses",
            baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
            apiKey: "sk-gw-inc",
            allowPrivateNetwork: true,
            gatewayToolSearch: true,
            models: ["gpt-5.4"],
          },
        },
      };
      saveConfig(cfg);
      const res = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gw-inc/gpt-5.4",
            stream: true,
            input: "lookup invoice",
            tools: [
              { type: "function", name: "invoice_lookup", defer_loading: true, parameters: { type: "object", properties: { id: { type: "string" } } } },
              { type: "function", name: "ping", parameters: { type: "object", properties: {} } },
            ],
          }),
        }),
        cfg,
        { model: "", provider: "" } as RequestLogContext,
      );
      expect(res.status).toBe(200);
      const sseText = await res.text();
      expect(sseText).toContain("\"Partial answer \"");
      expect(sseText).toContain("\"tail\"");
      expect(sseText).toContain("event: response.incomplete");
      expect(sseText).not.toContain("event: response.failed");
    }
  });
});
