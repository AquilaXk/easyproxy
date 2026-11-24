import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { messagesToResponsesTranslation } from "../../src/protocols/codecs/messages";
import { parseEpxCacheControl, stripBridgeCacheControlsForResponsesWire } from "../../src/protocols/cache-control";
import { parseRequest } from "../../src/responses/parser";
import type { EpxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;

beforeAll(() => {
  previousHome = process.env.EASYPROXY_HOME;
  home = mkdtempSync(join(tmpdir(), "epx-cc-bridge-"));
  process.env.EASYPROXY_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
});

afterAll(() => {
  releaseSpend?.();
  if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousHome;
  removeTreeWithRetry(home);
});

const ANTHROPIC_PROVIDER: EpxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "key",
  apiKey: "sk-ant-fixture",
  models: ["claude-sonnet-4-6"],
};

const OPENAI_KEY_PROVIDER: EpxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authMode: "key",
  apiKey: "sk-openai-fixture",
  models: ["gpt-5.4"],
};

const OPENAI_FORWARD_PROVIDER: EpxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  models: ["gpt-5.4"],
};

const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

function collectKeysRecursive(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysRecursive(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      keys.add(k);
      collectKeysRecursive(v, keys);
    }
  }
  return keys;
}

describe("Anthropic per-block cache_control preservation across bridges", () => {
  test("preserves multi-block system, tool, content, nested tool_result, assistant, and automatic cache_control to Anthropic adapter", async () => {
    const budget = createTranslatorBudget();
    const rawInbound = {
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      cache_control: { type: "ephemeral", ttl: "1h", scope: "turn" },
      system: [
        { type: "text", text: "System static preface.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "System workspace guide.", cache_control: { type: "ephemeral", ttl: "5m", scope: "global" } },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read workspace file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          name: "bad_marker_tool",
          description: "Malformed cache_control fails closed",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "invalid_type", ttl: "99h", extraSecret: "drop-me" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze screenshot and doc.", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_DATA_URL.split(",")[1] }, cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: TINY_PDF_B64 }, cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading file now.", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" }, cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "README contents", cache_control: { type: "ephemeral", ttl: "5m" } },
                { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_DATA_URL.split(",")[1] }, cache_control: { type: "ephemeral", ttl: "5m" } },
              ],
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    };

    const translation = messagesToResponsesTranslation(rawInbound, undefined, budget);
    const parsed = parseRequest(translation.body);
    expect(parsed.options.automaticCacheControl).toEqual({ type: "ephemeral", ttl: "1h", scope: "turn" });
    expect(parsed.context.systemPrompt).toEqual([
      "System static preface.",
      "System workspace guide.",
    ]);
    expect(parsed.context.systemCacheControls).toEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "5m", scope: "global" },
    ]);

    // Malformed marker on tool 2 failed closed while valid marker on tool 1 survived.
    expect(parsed.context.tools?.[0]?.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(parsed.context.tools?.[1]?.cacheControl).toBeUndefined();

    const adapter = withTestTranslatorBudget(createAnthropicAdapter(ANTHROPIC_PROVIDER));
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
    const wire = JSON.parse(req.body!) as {
      cache_control?: Record<string, unknown>;
      system?: Array<{ text: string; cache_control?: Record<string, unknown> }>;
      tools?: Array<{ name: string; cache_control?: Record<string, unknown> }>;
      messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };

    // Top-level automatic caching follows all explicit blocks, so 1h after an explicit 5m system
    // breakpoint demotes to default 5m while preserving scope: "turn".
    expect(wire.cache_control).toEqual({ type: "ephemeral", scope: "turn" });
    // Multi-block caller system preserved cleanly before uncached tool-catalog guidance.
    expect(Array.isArray(wire.system)).toBe(true);
    expect(wire.system!.length).toBeGreaterThanOrEqual(2);
    expect(wire.system?.[0]?.text).toBe("System static preface.");
    expect(wire.system?.[1]?.text).toBe("System workspace guide.");
    expect(wire.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Top-level cache_control consumes 1 slot, leaving <= 3 explicit breakpoints (system + tool).
    let explicitBreakpoints = 0;
    const countCc = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) countCc(x); return; }
      if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        if (rec.cache_control) explicitBreakpoints += 1;
        for (const [k, child] of Object.entries(rec)) {
          if (k !== "cache_control") countCc(child);
        }
      }
    };
    countCc({ system: wire.system, tools: wire.tools, messages: wire.messages });
    expect(explicitBreakpoints).toBeLessThanOrEqual(3);
    expect(explicitBreakpoints).toBeGreaterThanOrEqual(1);
    expect(wire.tools?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("preserves per-block cache_control on user text/image/document, assistant text/tool_use, and nested tool_result within the 4-breakpoint budget", async () => {
    const budget = createTranslatorBudget();

    // 1a. First-party Anthropic preserves explicit 1h/5m TTLs across text, image, and document blocks (3 explicit + 1 automatic = 4 total).
    const firstPartyMedia = {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Prompt block", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_DATA_URL.split(",")[1] }, cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: TINY_PDF_B64 }, cache_control: { type: "ephemeral", ttl: "5m" } },
          ],
        },
        { role: "assistant", content: "Checked media." },
        { role: "user", content: "Proceed." },
      ],
    };
    const firstPartyAdapter = withTestTranslatorBudget(createAnthropicAdapter(ANTHROPIC_PROVIDER));
    const fpParsed = parseRequest(anthropicToResponsesTranslation(firstPartyMedia, undefined, budget).body);
    const fpWire = JSON.parse((await firstPartyAdapter.buildRequest(fpParsed, { headers: new Headers(), translatorBudget: budget })).body!) as {
      cache_control?: unknown;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    // Top-level automatic caching follows the 5m document block, so 1h demotes to default 5m.
    expect(fpWire.cache_control).toEqual({ type: "ephemeral" });
    expect(fpWire.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(fpWire.messages[0]?.content[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(fpWire.messages[0]?.content[2]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });

    // 1b. Compatible upstream without automatic top-level breakpoint allows 4 explicit blocks and strips 1st-party TTL (`short` retention).
    const compatibleMedia = {
      ...firstPartyMedia,
      messages: [
        firstPartyMedia.messages[0]!,
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checked media.", cache_control: { type: "ephemeral", ttl: "5m" } },
          ],
        },
        { role: "user", content: "Proceed." },
      ],
    };
    const compatAdapter = withTestTranslatorBudget(createAnthropicAdapter({
      ...ANTHROPIC_PROVIDER,
      baseUrl: "https://custom-anthropic-compatible.example.com",
    }));
    const compatParsed = parseRequest(anthropicToResponsesTranslation(compatibleMedia, undefined, budget).body);
    const compatWire = JSON.parse((await compatAdapter.buildRequest(compatParsed, { headers: new Headers(), translatorBudget: budget })).body!) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(compatWire.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(compatWire.messages[0]?.content[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(compatWire.messages[0]?.content[2]?.cache_control).toEqual({ type: "ephemeral" });
    expect(compatWire.messages[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });

    // 2. Assistant tool_use + nested tool_result block + outer tool_result container on first-party preserve exact TTLs.
    const toolInbound = {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      tools: [{ name: "read_file", description: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "Read README" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_9", name: "read_file", input: {}, cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: [
                { type: "text", text: "file text", cache_control: { type: "ephemeral", ttl: "5m" } },
                { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_DATA_URL.split(",")[1] } },
              ],
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    };
    const toolParsed = parseRequest(anthropicToResponsesTranslation(toolInbound, undefined, budget).body);
    const toolWire = JSON.parse((await firstPartyAdapter.buildRequest(toolParsed, { headers: new Headers(), translatorBudget: budget })).body!) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(toolWire.messages[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const toolResult = toolWire.messages[2]?.content[0] as { cache_control?: unknown; content?: Array<{ cache_control?: unknown }> };
    expect(toolResult.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(toolResult.content?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("normalizes TTL ordering (1h before 5m) and enforces <= 4 explicit breakpoints without top-level cache_control", async () => {
    const budget = createTranslatorBudget();
    const rawInbound = {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: [
        { type: "text", text: "Part A", cache_control: { type: "ephemeral", ttl: "5m" } },
        { type: "text", text: "Part B", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      tools: [
        { name: "t1", description: "d", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral", ttl: "5m" } },
        { name: "t2", description: "d", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "5m" } }] },
        { role: "assistant", content: [{ type: "text", text: "a1", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        { role: "user", content: [{ type: "text", text: "u2", cache_control: { type: "ephemeral", ttl: "5m" } }] },
      ],
    };

    const parsed = parseRequest(anthropicToResponsesTranslation(rawInbound, undefined, budget).body);
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(ANTHROPIC_PROVIDER));
    const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
    const wire = JSON.parse(req.body!) as Record<string, unknown>;

    const collectedTtls: Array<{ ttl?: string }> = [];
    const collectOrder = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) collectOrder(x); return; }
      if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        if (rec.cache_control && typeof rec.cache_control === "object") {
          collectedTtls.push(rec.cache_control as { ttl?: string });
        }
        for (const [k, child] of Object.entries(rec)) {
          if (k !== "cache_control") collectOrder(child);
        }
      }
    };
    collectOrder([wire.tools, wire.system, wire.messages]);
    // At most 3 explicit breakpoints when top-level cache_control was auto-injected (total <= 4).
    const total = collectedTtls.length + (wire.cache_control ? 1 : 0);
    expect(total).toBeLessThanOrEqual(4);

    // Every "1h" marker must precede any "5m" marker so Anthropic never rejects TTL ordering.
    let seen5m = false;
    for (const marker of collectedTtls) {
      if (marker.ttl === "5m") seen5m = true;
      if (seen5m) expect(marker.ttl).not.toBe("1h");
    }
  });

  test("strips all bridge cache_control markers and _anthropicSystemBlocks before OpenAI Responses wire (key and forward modes)", async () => {
    const budget = createTranslatorBudget();
    const rawInbound = {
      model: "gpt-5.4",
      max_tokens: 128,
      cache_control: { type: "ephemeral", ttl: "1h" },
      system: [
        { type: "text", text: "System A", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "System B", cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup item",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" }, cache_control: { type: "ephemeral" } }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "result text", cache_control: { type: "ephemeral" } }],
            cache_control: { type: "ephemeral" },
          }],
        },
      ],
    };

    const bridgeBody = anthropicToResponsesTranslation(rawInbound, undefined, budget).body;
    const parsed = parseRequest(bridgeBody);

    for (const provider of [OPENAI_KEY_PROVIDER, OPENAI_FORWARD_PROVIDER]) {
      const adapter = createResponsesPassthroughAdapter(provider);
      const req = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
      const wire = JSON.parse(req.body!) as Record<string, unknown>;
      const allKeys = collectKeysRecursive(wire);
      expect(allKeys.has("cache_control")).toBe(false);
      expect(allKeys.has("_anthropicSystemBlocks")).toBe(false);
    }
  });

  test("parseEpxCacheControl and stripBridgeCacheControlsForResponsesWire enforce strict bounds", () => {
    expect(parseEpxCacheControl(null)).toBeUndefined();
    expect(parseEpxCacheControl({ type: "persistent", ttl: "1h" })).toBeUndefined();
    expect(parseEpxCacheControl({ type: "ephemeral", ttl: "24h", scope: "invalid" })).toEqual({ type: "ephemeral" });
    expect(parseEpxCacheControl({ type: "ephemeral", ttl: "5m", scope: "global", extra: 1 })).toEqual({
      type: "ephemeral",
      ttl: "5m",
      scope: "global",
    });

    const sanitized = stripBridgeCacheControlsForResponsesWire({
      model: "gpt-5.4",
      cache_control: { type: "ephemeral" },
      _anthropicSystemBlocks: [{ text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ type: "function", name: "t", cache_control: { type: "ephemeral" } }],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    const keys = collectKeysRecursive(sanitized);
    expect(keys.has("cache_control")).toBe(false);
    expect(keys.has("_anthropicSystemBlocks")).toBe(false);
  });

  test("preserves single-block system scope/ttl and retains 1h top-level cache_control when no 5m block precedes it", async () => {
    const budget = createTranslatorBudget();
    const rawSingleSystem = {
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      system: [
        { type: "text", text: "Single cached system prompt.", cache_control: { type: "ephemeral", ttl: "5m", scope: "global" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    };
    const parsed = parseRequest(anthropicToResponsesTranslation(rawSingleSystem, undefined, budget).body);
    expect(parsed.context.systemCacheControls).toEqual([{ type: "ephemeral", ttl: "5m", scope: "global" }]);

    const allLong = {
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      cache_control: { type: "ephemeral", ttl: "1h", scope: "turn" },
      system: [{ type: "text", text: "Long TTL system.", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } }],
      messages: [{ role: "user", content: "Hi" }],
    };
    const allLongParsed = parseRequest(anthropicToResponsesTranslation(allLong, undefined, budget).body);
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(ANTHROPIC_PROVIDER));
    const wire = JSON.parse((await adapter.buildRequest(allLongParsed, { headers: new Headers(), translatorBudget: budget })).body!) as {
      cache_control?: unknown;
      system?: Array<{ cache_control?: unknown }>;
    };
    expect(wire.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" });
    expect(wire.cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "turn" });
  });
});
