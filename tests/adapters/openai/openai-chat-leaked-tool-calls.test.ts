import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { configSchema } from "../../../src/config/schema/config-schema";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import type { AdapterEvent, EpxProviderConfig, EpxTool } from "../../../src/types";
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
    options: {},
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

    // Ordinary prose `<function>` or fenced/inlined `<function\nname=...>` must fail closed and stay visible.
    const prose = "Use <function> or <function_name> helper.";
    const fenced = "```xml\n<function\nname=\"ping\"/>\n```";
    const inlined = "Syntax: `<function\tname=\"ping\"/>`";
    for (const content of [prose, fenced, inlined]) {
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
});
