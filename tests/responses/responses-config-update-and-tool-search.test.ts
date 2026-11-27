import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
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
      description: "Matches literal (a+)+! marker cleanly",
      parameters: { type: "object", properties: {} },
      deferLoading: true,
    };
    for (const evilQuery of ["(.*)+!", "(a+)+!", "(a+)+$"]) {
      const startNs = Bun.nanoseconds();
      const hits = searchDeferredTools([...deferred, repeatDescTool], evilQuery);
      const elapsedMs = (Bun.nanoseconds() - startNs) / 1e6;
      expect(elapsedMs).toBeLessThan(10);
      expect(hits).toEqual([]);
    }
    const literalStartNs = Bun.nanoseconds();
    const literalHits = searchDeferredTools([repeatDescTool, literalExprTool], "(a+)+!");
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
});
