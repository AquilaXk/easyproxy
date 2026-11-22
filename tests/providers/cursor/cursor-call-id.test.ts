import { beforeEach, describe, expect, test } from "bun:test";
import {
  decodeCursorCallId,
  encodeCursorCallId,
  resetCursorCallIdProvenanceForTests,
} from "../../../src/adapters/cursor/call-id";
import { mapCursorServerMessage } from "../../../src/adapters/cursor/message-mapper";
import type { CursorMessageMapperState } from "../../../src/adapters/cursor/message-mapper";
import type { CursorKvStore } from "../../../src/adapters/cursor/kv-store";

const COMPOSITE = "call-9aee6d07-edc0-442f-8466-9d3924e16e03-0\nfc_5a1a53c6-32ce-9602-bc56-459030165589_0";

function mapperState(): CursorMessageMapperState {
  const kv: CursorKvStore = { get: () => undefined, set: () => {} };
  return { kv, writeClient: () => {} };
}

beforeEach(() => {
  resetCursorCallIdProvenanceForTests();
});

describe("cursor call-id codec", () => {
  test("local side effects map to replay-unsafe invisible heartbeats", () => {
    expect(mapCursorServerMessage({ type: "local_side_effect" }, mapperState())).toEqual([
      { type: "heartbeat", replayUnsafe: true },
    ]);
  });

  test("plain ids pass through unchanged", () => {
    expect(encodeCursorCallId("call_abc123")).toBe("call_abc123");
    expect(decodeCursorCallId("call_abc123")).toBe("call_abc123");
  });

  test("reserved-prefix ids are escaped and round-trip", () => {
    for (const id of ["epxc1_", "epxc1_Y2FsbF8x", "epxc1_!!not-base64url!!", "epxc1_raw\nwire"]) {
      const encoded = encodeCursorCallId(id);
      expect(encoded).not.toBe(id);
      // Newline-bearing ids take the encoding namespace; newline-free reserved ids take the
      // escape namespace. Both are single-line and both reverse exactly.
      expect(encoded.startsWith(id.includes("\n") ? "epxc1_" : "epxc1e_")).toBe(true);
      expect(encoded).not.toContain("\n");
      expect(encoded).not.toContain("\r");
      expect(decodeCursorCallId(encoded)).toBe(id);
    }
  });

  test("opaque ids whose payloads look like reserved namespaces are preserved without provenance", () => {
    for (const id of ["epxc1_ZXB4YzFf", "epxc1e_ZXB4YzFf", "epxc1e_ZXB4YzFlXw"]) {
      expect(decodeCursorCallId(id)).toBe(id);
    }
    // And it still survives a full round trip, via the escape namespace.
    const encoded = encodeCursorCallId("epxc1_ZXB4YzFf");
    expect(encoded.startsWith("epxc1e_")).toBe(true);
    expect(decodeCursorCallId(encoded)).toBe("epxc1_ZXB4YzFf");
  });

  test("ids already in the escape namespace are themselves escaped", () => {
    const id = "epxc1e_YQpi";
    const encoded = encodeCursorCallId(id);
    expect(encoded).not.toBe(id);
    expect(decodeCursorCallId(encoded)).toBe(id);
    // Untouched when it is not our output: the payload decodes to newline-free non-reserved text.
    expect(decodeCursorCallId("epxc1e_Y2FsbF8x")).toBe("epxc1e_Y2FsbF8x");
  });

  test("reserved-prefix ids resembling legacy newline encodings stay opaque", () => {
    const id = "epxc1_YQpi";
    const encoded = encodeCursorCallId(id);
    expect(encoded).not.toBe(id);
    expect(decodeCursorCallId(encoded)).toBe(id);
    expect(decodeCursorCallId("epxc1_Y2FsbF8x")).toBe("epxc1_Y2FsbF8x");
  });

  test("adversarial reserved-prefix ids escape one layer at a time", () => {
    const cases = [
      "epxc1_Y2FsbF8x",
      "epxc1_Y2FsbF8xCg",
      "epxc1e_ZXB4YzFfWTJGc2JGOHhDZw",
    ] as const;

    for (const id of cases) {
      const encoded = encodeCursorCallId(id);
      expect(encoded.startsWith("epxc1e_")).toBe(true);
      expect(decodeCursorCallId(encoded)).toBe(id);
    }
  });

  test("unsigned pre-restart encodings stay opaque", () => {
    for (const id of ["epxc1_YQpi", "epxc1_DQ", "epxc1_DQo", "epxc1_Y2FsbF8xCg"]) {
      expect(decodeCursorCallId(id)).toBe(id);
    }
  });

  test("a process restart invalidates provenance instead of guessing from the payload", () => {
    const encoded = encodeCursorCallId("epxc1e_");
    expect(decodeCursorCallId(encoded)).toBe("epxc1e_");

    resetCursorCallIdProvenanceForTests();
    expect(decodeCursorCallId(encoded)).toBe(encoded);
  });

  test("newline composite id round-trips through a single-line form", () => {
    const encoded = encodeCursorCallId(COMPOSITE);
    expect(encoded).not.toContain("\n");
    expect(encoded).not.toContain("\r");
    expect(encoded.startsWith("epxc1_")).toBe(true);
    expect(decodeCursorCallId(encoded)).toBe(COMPOSITE);
  });

  test("legacy raw newline id decodes to itself (backward compat)", () => {
    expect(decodeCursorCallId(COMPOSITE)).toBe(COMPOSITE);
  });

  test("malformed encoded payloads are not corrupted", () => {
    expect(decodeCursorCallId("epxc1_")).toBe("epxc1_");
    expect(decodeCursorCallId("epxc1_!!not-base64url!!")).toBe("epxc1_!!not-base64url!!");
  });

  test("tool_call_start ids are reversible and single-line at the adapter boundary", () => {
    for (const id of [COMPOSITE, "epxc1_YQpi"]) {
      const events = mapCursorServerMessage(
        { type: "tool_call_start", id, name: "get_weather" },
        mapperState(),
      );
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event.type !== "tool_call_start") throw new Error("expected tool_call_start");
      expect(event.id).not.toContain("\n");
      expect(event.id).not.toContain("\r");
      expect(decodeCursorCallId(event.id)).toBe(id);
    }
  });
});
