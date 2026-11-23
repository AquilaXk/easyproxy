import { describe, expect, spyOn, test } from "bun:test";
import { createSseTerminalOutputBoundary, relaySseWithFailedTail } from "../../src/server/relay";
import { relaySseEagerBounded, type EagerRelayHooks } from "../../src/server/relay-eager";
import { mayRequireTerminalBoundaryInspection } from "../../src/server/sse-frame-buffer";
import {
  composeSseBlockRewrites,
  payloadRewriteAsBlockRewrite,
  relaySseWithBlockRewrite,
} from "../../src/server/sse-payload-rewrite";
import { createResponsesFieldBackfillBlockRewrite } from "../../src/server/responses/responses-field-backfill";
import { createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { rewriteResponsesIncompleteReasonJson } from "../../src/responses/incomplete-reason";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deltaBlock(index: number): string {
  return `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: index,
    delta: `tok-${index}`,
  })}\n\n`;
}

describe("single-pass SSE passthrough fast path", () => {
  test("skips JSON.parse on 200 delta + keepalive frames and returns a zero-copy prefix view", () => {
    const frames = Array.from({ length: 200 }, (_, index) =>
      index % 10 === 0 ? ": keepalive\n\n" : deltaBlock(index),
    ).join("");
    const deltaChunk = encoder.encode(frames);
    const completedChunk = encoder.encode(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp-single-pass", status: "completed", output: [] },
      })}\n\n`,
    );

    const boundary = createSseTerminalOutputBoundary();
    const originalParse = JSON.parse;
    let parseCalls = 0;
    const parseSpy = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      parseCalls += 1;
      return originalParse(text, reviver);
    });
    try {
      const outbound = boundary.feed(deltaChunk);
      expect(outbound.byteLength).toBe(deltaChunk.byteLength);
      expect(outbound.buffer).toBe(deltaChunk.buffer);
      expect(parseCalls).toBe(0);
      expect(boundary.terminalSeen()).toBe(false);

      const terminalOut = boundary.feed(completedChunk);
      expect(decoder.decode(terminalOut)).toContain('"response.completed"');
      expect(parseCalls).toBe(1);
      expect(boundary.terminalSeen()).toBe(true);
    } finally {
      parseSpy.mockRestore();
      boundary.dispose();
    }
  });

  test("adversarial multi-line data splits never bypass mayRequireTerminalBoundaryInspection or terminal inspection", () => {
    const splitCompleted = encoder.encode(
      'event: response.completed\ndata: {"type":\ndata: "response.completed","response":{"id":"resp-split","status":"completed","output":[]}}\n\n',
    );
    const splitDoneLike = encoder.encode("data: [DO\ndata: NE]\n\n");
    const prematureDoneWithComment = encoder.encode(": keepalive\ndata: [DONE]\n\n");
    const ordinaryDelta = encoder.encode(deltaBlock(1).slice(0, -2));

    expect(mayRequireTerminalBoundaryInspection(ordinaryDelta, false)).toBe(false);
    expect(mayRequireTerminalBoundaryInspection(splitCompleted.subarray(0, splitCompleted.byteLength - 2), false)).toBe(true);
    expect(mayRequireTerminalBoundaryInspection(splitDoneLike.subarray(0, splitDoneLike.byteLength - 2), false)).toBe(true);
    expect(mayRequireTerminalBoundaryInspection(prematureDoneWithComment.subarray(0, prematureDoneWithComment.byteLength - 2), false)).toBe(true);

    const boundary = createSseTerminalOutputBoundary();
    try {
      // Multi-line `data: [DO\ndata: NE]` joins with `\n` per SSE spec, so it is relayed as non-DONE text.
      const nonDoneOut = boundary.feed(splitDoneLike);
      expect(decoder.decode(nonDoneOut)).toBe("data: [DO\ndata: NE]\n\n");
      expect(boundary.doneSeen()).toBe(false);

      const heldDoneOut = boundary.feed(prematureDoneWithComment);
      expect(heldDoneOut.byteLength).toBe(0);
      expect(boundary.doneSeen()).toBe(true);
      expect(boundary.terminalSeen()).toBe(false);

      const terminalOut = boundary.feed(splitCompleted);
      const text = decoder.decode(terminalOut);
      expect(boundary.terminalSeen()).toBe(true);
      expect(text).toContain('data: {"type":\ndata: "response.completed"');
      expect(text).toContain("data: [DONE]\n\n");
      expect(text).not.toContain(": keepalive\ndata: [DONE]");
    } finally {
      boundary.dispose();
    }
  });

  test("fuses relaySseWithBlockRewrite and relaySseWithFailedTail with zero delta encodes while still backfilling annotations", async () => {
    const budget = createTestTranslatorBudget();
    const rewrite = composeSseBlockRewrites(
      payloadRewriteAsBlockRewrite(rewriteResponsesIncompleteReasonJson),
      createResponsesFieldBackfillBlockRewrite(),
      createTerminalErrorRedactionBlockRewrite({}, value => value),
    );
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const rewritten = relaySseWithBlockRewrite(upstream, rewrite, budget);
    const client = relaySseWithFailedTail(rewritten, new AbortController());
    expect(rewritten.locked).toBe(false);

    const deltasText = Array.from({ length: 50 }, (_, index) => deltaBlock(index)).join("");
    const deltasChunk = encoder.encode(deltasText);
    const completedChunk = encoder.encode(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-fused-backfill",
          status: "completed",
          output: [{
            type: "message",
            id: "msg-fused",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok" }],
          }],
        },
      })}\n\n`,
    );

    const reader = client.getReader();
    const originalEncode = TextEncoder.prototype.encode;
    let encodeCalls = 0;
    const encodeSpy = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, input) {
      encodeCalls += 1;
      return originalEncode.call(this, input);
    });
    try {
      controller.enqueue(deltasChunk);
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      expect(decoder.decode(firstRead.value)).toBe(deltasText);
      expect(encodeCalls).toBe(0);

      controller.enqueue(completedChunk);
      controller.close();

      let tailText = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        tailText += decoder.decode(next.value, { stream: true });
      }
      tailText += decoder.decode();
      const completedData = tailText
        .split("\n")
        .find(line => line.startsWith("data: {"))!
        .slice("data: ".length);
      const parsed = JSON.parse(completedData) as {
        response: { output: Array<{ content: Array<{ annotations?: unknown }> }> };
      };
      expect(parsed.response.output[0]!.content[0]!.annotations).toEqual([]);
      expect(tailText).toContain("data: [DONE]\n\n");
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      encodeSpy.mockRestore();
      await reader.cancel().catch(() => {});
      budget.dispose();
    }
  });

  test("relaySseEagerBounded executes post-boundary rewrite in one pass with 0 delta encodes", async () => {
    const budget = createTestTranslatorBudget();
    const rewrite = composeSseBlockRewrites(
      createResponsesFieldBackfillBlockRewrite(),
      block => {
        if (block.includes('"response.created"')) {
          return [block, 'event: proxy.injected\ndata: {"injected":true}'];
        }
        return [block];
      },
    );
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }, { highWaterMark: 0 });
    const hooks: EagerRelayHooks = {
      inspectChunk() {},
      finishInspection() {},
      sawTerminal: () => false,
      onSynthetic() {},
      onClientCancel() {},
      onDone() {},
      rewriteBlocks: rewrite,
    };

    const deltasText = Array.from({ length: 50 }, (_, index) => deltaBlock(index)).join("");
    const deltasChunk = encoder.encode(deltasText);
    const createdChunk = encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}\n\n');
    const completedChunk = encoder.encode(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "r1",
          status: "completed",
          output: [{
            type: "message",
            id: "m1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok" }],
          }],
        },
      })}\n\n`,
    );

    const relayed = relaySseEagerBounded(upstream, new AbortController(), hooks, { rewriteBudget: budget });
    const reader = relayed.getReader();
    const originalEncode = TextEncoder.prototype.encode;
    let encodeCalls = 0;
    const encodeSpy = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, input) {
      encodeCalls += 1;
      return originalEncode.call(this, input);
    });
    try {
      controller.enqueue(deltasChunk);
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      expect(decoder.decode(firstRead.value)).toBe(deltasText);
      expect(encodeCalls).toBe(0);

      controller.enqueue(createdChunk);
      controller.enqueue(completedChunk);
      controller.close();

      let restText = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        restText += decoder.decode(next.value, { stream: true });
      }
      restText += decoder.decode();
      expect(restText).toContain("event: proxy.injected");
      const completedData = restText
        .split("\n")
        .find(line => line.startsWith("data: ") && line.includes('"response.completed"'))!
        .slice("data: ".length);
      const parsed = JSON.parse(completedData) as {
        response: { output: Array<{ content: Array<{ annotations?: unknown }> }> };
      };
      expect(parsed.response.output[0]!.content[0]!.annotations).toEqual([]);
      expect(restText).toContain("data: [DONE]\n\n");
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      encodeSpy.mockRestore();
      await reader.cancel().catch(() => {});
      budget.dispose();
    }
  });
});
