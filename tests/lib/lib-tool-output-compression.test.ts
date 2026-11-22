import { describe, expect, test } from "bun:test";
import {
  compressResponsesToolOutputsInPlace,
  compressToolOutputText,
  MAX_COMPRESSIBLE_STRING_BYTES,
  normalizeToolLogText,
  stripAnsiControlSequences,
} from "../../src/lib/tool-output-compression";

describe("tool-output-compression", () => {
  test("strips ANSI CSI and OSC sequences without regex backtracking", () => {
    const ansi = "\x1b[31mERROR\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ ok";
    expect(stripAnsiControlSequences(ansi)).toBe("ERROR link ok");
  });

  test("collapses carriage-return progress overwrites and excess blank lines", () => {
    const raw = "step 1\r10%\r50%\r100%\ndone\r\nline2\n\n\n\n\nline3";
    expect(normalizeToolLogText(raw, false)).toBe("100%\ndone\nline2\n\n\nline3");

    // Repeated trailing CRs before LF must preserve the line content rather than returning empty string.
    expect(normalizeToolLogText("Build ok\r\r\nNext line\r\r\r\n", true)).toBe("Build ok\nNext line\n");

    // Malformed CSI containing newline (< 0x20) and unterminated OSC must never delete subsequent log lines.
    expect(stripAnsiControlSequences("ok\x1b[\nnext\n")).toBe("ok\nnext\n");
    expect(stripAnsiControlSequences("ok\x1b]0;unterminated\nsecond line\nthird line")).toBe("ok0;unterminated\nsecond line\nthird line");
  });

  test("preserves valid UTF-16 surrogate pairs and compresses Anthropic user tool_result blocks", () => {
    const emojiHead = "🎉".repeat(600);
    const emojiTail = "🚀".repeat(600);
    const input = `${emojiHead}${"M".repeat(2_000)}${emojiTail}`;
    const compressed = compressToolOutputText(input, {
      enabled: true,
      minChars: 1_000,
      headChars: 101,
      tailChars: 101,
    });
    expect(compressed).toContain("...[easyproxy compressed ");
    expect(compressed.isWellFormed()).toBe(true);

    const anthropicBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "P".repeat(2_000) },
            { type: "tool_result", tool_use_id: "toolu_1", content: "T".repeat(3_000) },
            { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "B".repeat(3_000) }] },
          ],
        },
      ],
    };
    const res = compressResponsesToolOutputsInPlace(anthropicBody, {
      enabled: true,
      minChars: 1_000,
      headChars: 100,
      tailChars: 100,
    });
    expect(res.compressedItems).toBe(2);
    expect((anthropicBody.messages[0]!.content[0] as { text: string }).text.length).toBe(2_000);
    expect((anthropicBody.messages[0]!.content[1] as { content: string }).content).toContain("...[easyproxy compressed ");
    expect(((anthropicBody.messages[0]!.content[2] as { content: Array<{ text: string }> }).content[0]!).text).toContain("...[easyproxy compressed ");
  });

  test("elides oversized tool outputs deterministically while preserving prefix turns", () => {
    const longOutput = "HEAD-".repeat(800) + "MIDDLE-".repeat(2_000) + "TAIL-".repeat(800);
    const body = {
      instructions: "\x1b[32msystem instructions untouched\x1b[0m " + "A".repeat(15_000),
      input: [
        { role: "system", content: "system prompt untouched " + "B".repeat(15_000) },
        { role: "user", content: "user prompt untouched " + "C".repeat(15_000) },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: `\x1b[33m${longOutput}\x1b[0m`,
        },
        { role: "assistant", content: "assistant turn untouched " + "D".repeat(15_000) },
      ],
      tools: [{ type: "function", name: "run", description: "E".repeat(15_000) }],
    };

    const origInstructions = body.instructions;
    const origSystem = body.input[0]!.content;
    const origUser = body.input[1]!.content;
    const origAssistant = body.input[3]!.content;
    const origToolDesc = body.tools[0]!.description;

    const result = compressResponsesToolOutputsInPlace(body, {
      enabled: true,
      minChars: 2_000,
      headChars: 200,
      tailChars: 200,
    });

    expect(result.compressedItems).toBe(1);
    expect(result.savedChars).toBeGreaterThan(10_000);
    expect(body.input[2]!.output).toStartWith("HEAD-");
    expect(body.input[2]!.output).toContain("...[easyproxy compressed ");
    expect(body.input[2]!.output).toEndWith("TAIL-");
    expect(body.input[2]!.output).not.toContain("\x1b[");

    // Prompt KV prefix invariance: non-tool entries remain byte-identical.
    expect(body.instructions).toBe(origInstructions);
    expect(body.input[0]!.content).toBe(origSystem);
    expect(body.input[1]!.content).toBe(origUser);
    expect(body.input[3]!.content).toBe(origAssistant);
    expect(body.tools[0]!.description).toBe(origToolDesc);
  });

  test("compresses Chat messages with role=tool text and skips >16 MiB payloads safely", () => {
    const body = {
      messages: [
        { role: "user", content: "X".repeat(5_000) },
        { role: "tool", content: "LOG\n".repeat(2_000) },
      ],
    };
    const res = compressResponsesToolOutputsInPlace(body, {
      enabled: true,
      minChars: 1_000,
      headChars: 120,
      tailChars: 120,
    });
    expect(res.compressedItems).toBe(1);
    expect(body.messages[0]!.content.length).toBe(5_000);
    expect(body.messages[1]!.content).toContain("...[easyproxy compressed ");

    const oversized = "Z".repeat(MAX_COMPRESSIBLE_STRING_BYTES + 1);
    expect(compressToolOutputText(oversized, { enabled: true })).toBe(oversized);
  });
});
