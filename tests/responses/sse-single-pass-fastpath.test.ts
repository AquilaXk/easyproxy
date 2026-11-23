import { describe, expect, spyOn, test } from "bun:test";
import { consumeForInspection, createSseTerminalOutputBoundary, relaySseWithFailedTail } from "../../src/server/relay";
import { relaySseEagerBounded, type EagerRelayHooks } from "../../src/server/relay-eager";
import { teeWithBoundedInspection } from "../../src/server/inspection-tee";
import { mayRequireTerminalBoundaryInspection } from "../../src/server/sse-frame-buffer";
import {
  composeSseBlockRewrites,
  payloadRewriteAsBlockRewrite,
  relaySseWithBlockRewrite,
} from "../../src/server/sse-payload-rewrite";
import { createResponsesFieldBackfillBlockRewrite } from "../../src/server/responses/responses-field-backfill";
import { createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { deliverPassthroughResponse, setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import { createResponsesEffects } from "../../src/server/responses/response-effects";
import { routedProviderConfig } from "../../src/router";
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

  test("streamMode auto tee() path fires onResponseComplete on response.completed for bare and fused relays when upstream stays open, and suppresses it on cancel", async () => {
    for (const withBlockRewrite of [false, true]) {
      const upstreamAc = new AbortController();
      const clientGone = new AbortController();
      let completionCancelled = false;
      const completedModels: string[] = [];

      const sse = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: { id: "resp-tee-open", status: "completed", model: "gpt-5.4", output: [] },
            })}\n\n`,
          ));
          // Upstream intentionally keeps the HTTP stream open after response.completed.
        },
      });
      const budget = createTestTranslatorBudget();
      const [nativeBody, inspectBody] = teeWithBoundedInspection(sse, { clientGoneSignal: clientGone.signal });
      const inspectDone = new Promise<void>(resolve => {
        consumeForInspection(
          inspectBody,
          () => {},
          undefined,
          resolve,
          undefined,
          () => { completionCancelled = true; },
          response => {
            if (!completionCancelled && response.status === "completed") {
              completedModels.push("gpt-5.4");
            }
          },
          undefined,
          { clientGoneSignal: clientGone.signal, drainBounds: { ms: 5_000, bytes: 1024 * 1024 }, upstream: upstreamAc },
        );
      });
      const rewrittenBody = withBlockRewrite
        ? relaySseWithBlockRewrite(nativeBody, createResponsesFieldBackfillBlockRewrite(), budget)
        : nativeBody;
      const clientBody = relaySseWithFailedTail(
        rewrittenBody,
        upstreamAc,
        (reason, terminalReceived) => {
          if (!terminalReceived) completionCancelled = true;
          clientGone.abort(reason);
        },
      );

      const text = await new Response(clientBody).text();
      await inspectDone;
      expect(text).toContain("data: [DONE]");
      expect(upstreamAc.signal.aborted).toBe(true);
      expect(completionCancelled).toBe(false);
      expect(completedModels).toEqual(["gpt-5.4"]);
      budget.dispose();
    }

    // Cancelling the client stream before any terminal still sets cancelled and suppresses completion.
    const cancelUpstreamAc = new AbortController();
    const cancelClientGone = new AbortController();
    let cancelStreamCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let cancelSuppressed = false;
    const cancelCompleted: string[] = [];
    const stalledSse = new ReadableStream<Uint8Array>({
      start(controller) {
        cancelStreamCtrl = controller;
        controller.enqueue(encoder.encode(deltaBlock(1)));
      },
    });
    const [cancelNativeBody, cancelInspectBody] = teeWithBoundedInspection(stalledSse, {
      clientGoneSignal: cancelClientGone.signal,
    });
    const cancelInspectDone = new Promise<void>(resolve => {
      consumeForInspection(
        cancelInspectBody,
        () => {},
        undefined,
        resolve,
        undefined,
        () => { cancelSuppressed = true; },
        () => {
          if (!cancelSuppressed) cancelCompleted.push("gpt-5.4");
        },
        undefined,
        { clientGoneSignal: cancelClientGone.signal, drainBounds: { ms: 5_000, bytes: 1024 * 1024 }, upstream: cancelUpstreamAc },
      );
    });
    const cancelClientBody = relaySseWithFailedTail(
      cancelNativeBody,
      cancelUpstreamAc,
      (reason, terminalReceived) => {
        if (!terminalReceived) cancelSuppressed = true;
        cancelClientGone.abort(reason);
      },
    );
    const reader = cancelClientBody.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    await reader.cancel("client disconnect");
    cancelStreamCtrl.enqueue(encoder.encode(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp-after-cancel", status: "completed", model: "gpt-5.4", output: [] },
      })}\n\n`,
    ));
    await cancelInspectDone;
    expect(cancelSuppressed).toBe(true);
    expect(cancelCompleted).toEqual([]);
  });

  test("deliverPassthroughResponse on streamMode auto fires onResponseComplete on response.completed with open upstream and suppresses it on cancel", async () => {
    setRelayPlatformForTests("darwin");
    try {
      const makeSetup = (openUpstream: ReadableStream<Uint8Array>) => {
        const provider = routedProviderConfig("test-sse", {
          adapter: "openai-responses",
          baseUrl: "https://test-sse.example/v1",
          authMode: "key",
          apiKey: "test-key",
        });
        const config = {
          providers: { "test-sse": provider },
          streamMode: "auto" as const,
          maxUpstreamBodyBytes: 8 * 1024 * 1024,
        };
        const completedModels: string[] = [];
        const req = new Request("http://localhost/v1/responses", { method: "POST" });
        const requestContext = {
          logCtx: { model: "gpt-5.4", provider: "test-sse" },
          config,
          options: {
            onResponseComplete: (model: string) => { completedModels.push(model); },
          },
          req,
        };
        const admissionState = { pendingHostAdmissionLease: null, authCtx: { kind: "main" as const, accountId: null } };
        const translatorBudget = createTestTranslatorBudget();
        const requestState = {
          parsed: {
            modelId: "gpt-5.4",
            stream: true,
            options: {},
            context: { messages: [] },
          } as never,
          route: {
            providerName: "test-sse",
            provider,
            modelId: "gpt-5.4",
            staticPolicy: { model: {} },
          } as never,
          poolAffinityKey: undefined,
          substituteMainCredential: false,
          subagentQuotaFailureModel: undefined,
          subagentFallbackAccountId: undefined,
          clientRequestedStream: true,
          translatorBudget,
          inboundWire: undefined,
        };
        const responseEffects = createResponsesEffects(
          requestContext,
          admissionState,
          requestState,
          { routedCompaction: false },
        );
        const upstream = new AbortController();
        const upstreamRequest = {
          url: "https://test-sse.example/v1/responses",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.4", stream: true, input: [] }),
        };
        const requestBindings = new WeakMap<object, unknown>();
        requestBindings.set(upstreamRequest, { kind: "api-key", provider });
        return {
          completedModels,
          translatorBudget,
          upstream,
          responseEffects,
          run: () => deliverPassthroughResponse(
            requestContext,
            admissionState,
            requestState,
            { requestBindings } as never,
            { openAiSidecar: undefined },
            responseEffects,
            {
              upstreamResponse: new Response(openUpstream, {
                headers: { "content-type": "text/event-stream" },
              }),
              codexSafetyBufferingOptions: undefined,
              upstream,
              request: upstreamRequest,
              connectMs: 1,
              imageGenCallAliases: new Map(),
              selfNamedNamespaceScrubAuthorization: undefined,
              authorizedBareNamespaceToolAliases: new Map(),
              rememberPassthroughResponseChecked: response => {
                responseEffects.notifyResponseComplete(response);
              },
              routedCustomToolNames: new Set<string>(),
              routedCustomToolRepairNames: new Set<string>(),
              declaredWireToolNames: new Set<string>(),
              routedToolSearchNames: new Set<string>(),
              outboundRequestBody: undefined,
              functionRepairSchemas: new Map(),
              undeclaredToolGuardActive: false,
              declaredNamelessClientCallTypes: new Set<string>(),
              providerExecutedCallTypes: new Set<string>(),
              declaredBareWireToolNames: new Set<string>(),
              rememberPassthroughResponse: () => {},
              noteInspectedPayload: () => {},
              normalizeFunctionCompletionJson: (text: string) => text,
            } as never,
          ),
        };
      };

      const openSse = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: { id: "resp-deliver-open", status: "completed", model: "gpt-5.4", output: [] },
            })}\n\n`,
          ));
        },
      });
      const successSetup = makeSetup(openSse);
      const response = await successSetup.run();
      const body = await response.text();
      for (let i = 0; i < 50 && successSetup.completedModels.length === 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(body).toContain("data: [DONE]");
      expect(successSetup.upstream.signal.aborted).toBe(true);
      expect(successSetup.responseEffects.responseCompletionCancelled).toBe(false);
      expect(successSetup.completedModels).toEqual(["gpt-5.4"]);
      successSetup.translatorBudget.dispose();

      let cancelCtrl!: ReadableStreamDefaultController<Uint8Array>;
      const cancellableSse = new ReadableStream<Uint8Array>({
        start(controller) {
          cancelCtrl = controller;
          controller.enqueue(encoder.encode(deltaBlock(1)));
        },
      });
      const cancelSetup = makeSetup(cancellableSse);
      const cancelResponse = await cancelSetup.run();
      const reader = cancelResponse.body!.getReader();
      await reader.read();
      await reader.cancel("client cancelled");
      cancelCtrl.enqueue(encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { id: "resp-deliver-cancelled", status: "completed", model: "gpt-5.4", output: [] },
        })}\n\n`,
      ));
      for (let i = 0; i < 20; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(cancelSetup.responseEffects.responseCompletionCancelled).toBe(true);
      expect(cancelSetup.completedModels).toEqual([]);
      cancelSetup.translatorBudget.dispose();
    } finally {
      setRelayPlatformForTests(undefined);
    }
  });
});
