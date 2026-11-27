import { describe, expect, test } from "bun:test";
import {
  compactJsonToolText,
  compressResponsesToolOutputsInPlace,
  compressToolOutputText,
  foldRepetitiveLogLines,
  MAX_COMPRESSIBLE_STRING_BYTES,
  MAX_FOLD_LINES,
  MAX_JSON_COMPACT_BYTES,
  MAX_JSON_NESTING_DEPTH,
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

  test("losslessly minifies pretty-printed JSON within depth and byte bounds and fails closed on hostile nesting", () => {
    const prettyObj = JSON.stringify(
      {
        status: "ok",
        items: Array.from({ length: 12 }, (_, idx) => ({
          id: `item_${idx}`,
          score: idx * 10,
          tags: ["alpha", "beta"],
        })),
      },
      null,
      2,
    );
    const compacted = compactJsonToolText(prettyObj);
    expect(compacted.compacted).toBe(true);
    expect(compacted.text.length).toBeLessThan(prettyObj.length - 80);
    expect(JSON.parse(compacted.text)).toEqual(JSON.parse(prettyObj));

    // Malformed JSON stays intact without throwing.
    const invalidJson = "{\n  \"broken\": [1, 2,\n  \"missing\": true\n}".repeat(3);
    expect(compactJsonToolText(invalidJson)).toEqual({ text: invalidJson, compacted: false });

    // Hostile deeply nested JSON (> MAX_JSON_NESTING_DEPTH) fails closed before JSON.parse.
    const deepDepth = MAX_JSON_NESTING_DEPTH + 6;
    const hostileNested = `${"[\n  ".repeat(deepDepth)}1${"\n]".repeat(deepDepth)}`;
    expect(hostileNested.length).toBeGreaterThan(64);
    expect(compactJsonToolText(hostileNested)).toEqual({ text: hostileNested, compacted: false });

    // Payloads exceeding MAX_JSON_COMPACT_BYTES skip JSON parsing safely.
    const hugePretty = `{\n  "blob": "${"x".repeat(MAX_JSON_COMPACT_BYTES)}"\n}`;
    expect(compactJsonToolText(hugePretty).compacted).toBe(false);

    // compactJson: false opt-out preserves whitespace when under minChars.
    const body = {
      input: [{ type: "function_call_output", call_id: "call_json_1", output: prettyObj }],
    };
    const optedOut = compressResponsesToolOutputsInPlace(body, {
      enabled: true,
      minChars: 50_000,
      compactJson: false,
    });
    expect(optedOut.compactedJsonItems ?? 0).toBe(0);
    expect(body.input[0]!.output).toBe(prettyObj);

    const optedIn = compressResponsesToolOutputsInPlace(body, {
      enabled: true,
      minChars: 50_000,
      compactJson: true,
    });
    expect(optedIn.compactedJsonItems).toBe(1);
    expect(optedIn.savedChars).toBeGreaterThan(80);
    expect(optedIn.estimatedSavedTokens).toBe(Math.floor(optedIn.savedChars / 4));
    expect(JSON.parse(body.input[0]!.output)).toEqual(JSON.parse(prettyObj));
  });

  test("deduplicates identical non-error tool outputs across Responses, Chat, and Anthropic while skipping errors and ambiguous IDs", () => {
    const repeatedListing = Array.from(
      { length: 30 },
      (_, i) => `drwxr-xr-x  12 dev  staff  384 Nov 26 12:00 package-${i + 1}`,
    ).join("\n");
    expect(repeatedListing.length).toBeGreaterThan(600);

    // 1. Responses input[] deduplication
    const responsesBody = {
      input: [
        { type: "function_call_output", call_id: "call_ls_1", output: repeatedListing },
        { type: "function_call_output", call_id: "call_ls_2", output: repeatedListing },
      ],
    };
    const res1 = compressResponsesToolOutputsInPlace(responsesBody, {
      enabled: true,
      minChars: 50_000,
      deduplicateIdentical: true,
      dedupMinChars: 512,
    });
    expect(res1.deduplicatedItems).toBe(1);
    expect(responsesBody.input[0]!.output).toBe(repeatedListing);
    expect(responsesBody.input[1]!.output).toContain("[easyproxy deduplicated tool output: identical to call_id=call_ls_1");

    // 2. Chat messages[] (role=tool) deduplication
    const chatBody = {
      messages: [
        { role: "tool", tool_call_id: "toolc_1", content: repeatedListing },
        { role: "tool", tool_call_id: "toolc_2", content: repeatedListing },
      ],
    };
    const res2 = compressResponsesToolOutputsInPlace(chatBody, {
      enabled: true,
      minChars: 50_000,
      deduplicateIdentical: true,
      dedupMinChars: 512,
    });
    expect(res2.deduplicatedItems).toBe(1);
    expect(chatBody.messages[0]!.content).toBe(repeatedListing);
    expect(chatBody.messages[1]!.content).toContain("call_id=toolc_1");

    // 3. Anthropic tool_result deduplication + is_error exclusion
    const errText = `Permission denied while reading workspace index:\n${" detail line\n".repeat(60)}`;
    const anthropicBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_ok_1", content: repeatedListing },
            { type: "tool_result", tool_use_id: "toolu_err_1", is_error: true, content: errText },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_ok_2", content: [{ type: "text", text: repeatedListing }] },
            { type: "tool_result", tool_use_id: "toolu_err_2", is_error: true, content: errText },
          ],
        },
      ],
    };
    const res3 = compressResponsesToolOutputsInPlace(anthropicBody, {
      enabled: true,
      minChars: 50_000,
      deduplicateIdentical: true,
      dedupMinChars: 512,
    });
    expect(res3.deduplicatedItems).toBe(1);
    const secondOk = (anthropicBody.messages[1]!.content[0] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(secondOk).toContain("call_id=toolu_ok_1");
    // Error blocks must NEVER be deduplicated.
    expect((anthropicBody.messages[1]!.content[1] as { content: string }).content).toBe(errText);

    // 4. Error-prefix strings and ambiguous duplicate call_ids must NEVER be deduplicated.
    const tracebackText = `Traceback (most recent call last):\n${"  File \"main.py\", line 10, in run\n".repeat(30)}`;
    const edgeBody = {
      input: [
        { type: "function_call_output", call_id: "call_tb_1", output: tracebackText },
        { type: "function_call_output", call_id: "call_tb_2", output: tracebackText },
        { type: "function_call_output", call_id: "call_dup_id", output: repeatedListing },
        { type: "function_call_output", call_id: "call_dup_id", output: repeatedListing },
      ],
    };
    const res4 = compressResponsesToolOutputsInPlace(edgeBody, {
      enabled: true,
      minChars: 50_000,
      deduplicateIdentical: true,
      dedupMinChars: 512,
    });
    expect(res4.deduplicatedItems ?? 0).toBe(0);
    expect(edgeBody.input[1]!.output).toBe(tracebackText);
    expect(edgeBody.input[3]!.output).toBe(repeatedListing);
  });

  test("snaps head and tail excerpts to clean newline boundaries when available", () => {
    const lines = Array.from({ length: 100 }, (_, idx) => `line-${String(idx + 1).padStart(3, "0")}: deterministic structured output segment`);
    const joined = lines.join("\n");
    const out = compressToolOutputText(joined, {
      enabled: true,
      minChars: 1_000,
      headChars: 260,
      tailChars: 260,
    });
    const markerIdx = out.indexOf("\n\n...[easyproxy compressed ");
    expect(markerIdx).toBeGreaterThan(0);
    const headPart = out.slice(0, markerIdx);
    const markerEnd = out.indexOf("]...\n\n", markerIdx) + "]...\n\n".length;
    const tailPart = out.slice(markerEnd);

    // Neither head nor tail cuts a line in half.
    expect(headPart.endsWith("deterministic structured output segment")).toBe(true);
    expect(tailPart.startsWith("line-")).toBe(true);
  });

  test("excludes ANSI-colored and pretty-JSON error outputs, protects multimodal [text, image] tool_result blocks, and matches canonical JSON wire lengths", () => {
    const coloredError = `\x1b[31mError: ENOENT: no such file or directory\x1b[0m\n${"  at fs.readFileSync (node:fs:448:20)\n".repeat(20)}`;
    const prettyJsonError = JSON.stringify(
      { error: { code: "ECONNREFUSED", details: Array.from({ length: 18 }, (_, i) => `retry-${i}`) } },
      null,
      2,
    );
    const prettyData = JSON.stringify(
      { items: Array.from({ length: 20 }, (_, i) => ({ id: i, label: `entry_${i}`, ok: true })) },
      null,
      2,
    );
    const compactData = JSON.stringify(JSON.parse(prettyData));

    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_dup_assist", name: "read", input: {} },
            { type: "tool_use", id: "toolu_dup_assist", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_ansi_err_1", content: coloredError },
            { type: "tool_result", tool_use_id: "toolu_json_err_1", content: prettyJsonError },
            { type: "tool_result", tool_use_id: "toolu_dup_assist", content: prettyData },
            {
              type: "tool_result",
              tool_use_id: "toolu_mm_1",
              cache_control: { type: "ephemeral" },
              content: [
                { type: "text", text: prettyData },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
            { type: "tool_result", tool_use_id: "toolu_json_ok_1", content: prettyData },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_ansi_err_2", content: coloredError },
            { type: "tool_result", tool_use_id: "toolu_json_err_2", content: prettyJsonError },
            { type: "tool_result", tool_use_id: "toolu_after_ambig", content: prettyData },
            {
              type: "tool_result",
              tool_use_id: "toolu_mm_2",
              cache_control: { type: "ephemeral" },
              content: [
                { type: "text", text: prettyData },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
              ],
            },
            { type: "tool_result", tool_use_id: "toolu_json_ok_2", content: compactData },
          ],
        },
      ],
    };

    const outcome = compressResponsesToolOutputsInPlace(body, {
      enabled: true,
      minChars: 50_000,
      stripAnsi: true,
      compactJson: true,
      deduplicateIdentical: true,
      dedupMinChars: 256,
    });

    const turn1 = body.messages[1]!.content as Array<Record<string, unknown>>;
    const turn2 = body.messages[2]!.content as Array<Record<string, unknown>>;

    // 1. ANSI-colored error and pretty-JSON error strip/compact in place, but are NEVER replaced by dedup stubs.
    expect(String(turn2[0]!.content)).not.toContain("[easyproxy deduplicated tool output:");
    expect(String(turn2[0]!.content).startsWith("Error: ENOENT")).toBe(true);
    expect(String(turn2[1]!.content)).not.toContain("[easyproxy deduplicated tool output:");
    expect(JSON.parse(String(turn2[1]!.content)).error.code).toBe("ECONNREFUSED");

    // 2. Duplicate assistant tool_use id ("toolu_dup_assist") was not recorded as a dedup source,
    //    so toolu_json_ok_1 became the canonical source and toolu_after_ambig + toolu_json_ok_2 deduplicated against it!
    expect(turn1[4]!.content).toBe(compactData);
    expect(turn2[2]!.content).toBe(`[easyproxy deduplicated tool output: identical to call_id=toolu_json_ok_1 (${compactData.length} chars)]`);
    expect(turn2[4]!.content).toBe(`[easyproxy deduplicated tool output: identical to call_id=toolu_json_ok_1 (${compactData.length} chars)]`);
    expect(outcome.deduplicatedItems).toBe(2);

    // 3. Multimodal [text, image] tool_result compacts JSON inside text blocks without deduplicating across distinct images or touching cache_control.
    const mm2Parts = turn2[3]!.content as Array<Record<string, unknown>>;
    expect(mm2Parts[0]!.text).toBe(compactData);
    expect((mm2Parts[1]!.source as { data: string }).data).toBe("BBBB");
    expect(turn2[3]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("folds repetitive CLI/build progress and duplicate log lines while strictly preserving diffs, stack traces, and line caps", () => {
    const buildLog = [
      "[cargo] compiling workspace...",
      ...Array.from({ length: 16 }, (_, idx) => `Downloading crate_bundle (${idx + 1}/16) ${Math.round(((idx + 1) / 16) * 100)}%`),
      ...Array.from({ length: 10 }, () => "  [cache] artifact digest verified clean"),
      "Finished release target in 2.10s",
    ].join("\n");

    const folded = foldRepetitiveLogLines(buildLog);
    expect(folded.folded).toBe(true);
    expect(folded.text).toContain("Downloading crate_bundle (1/16)");
    expect(folded.text).toContain("[... 14 intermediate progress lines folded]");
    expect(folded.text).toContain("Downloading crate_bundle (16/16) 100%");
    expect(folded.text).toContain("[... repeated 9 more times]");

    // Unified diffs must NEVER be folded even with repeated identical lines
    const unifiedDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,12 +1,12 @@",
      ...Array.from({ length: 12 }, () => "   const unchangedContextLine = true;"),
    ].join("\n");
    expect(foldRepetitiveLogLines(unifiedDiff)).toEqual({ text: unifiedDiff, folded: false });

    // Stack traces must NEVER be folded
    const stackLog = [
      "Unhandled rejection in worker:",
      ...Array.from({ length: 10 }, () => "    at processTicksAndRejections (node:internal/process/task_queues:95:5)"),
    ].join("\n");
    expect(foldRepetitiveLogLines(stackLog)).toEqual({ text: stackLog, folded: false });

    // Oversized line counts (> MAX_FOLD_LINES) fail-safe without folding
    const hugeLines = "ok line content repeated\n".repeat(MAX_FOLD_LINES + 5);
    expect(foldRepetitiveLogLines(hugeLines).folded).toBe(false);

    // Payload-level integration tracks foldedLogItems and respects foldRepetitiveLines: false
    const payloadA = { input: [{ type: "function_call_output", call_id: "call_build_1", output: buildLog }] };
    const resOn = compressResponsesToolOutputsInPlace(payloadA, { enabled: true, minChars: 50_000, foldRepetitiveLines: true });
    expect(resOn.foldedLogItems).toBe(1);
    expect(payloadA.input[0]!.output).toContain("intermediate progress lines folded");

    const payloadB = { input: [{ type: "function_call_output", call_id: "call_build_2", output: buildLog }] };
    const resOff = compressResponsesToolOutputsInPlace(payloadB, { enabled: true, minChars: 50_000, foldRepetitiveLines: false });
    expect(resOff.foldedLogItems).toBe(0);
    expect(payloadB.input[0]!.output).toBe(buildLog);
  });

  test("never corrupts distinct telemetry/table rows with percentages or ratios, while folding multi-file build steps before linker errors", () => {
    // Distinct entity rows (`node-1`..`node-6`) with non-monotonic % and ratios must NEVER be folded
    const serverMetricsTable = [
      "Cluster health snapshot:",
      "node-1: cpu 12% memory 41% shards 1/8 latency 14ms",
      "node-2: cpu 19% memory 44% shards 2/8 latency 15ms",
      "node-3: cpu 99% memory 98% shards 7/8 latency 4200ms",
      "node-4: cpu 11% memory 39% shards 1/8 latency 12ms",
      "node-5: cpu 14% memory 42% shards 3/8 latency 13ms",
      "node-6: cpu 16% memory 40% shards 2/8 latency 14ms",
    ].join("\n");
    const tableFold = foldRepetitiveLogLines(serverMetricsTable);
    expect(tableFold.folded).toBe(false);
    expect(tableFold.text).toContain("node-3: cpu 99% memory 98% shards 7/8 latency 4200ms");

    // Multi-file Ninja/CMake steps fold monotonically while subtle linker errors without `error:` remain untouched
    const ninjaWithLinkerFailure = [
      ...Array.from({ length: 16 }, (_, idx) => `[${idx + 1}/16] Building CXX object src/CMakeFiles/core.dir/unit_${idx + 1}.cpp.o`),
      "ld: symbol(s) not found for architecture arm64",
      "undefined reference to `epx_missing_symbol'",
      "collect2: ld returned 1 exit status",
    ].join("\n");
    const ninjaFold = foldRepetitiveLogLines(ninjaWithLinkerFailure);
    expect(ninjaFold.folded).toBe(true);
    expect(ninjaFold.text).toContain("[1/16] Building CXX object src/CMakeFiles/core.dir/unit_1.cpp.o");
    expect(ninjaFold.text).toContain("[... 14 intermediate progress lines folded]");
    expect(ninjaFold.text).toContain("[16/16] Building CXX object src/CMakeFiles/core.dir/unit_16.cpp.o");
    expect(ninjaFold.text).toContain("ld: symbol(s) not found for architecture arm64");
    expect(ninjaFold.text).toContain("undefined reference to `epx_missing_symbol'");
    expect(ninjaFold.text).toContain("collect2: ld returned 1 exit status");
  });

  test("compactJsonToolText preserves >53-bit ints, duplicate keys, trailing decimals, and ignores invalid JSON syntax", () => {
    const losslessPretty = [
      "{",
      '  "snowflakeId": 9007199254740993,',
      '  "amount": 12.50,',
      '  "tag": "first",',
      '  "tag": "second",',
      '  "nested": {',
      '    "exact": -0.000,',
      '    "exp": 1.2500e+02,',
      '    "unicode": "\\u0066oo"',
      "  }",
      "}",
    ].join("\n");
    const compacted = compactJsonToolText(losslessPretty);
    expect(compacted.compacted).toBe(true);
    expect(compacted.text).toBe(
      '{"snowflakeId":9007199254740993,"amount":12.50,"tag":"first","tag":"second","nested":{"exact":-0.000,"exp":1.2500e+02,"unicode":"\\u0066oo"}}',
    );

    // Invalid RFC 8259 syntax variations (trailing comma, leading zero, JS escape, trailing prose, NBSP) stay untouched.
    const invalidCases = [
      '{\n  "id": 9007199254740993,\n  "trailing": true,\n}\n// trailing comment',
      '{\n  "leadingZero": 01,\n  "long": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n}',
      '{\n  "ok": 12.50,\n  "tail": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n}\nERROR next log line',
      '{\n  "badEscape": "\\x41",\n  "long": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n}',
      '{\u00a0\n  "nbsp": true,\n  "long": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n}',
    ];
    for (const raw of invalidCases) {
      expect(compactJsonToolText(raw)).toEqual({ text: raw, compacted: false });
    }
  });

  test("keeps prefix tool-output deduplication deterministic beyond MAX_SCAN_ITEMS and compresses Gemini functionResponse payloads", () => {
    const repeatedListing = Array.from(
      { length: 25 },
      (_, i) => `item-${i + 1}: deterministic output block payload`,
    ).join("\n");

    const basePrefix = [
      { type: "function_call_output", call_id: "call_prefix_1", output: repeatedListing },
      { type: "function_call_output", call_id: "call_prefix_2", output: repeatedListing },
    ];
    const FillerCount = 4_200;
    const filler = Array.from({ length: FillerCount }, (_, i) => ({
      role: "assistant",
      content: `step-${i}`,
    }));
    const oversizedBody = { input: [...basePrefix, ...filler] };
    const dedupRes = compressResponsesToolOutputsInPlace(oversizedBody, {
      enabled: true,
      minChars: 50_000,
      deduplicateIdentical: true,
      dedupMinChars: 256,
    });
    expect(dedupRes.deduplicatedItems).toBe(1);
    expect(oversizedBody.input[0]!.output).toBe(repeatedListing);
    expect(oversizedBody.input[1]!.output).toContain("identical to call_id=call_prefix_1");

    // Gemini contents[].parts[].functionResponse compression & dedup (while excluding errors)
    const geminiErr = `Error: EACCES permission denied\n${"trace detail\n".repeat(40)}`;
    const geminiBody = {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "gcall_1", name: "list_files", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "gcall_1", name: "list_files", response: { result: repeatedListing } } }] },
        { role: "model", parts: [{ functionCall: { id: "gcall_2", name: "list_files", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "gcall_2", name: "list_files", response: { result: repeatedListing } } }] },
        { role: "user", parts: [{ functionResponse: { id: "gcall_err_1", name: "read_file", response: { result: geminiErr, error: "EACCES" } } }] },
        { role: "user", parts: [{ functionResponse: { id: "gcall_err_2", name: "read_file", response: { result: geminiErr, error: "EACCES" } } }] },
      ],
    };
    const geminiRes = compressResponsesToolOutputsInPlace(geminiBody, {
      enabled: true,
      minChars: 50_000,
      deduplicateIdentical: true,
      dedupMinChars: 256,
    });
    expect(geminiRes.deduplicatedItems).toBe(1);
    expect((geminiBody.contents[1]!.parts[0] as { functionResponse: { response: { result: string } } }).functionResponse.response.result).toBe(repeatedListing);
    expect((geminiBody.contents[3]!.parts[0] as { functionResponse: { response: { result: string } } }).functionResponse.response.result).toContain("identical to call_id=gcall_1");
    expect((geminiBody.contents[5]!.parts[0] as { functionResponse: { response: { result: string } } }).functionResponse.response.result).toBe(geminiErr);
  });
});
