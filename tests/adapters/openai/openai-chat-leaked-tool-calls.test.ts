import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import {
  createOpenAIChatToolContentBuffer,
  recoverLeakedToolCallsFromText,
  resolveLeakedToolCallOptions,
} from "../../../src/adapters/openai-chat/leaked-tool-calls";
import { createOpenAIChatToolNameRegistry } from "../../../src/adapters/openai-chat/tool-name-registry";
import { configSchema } from "../../../src/config/schema/config-schema";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import type { AdapterEvent, EpxProviderConfig, EpxTool, EpxToolChoice } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const weatherTool: EpxTool = {
  name: "get_weather",
  description: "Fetch weather",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
      days: { type: "integer" },
      detailed: { type: "boolean" },
    },
    required: ["city"],
  },
};

const pingTool: EpxTool = {
  name: "ping",
  description: "Ping",
  parameters: { type: "object", properties: {} },
};

const visible = (events: AdapterEvent[]) => events.flatMap(e => (e.type === "text_delta" ? [e.text] : [])).join("");
const toolCallsFrom = (events: AdapterEvent[]) => {
  const out: Array<{ id: string; name: string; arguments: string }> = [];
  let cur: { id: string; name: string; args: string[] } | undefined;
  for (const ev of events) {
    if (ev.type === "tool_call_start") cur = { id: ev.id, name: ev.name, args: [] };
    else if (ev.type === "tool_call_delta" && cur) cur.args.push(ev.arguments);
    else if (ev.type === "tool_call_end" && cur) {
      out.push({ id: cur.id, name: cur.name, arguments: cur.args.join("") });
      cur = undefined;
    }
  }
  return out;
};

async function runChat(options: {
  mode: "buffered" | "streamed";
  model: string;
  chunks: string[];
  provider?: Partial<EpxProviderConfig>;
  tools?: EpxTool[];
  toolChoice?: EpxToolChoice;
  summaryProhibitsToolCalls?: boolean;
  finishReason?: string | null;
  structured?: boolean;
  omitStreamFinish?: boolean;
}): Promise<AdapterEvent[]> {
  const provider: EpxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "test-key",
    ...options.provider,
  };
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  adapter.buildRequest({
    modelId: options.model,
    stream: options.mode === "streamed",
    options: {
      ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    },
    ...(options.summaryProhibitsToolCalls !== undefined
      ? { _summaryProhibitsToolCalls: options.summaryProhibitsToolCalls }
      : {}),
    context: {
      messages: [{ role: "user", content: "Check weather", timestamp: 0 }],
      tools: options.tools ?? [weatherTool, pingTool],
    },
  });

  const structuredCall = { id: "call_struct", function: { name: "ping", arguments: "{}" } };
  if (options.mode === "buffered") {
    return await adapter.parseResponse!(Response.json({
      choices: [{
        message: {
          content: options.chunks.join(""),
          ...(options.structured ? { tool_calls: [structuredCall] } : {}),
        },
        finish_reason: options.finishReason === undefined ? "stop" : options.finishReason,
        ...(options.finishReason === "error" ? { error: { message: "boom" } } : {}),
      }],
    }), createTestTranslatorBudget());
  }

  const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
  let body = options.chunks.map(content => frame({ choices: [{ delta: { content } }] })).join("");
  if (options.structured) {
    body += frame({ choices: [{ delta: { tool_calls: [{ index: 0, ...structuredCall }] } }] });
  }
  if (!options.omitStreamFinish) {
    body += options.finishReason === "error"
      ? frame({ choices: [{ finish_reason: "error", error: { message: "boom" } }] })
      : frame({ choices: [{ delta: {}, finish_reason: options.finishReason === undefined ? "stop" : options.finishReason }] }) + "data: [DONE]\n\n";
  }
  const events: AdapterEvent[] = [];
  for await (const ev of adapter.parseStream(new Response(body))) {
    if (ev.type !== "heartbeat") events.push(ev);
  }
  return events;
}

describe("Phase 2-A openai-chat leaked Harmony and XML tool call recovery", () => {
  for (const mode of ["buffered", "streamed"] as const) {
    test(`${mode} recovers gpt-oss Harmony calls outside fences and coerces integer args`, async () => {
      const harmony =
        "Checking now.\n"
        + `<|start|>assistant<|channel|>commentary to=functions.get_weather<|constrain|>json<|message|>{"city":"Seoul","days":3.0}<|call|>`
        + `<|channel|>commentary to=functions.ping<|message|>{}<|call|>`;
      const chunks = mode === "streamed" ? [...harmony] : [harmony];
      const events = await runChat({ mode, model: "openai/gpt-oss-120b", chunks });
      expect(visible(events)).toBe("Checking now.\n");
      expect(toolCallsFrom(events)).toEqual([
        { id: "call_1", name: "get_weather", arguments: '{"city":"Seoul","days":3}' },
        { id: "call_2", name: "ping", arguments: "{}" },
      ]);
    });

    test(`${mode} ignores XML markup unless model is in leakedToolCallModels`, async () => {
      const xml = `<antml:invoke name="get_weather"><antml:parameter name="city">Seoul</antml:parameter></antml:invoke>`;
      const eventsOff = await runChat({ mode, model: "openai/gpt-oss-120b", chunks: [xml] });
      expect(toolCallsFrom(eventsOff)).toEqual([]);
      expect(visible(eventsOff)).toBe(xml);
    });

    test(`${mode} recovers opted-in XML antml:invoke and function tags with schema coercion`, async () => {
      const xml =
        "Running tools:\n"
        + `<antml:function_calls>\n`
        + `  <antml:invoke name="get_weather">\n`
        + `    <antml:parameter name="city">007</antml:parameter>\n`
        + `    <antml:parameter name="days">5</antml:parameter>\n`
        + `    <antml:parameter name="detailed">true</antml:parameter>\n`
        + `  </antml:invoke>\n`
        + `</antml:function_calls>`
        + `<function name="ping"/>`;
      const splitChunks = mode === "streamed" ? [xml.slice(0, 19), xml.slice(19, 60), xml.slice(60)] : [xml];
      const events = await runChat({
        mode,
        model: "qwen3-coder-30b",
        chunks: splitChunks,
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
      });
      expect(visible(events)).toBe("Running tools:\n");
      expect(toolCallsFrom(events)).toEqual([
        { id: "call_1", name: "get_weather", arguments: JSON.stringify({ city: "007", days: 5, detailed: true }) },
        { id: "call_2", name: "ping", arguments: "{}" },
      ]);
    });

    test(`${mode} fails closed inside code fences, inline ticks, undeclared tools, structured calls, and truncation`, async () => {
      const fenced = "Example:\n```xml\n<antml:invoke name=\"ping\"></antml:invoke>\n```";
      const inlined = "Syntax: `<|channel|>commentary to=functions.ping<|message|>{}<|call|>` ok.";
      const quoted = `> <antml:function_calls><antml:invoke name="ping"/></antml:function_calls>`;
      const indented = `    <antml:invoke name="ping"/>`;
      const unknown = `<|channel|>commentary to=functions.rm_rf<|message|>{"all":true}<|call|>`;

      for (const content of [fenced, inlined, quoted, indented, unknown]) {
        const chunks = mode === "streamed" ? [content.slice(0, 12), content.slice(12)] : [content];
        const events = await runChat({
          mode,
          model: "openai/gpt-oss-120b",
          chunks,
          provider: { leakedToolCallModels: ["openai/gpt-oss-120b"] },
        });
        expect(toolCallsFrom(events)).toEqual([]);
        expect(visible(events)).toBe(content);
      }

      const harmony = `<|channel|>commentary to=functions.get_weather<|message|>{"city":"Seoul"}<|call|>`;
      const withStructured = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        chunks: [harmony],
        structured: true,
      });
      expect(toolCallsFrom(withStructured)).toEqual([{ id: "call_struct", name: "ping", arguments: "{}" }]);

      const truncated = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        chunks: [harmony],
        finishReason: "length",
      });
      expect(toolCallsFrom(truncated)).toEqual([]);
      expect(visible(truncated)).toBe(harmony);
    });
  }

  test("streamed incomplete without finish_reason refuses leaked calls and flushes literal text", async () => {
    const harmony = `Prose <|channel|>commentary to=functions.ping<|message|>{}<|call|>`;
    const events = await runChat({
      mode: "streamed",
      model: "openai/gpt-oss-120b",
      chunks: [harmony],
      omitStreamFinish: true,
    });
    expect(toolCallsFrom(events)).toEqual([]);
    expect(visible(events)).toBe(harmony);
  });

  test("exceeding 128 call cap fails closed for entire batch", async () => {
    const call = `<|channel|>commentary to=functions.ping<|message|>{}<|call|>`;
    const flood = call.repeat(129);
    const events = await runChat({ mode: "buffered", model: "openai/gpt-oss-120b", chunks: [flood] });
    expect(toolCallsFrom(events)).toEqual([]);
    expect(visible(events)).toBe(flood);
  });

  test("preserves leakedToolCallModels through schema and routedProviderConfig", () => {
    const parsed = configSchema.parse({
      defaultProvider: "gw",
      providers: {
        gw: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          leakedToolCallModels: ["  qwen3-coder  ", "qwen3-coder"],
        },
      },
    });
    expect(parsed.providers.gw!.leakedToolCallModels).toEqual(["qwen3-coder"]);
    expect(routedProviderConfig("gw", parsed.providers.gw!).leakedToolCallModels).toEqual(["qwen3-coder"]);
  });

  test("recovers leaked Harmony and XML tool calls even when inline <think> produces reasoning_raw_delta events", async () => {
    const harmonyWithThink = `<think>Need weather first.</think>\nCheck: <|channel|>commentary to=functions.get_weather<|message|>{"city":"Tokyo"}<|call|>`;
    for (const mode of ["buffered", "streamed"] as const) {
      const events = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        provider: { inlineThinkTagModels: ["openai/gpt-oss-120b"] },
        chunks: mode === "buffered"
          ? [harmonyWithThink]
          : ["<think>Need weather first.</think>\nCheck: ", "<|channel|>commentary to=functions.get_weather", "<|message|>{\"city\":\"Tokyo\"}<|call|>"],
      });
      const thinking = events
        .filter((e): e is Extract<AdapterEvent, { type: "reasoning_raw_delta" }> => e.type === "reasoning_raw_delta")
        .map(e => e.text)
        .join("");
      expect(thinking).toContain("Need weather first.");
      expect(toolCallsFrom(events)).toEqual([{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" }]);
      expect(visible(events)).toBe("\nCheck: ");
    }

    const xmlWithThink = `<think>Invoke ping</think><antml:invoke name="ping"></antml:invoke>`;
    const bufferedXml = await runChat({
      mode: "buffered",
      model: "qwen3-coder",
      chunks: [xmlWithThink],
      provider: {
        inlineThinkTagModels: ["qwen3-coder"],
        leakedToolCallModels: ["qwen3-coder"],
      },
    });
    expect(bufferedXml.some(e => e.type === "reasoning_raw_delta")).toBe(true);
    expect(toolCallsFrom(bufferedXml)).toEqual([{ id: "call_1", name: "ping", arguments: "{}" }]);
    expect(visible(bufferedXml)).toBe("");
  });

  test("streamed <function name=...> opener tolerates space, tab, LF, and CRLF across arbitrary chunk splits", async () => {
    const cases: Array<{ name: string; xml: string; chunks: string[]; expectedName: string; expectedArgs: string }> = [
      {
        name: "tab separator in single chunk",
        xml: `Before\n<function\tname="ping"/>`,
        chunks: [`Before\n<function\tname="ping"/>`],
        expectedName: "ping",
        expectedArgs: "{}",
      },
      {
        name: "newline separator split across opener and attribute",
        xml: `Before\n<function\nname="ping"/>`,
        chunks: ["Before\n<function", `\nname="ping"/>`],
        expectedName: "ping",
        expectedArgs: "{}",
      },
      {
        name: "CRLF + indentation with parameters split mid-tag",
        xml: `<function\r\n  name="get_weather"><parameter\tname="city">Seoul</parameter><parameter\nname="days">2</parameter></function>`,
        chunks: [
          "<function",
          "\r\n  name=\"get_weather\">",
          "<parameter\tname=\"city\">Seoul</parameter>",
          "<parameter\nname=\"days\">2</parameter></function>",
        ],
        expectedName: "get_weather",
        expectedArgs: JSON.stringify({ city: "Seoul", days: 2 }),
      },
      {
        name: "tab separator split directly after <function opener",
        xml: `Before\n<function\tname="ping"/>`,
        chunks: ["Before\n<function", "\t", `name="ping"/>`],
        expectedName: "ping",
        expectedArgs: "{}",
      },
      {
        name: "char-by-char stream with newline before name",
        xml: `Check:<function\nname='ping' />`,
        chunks: [...`Check:<function\nname='ping' />`],
        expectedName: "ping",
        expectedArgs: "{}",
      },
    ];

    for (const testCase of cases) {
      const events = await runChat({
        mode: "streamed",
        model: "qwen3-coder-30b",
        chunks: testCase.chunks,
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
      });
      expect(toolCallsFrom(events), testCase.name).toEqual([
        { id: "call_1", name: testCase.expectedName, arguments: testCase.expectedArgs },
      ]);
      expect(visible(events), testCase.name).toBe(testCase.xml.startsWith("Before\n") ? "Before\n" : testCase.xml.startsWith("Check:") ? "Check:" : "");
    }

    // Ordinary prose `<function>`, `<function\tfoo>`, fenced/inlined, and nested `<parameter\t...>` fail closed.
    const prose = "Use <function> or <function_name> helper.";
    const invalidAttr = "<function\tfoo>bar</function>";
    const fenced = "```xml\n<function\nname=\"ping\"/>\n```";
    const inlined = "Syntax: `<function\tname=\"ping\"/>`";
    const nestedTabParam = `<function\tname="get_weather"><parameter\tname="city">Seoul<parameter\tname="days">2</parameter></function>`;
    const nestedAntmlNewlineParam = `<antml:invoke name="get_weather"><antml:parameter name="city">Seoul<antml:parameter\nname="days">2</antml:parameter></antml:invoke>`;
    for (const content of [prose, invalidAttr, fenced, inlined, nestedTabParam, nestedAntmlNewlineParam]) {
      const events = await runChat({
        mode: "streamed",
        model: "qwen3-coder-30b",
        chunks: [content.slice(0, 10), content.slice(10)],
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
      });
      expect(toolCallsFrom(events)).toEqual([]);
      expect(visible(events)).toBe(content);
    }
  });

  for (const mode of ["buffered", "streamed"] as const) {
    test(`${mode} honors toolChoice='none', forced tool_choice, allowedTools, and _summaryProhibitsToolCalls`, async () => {
      const harmonyWeather = `<|channel|>commentary to=functions.get_weather<|message|>{"city":"Seoul"}<|call|>`;
      const harmonyPing = `<|channel|>commentary to=functions.ping<|message|>{}<|call|>`;
      const xmlWeather = `<antml:invoke name="get_weather"><antml:parameter name="city">Seoul</antml:parameter></antml:invoke>`;
      const xmlPing = `<function name="ping"/>`;

      // toolChoice: "none" disables recovery for both Harmony and opted-in XML.
      const noneHarmony = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        chunks: mode === "streamed" ? [...harmonyPing] : [harmonyPing],
        toolChoice: "none",
      });
      expect(toolCallsFrom(noneHarmony)).toEqual([]);
      expect(visible(noneHarmony)).toBe(harmonyPing);

      const noneXml = await runChat({
        mode,
        model: "qwen3-coder-30b",
        chunks: [xmlWeather],
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
        toolChoice: "none",
      });
      expect(toolCallsFrom(noneXml)).toEqual([]);
      expect(visible(noneXml)).toBe(xmlWeather);

      // Forced specific function permits only that function and refuses disallowed siblings.
      const forcedDisallowed = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        chunks: [harmonyWeather],
        toolChoice: { name: "ping" },
      });
      expect(toolCallsFrom(forcedDisallowed)).toEqual([]);
      expect(visible(forcedDisallowed)).toBe(harmonyWeather);

      const forcedMixed = await runChat({
        mode,
        model: "qwen3-coder-30b",
        chunks: [xmlWeather + xmlPing],
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
        toolChoice: { name: "ping" },
      });
      expect(toolCallsFrom(forcedMixed)).toEqual([{ id: "call_1", name: "ping", arguments: "{}" }]);
      expect(visible(forcedMixed)).toBe(xmlWeather);

      // allowedTools restricts recovery to the allowed subset.
      const allowedOnlyPing = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        chunks: [harmonyWeather + harmonyPing],
        toolChoice: { allowedTools: ["ping"], mode: "required" },
      });
      expect(toolCallsFrom(allowedOnlyPing)).toEqual([{ id: "call_1", name: "ping", arguments: "{}" }]);
      expect(visible(allowedOnlyPing)).toBe(harmonyWeather);

      // Namespaced MCP tool selected by tool_choice permits only that tool.
      const nsRead: EpxTool = { name: "read", namespace: "mcp__fs", parameters: { type: "object", properties: {} } };
      const nsWrite: EpxTool = { name: "write", namespace: "mcp__fs", parameters: { type: "object", properties: {} } };
      const nsBlocked = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        tools: [nsRead, nsWrite],
        toolChoice: { name: "read" },
        chunks: [`<|channel|>commentary to=functions.mcp__fs__write<|message|>{}<|call|><|channel|>commentary to=functions.mcp__fs__read<|message|>{}<|call|>`],
      });
      expect(toolCallsFrom(nsBlocked)).toEqual([{ id: "call_1", name: "mcp__fs__read", arguments: "{}" }]);
      expect(visible(nsBlocked)).toBe(`<|channel|>commentary to=functions.mcp__fs__write<|message|>{}<|call|>`);

      // _summaryProhibitsToolCalls disables leaked recovery even with tools and permissive toolChoice.
      const summaryBlockedHarmony = await runChat({
        mode,
        model: "openai/gpt-oss-120b",
        chunks: [harmonyPing],
        toolChoice: "auto",
        summaryProhibitsToolCalls: true,
      });
      expect(toolCallsFrom(summaryBlockedHarmony)).toEqual([]);
      expect(visible(summaryBlockedHarmony)).toBe(harmonyPing);

      const summaryBlockedXml = await runChat({
        mode,
        model: "qwen3-coder-30b",
        chunks: [xmlPing],
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
        toolChoice: { name: "ping" },
        summaryProhibitsToolCalls: true,
      });
      expect(toolCallsFrom(summaryBlockedXml)).toEqual([]);
      expect(visible(summaryBlockedXml)).toBe(xmlPing);
    });

    test(`${mode} rejects reserved XML parameter keys without prototype pollution`, async () => {
      const payloads = [
        `<function name="get_weather"><parameter name="__proto__">{"polluted":true}</parameter><parameter name="city">Seoul</parameter></function>`,
        `<antml:invoke name="get_weather"><antml:parameter name="constructor">{"polluted":true}</antml:parameter><antml:parameter name="city">Seoul</antml:parameter></antml:invoke>`,
        `<function name="get_weather"><parameter name="prototype">{"polluted":true}</parameter><parameter name="city">Seoul</parameter></function>`,
      ];
      for (const payload of payloads) {
        const events = await runChat({
          mode,
          model: "qwen3-coder-30b",
          chunks: mode === "streamed" ? [payload.slice(0, 27), payload.slice(27)] : [payload],
          provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
        });
        expect(toolCallsFrom(events)).toEqual([]);
        expect(visible(events)).toBe(payload);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      }

      // Non-reserved Object.prototype property names still serialize cleanly via null-prototype accumulation.
      const protoMethodTool: EpxTool = {
        name: "meta",
        parameters: { type: "object", properties: { toString: { type: "string" } } },
      };
      const safeEvents = await runChat({
        mode,
        model: "qwen3-coder-30b",
        tools: [protoMethodTool],
        chunks: [`<function name="meta"><parameter name="toString">value</parameter></function>`],
        provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
      });
      expect(toolCallsFrom(safeEvents)).toEqual([
        { id: "call_1", name: "meta", arguments: JSON.stringify({ toString: "value" }) },
      ]);
    });
  }

  test("handles 4 MiB repeated and 950 KiB nested Harmony/XML openers in linear time (fail-closed)", async () => {
    const aTool: EpxTool = { name: "a", parameters: { type: "object", properties: { x: { type: "string" } } } };
    const registry = createOpenAIChatToolNameRegistry([aTool, pingTool]);
    const options = resolveLeakedToolCallOptions(
      { leakedToolCallModels: ["qwen3-coder-30b"] },
      "qwen3-coder-30b",
      [aTool, pingTool],
      registry,
    )!;
    expect(options).toBeDefined();

    const fourMiB = 4 * 1024 * 1024;
    const inputs: Array<{ label: string; text: string }> = [
      {
        label: "4 MiB unclosed <function name=\"a\">",
        text: `<function name="a">`.repeat(Math.ceil(fourMiB / `<function name="a">`.length)),
      },
      {
        label: "4 MiB unclosed <antml:invoke name=\"a\">",
        text: `<antml:invoke name="a">`.repeat(Math.ceil(fourMiB / `<antml:invoke name="a">`.length)),
      },
      {
        label: "4 MiB unclosed <function_calls>",
        text: `<function_calls>`.repeat(Math.ceil(fourMiB / `<function_calls>`.length)),
      },
      {
        label: "3.9 MiB nested <function_calls> with trailing </function_calls>",
        text: `<function_calls>`.repeat(240_000) + `</function_calls>`,
      },
      {
        label: "1.8 MiB repeated <|channel|>to=functions.a<|message|>",
        text: `<|channel|>to=functions.a<|message|>`.repeat(52_000),
      },
      {
        label: "4 MiB repeated <|channel|>to=functions.a without <|message|>",
        text: `<|channel|>to=functions.a`.repeat(170_000),
      },
      {
        label: "950 KiB nested <function name=\"a\"> + single invalid </function>",
        text: `<function name="a">`.repeat(51_000) + `invalid</function>`,
      },
      {
        label: "960 KiB nested <antml:invoke name=\"a\"> + single invalid </antml:invoke>",
        text: `<antml:invoke name="a">`.repeat(41_000) + `invalid</antml:invoke>`,
      },
      {
        label: "1.0 MiB nested <|channel|>...<|message|> + single invalid <|call|>",
        text: `<|channel|>to=functions.a<|message|>`.repeat(28_000) + `invalid<|call|>`,
      },
      {
        label: "1.0 MiB nested <function_calls><function name=\"a\"> + trailing invalid closers",
        text: `<function_calls><function name="a">`.repeat(30_000) + `invalid</function></function_calls>`,
      },
    ];

    for (const { label, text } of inputs) {
      let seq = 0;
      const start = performance.now();
      const res = recoverLeakedToolCallsFromText(text, options, () => `call_${++seq}`);
      const elapsed = performance.now() - start;
      expect(res.calls, label).toEqual([]);
      expect(res.remainingText.length, label).toBe(text.length);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    }

    // 950 KiB nested openers with a single empty </function> only matches the final innermost call in linear time.
    const nestedInnermost = `<function name="a">`.repeat(51_000) + `</function>`;
    const nestedStart = performance.now();
    let nestedSeq = 0;
    const nestedRes = recoverLeakedToolCallsFromText(nestedInnermost, options, () => `call_${++nestedSeq}`);
    expect(nestedRes.calls).toHaveLength(1);
    expect(nestedRes.calls[0]!.name).toBe("a");
    expect(performance.now() - nestedStart).toBeLessThan(500);

    // Also verify end-to-end buffered and streamed adapter execution near the 4 MiB recovery cap.
    const nestedBuffered = `<function name="a">`.repeat(51_000) + `invalid</function>`;
    const startAdapter = performance.now();
    const bufferedEvents = await runChat({
      mode: "buffered",
      model: "qwen3-coder-30b",
      tools: [aTool],
      provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
      chunks: [nestedBuffered],
    });
    expect(toolCallsFrom(bufferedEvents)).toEqual([]);
    expect(visible(bufferedEvents)).toBe(nestedBuffered);

    const streamedEvents = await runChat({
      mode: "streamed",
      model: "qwen3-coder-30b",
      tools: [aTool],
      provider: { leakedToolCallModels: ["qwen3-coder-30b"] },
      chunks: [nestedBuffered.slice(0, 500_000), nestedBuffered.slice(500_000)],
    });
    expect(toolCallsFrom(streamedEvents)).toEqual([]);
    expect(visible(streamedEvents)).toBe(nestedBuffered);
    expect(performance.now() - startAdapter).toBeLessThan(1_000);

    // Streaming repeated partial/complete openers across many small chunks also stays linear.
    const budget = createTestTranslatorBudget();
    const streamBuf = createOpenAIChatToolContentBuffer(budget, "openai/gpt-oss-120b", new Map(), options);
    const streamStart = performance.now();
    const partialOut: string[] = [];
    for (let i = 0; i < 40_000; i += 1) {
      for (const ev of streamBuf.ingestStreaming("<|channel|")) {
        if (ev.type === "text_delta") partialOut.push(ev.text);
      }
    }
    for (const ev of streamBuf.recoverStandalone(true, () => "call_1", n => n)) {
      if (ev.type === "text_delta") partialOut.push(ev.text);
    }
    for (const ev of streamBuf.drain([])) {
      if (ev.type === "text_delta") partialOut.push(ev.text);
    }
    streamBuf.dispose();
    expect(partialOut.join("")).toBe("<|channel|".repeat(40_000));
    expect(performance.now() - streamStart).toBeLessThan(1_000);

    // Failed wrapper backtracking still recovers valid leading calls without leaking nested parameter tags.
    const backtrackText =
      `<function_calls><antml:invoke name="a"><antml:parameter name="x">ok</antml:parameter></antml:invoke><function name="ping"/><function name="undeclared"/></function_calls>`;
    let seq = 0;
    const backtrackRes = recoverLeakedToolCallsFromText(backtrackText, options, () => `call_${++seq}`);
    expect(backtrackRes.calls.map(c => c.name)).toEqual(["a", "ping"]);
  });
});
