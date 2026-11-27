import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAnthropicCacheControl } from "../../src/adapters/anthropic/cache-retention";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { saveConfig } from "../../src/config";
import { inspectPromptContextJson, MAX_CONTEXT_INSPECT_CHARS } from "../../src/lib/context-inspector";
import { injectPromptCacheBreakpointsInPlace } from "../../src/lib/prompt-cache-injection";
import { routeModel } from "../../src/router";
import { applyAnthropicScenarioEffort, supportsAnthropicOutputConfigEffort } from "../../src/routing/scenario";
import { handleAgentScenarioRoutingCommand } from "../../src/cli/agent-scenario-routing";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  applyOutboundPayloadHygiene,
  getOutboundHygieneStats,
  resetOutboundHygieneStatsForTests,
} from "../../src/server/outbound-payload-hygiene";
import type { EpxConfig, EpxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { managementHeaders, ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;
let previousUserHome: string | undefined;
let releaseSpend: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.EASYPROXY_HOME;
  previousUserHome = process.env.HOME;
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "epx-token-eff-")));
  process.env.EASYPROXY_HOME = home;
  process.env.HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  resetOutboundHygieneStatsForTests();
});

afterEach(() => {
  resetOutboundHygieneStatsForTests();
  releaseSpend?.();
  releaseSpend = undefined;
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  if (previousUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousUserHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function callMgmt(method: string, path: string, cfg: EpxConfig, body?: unknown) {
  const req = new Request(`http://127.0.0.1:10100${path}`, {
    method,
    headers: {
      host: "127.0.0.1:10100",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), cfg, {});
  const json = res ? (await res.json()) as Record<string, unknown> : null;
  return { status: res?.status ?? 0, json };
}

describe("gateway guardrails token-efficiency routes and prompt-cache optimizations", () => {
  test("GET/PUT /api/gateway-guardrails persists compactJson, deduplicateIdentical, and dedupMinChars and validates bounds", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-test-alpha",
          models: ["gpt-5"],
        },
      },
    };
    saveConfig(cfg);

    const initial = await callMgmt("GET", "/api/gateway-guardrails", cfg);
    expect(initial.status).toBe(200);
    expect((initial.json?.toolOutputCompression as Record<string, unknown>)?.enabled).toBe(false);
    expect((initial.json?.promptCacheInjection as Record<string, unknown>)?.enabled).toBe(false);

    // Out-of-range dedupMinChars (< 128) is rejected fail-closed with 400.
    const invalidPut = await callMgmt("PUT", "/api/gateway-guardrails", cfg, {
      toolOutputCompression: {
        enabled: true,
        minChars: 8000,
        headChars: 2000,
        tailChars: 2000,
        stripAnsi: true,
        compactJson: false,
        deduplicateIdentical: true,
        dedupMinChars: 64,
      },
    });
    expect(invalidPut.status).toBe(400);

    // Valid custom settings persist and round-trip.
    const validPut = await callMgmt("PUT", "/api/gateway-guardrails", cfg, {
      outboundSecretGuard: { mode: "redact" },
      toolOutputCompression: {
        enabled: true,
        minChars: 8000,
        headChars: 2000,
        tailChars: 2000,
        stripAnsi: true,
        compactJson: false,
        deduplicateIdentical: false,
        dedupMinChars: 1024,
      },
    });
    expect(validPut.status).toBe(200);
    expect(validPut.json?.toolOutputCompression).toEqual({
      enabled: true,
      minChars: 8000,
      headChars: 2000,
      tailChars: 2000,
      stripAnsi: true,
      compactJson: false,
      deduplicateIdentical: false,
      dedupMinChars: 1024,
    });
  });

  test("POST /api/gateway-guardrails/dry-run simulates JSON compaction, duplicate-turn dedup, and hygiene stats", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {},
      toolOutputCompression: {
        enabled: true,
        minChars: 50_000,
        headChars: 4_000,
        tailChars: 4_000,
        stripAnsi: true,
        compactJson: true,
        deduplicateIdentical: true,
        dedupMinChars: 256,
      },
    };

    const prettyJson = JSON.stringify(
      {
        files: Array.from({ length: 14 }, (_, idx) => ({
          name: `module_${idx}.ts`,
          exports: ["init", "dispose"],
          size: 1024 + idx * 64,
        })),
      },
      null,
      2,
    );

    const singleDryRun = await callMgmt("POST", "/api/gateway-guardrails/dry-run", cfg, {
      text: prettyJson,
    });
    expect(singleDryRun.status).toBe(200);
    expect(singleDryRun.json?.compactedJsonItems).toBe(1);
    expect(singleDryRun.json?.deduplicatedItems ?? 0).toBe(0);
    expect(Number(singleDryRun.json?.savedChars)).toBeGreaterThan(80);
    expect(Number(singleDryRun.json?.estimatedSavedTokens)).toBeGreaterThan(20);

    const dupDryRun = await callMgmt("POST", "/api/gateway-guardrails/dry-run", cfg, {
      text: prettyJson,
      duplicatePass: true,
    });
    expect(dupDryRun.status).toBe(200);
    expect(dupDryRun.json?.deduplicatedItems).toBe(1);
    expect(String(dupDryRun.json?.previewText)).toContain("[easyproxy deduplicated tool output: identical to call_id=call_dryrun_1");

    // Non-boolean duplicatePass fails closed with 400.
    const badDupFlag = await callMgmt("POST", "/api/gateway-guardrails/dry-run", cfg, {
      text: "hello",
      duplicatePass: "yes",
    });
    expect(badDupFlag.status).toBe(400);

    // Oversized text (> 65,536 chars) fails closed with 413.
    const tooLarge = await callMgmt("POST", "/api/gateway-guardrails/dry-run", cfg, {
      text: "x".repeat(66_000),
    });
    expect(tooLarge.status).toBe(413);

    // Outbound hygiene runtime stats aggregate compactedJsonOutputs, deduplicatedToolOutputs, and estimatedSavedTokens.
    const livePayload = {
      input: [
        { type: "function_call_output", call_id: "c_1", output: prettyJson },
        { type: "function_call_output", call_id: "c_2", output: prettyJson },
      ],
    };
    applyOutboundPayloadHygiene(livePayload, cfg);
    const stats = getOutboundHygieneStats();
    expect(stats.compactedJsonOutputs).toBe(1);
    expect(stats.deduplicatedToolOutputs).toBe(1);
    expect(stats.estimatedSavedTokens).toBe(Math.floor(stats.savedChars / 4));
  });

  test("hasAnthropicCacheControl ignores literal cache_control inside user strings and tool schemas while detecting real breakpoints", () => {
    const falsePositiveBody = {
      system: [{ type: "text", text: 'Explain how {"cache_control":{"type":"ephemeral"}} works in Claude.' }],
      tools: [
        {
          name: "inspect_config",
          input_schema: {
            type: "object",
            properties: {
              cache_control: { type: "object", properties: { ttl: { type: "string" } } },
            },
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: 'Payload sample: "cache_control": {"type": "ephemeral", "ttl": "1h"}' }],
        },
      ],
    };
    expect(hasAnthropicCacheControl(falsePositiveBody)).toBe(false);

    // Real breakpoints at top-level, system, tool, and nested tool_result are detected.
    expect(hasAnthropicCacheControl({ ...falsePositiveBody, cache_control: { type: "ephemeral" } })).toBe(true);
    expect(hasAnthropicCacheControl({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", cache_control: { type: "ephemeral", ttl: "5m" }, content: "ok" }],
        },
      ],
    })).toBe(true);
  });

  test("Chat Completions inbound and native passthrough preserve prompt_cache_retention when promptCacheKey is enabled", () => {
    const rawChat = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Cache this long system context." }],
      prompt_cache_key: "repo:easyproxy:main",
      prompt_cache_retention: "24h",
    };

    const translated = chatCompletionsToResponsesBody(rawChat);
    expect(translated.prompt_cache_key).toBe("repo:easyproxy:main");
    expect(translated.prompt_cache_retention).toBe("24h");

    const enabledProvider: EpxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "sk-test",
      promptCacheKey: true,
    };
    const nativeEnabled = buildOpenAIChatPassthroughRequest(enabledProvider, rawChat, "gpt-5", false);
    const nativeBody = JSON.parse(nativeEnabled.body) as Record<string, unknown>;
    expect(nativeBody.prompt_cache_key).toBe("repo:easyproxy:main");
    expect(nativeBody.prompt_cache_retention).toBe("24h");

    // Unsupported retention values or providers without promptCacheKey never leak onto the upstream wire.
    const disabledProvider: EpxProviderConfig = {
      ...enabledProvider,
      promptCacheKey: false,
    };
    const nativeDisabled = buildOpenAIChatPassthroughRequest(disabledProvider, rawChat, "gpt-5", false);
    const disabledBody = JSON.parse(nativeDisabled.body) as Record<string, unknown>;
    expect(disabledBody.prompt_cache_key).toBeUndefined();
    expect(disabledBody.prompt_cache_retention).toBeUndefined();

    const bogusRetention = buildOpenAIChatPassthroughRequest(
      enabledProvider,
      { ...rawChat, prompt_cache_retention: "forever" },
      "gpt-5",
      false,
    );
    expect((JSON.parse(bogusRetention.body) as Record<string, unknown>).prompt_cache_retention).toBeUndefined();

    // Non-OpenAI hosts with promptCacheKey: true (e.g. Mistral, Kimi) keep prompt_cache_key but never receive OpenAI-only prompt_cache_retention.
    const mistralProvider: EpxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.mistral.ai/v1",
      authMode: "key",
      apiKey: "sk-mistral",
      promptCacheKey: true,
    };
    const mistralWire = buildOpenAIChatPassthroughRequest(mistralProvider, rawChat, "codestral-latest", false);
    const mistralBody = JSON.parse(mistralWire.body) as Record<string, unknown>;
    expect(mistralBody.prompt_cache_key).toBe("repo:easyproxy:main");
    expect(mistralBody.prompt_cache_retention).toBeUndefined();

    // Retired gpt-5.6 family on api.openai.com omits prompt_cache_retention on Chat passthrough too.
    const gpt56Wire = buildOpenAIChatPassthroughRequest(enabledProvider, rawChat, "gpt-5.6-codex", false);
    const gpt56Body = JSON.parse(gpt56Wire.body) as Record<string, unknown>;
    expect(gpt56Body.prompt_cache_key).toBe("repo:easyproxy:main");
    expect(gpt56Body.prompt_cache_retention).toBeUndefined();
  });

  test("POST /api/routing/scenario/classify evaluates disabled candidate drafts, reports resolveError, and estimates tokens", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "alpha",
      providers: {
        alpha: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-alpha",
          models: ["gpt-5-mini"],
        },
      },
    };
    saveConfig(cfg);

    // Pre-activation probe (`enabled: false`) still tests candidate routes, validates target availability, and estimates prompt tokens.
    const brokenTargetProbe = await callMgmt("POST", "/api/routing/scenario/classify", cfg, {
      body: {
        system: "Summarize this conversation in 5-10 words.",
        messages: [{ role: "user", content: "Verify gateway routing rules before enabling." }],
      },
      scenarioRouting: {
        enabled: false,
        routes: { background: "combo/missing-combo" },
      },
    });
    expect(brokenTargetProbe.status).toBe(200);
    expect(brokenTargetProbe.json?.active).toBe(false);
    expect(brokenTargetProbe.json?.matched).toBeNull();
    expect(brokenTargetProbe.json?.targetSelector).toBe("combo/missing-combo");
    expect(typeof brokenTargetProbe.json?.resolveError).toBe("string");
    const cls1 = brokenTargetProbe.json?.classification as { matched: string; estimatedTokens: number };
    expect(cls1.matched).toBe("background");
    expect(cls1.estimatedTokens).toBeGreaterThan(10);

    // Empty-routes probe still evaluates custom longContextThresholdTokens so users can inspect signal matching first.
    const thresholdOnlyProbe = await callMgmt("POST", "/api/routing/scenario/classify", cfg, {
      body: {
        messages: [{ role: "user", content: "x".repeat(4_400) }],
      },
      scenarioRouting: {
        enabled: false,
        longContextThresholdTokens: 1_000,
        routes: {},
      },
    });
    expect(thresholdOnlyProbe.status).toBe(200);
    const cls2 = thresholdOnlyProbe.json?.classification as { matched: string; estimatedTokens: number };
    expect(cls2.matched).toBe("longContext");
    expect(cls2.estimatedTokens).toBeGreaterThanOrEqual(1_000);
  });

  test("injectPromptCacheBreakpointsInPlace respects 4-breakpoint cap, TTL ordering, thinking/reminder exclusions, and volatile clock hygiene", () => {
    const anthropicPayload = {
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [
        { type: "text", text: `${"Static architectural rules. ".repeat(100)}\nCurrent time: 2026-11-27T03:45:12.987Z` },
        { type: "text", text: "<system-reminder>Volatile per-turn reminder</system-reminder>" },
      ],
      tools: [
        {
          name: "search_symbols",
          description: "Search symbol index across repository. ".repeat(70),
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      messages: [
        { role: "user", content: "Inspect routing invariants. ".repeat(90) },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Internal reasoning..." },
            { type: "text", text: "" },
          ],
        },
      ],
    };

    const res = injectPromptCacheBreakpointsInPlace(anthropicPayload, {
      enabled: true,
      ttl: "1h",
      stripVolatileSystemTimestamps: true,
    });
    expect(res.injectedBreakpoints).toBe(3);
    expect(res.normalizedTimestamps).toBe(1);
    expect(anthropicPayload.system[0]!.text).toContain("Current time: 2026-11-27");
    expect(anthropicPayload.system[0]!.text).not.toContain("03:45:12");
    // Static system block got breakpoint; turn-scoped <system-reminder> was skipped!
    expect((anthropicPayload.system[0] as Record<string, unknown>).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((anthropicPayload.system[1] as Record<string, unknown>).cache_control).toBeUndefined();
    expect((anthropicPayload.tools[0] as Record<string, unknown>).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Assistant message had only thinking + empty text, so user message[0] was promoted and cached!
    expect(Array.isArray(anthropicPayload.messages[0]!.content)).toBe(true);

    // TTL ordering: if caller pinned "5m" on tools, downstream system/messages must NEVER get "1h"
    const caller5mBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools: [
        {
          name: "t1",
          description: "x".repeat(2_200),
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      system: "s".repeat(2_400),
      messages: [{ role: "user", content: "m".repeat(2_400) }],
    };
    const res5m = injectPromptCacheBreakpointsInPlace(caller5mBody, { enabled: true, ttl: "1h" });
    expect(res5m.injectedBreakpoints).toBe(2);
    expect(((caller5mBody.system as unknown as Array<Record<string, unknown>>)[0]!.cache_control as { ttl?: string }).ttl).toBe("5m");

    // 4-breakpoint ceiling: when 4 breakpoints already exist, injects 0
    const fullBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        { type: "text", text: "a".repeat(1000), cache_control: { type: "ephemeral" } },
        { type: "text", text: "b".repeat(1000), cache_control: { type: "ephemeral" } },
        { type: "text", text: "c".repeat(1000), cache_control: { type: "ephemeral" } },
        { type: "text", text: "d".repeat(1000), cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "u".repeat(2_500) }],
    };
    expect(injectPromptCacheBreakpointsInPlace(fullBody, { enabled: true }).injectedBreakpoints).toBe(0);

    // OpenAI Chat Completions wire must NEVER receive Anthropic cache_control
    const openAiChat = {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "s".repeat(3_000) },
        { role: "user", content: "u".repeat(3_000) },
      ],
    };
    expect(injectPromptCacheBreakpointsInPlace(openAiChat, { enabled: true }).injectedBreakpoints).toBe(0);
  });

  test("inspectPromptContextJson decomposes categories, 128-cell grid, warnings, and fails closed on hostile inputs", () => {
    expect(inspectPromptContextJson("").ok).toBe(false);
    expect(inspectPromptContextJson("not-json").ok).toBe(false);
    expect(inspectPromptContextJson(`${"[".repeat(60)}${"]".repeat(60)}`).ok).toBe(false);
    expect(inspectPromptContextJson("x".repeat(MAX_CONTEXT_INSPECT_CHARS + 10)).ok).toBe(false);

    const report = inspectPromptContextJson(JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: [
        { type: "text", text: `System rules ${"a".repeat(2_000)} 2026-11-27T03:45:00Z`, cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
      tools: [
        { name: "mcp__fs__read", description: "d".repeat(4_000), input_schema: { type: "object" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "u1", content: "same_output_".repeat(40), cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "tool_result", tool_use_id: "u2", content: "same_output_".repeat(40) },
          ],
        },
      ],
    }));
    expect(report.ok).toBe(true);
    expect(report.cells).toHaveLength(128);
    expect(report.categories.find(c => c.id === "mcp")?.tokens).toBeGreaterThan(900);
    expect(report.cache.warnings).toContain("volatile_iso_timestamp_in_system");
    expect(report.cache.warnings).toContain("ttl_ordering_hazard");
    expect(report.cache.warnings).toContain("duplicate_tool_outputs");
  });

  test("scenarioRouting.efforts supports cache-preserving in-place effort overrides and classify dry-run reporting", async () => {
    const cfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "main",
      providers: {
        main: {
          adapter: "openai-responses",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-main",
          models: ["alpha-model"],
        },
      },
      scenarioRouting: {
        enabled: true,
        routes: {},
        efforts: {
          background: "low",
          think: "xhigh",
        },
      },
    };
    saveConfig(cfg);

    const routed = routeModel(cfg, "alpha-model", undefined, {
      body: {
        instructions: "Generate a concise title for this session.",
        input: "Refactor scenario routing.",
      },
    });
    expect(routed.providerName).toBe("main");
    expect(routed.modelId).toBe("alpha-model");
    expect(routed.credentialDomainRewrite).toBeUndefined();
    expect(routed.scenarioMatch?.scenario).toBe("background");
    expect(routed.scenarioMatch?.effort).toBe("low");

    const classifyRes = await callMgmt("POST", "/api/routing/scenario/classify", cfg, {
      body: {
        instructions: "Generate a concise title for this session.",
        input: "Refactor scenario routing.",
      },
    });
    expect(classifyRes.status).toBe(200);
    expect(classifyRes.json?.matched).toBe("background");
    expect(classifyRes.json?.resolvedEffort).toBe("low");
  });

  test("gates Anthropic output_config.effort by Claude family/thinking mode, injects rolling tail breakpoints after early cached turns, and validates top-level cache_control TTL order", () => {
    expect(supportsAnthropicOutputConfigEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsAnthropicOutputConfigEffort("claude-sonnet-4-5")).toBe(false);
    expect(supportsAnthropicOutputConfigEffort("claude-sonnet-4-6")).toBe(true);
    expect(supportsAnthropicOutputConfigEffort("claude-opus-4-6")).toBe(true);
    expect(supportsAnthropicOutputConfigEffort("claude-haiku-5-5")).toBe(true);

    // Unsupported Haiku 4.5 must NEVER receive output_config.effort (prevents upstream 400)
    const haikuBody: Record<string, unknown> = {
      model: "claude-haiku-4-5",
      system: "Summarize this conversation in 5-10 words.",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(
      applyAnthropicScenarioEffort(haikuBody, {
        enabled: true,
        routes: {},
        efforts: { background: "low" },
      }),
    ).toBeNull();
    expect(haikuBody.output_config).toBeUndefined();

    // Conflicting thinking.type=disabled must not receive output_config.effort; between_tools clamps xhigh -> high
    const disabledThinkBody: Record<string, unknown> = {
      model: "claude-sonnet-4-6",
      thinking: { type: "disabled" },
      system: "Summarize this conversation in 5-10 words.",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(
      applyAnthropicScenarioEffort(disabledThinkBody, {
        enabled: true,
        routes: {},
        efforts: { background: "low" },
      }),
    ).toBeNull();

    const betweenToolsBody: Record<string, unknown> = {
      model: "claude-sonnet-5-5",
      thinking: { type: "between_tools" },
      messages: [{ role: "user", content: "hi" }],
    };
    const clampedRes = applyAnthropicScenarioEffort(
      betweenToolsBody,
      { enabled: true, routes: {}, efforts: { think: "xhigh" } },
      { "x-epx-scenario": "think" },
    );
    expect(clampedRes?.effort).toBe("high");
    expect(betweenToolsBody.output_config).toEqual({ effort: "high" });

    // Multi-turn messages where turn 0 already has 5m cache_control still inject a rolling tail breakpoint downgraded from 1h -> 5m
    const multiTurnBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "early context", cache_control: { type: "ephemeral", ttl: "5m" } }] },
        { role: "assistant", content: "ack" },
        { role: "user", content: "tail content ".repeat(240) },
      ],
    };
    const tailRes = injectPromptCacheBreakpointsInPlace(multiTurnBody, { enabled: true, ttl: "1h" });
    expect(tailRes.existingBreakpoints).toBe(1);
    expect(tailRes.injectedBreakpoints).toBe(1);
    expect(multiTurnBody.messages[2]!.content).toEqual([
      { type: "text", text: "tail content ".repeat(240), cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);

    // Vertex Claude 3.x IDs downgrade explicit 1h -> 5m
    const vertexClaude3 = {
      model: "claude-3-7-sonnet@20250219",
      max_tokens: 1024,
      messages: [{ role: "user", content: "v".repeat(2_500) }],
    };
    injectPromptCacheBreakpointsInPlace(vertexClaude3, { enabled: true, ttl: "1h" });
    expect((vertexClaude3.messages[0]!.content as unknown as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });

    // Top-level automatic cache_control evaluates AFTER tools/system/messages (1h tools + 5m top-level is valid; 5m tools + 1h top-level is hazard)
    const validTopAuto = inspectPromptContextJson(JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      cache_control: { type: "ephemeral" },
      tools: [{ name: "read", description: "r".repeat(2_000), input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "check" }],
    }));
    expect(validTopAuto.cache.warnings).not.toContain("ttl_ordering_hazard");
    expect(validTopAuto.cellsFit.every(c => c.kind !== "free")).toBe(true);
    expect(validTopAuto.entries[0]?.preview).toContain("read");

    const invalidTopAuto = inspectPromptContextJson(JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      cache_control: { type: "ephemeral", ttl: "1h" },
      tools: [{ name: "read", description: "r".repeat(2_000), input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "5m" } }],
      messages: [{ role: "user", content: "check" }],
    }));
    expect(invalidTopAuto.cache.warnings).toContain("ttl_ordering_hazard");
  });

  test("scenarioRouting.efforts respects supportedLadderFor on /v1/responses + native /v1/chat/completions, and CLI surfaces efforts", async () => {
    const capturedBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, unknown>;
        capturedBodies.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/chat/completions")) {
          return Response.json({
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 1,
            model: String(body.model ?? "chat-reasoner"),
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          });
        }
        if (url.pathname.endsWith("/messages")) {
          return Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: String(body.model ?? "claude-sonnet-4-6"),
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 16, output_tokens: 4 },
          });
        }
        return Response.json({
          id: "resp_1",
          object: "response",
          status: "completed",
          model: String(body.model ?? "plain-no-reason"),
          output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        });
      },
    });

    try {
      const cfg: EpxConfig = {
        port: 10101,
        hostname: "127.0.0.1",
        defaultProvider: "resp-prov",
        providers: {
          "resp-prov": {
            adapter: "openai-responses",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-test",
            allowPrivateNetwork: true,
            models: ["plain-no-reason", "capped-reasoner"],
            noReasoningModels: ["plain-no-reason"],
            modelReasoningEfforts: { "capped-reasoner": ["low", "medium", "high"] },
          },
          "chat-prov": {
            adapter: "openai-chat",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-test",
            allowPrivateNetwork: true,
            models: ["chat-reasoner", "chat-no-reason"],
            noReasoningModels: ["chat-no-reason"],
            modelReasoningEfforts: { "chat-reasoner": ["low", "medium", "high"] },
          },
        },
        scenarioRouting: {
          enabled: true,
          routes: {},
          efforts: {
            background: "low",
            think: "xhigh",
          },
        },
      };
      saveConfig(cfg);

      const freshLog = (): RequestLogContext => ({ model: "", provider: "" } as RequestLogContext);

      // 1. /v1/responses on noReasoningModels strips scenario effort instead of sending unsupported reasoning
      const noReasonRes = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json", "x-epx-priority": "background" },
          body: JSON.stringify({ model: "resp-prov/plain-no-reason", input: "hello" }),
        }),
        cfg,
        freshLog(),
      );
      expect(noReasonRes.status).toBe(200);
      await noReasonRes.text();
      expect(capturedBodies[0]?.body.reasoning).toBeUndefined();

      // 2. /v1/responses on ["low","medium","high"] clamps scenario xhigh -> high
      const clampedResp = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json", "x-epx-scenario": "think" },
          body: JSON.stringify({ model: "resp-prov/capped-reasoner", input: "prove invariant" }),
        }),
        cfg,
        freshLog(),
      );
      expect(clampedResp.status).toBe(200);
      await clampedResp.text();
      expect(capturedBodies[1]?.body.reasoning).toEqual({ effort: "high" });

      // 3. Native /v1/chat/completions applies scenario effort on chat-reasoner and skips chat-no-reason
      const nativeChatOk = await handleChatCompletions(
        new Request("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-epx-priority": "background" },
          body: JSON.stringify({
            model: "chat-prov/chat-reasoner",
            stream: false,
            messages: [{ role: "user", content: "short title" }],
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(nativeChatOk.status).toBe(200);
      expect(capturedBodies[2]?.body.reasoning_effort).toBe("low");

      const nativeChatPlain = await handleChatCompletions(
        new Request("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-epx-priority": "background" },
          body: JSON.stringify({
            model: "chat-prov/chat-no-reason",
            stream: false,
            messages: [{ role: "user", content: "short title" }],
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(nativeChatPlain.status).toBe(200);
      expect(capturedBodies[3]?.body.reasoning_effort).toBeUndefined();

      // 4. Managed native /v1/messages skips output_config.effort on claude-haiku-4-5 and applies effort on claude-sonnet-4-6
      const cfgWithAnthropic: EpxConfig = {
        ...cfg,
        protocols: { rollout: { managedMessagesNative: true } },
        providers: {
          ...cfg.providers,
          "anth-gw": {
            adapter: "anthropic",
            baseUrl: `http://127.0.0.1:${upstream.port}`,
            authMode: "key",
            apiKey: "sk-ant-test",
            allowPrivateNetwork: true,
            models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
          },
        },
        promptCacheInjection: {
          enabled: true,
          ttl: "auto",
          stripVolatileSystemTimestamps: true,
        },
      };
      saveConfig(cfgWithAnthropic);

      const haikuMsg = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-epx-priority": "background" },
          body: JSON.stringify({
            model: "anth-gw/claude-haiku-4-5",
            max_tokens: 64,
            stream: false,
            messages: [{ role: "user", content: "Cacheable prefix. ".repeat(160) }],
          }),
        }),
        cfgWithAnthropic,
        freshLog(),
      );
      expect(haikuMsg.status).toBe(200);
      expect(capturedBodies[4]?.body.output_config).toBeUndefined();
      // Gateway host under ttl: "auto" stays at 5m (omits ttl: "1h")
      const haikuMsgBlocks = (capturedBodies[4]?.body.messages as Array<Record<string, unknown>>)[0]?.content as Array<Record<string, unknown>>;
      expect(haikuMsgBlocks[0]?.cache_control).toEqual({ type: "ephemeral" });

      const sonnetMsg = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-epx-scenario": "think" },
          body: JSON.stringify({
            model: "anth-gw/claude-sonnet-4-6",
            max_tokens: 64,
            stream: false,
            messages: [{ role: "user", content: "Reason deeply." }],
          }),
        }),
        cfgWithAnthropic,
        freshLog(),
      );
      expect(sonnetMsg.status).toBe(200);
      expect(capturedBodies[5]?.body.output_config).toEqual({ effort: "xhigh" });

      // 5. CLI parity: set --background-effort medium, show, and classify display Efforts
      const outLines: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((value?: unknown) => {
        outLines.push(String(value ?? ""));
      });
      try {
        const cliDeps = {
          baseUrl: "http://127.0.0.1:10101",
          fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const u = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
            const req = new ManagementRequest(u, { ...init, method, headers: managementHeaders(init?.headers) });
            return (await handleManagementAPI(req, u, cfgWithAnthropic, {})) ?? new Response("not found", { status: 404 });
          }) as typeof fetch,
        };
        const setCode = await handleAgentScenarioRoutingCommand(
          ["set", "--background-effort", "medium", "--think-effort", "high"],
          cliDeps,
        );
        expect(setCode).toBe(0);
        expect(outLines.some(l => l.includes("Efforts:") && l.includes("background=medium") && l.includes("think=high"))).toBe(true);

        outLines.length = 0;
        const classifyCode = await handleAgentScenarioRoutingCommand(
          ["classify", "--header", "x-epx-priority=background"],
          cliDeps,
        );
        expect(classifyCode).toBe(0);
        expect(outLines.some(l => l.includes("Effort: medium"))).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      upstream.stop(true);
    }
  });

  test("Item 7: volatile timestamps stripped across /v1/responses input[] and messages[1..31] without touching user text", () => {
    const responsesBody = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "developer", content: "Current timestamp: 2026-11-27T12:00:00Z\nRespond concisely." },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Current timestamp: 2026-11-27T12:00:00Z" }] },
      ],
    };
    const respResult = injectPromptCacheBreakpointsInPlace(responsesBody, {
      enabled: true,
      stripVolatileSystemTimestamps: true,
    });
    expect(respResult.normalizedTimestamps).toBe(1);
    expect((respResult.body as typeof responsesBody).input[0]!.content).toBe("Current timestamp: 2026-11-27\nRespond concisely.");
    expect(((respResult.body as typeof responsesBody).input[1]!.content as Array<{ text: string }>)[0]!.text).toBe("Current timestamp: 2026-11-27T12:00:00Z");

    const messagesBody = {
      model: "gpt-5.4",
      messages: [
        { role: "user", content: "Current timestamp: 2026-11-27T12:00:00Z" },
        { role: "system", content: "Current timestamp: 2026-11-27T12:00:00Z\nHelper." },
      ],
    };
    const msgResult = injectPromptCacheBreakpointsInPlace(messagesBody, {
      enabled: true,
      stripVolatileSystemTimestamps: true,
    });
    expect(msgResult.normalizedTimestamps).toBe(1);
    expect((msgResult.body as typeof messagesBody).messages[0]!.content).toBe("Current timestamp: 2026-11-27T12:00:00Z");
    expect((msgResult.body as typeof messagesBody).messages[1]!.content).toBe("Current timestamp: 2026-11-27\nHelper.");
  });

  test("Item 7: uses 4th Anthropic breakpoint slot on >20-block spans and earlier turn boundaries", () => {
    const largeText = (label: string) => `${label}: ${"x".repeat(2100)}`;

    // 4-turn multi-turn prefix with tools + system (slots 1 & 2) + tail (slot 3) + earlier turn boundary (slot 4)
    const multiTurnLongBody = {
      model: "claude-sonnet-4-6",
      system: largeText("system-preamble"),
      tools: [{ name: "tool_a", description: largeText("desc-a"), input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: largeText("turn-0-user") },
        { role: "assistant", content: largeText("turn-1-assistant") },
        { role: "user", content: largeText("turn-2-user") },
        { role: "assistant", content: largeText("turn-3-assistant") },
      ],
    };
    const multiRes = injectPromptCacheBreakpointsInPlace(multiTurnLongBody, {
      enabled: true,
      ttl: "5m",
    });
    expect(multiRes.injectedBreakpoints).toBe(4);
    const outMsgs = (multiRes.body as Record<string, unknown>).messages as Array<{ content: unknown }>;
    // Tail (index 3) and an earlier boundary (index 2 or 1) must both carry breakpoints
    expect(Array.isArray(outMsgs[3]!.content)).toBe(true);
    expect(outMsgs.slice(0, 3).filter(m => Array.isArray(m.content)).length).toBe(1);

    // >20-block span: 25 messages with rolling tail bridges the 20-block lookback window
    const manyMessages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: largeText(`turn-${i}`),
    }));
    const lookbackBody = {
      model: "claude-sonnet-4-6",
      system: largeText("system-preamble"),
      tools: [{ name: "tool_a", description: largeText("desc-a"), input_schema: { type: "object" } }],
      messages: manyMessages,
    };
    const lookbackRes = injectPromptCacheBreakpointsInPlace(lookbackBody, {
      enabled: true,
      ttl: "5m",
    });
    expect(lookbackRes.injectedBreakpoints).toBe(4);
    const lookbackOut = (lookbackRes.body as Record<string, unknown>).messages as Array<{ content: unknown }>;
    // Last message is index 24; an intermediate breakpoint sits within lookback distance (indices 4..23)
    expect(Array.isArray(lookbackOut[24]!.content)).toBe(true);
    const earlierBpIndices = lookbackOut
      .slice(0, 24)
      .map((m, idx) => (Array.isArray(m.content) ? idx : -1))
      .filter(idx => idx >= 0);
    expect(earlierBpIndices.length).toBe(1);
    expect(24 - earlierBpIndices[0]!).toBeLessThanOrEqual(20);
  });

  test("Items 7 & 9: single inbound hygiene, accurate telemetry, and native vs bridge cache placement", async () => {
    const upstreamCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.json() as Record<string, unknown>;
        upstreamCalls.push({ path: url.pathname, body });
        if (url.pathname.startsWith("/fail500")) {
          return Response.json({ error: { message: "transient upstream error", type: "server_error" } }, { status: 500 });
        }
        if (url.pathname.endsWith("/messages")) {
          if (body.stream === true) {
            const sse = [
              `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_nat", type: "message", role: "assistant", model: String(body.model ?? "claude-sonnet-4-6"), content: [], stop_reason: null, usage: { input_tokens: 16, output_tokens: 0 } } })}`,
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "native ok" } })}`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
              `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}`,
              `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
            ].join("\n\n") + "\n\n";
            return new Response(sse, { headers: { "content-type": "text/event-stream" } });
          }
          return Response.json({
            id: "msg_nat",
            type: "message",
            role: "assistant",
            model: String(body.model ?? "claude-sonnet-4-6"),
            content: [{ type: "text", text: "native ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 16, output_tokens: 4 },
          });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          if (body.stream === true) {
            const sse = [
              `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", model: String(body.model ?? "gpt-5.4"), choices: [{ index: 0, delta: { role: "assistant", content: "chat ok" }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", model: String(body.model ?? "gpt-5.4"), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
              "data: [DONE]",
            ].join("\n\n") + "\n\n";
            return new Response(sse, { headers: { "content-type": "text/event-stream" } });
          }
          return Response.json({
            id: "chatcmpl_1",
            object: "chat.completion",
            model: String(body.model ?? "gpt-5.4"),
            choices: [{ index: 0, message: { role: "assistant", content: "chat ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          });
        }
        const syntheticLeak = ["sk", "proj", "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"].join("-");
        const respPayload = {
          id: "resp_prev_audit9",
          object: "response",
          status: "completed",
          model: String(body.model ?? "gpt-5.4"),
          output: [{
            id: "msg_r1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: `leaked ${syntheticLeak}` }],
          }],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        };
        if (body.stream === true) {
          const sse = [
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_prev_audit9", object: "response", status: "in_progress", model: String(body.model ?? "gpt-5.4"), output: [] } })}`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: `leaked ${syntheticLeak}` })}`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: respPayload })}`,
          ].join("\n\n") + "\n\n";
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json(respPayload);
      },
    });

    try {
      const cfg: EpxConfig = {
        port: 10109,
        hostname: "127.0.0.1",
        defaultProvider: "anth-primary",
        protocols: { rollout: { managedMessagesNative: true } },
        providers: {
          "anth-fail": {
            adapter: "anthropic",
            baseUrl: `http://127.0.0.1:${upstream.port}/fail500/v1`,
            authMode: "key",
            apiKey: "sk-ant-key-1",
            allowPrivateNetwork: true,
            models: ["claude-sonnet-4-6"],
          },
          "anth-primary": {
            adapter: "anthropic",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-ant-key-2",
            allowPrivateNetwork: true,
            models: ["claude-sonnet-4-6"],
          },
          "resp-fail": {
            adapter: "openai-responses",
            baseUrl: `http://127.0.0.1:${upstream.port}/fail500/v1`,
            authMode: "key",
            apiKey: "sk-resp-fail-key",
            allowPrivateNetwork: true,
            models: ["gpt-5.4"],
          },
          "resp-prov": {
            adapter: "openai-responses",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-resp-key",
            allowPrivateNetwork: true,
            models: ["gpt-5.4"],
          },
          "chat-prov": {
            adapter: "openai-chat",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-chat-key",
            allowPrivateNetwork: true,
            models: ["gpt-5.4"],
          },
        },
        combos: {
          "anth-combo": {
            targets: [
              { provider: "anth-fail", model: "claude-sonnet-4-6" },
              { provider: "anth-primary", model: "claude-sonnet-4-6" },
            ],
          },
          "bridge-combo": {
            targets: [
              { provider: "resp-fail", model: "gpt-5.4" },
              { provider: "chat-prov", model: "gpt-5.4" },
            ],
          },
        },
        outboundSecretGuard: { mode: "redact" },
        toolOutputCompression: { enabled: true },
        promptCacheInjection: { enabled: true, ttl: "1h" },
      };
      saveConfig(cfg);
      const freshLog = (): RequestLogContext => ({ model: "", provider: "" } as RequestLogContext);

      // 1. /v1/messages -> OpenAI Chat bridge: scanned once, NO cache_control pollution, NO bogus injectedCacheBreakpoints
      resetOutboundHygieneStatsForTests();
      const bridgeRes = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "chat-prov/gpt-5.4",
            stream: false,
            max_tokens: 128,
            system: "S".repeat(2200),
            messages: [{ role: "user", content: "U".repeat(2200) }],
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(bridgeRes.status).toBe(200);
      await bridgeRes.text();
      expect(getOutboundHygieneStats()).toMatchObject({ scannedRequests: 1, injectedCacheBreakpoints: 0 });
      expect(JSON.stringify(upstreamCalls.at(-1)?.body)).not.toContain("cache_control");

      // 2. /v1/chat/completions -> OpenAI Responses bridge: scanned once, NO cache_control pollution
      resetOutboundHygieneStatsForTests();
      const chatBridgeRes = await handleChatCompletions(
        new Request("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "resp-prov/gpt-5.4",
            stream: false,
            messages: [
              { role: "system", content: "S".repeat(2200) },
              { role: "user", content: "U".repeat(2200) },
            ],
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(chatBridgeRes.status).toBe(200);
      await chatBridgeRes.text();
      expect(getOutboundHygieneStats()).toMatchObject({ scannedRequests: 1, injectedCacheBreakpoints: 0 });
      expect(JSON.stringify(upstreamCalls.at(-1)?.body)).not.toContain("cache_control");

      // 3. /v1/messages combo failover across failing Responses -> Chat bridge: still scanned once, 0 breakpoints
      resetOutboundHygieneStatsForTests();
      const beforeBridgeComboCalls = upstreamCalls.length;
      const comboBridgeRes = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "combo/bridge-combo",
            stream: false,
            max_tokens: 128,
            system: "S".repeat(2200),
            messages: [{ role: "user", content: "U".repeat(2200) }],
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(comboBridgeRes.status).toBe(200);
      await comboBridgeRes.text();
      const bridgePaths = upstreamCalls.slice(beforeBridgeComboCalls).map(c => c.path);
      expect(bridgePaths[0]).toBe("/fail500/v1/responses");
      expect(bridgePaths.at(-1)).toBe("/v1/chat/completions");
      expect(getOutboundHygieneStats()).toMatchObject({ scannedRequests: 1, injectedCacheBreakpoints: 0 });
      expect(JSON.stringify(upstreamCalls.at(-1)?.body)).not.toContain("cache_control");

      // 4. /v1/messages native Anthropic combo child injects 1h cache_control and still counts 1 inbound scan
      resetOutboundHygieneStatsForTests();
      const beforeNativeComboCalls = upstreamCalls.length;
      const comboNativeRes = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "combo/anth-combo",
            stream: false,
            max_tokens: 128,
            system: "S".repeat(2200),
            messages: [{ role: "user", content: "U".repeat(2200) }],
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(comboNativeRes.status).toBe(200);
      await comboNativeRes.text();
      const nativePaths = upstreamCalls.slice(beforeNativeComboCalls).map(c => c.path);
      expect(nativePaths[0]).toBe("/fail500/v1/messages");
      expect(nativePaths.at(-1)).toBe("/v1/messages");
      expect(getOutboundHygieneStats().scannedRequests).toBe(1);
      expect(getOutboundHygieneStats().injectedCacheBreakpoints).toBeGreaterThanOrEqual(2);
      const nativeBody = upstreamCalls.at(-1)?.body;
      expect(Array.isArray(nativeBody?.messages)).toBe(true);
      expect(JSON.stringify(nativeBody)).toContain('"ttl":"1h"');

      // 5. Translated Anthropic call (inbound /v1/responses -> anthropic adapter) honors promptCacheInjection.ttl=1h
      resetOutboundHygieneStatsForTests();
      const translatedAnthRes = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "anth-primary/claude-sonnet-4-6",
            stream: false,
            instructions: "S".repeat(2200),
            input: "U".repeat(2200),
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(translatedAnthRes.status).toBe(200);
      await translatedAnthRes.text();
      expect(getOutboundHygieneStats().scannedRequests).toBe(1);
      expect(JSON.stringify(upstreamCalls.at(-1)?.body)).toContain('"ttl":"1h"');

      // 6. previous_response_id continuation scans restored prefix cleanly without counting twice
      resetOutboundHygieneStatsForTests();
      const turn1 = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "resp-prov/gpt-5.4",
            store: true,
            stream: false,
            input: "turn 1 clean",
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(turn1.status).toBe(200);
      await turn1.text();
      expect(getOutboundHygieneStats().scannedRequests).toBe(1);

      const turn2 = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "resp-prov/gpt-5.4",
            previous_response_id: "resp_prev_audit9",
            stream: false,
            input: "turn 2 follow-up",
          }),
        }),
        cfg,
        freshLog(),
      );
      expect(turn2.status).toBe(200);
      await turn2.text();
      expect(getOutboundHygieneStats().scannedRequests).toBe(2);
      const turn2Json = JSON.stringify(upstreamCalls.at(-1)?.body);
      expect(turn2Json).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
      expect(turn2Json).toContain("[REDACTED:openai_key]");
    } finally {
      upstream.stop(true);
    }
  });

  test("guardrails dry-run computes Anthropic TTL-parity cache breakeven across default 1h, custom gateway 5m, and explicit 5m override", async () => {
    const sampleAnthropic = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: false,
      max_tokens: 128,
      system: "S".repeat(8_000),
      messages: [{ role: "user", content: "hi" }],
    });

    const firstPartyCfg: EpxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      providers: {},
      modelAliases: {},
      modelMappings: {},
      quotaThresholds: { hourlyWarning: 80, weeklyWarning: 80 },
      preferredProviders: [],
      logRetention: "7d",
    };

    const callDryRun = async (cfg: EpxConfig, ttl: "auto" | "5m" | "1h" = "auto") => {
      const { status, json } = await callMgmt("POST", "/api/gateway-guardrails/dry-run", cfg, {
        text: sampleAnthropic,
        promptCacheInjection: { enabled: true, ttl },
      });
      expect(status).toBe(200);
      return json as {
        injectedCacheBreakpoints: number;
        contextInspection?: {
          cache?: {
            cacheablePrefixTokens?: number;
            breakeven?: {
              writeTtl?: string;
              economicsAvailable?: boolean;
              breakevenHitCount?: number | null;
            };
          };
        };
      };
    };

    // 1. Default first-party Anthropic resolves ttl="auto" -> "1h" parity ($6/MTok -> 2 hits breakeven)
    const defaultAuto = await callDryRun(firstPartyCfg, "auto");
    expect(defaultAuto.injectedCacheBreakpoints).toBeGreaterThanOrEqual(1);
    expect(defaultAuto.contextInspection?.cache?.cacheablePrefixTokens).toBeGreaterThan(0);
    expect(defaultAuto.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "1h",
      economicsAvailable: true,
      breakevenHitCount: 2,
    });

    // 2. Explicit 5m overrides first-party 1h default -> 1 hit breakeven
    const explicit5m = await callDryRun(firstPartyCfg, "5m");
    expect(explicit5m.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "5m",
      economicsAvailable: true,
      breakevenHitCount: 1,
    });

    // 3. Configured custom third-party Anthropic gateway stays on conservative "5m" under ttl="auto"
    const customGatewayCfg: EpxConfig = {
      ...firstPartyCfg,
      providers: {
        "anth-gw": {
          adapter: "anthropic",
          apiKey: "test-key",
          baseUrl: "https://relay.example.invalid/v1",
          authMode: "key",
          models: ["claude-sonnet-4-6"],
        },
      },
    };
    const customAuto = await callDryRun(customGatewayCfg, "auto");
    expect(customAuto.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "5m",
      economicsAvailable: true,
      breakevenHitCount: 1,
    });

    // 4. config.cacheRetention === "long" upgrades "auto"/TTL-less payloads to "1h", while explicit "5m" still stays "5m"
    const longConfig: EpxConfig = { ...customGatewayCfg, cacheRetention: "long" };
    const longWithAuto = await callDryRun(longConfig, "auto");
    expect(longWithAuto.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "1h",
      economicsAvailable: true,
      breakevenHitCount: 2,
    });

    const longWithExplicit5m = await callDryRun(longConfig, "5m");
    expect(longWithExplicit5m.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "5m",
      economicsAvailable: true,
      breakevenHitCount: 1,
    });

    // 5. Disabled promptCacheInjection with stale ttl="5m" does not hide config.cacheRetention="long" 1h upgrade on TTL-less caller breakpoints
    const disabledWithLongRes = await callMgmt("POST", "/api/gateway-guardrails/dry-run", longConfig, {
      text: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        max_tokens: 128,
        system: [{ type: "text", text: "S".repeat(8_000), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
      promptCacheInjection: { enabled: false, ttl: "5m" },
    });
    expect(disabledWithLongRes.status).toBe(200);
    const disabledWithLongJson = disabledWithLongRes.json as {
      contextInspection?: { cache?: { breakeven?: { writeTtl?: string } } };
    };
    expect(disabledWithLongJson.contextInspection?.cache?.breakeven?.writeTtl).toBe("1h");

    // 6. Existing caller "5m" breakpoint caps injection at "5m" even when ttl="1h" is configured
    const caller5mRes = await callMgmt("POST", "/api/gateway-guardrails/dry-run", firstPartyCfg, {
      text: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        max_tokens: 128,
        system: [{ type: "text", text: "S".repeat(8_000), cache_control: { type: "ephemeral", ttl: "5m" } }],
        messages: [{ role: "user", content: "U".repeat(8_000) }],
      }),
      promptCacheInjection: { enabled: true, ttl: "1h" },
    });
    expect(caller5mRes.status).toBe(200);
    const caller5mJson = caller5mRes.json as {
      contextInspection?: { cache?: { breakeven?: { writeTtl?: string } } };
    };
    expect(caller5mJson.contextInspection?.cache?.breakeven?.writeTtl).toBe("5m");

    // 7. Vertex @YYYYMMDD models resolve dry-run breakeven rates while preserving Vertex 3.x 5m vs 4.x 1h TTL rules
    const vertex35Res = await callMgmt("POST", "/api/gateway-guardrails/dry-run", firstPartyCfg, {
      text: JSON.stringify({
        model: "claude-3-5-sonnet@20240620",
        stream: false,
        max_tokens: 128,
        system: "S".repeat(8_000),
        messages: [{ role: "user", content: "U".repeat(8_000) }],
      }),
      promptCacheInjection: { enabled: true, ttl: "1h" },
    });
    expect(vertex35Res.status).toBe(200);
    const vertex35Json = vertex35Res.json as {
      contextInspection?: { cache?: { breakeven?: { writeTtl?: string; economicsAvailable?: boolean; breakevenHitCount?: number } } };
    };
    expect(vertex35Json.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "5m",
      economicsAvailable: true,
      breakevenHitCount: 1,
    });

    const vertex41Res = await callMgmt("POST", "/api/gateway-guardrails/dry-run", firstPartyCfg, {
      text: JSON.stringify({
        model: "claude-opus-4-1@20250805",
        stream: false,
        max_tokens: 128,
        system: "S".repeat(8_000),
        messages: [{ role: "user", content: "U".repeat(8_000) }],
      }),
      promptCacheInjection: { enabled: true, ttl: "1h" },
    });
    expect(vertex41Res.status).toBe(200);
    const vertex41Json = vertex41Res.json as {
      contextInspection?: { cache?: { breakeven?: { writeTtl?: string; economicsAvailable?: boolean; breakevenHitCount?: number } } };
    };
    expect(vertex41Json.contextInspection?.cache?.breakeven).toMatchObject({
      writeTtl: "1h",
      economicsAvailable: true,
      breakevenHitCount: 2,
    });
  });

  test("sanitizes expanded previous_response_id prefixes on combos and preserves Vertex 3.x 5m cache retention across aliases and combos", async () => {
    const leakedKey = ["sk", "proj", "COMBO1234567890abcdefghijklmnop"].join("-");
    const upstreamPayloads: Array<{ path: string; body: Record<string, unknown> }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = await req.json() as Record<string, unknown>;
        upstreamPayloads.push({ path, body });
        if (path.endsWith("/messages")) {
          if (body.stream === true) {
            const sse = [
              `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_vertex_1", type: "message", role: "assistant", model: String(body.model ?? "claude-3-5-sonnet@20240620"), content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } })}`,
              `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
              `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}`,
              `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
            ].join("\n\n") + "\n\n";
            return new Response(sse, { headers: { "content-type": "text/event-stream" } });
          }
          return Response.json({
            id: "msg_vertex_1",
            type: "message",
            role: "assistant",
            model: String(body.model ?? "claude-3-5-sonnet@20240620"),
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 20, output_tokens: 5 },
          });
        }
        return Response.json({
          id: "resp_combo_prev_1",
          object: "response",
          status: "completed",
          model: String(body.model ?? "gpt-5.4"),
          output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `stored ${leakedKey}` }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      },
    });

    try {
      const cfg: EpxConfig = {
        port: 10112,
        hostname: "127.0.0.1",
        defaultProvider: "resp-prov",
        outboundSecretGuard: { mode: "redact" },
        promptCacheInjection: { enabled: true, ttl: "1h" },
        protocols: { rollout: { managedMessagesNative: true } },
        providers: {
          "resp-prov": {
            adapter: "openai-responses",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-resp",
            allowPrivateNetwork: true,
            models: ["gpt-5.4"],
          },
          "vertex-anth": {
            adapter: "anthropic",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-vertex",
            allowPrivateNetwork: true,
            models: ["claude-3-5-sonnet@20240620"],
            modelAliases: {
              "claude-3-5-sonnet@20240620": "vertex-35-alias",
            },
          },
        },
        combos: {
          "resp-prev-combo": {
            strategy: "ordered",
            targets: [{ provider: "resp-prov", model: "gpt-5.4" }],
          },
          "vertex-35-combo": {
            strategy: "failover",
            reasoningEffortMode: "strict",
            targets: [{ provider: "vertex-anth", model: "claude-3-5-sonnet@20240620" }],
          },
        },
      };
      saveConfig(cfg);
      const freshLog = (): RequestLogContext => ({ model: "", provider: "" } as RequestLogContext);

      // 1. Combo previous_response_id expansion redacts stored prefix secret cleanly without double counting
      resetOutboundHygieneStatsForTests();
      const comboTurn1 = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/resp-prev-combo", store: true, stream: false, input: "first" }),
        }),
        cfg,
        freshLog(),
      );
      expect(comboTurn1.status).toBe(200);
      await comboTurn1.text();

      resetOutboundHygieneStatsForTests();
      const comboTurn2 = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/resp-prev-combo", previous_response_id: "resp_combo_prev_1", stream: false, input: "second" }),
        }),
        cfg,
        freshLog(),
      );
      expect(comboTurn2.status).toBe(200);
      await comboTurn2.text();
      expect(getOutboundHygieneStats().scannedRequests).toBe(1);
      const comboTurn2Json = JSON.stringify(upstreamPayloads.at(-1)?.body);
      expect(comboTurn2Json).not.toContain("COMBO1234567890");
      expect(comboTurn2Json).toContain("[REDACTED:openai_key]");

      // Block mode rejects expanded historical secret on combo before any upstream dispatch
      const beforeBlockLen = upstreamPayloads.length;
      const blockCfg: EpxConfig = { ...cfg, outboundSecretGuard: { mode: "block" } };
      const comboBlocked = await handleResponses(
        new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/resp-prev-combo", previous_response_id: "resp_combo_prev_1", stream: false, input: "blocked" }),
        }),
        blockCfg,
        freshLog(),
      );
      expect(comboBlocked.status).toBe(400);
      expect(upstreamPayloads.length).toBe(beforeBlockLen);

      // 2. /v1/messages via alias & combo targeting Vertex Claude 3.5 downgrades 1h -> 5m on both native and bridged paths
      const bridgedCfg: EpxConfig = { ...cfg, protocols: { rollout: { managedMessagesNative: false } } };
      for (const [isNative, activeCfg] of [[true, cfg], [false, bridgedCfg]] as const) {
        saveConfig(activeCfg);
        for (const selector of ["vertex-35-alias", "combo/vertex-35-combo"]) {
          const res = await handleClaudeMessages(
            new Request("http://127.0.0.1/v1/messages", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: selector,
                max_tokens: 128,
                stream: false,
                system: "S".repeat(2200),
                messages: [{ role: "user", content: "U".repeat(2200) }],
              }),
            }),
            activeCfg,
            freshLog(),
          );
          expect(res.status).toBe(200);
          await res.text();
          const sent = JSON.stringify(upstreamPayloads.at(-1)?.body);
          expect(sent).toContain(isNative ? '"ttl":"5m"' : '"cache_control":{"type":"ephemeral"}');
          expect(sent).not.toContain('"ttl":"1h"');
        }
      }

      // 3. /v1/messages combo & policy routes do not let a caller's 5m breakpoint override promptCacheInjection.ttl="1h"
      const anthFourCfg: EpxConfig = {
        ...cfg,
        providers: {
          ...cfg.providers,
          "anth-four": {
            adapter: "anthropic",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            authMode: "key",
            apiKey: "sk-anth4",
            allowPrivateNetwork: true,
            models: ["claude-sonnet-4-6"],
          },
        },
        combos: {
          ...cfg.combos,
          "anth4-combo": {
            strategy: "failover",
            targets: [{ provider: "anth-four", model: "claude-sonnet-4-6" }],
          },
        },
        routingProfiles: {
          "anth4-policy": {
            candidates: [{ provider: "anth-four", model: "claude-sonnet-4-6" }],
          },
        },
      };
      const anthFourBridgedCfg: EpxConfig = {
        ...anthFourCfg,
        protocols: { rollout: { managedMessagesNative: false } },
      };

      // Bridged concrete, combo & policy routes: caller 5m breakpoint on trailing user block must NOT override promptCacheInjection.ttl="1h"
      saveConfig(anthFourBridgedCfg);
      for (const selector of ["anth-four/claude-sonnet-4-6", "combo/anth4-combo", "policy/anth4-policy"]) {
        const resMixed = await handleClaudeMessages(
          new Request("http://127.0.0.1/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: selector,
              max_tokens: 128,
              stream: false,
              system: [{ type: "text", text: "S".repeat(2200), cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: [{ type: "text", text: "U".repeat(2200), cache_control: { type: "ephemeral", ttl: "5m" } }] }],
            }),
          }),
          anthFourBridgedCfg,
          freshLog(),
        );
        expect(resMixed.status, `${selector}-mixed`).toBe(200);
        await resMixed.text();
        const sentMixed = JSON.stringify(upstreamPayloads.at(-1)?.body);
        expect(sentMixed, `${selector}-mixed`).toContain('"ttl":"1h"');
      }

      // Native combo & policy routes: TTL-less breakpoint must upgrade to "1h" without being clamped to "short"
      saveConfig(anthFourCfg);
      for (const selector of ["combo/anth4-combo", "policy/anth4-policy"]) {
        const res = await handleClaudeMessages(
          new Request("http://127.0.0.1/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: selector,
              max_tokens: 128,
              stream: false,
              system: [{ type: "text", text: "S".repeat(2200), cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: "U".repeat(2200) }],
            }),
          }),
          anthFourCfg,
          freshLog(),
        );
        expect(res.status, selector).toBe(200);
        await res.text();
        const sent = JSON.stringify(upstreamPayloads.at(-1)?.body);
        expect(sent, selector).toContain('"ttl":"1h"');
      }

      // Under ttl="auto" (no explicit 1h/5m promptCacheInjection override), caller's 5m breakpoint still wins on bridged combo/policy
      const autoComboCfg: EpxConfig = {
        ...anthFourBridgedCfg,
        promptCacheInjection: { enabled: true, ttl: "auto" },
      };
      saveConfig(autoComboCfg);
      const autoRes = await handleClaudeMessages(
        new Request("http://127.0.0.1/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "combo/anth4-combo",
            max_tokens: 128,
            stream: false,
            system: [{ type: "text", text: "S".repeat(2200), cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: [{ type: "text", text: "U".repeat(2200), cache_control: { type: "ephemeral", ttl: "5m" } }] }],
          }),
        }),
        autoComboCfg,
        freshLog(),
      );
      expect(autoRes.status).toBe(200);
      await autoRes.text();
      const autoSent = JSON.stringify(upstreamPayloads.at(-1)?.body);
      expect(autoSent).not.toContain('"ttl":"1h"');
    } finally {
      upstream.stop(true);
    }
  });
});
