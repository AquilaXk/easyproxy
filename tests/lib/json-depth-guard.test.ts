import { describe, expect, test } from "bun:test";
import {
  assertJsonNestingDepth,
  DEFAULT_MAX_JSON_NESTING_DEPTH,
  JsonNestingDepthExceededError,
} from "../../src/lib/json-depth-guard";

const enc = new TextEncoder();

describe("json-depth-guard", () => {
  test("accepts valid nesting up to the default cap of 256", () => {
    expect(DEFAULT_MAX_JSON_NESTING_DEPTH).toBe(256);
    const arrayAtCap = "[".repeat(256) + "]".repeat(256);
    expect(() => assertJsonNestingDepth(enc.encode(arrayAtCap))).not.toThrow();

    const objectAtCap = '{"a":'.repeat(255) + "{}" + "}".repeat(255);
    expect(() => assertJsonNestingDepth(enc.encode(objectAtCap))).not.toThrow();
  });

  test("rejects depth 257 fail-closed with JsonNestingDepthExceededError", () => {
    const tooDeepArrays = "[".repeat(257) + "]".repeat(257);
    expect(() => assertJsonNestingDepth(enc.encode(tooDeepArrays))).toThrow(JsonNestingDepthExceededError);

    const tooDeepObjects = '{"a":'.repeat(256) + "{}" + "}".repeat(256);
    try {
      assertJsonNestingDepth(enc.encode(tooDeepObjects));
      expect.unreachable("expected JsonNestingDepthExceededError");
    } catch (error) {
      expect(error).toBeInstanceOf(JsonNestingDepthExceededError);
      expect((error as JsonNestingDepthExceededError).code).toBe("json_nesting_depth_exceeded");
      expect((error as JsonNestingDepthExceededError).maxDepth).toBe(256);
    }
  });

  test("ignores brackets and braces inside string literals and honors escape sequences", () => {
    const stringBrackets = JSON.stringify({
      payload: "[".repeat(1_000) + "{".repeat(1_000) + "}".repeat(1_000),
      escapedQuote: 'foo \\" [[[[ \\" bar',
    });
    expect(() => assertJsonNestingDepth(enc.encode(stringBrackets))).not.toThrow();

    // Even backslash counts (`\\\\"`) close the string so trailing structural brackets count toward depth.
    const raw = `{"a":"\\\\"${",[".repeat(256).replace(/^,/, "")}${"]".repeat(256)}`;
    expect(() => assertJsonNestingDepth(enc.encode(raw), 257)).not.toThrow();
    expect(() => assertJsonNestingDepth(enc.encode(raw), 256)).toThrow(JsonNestingDepthExceededError);
  });

  test("rejects unbalanced deep prefixes immediately without waiting for closing tokens", () => {
    const unclosedDeep = new Uint8Array(10_000).fill(0x5b); // '['
    expect(() => assertJsonNestingDepth(unclosedDeep, 256)).toThrow(JsonNestingDepthExceededError);
    expect(() => assertJsonNestingDepth(new Uint8Array(0), 256)).not.toThrow();
  });
});
