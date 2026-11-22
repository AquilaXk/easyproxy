import { describe, expect, spyOn, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import {
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  TRANSLATOR_MAX_TURN_BYTES,
} from "../../src/lib/translator-budget";
import { createAdapterTierMetadata } from "../../src/providers/fastwire";
import {
  streamNativeFromChat,
  type NativeStreamTranslator,
} from "../../src/server/native-chat-bridge";
import type { NativeFinalLog, NativeFinalOutcome } from "../../src/server/native-final-log";
import type { EpxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const anthropicProvider = {
  adapter: "anthropic",
  baseUrl: "https://example.test/v1",
  apiKey: "k",
  authMode: "key",
} as EpxProviderConfig;

const openAIChatProvider = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "k",
  authMode: "key",
} as EpxProviderConfig;

function createTrackingTierMetadata() {
  const tier = createAdapterTierMetadata(
    {
      capability: true,
      eligibility: "eligible",
      demandDecision: "force-fast",
      callerTier: "priority",
      fastWire: {
        kind: "service-tier",
        canonicalToWire: { priority: "priority" },
        foreignCallerTiers: "verbatim",
      },
    },
    { kind: "set", value: "priority" },
    "service-tier",
    "priority",
  )!;
  const markSpy = spyOn(tier, "markResponseUnparseable");
  return { tier, markSpy };
}

function createIncrementalByteStream(
  totalChunks: number,
  chunkBytes: number,
  fillByte = 0x20,
): {
  stream: ReadableStream<Uint8Array>;
  chunksEmitted: () => number;
  cancelled: () => boolean;
} {
  const reusableChunk = new Uint8Array(chunkBytes).fill(fillByte);
  let emitted = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalChunks) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(reusableChunk);
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return {
    stream,
    chunksEmitted: () => emitted,
    cancelled: () => wasCancelled,
  };
}

describe("createAnthropicAdapter.parseResponse bounds", () => {
  const adapter = createAnthropicAdapter(anthropicProvider);

  test("rejects Content-Length > 32 MiB before reading body and marks tier unparseable", async () => {
    const source = createIncrementalByteStream(40, 1024 * 1024);
    const response = new Response(source.stream, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(TRANSLATOR_MAX_TURN_BYTES + 1),
      },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    expect((events[0] as Extract<typeof events[number], { type: "error" }>).message).toContain(
      String(TRANSLATOR_MAX_TURN_BYTES),
    );
    expect(source.chunksEmitted()).toBe(0);
    expect(source.cancelled()).toBe(true);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects unframed chunked stream exceeding 32 MiB and marks tier unparseable", async () => {
    const source = createIncrementalByteStream(40, 1024 * 1024);
    const response = new Response(source.stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(response.headers.get("content-length")).toBeNull();

    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    expect((events[0] as Extract<typeof events[number], { type: "error" }>).message).toContain(
      String(TRANSLATOR_MAX_TURN_BYTES),
    );
    // 32 chunks fit within 32 MiB; chunk 33 triggers the byte cap (with at most 1 stream read-ahead chunk).
    expect(source.chunksEmitted()).toBeGreaterThanOrEqual(33);
    expect(source.chunksEmitted()).toBeLessThanOrEqual(34);
    expect(source.cancelled()).toBe(true);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects > 256-depth JSON and marks tier unparseable", async () => {
    const deepJson = `${'{"a":'.repeat(257)}{}${"}".repeat(257)}`;
    const response = new Response(deepJson, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    expect((events[0] as Extract<typeof events[number], { type: "error" }>).message).toContain("256");
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects invalid JSON and marks tier unparseable", async () => {
    const response = new Response("{not valid json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);

    expect(events).toEqual([{
      type: "error",
      message: "anthropic response was not valid JSON",
      status: 502,
      errorType: "upstream_error",
    }]);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });
});

describe("createOpenAIChatAdapter.parseResponse bounds", () => {
  const adapter = createOpenAIChatAdapter(openAIChatProvider);

  test("rejects Content-Length > 32 MiB before reading body and marks tier unparseable", async () => {
    const source = createIncrementalByteStream(40, 1024 * 1024);
    const response = new Response(source.stream, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(TRANSLATOR_MAX_TURN_BYTES + 1),
      },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    expect((events[0] as Extract<typeof events[number], { type: "error" }>).message).toContain(
      String(TRANSLATOR_MAX_TURN_BYTES),
    );
    expect(source.chunksEmitted()).toBe(0);
    expect(source.cancelled()).toBe(true);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects unframed chunked stream exceeding 32 MiB and marks tier unparseable", async () => {
    const source = createIncrementalByteStream(40, 1024 * 1024);
    const response = new Response(source.stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(response.headers.get("content-length")).toBeNull();

    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    expect((events[0] as Extract<typeof events[number], { type: "error" }>).message).toContain(
      String(TRANSLATOR_MAX_TURN_BYTES),
    );
    expect(source.chunksEmitted()).toBeGreaterThanOrEqual(33);
    expect(source.chunksEmitted()).toBeLessThanOrEqual(34);
    expect(source.cancelled()).toBe(true);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects > 256-depth JSON and marks tier unparseable", async () => {
    const deepJson = `${'{"a":'.repeat(257)}{}${"}".repeat(257)}`;
    const response = new Response(deepJson, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    expect((events[0] as Extract<typeof events[number], { type: "error" }>).message).toContain("256");
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects invalid JSON and marks tier unparseable", async () => {
    const response = new Response("{not valid json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);

    expect(events).toEqual([{
      type: "error",
      message: "upstream response was not valid JSON",
      status: 502,
      errorType: "upstream_error",
    }]);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });

  test("rejects non-record JSON (null) and marks tier unparseable", async () => {
    const response = new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { tier, markSpy } = createTrackingTierMetadata();
    const events = await adapter.parseResponse!(response, createTestTranslatorBudget(), tier);

    expect(events).toEqual([{
      type: "error",
      message: "upstream response was not a JSON object",
      status: 502,
      errorType: "upstream_error",
    }]);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(tier.outcome.fastOutcome).toBe("unknown");
    expect(tier.outcome.confirmation).toBe("unknown");
  });
});

describe("streamNativeFromChat SSE frame byte bounds", () => {
  test("aborts cleanly and emits translator failure frames when upstream emits > 32 MiB without newline", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const source = createIncrementalByteStream(40, 1024 * 1024, 0x61); // 'a' without '\n'

    const commits: NativeFinalOutcome[] = [];
    const finalLog: NativeFinalLog = {
      innerSettled: () => true,
      waitForInner: async () => true,
      commit(outcome) {
        commits.push(outcome);
        return true;
      },
    };

    const failureMessages: string[] = [];
    let chunkCalls = 0;
    let terminalCalls = 0;
    let disposeCalls = 0;
    const translator: NativeStreamTranslator = {
      contentType: "application/x-ndjson",
      chunk() {
        chunkCalls += 1;
        return [];
      },
      terminal() {
        terminalCalls += 1;
        return { ok: true, frames: () => [] };
      },
      failure(message) {
        failureMessages.push(message);
        return [encoder.encode(`${JSON.stringify({ error: message })}\n`)];
      },
      dispose() {
        disposeCalls += 1;
      },
    };

    const controller = new AbortController();
    const response = streamNativeFromChat(translator, source.stream, finalLog, controller.signal);
    const bodyText = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("streamNativeFromChat did not terminate")), 5_000),
      ),
    ]);

    expect(response.status).toBe(200);
    expect(TRANSLATOR_MAX_SSE_EVENT_BYTES).toBe(32 * 1024 * 1024);
    // 32 * 1 MiB fits; chunk 33 pushes pending over 32 MiB and aborts without waiting for chunk 35..40.
    expect(source.chunksEmitted()).toBeGreaterThanOrEqual(33);
    expect(source.chunksEmitted()).toBeLessThanOrEqual(34);
    expect(source.cancelled()).toBe(true);
    expect(chunkCalls).toBe(0);
    expect(terminalCalls).toBe(0);
    expect(disposeCalls).toBe(1);
    expect(failureMessages).toEqual(["upstream stream failed"]);
    expect(decoder.decode(encoder.encode(bodyText))).toBe(
      `${JSON.stringify({ error: "upstream stream failed" })}\n`,
    );
    expect(commits).toEqual([{ status: 502, terminalStatus: "failed", closeReason: "terminal" }]);
  });
});
