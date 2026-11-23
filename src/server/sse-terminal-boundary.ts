import { Buffer } from "node:buffer";
import type { ResponsesTerminalStatus } from "../bridge";
import {
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  CYBER_POLICY_FALLBACK_MESSAGE,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  responsesCompletionError,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import type { TranslatorBudget } from "../lib/translator-budget";
import {
  bareUpstreamError,
  guardBareCopy,
  isUntypedBareUpstreamError,
  MAX_BARE_ERROR_MESSAGE_CHARS,
  reduceBareUpstreamEvidence,
  type BareUpstreamError,
  type BareUpstreamEvidence,
} from "./bare-upstream-error";
import {
  BoundedSseFrameBuffer,
  EMPTY_BYTES,
  joinSseFrameBytes,
  MAX_CLIENT_SSE_FRAME_BYTES,
  mayRequireTerminalBoundaryInspection,
  settledCrDelimiter,
  SseFrameCountLimitError,
} from "./sse-frame-buffer";
import {
  replaceSseDataPayload,
  splitSseBlock,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

export const MAX_INSPECTION_SSE_FRAME_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
export const MAX_TAIL_ERROR_MESSAGE_CHARS = MAX_BARE_ERROR_MESSAGE_CHARS;

const LIVE_TRANSIENT_SCOPE = { kind: "live_transient" as const };

export interface CodexSafetyBufferingFilterOptions {
  /**
   * Drop Codex safety-buffering hints: the `x-codex-safety-buffering-*` response
   * headers and the `safety_buffering` SSE metadata event / field. Absent and
   * `false` relay everything unchanged.
   */
  dropCodexSafetyBuffering?: boolean;
}

export type SseTerminalOutputBoundary = {
  feed(chunk: Uint8Array): Uint8Array;
  finish(): Uint8Array;
  terminalSeen(): boolean;
  doneSeen(): boolean;
  upstreamError(): string | undefined;
  upstreamRefusalCode(): string | undefined;
  upstreamErrorType(): string | undefined;
  upstreamErrorCode(): string | undefined;
  /** The winning bare verdict, already reduced; every synthetic tail is framed from it. */
  upstreamVerdict(): BareUpstreamError | undefined;
  /**
   * The winning bare verdict carries a provider status (recognized class, explicit refusal, or a
   * stated wrapper status), so a synthetic tail carries it instead of the read failure that
   * followed. A verdict without one keeps the transport failure.
   */
  recognizedBareError(): boolean;
  dispose(): void;
};

export class SseAggregateLimitError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upstream SSE transcript exceeded ${maxBytes} bytes`);
    this.name = "SseAggregateLimitError";
    this.maxBytes = maxBytes;
  }
}

export class SseBoundaryRewriteError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("SSE boundary rewrite failed");
    this.name = "SseBoundaryRewriteError";
    this.cause = cause;
  }
}

export type SseTerminalOutputBoundaryOptions = CodexSafetyBufferingFilterOptions & {
  /** Optional raw bytes admitted before the first terminal; omitted keeps streaming behavior. */
  maxInputBytes?: number;
  /** Optional client-facing bytes emitted through the first terminal. */
  maxOutputBytes?: number;
  /** Optional aggregate frame count through the first terminal. */
  maxFrames?: number;
  /** Per-request outbound mask, applied to upstream copy before the boundary bounds it. */
  maskCredential?: (text: string) => string;
  /**
   * Redaction for a typed bare `error` frame this boundary forwards, applied after the frame's
   * verdict is reduced from the original so every relay classifies the provider's own words.
   */
  redactForwardedEvidence?: (block: string) => string;
  /** Pre-boundary block rewrite fused from a lazy `relaySseWithBlockRewrite` shell. */
  preRewriteBlocks?: SseBlockRewrite;
  /** Budget owner for pre-boundary framing and replacement encoding. */
  preRewriteBudget?: TranslatorBudget;
  /** Post-boundary block rewrite executed inline on the eager single-reader path. */
  postRewriteBlocks?: SseBlockRewrite;
  /** Budget owner for post-boundary outbound rewrite admission. */
  rewriteBudget?: TranslatorBudget;
};

type BoundaryFrame = {
  block: Uint8Array;
  delimiter: Uint8Array;
  continuation?: true;
  decodedText?: string;
};

function admitTransientBytes(budget: TranslatorBudget, bytes: number): void {
  if (bytes <= 0) return;
  const reservation = budget.reserveTransient(bytes, LIVE_TRANSIENT_SCOPE);
  reservation.commitRetained();
  budget.releaseRetained(bytes, LIVE_TRANSIENT_SCOPE);
}

/**
 * Frame-aware client output boundary shared by both native Responses relays.
 * It buffers only the current incomplete SSE block under the same hard byte
 * cap as inspection, forwards complete blocks through the first Responses
 * terminal, and drops every later block/byte. A premature [DONE] is held until
 * a terminal arrives so clean EOF can synthesize one terminal and one sentinel.
 */
export function createSseTerminalOutputBoundary(
  options?: SseTerminalOutputBoundaryOptions,
): SseTerminalOutputBoundary {
  const dropSafetyBuffering = options?.dropCodexSafetyBuffering === true;
  const maxInputBytes = options?.maxInputBytes;
  const maxOutputBytes = options?.maxOutputBytes;
  const maxFrames = options?.maxFrames;
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0)) {
    throw new RangeError("maxInputBytes must be a positive safe integer");
  }
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }
  if (maxFrames !== undefined && (!Number.isSafeInteger(maxFrames) || maxFrames <= 0)) {
    throw new RangeError("maxFrames must be a positive safe integer");
  }
  const preRewriteBlocks = options?.preRewriteBlocks;
  const preRewriteBudget = options?.preRewriteBudget;
  const postRewriteBlocks = options?.postRewriteBlocks;
  const rewriteBudget = options?.rewriteBudget;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new BoundedSseFrameBuffer(
    MAX_INSPECTION_SSE_FRAME_BYTES,
    preRewriteBlocks ? preRewriteBudget : undefined,
  );
  let terminal = false;
  let done = false;
  let pendingDone: { block: Uint8Array; delimiter: Uint8Array; decodedText: string } | null = null;
  // One sentinel per turn: a [DONE] repeated after the terminal is dropped.
  let doneEmitted = false;
  let disposed = false;
  let preRewriteDisposed = false;
  let postRewriteDisposed = false;
  let prePendingLineFeedVisible = false;
  let stageBPendingLineFeedVisible = false;
  let postPendingLineFeedVisible = false;
  let upstreamError: string | undefined;
  let upstreamRefusalCode: string | undefined;
  let upstreamErrorType: string | undefined;
  let upstreamErrorCode: string | undefined;
  let bareEvidence: BareUpstreamEvidence | undefined;
  let inputBytes = 0;
  let outputBytes = 0;
  let framesSeen = 0;

  const disposePreRewrite = (): void => {
    if (preRewriteDisposed) return;
    preRewriteDisposed = true;
    try { preRewriteBlocks?.dispose?.(); } catch { /* teardown must not throw */ }
  };

  const disposePostRewrite = (): void => {
    if (postRewriteDisposed) return;
    postRewriteDisposed = true;
    try { postRewriteBlocks?.dispose?.(); } catch { /* teardown must not throw */ }
  };

  const runStageA = (
    rawFrames: readonly BoundaryFrame[],
  ): { frames: readonly BoundaryFrame[]; canUseChunkPrefix: boolean } => {
    if (!preRewriteBlocks) {
      return { frames: rawFrames, canUseChunkPrefix: true };
    }
    const out: BoundaryFrame[] = [];
    let canUseChunkPrefix = true;
    try {
      for (const frame of rawFrames) {
        if (frame.continuation) {
          if (prePendingLineFeedVisible) {
            out.push({ block: EMPTY_BYTES, delimiter: frame.delimiter, continuation: true, decodedText: "" });
          } else {
            canUseChunkPrefix = false;
          }
          continue;
        }
        const rawBlockText = decoder.decode(frame.block);
        const outBlocks = preRewriteBlocks(rawBlockText);
        prePendingLineFeedVisible = outBlocks.length > 0;
        if (outBlocks.length === 1 && outBlocks[0] === rawBlockText) {
          out.push({ block: frame.block, delimiter: frame.delimiter, decodedText: rawBlockText });
          continue;
        }
        canUseChunkPrefix = false;
        for (let i = 0; i < outBlocks.length; i += 1) {
          const outText = outBlocks[i]!;
          const delimiter = i < outBlocks.length - 1
            ? settledCrDelimiter(frame.delimiter)
            : frame.delimiter;
          if (outText === rawBlockText) {
            if (preRewriteBudget) {
              admitTransientBytes(preRewriteBudget, frame.block.byteLength + delimiter.byteLength);
            }
            out.push({ block: frame.block, delimiter, decodedText: rawBlockText });
            continue;
          }
          const byteLength = Buffer.byteLength(outText, "utf8");
          if (preRewriteBudget) {
            admitTransientBytes(preRewriteBudget, byteLength + delimiter.byteLength);
          }
          out.push({ block: encoder.encode(outText), delimiter, decodedText: outText });
        }
      }
    } catch (err) {
      disposePreRewrite();
      framer.dispose();
      throw err;
    }
    return { frames: out, canUseChunkPrefix };
  };

  const processStageBAndC = (
    frames: readonly BoundaryFrame[],
    prefixEnd: number | null,
    sourceChunk: Uint8Array | undefined,
    initialCanUseChunkPrefix: boolean,
  ): Uint8Array => {
    if (disposed || terminal || frames.length === 0) return EMPTY_BYTES;
    const completedFrames = frames.reduce((count, frame) => count + (frame.continuation ? 0 : 1), 0);
    if (maxFrames !== undefined && completedFrames > maxFrames - framesSeen) {
      throw new SseFrameCountLimitError(maxFrames);
    }
    framesSeen += completedFrames;
    const output: Uint8Array[] = [];
    let emittedByteSum = 0;
    let canUseChunkPrefix = initialCanUseChunkPrefix;
    const appendOutput = (...parts: Uint8Array[]): void => {
      for (const part of parts) {
        if (maxOutputBytes !== undefined && part.byteLength > maxOutputBytes - outputBytes) {
          throw new SseAggregateLimitError(maxOutputBytes);
        }
        outputBytes += part.byteLength;
        emittedByteSum += part.byteLength;
        output.push(part);
      }
    };
    const emitOutbound = (
      outboundBlock: Uint8Array,
      frameDelimiter: Uint8Array,
      knownText?: string,
      continuation?: true,
    ): void => {
      if (!postRewriteBlocks) {
        appendOutput(outboundBlock, frameDelimiter);
        return;
      }
      try {
        if (continuation) {
          if (postPendingLineFeedVisible) appendOutput(frameDelimiter);
          else canUseChunkPrefix = false;
          return;
        }
        if (rewriteBudget) {
          admitTransientBytes(rewriteBudget, outboundBlock.byteLength + frameDelimiter.byteLength);
        }
        const blockText = knownText ?? decoder.decode(outboundBlock);
        const rewritten = postRewriteBlocks(blockText);
        postPendingLineFeedVisible = rewritten.length > 0;
        if (rewritten.length === 1 && rewritten[0] === blockText) {
          appendOutput(outboundBlock, frameDelimiter);
          return;
        }
        canUseChunkPrefix = false;
        for (let i = 0; i < rewritten.length; i += 1) {
          const outText = rewritten[i]!;
          const delimiter = i < rewritten.length - 1
            ? settledCrDelimiter(frameDelimiter)
            : frameDelimiter;
          if (outText === blockText) {
            if (rewriteBudget) {
              admitTransientBytes(rewriteBudget, outboundBlock.byteLength + delimiter.byteLength);
            }
            appendOutput(outboundBlock, delimiter);
            continue;
          }
          const byteLength = Buffer.byteLength(outText, "utf8");
          if (rewriteBudget) {
            admitTransientBytes(rewriteBudget, byteLength + delimiter.byteLength);
          }
          appendOutput(encoder.encode(outText), delimiter);
        }
      } catch (err) {
        throw new SseBoundaryRewriteError(err);
      }
    };

    let responsesTerminal = false;
    for (const frame of frames) {
      if (frame.continuation) {
        if (!responsesTerminal && stageBPendingLineFeedVisible) {
          emitOutbound(frame.block, frame.delimiter, frame.decodedText, true);
        } else {
          canUseChunkPrefix = false;
        }
        continue;
      }
      if (!mayRequireTerminalBoundaryInspection(frame.block, dropSafetyBuffering)) {
        if (!responsesTerminal) {
          stageBPendingLineFeedVisible = true;
          emitOutbound(frame.block, frame.delimiter, frame.decodedText);
        } else {
          canUseChunkPrefix = false;
        }
        continue;
      }
      const rawBlockText = frame.decodedText ?? decoder.decode(frame.block);
      const payload = sseDataPayload(rawBlockText);
      const isDone = payload === "[DONE]";
      const parsed = payload === null ? undefined : parseSsePayload(payload);
      // Observe on the client reader itself: a tee inspection branch may lag
      // behind EOF, so its log context cannot determine the outgoing terminal.
      const evidence = reduceBareUpstreamEvidence(bareEvidence, parsed, options?.maskCredential);
      if (evidence !== undefined && evidence !== bareEvidence) {
        bareEvidence = evidence;
        upstreamError = evidence.verdict.message;
        upstreamRefusalCode = evidence.verdict.refusalCode;
        upstreamErrorType = evidence.verdict.errorType;
        upstreamErrorCode = evidence.verdict.errorCode;
      }
      const safetyBuffering = dropSafetyBuffering && parsed !== undefined
        ? codexSafetyBufferingBlockAction(parsed) : "keep";
      if (safetyBuffering === "drop") {
        stageBPendingLineFeedVisible = false;
        canUseChunkPrefix = false;
        continue;
      }
      // An untyped policy envelope that loses to earlier typed evidence is not the turn's verdict.
      const typedBareSeen = bareEvidence?.typed === true;
      const policyError = parsed !== undefined && isPolicyRewriteType(parsed, typedBareSeen)
        ? cyberPolicyTerminalError(parsed)
        : undefined;
      const policyPayload = policyError ? policyFailurePayload(policyError, parsed, options?.maskCredential) : undefined;
      // An untyped envelope is evidence, not a Responses event: the client receives the terminal it
      // decides (as the WebSocket bridge already does), never the provider's raw diagnostic frame.
      // Its verdict was reduced above; an explicit policy envelope continues as the policy terminal.
      if (policyPayload === undefined && parsed !== undefined && isUntypedBareUpstreamError(parsed)) {
        stageBPendingLineFeedVisible = false;
        canUseChunkPrefix = false;
        continue;
      }
      let outboundBlock: Uint8Array;
      let outboundText: string;
      if (policyPayload !== undefined) {
        // An untyped envelope's block is upstream text throughout (comments, extension and event
        // lines), so its policy terminal is a fresh block; a typed terminal keeps its own lines.
        outboundText = parsed !== undefined && isUntypedBareUpstreamError(parsed)
          ? `event: response.failed\ndata: ${policyPayload}`
          // A typed source keeps its own lines, so they pass the same redaction as a forwarded frame.
          : (options?.redactForwardedEvidence ?? ((block: string) => block))(rewritePolicyTerminalBlock(rawBlockText, policyPayload));
        outboundBlock = encoder.encode(outboundText);
      } else if (options?.redactForwardedEvidence !== undefined && asJsonRecord(parsed)?.type === "error") {
        const redacted = options.redactForwardedEvidence(rawBlockText);
        if (redacted !== rawBlockText) {
          outboundText = redacted;
          outboundBlock = encoder.encode(redacted);
        } else {
          outboundText = rawBlockText;
          outboundBlock = frame.block;
        }
      } else {
        outboundText = rawBlockText;
        outboundBlock = frame.block;
      }
      if (safetyBuffering === "strip") {
        outboundText = stripCodexSafetyBufferingField(
          outboundText,
          policyPayload !== undefined ? parseSsePayload(policyPayload) : parsed,
        );
        outboundBlock = encoder.encode(outboundText);
      }
      if (isDone) {
        done = true;
        // The sentinel is protocol: a [DONE] block carrying extra upstream lines (comments, fields)
        // is emitted as the bare sentinel, so nothing provider-written rides along with it.
        if (!/^data:[ \t]*\[DONE\][ \t]*$/.test(outboundText.trim())) {
          outboundText = "data: [DONE]";
          outboundBlock = encoder.encode(outboundText);
        }
        canUseChunkPrefix = false;
        if (responsesTerminal) {
          if (!doneEmitted) {
            stageBPendingLineFeedVisible = true;
            emitOutbound(outboundBlock, frame.delimiter, outboundText);
          } else {
            stageBPendingLineFeedVisible = false;
          }
          doneEmitted = true;
        } else if (!pendingDone) {
          // Do not expose a sentinel before a Responses terminal. If EOF
          // follows, the synthetic incomplete path owns the one sentinel;
          // if a terminal arrives later, this pending frame is emitted then.
          stageBPendingLineFeedVisible = false;
          pendingDone = { block: outboundBlock, delimiter: frame.delimiter, decodedText: outboundText };
        } else {
          stageBPendingLineFeedVisible = false;
        }
        continue;
      }
      // Preserve every frame through the first Responses terminal. Every
      // later non-DONE frame is dropped.
      if (!responsesTerminal) {
        stageBPendingLineFeedVisible = true;
        if (outboundBlock !== frame.block) canUseChunkPrefix = false;
        emitOutbound(outboundBlock, frame.delimiter, outboundText);
      } else {
        canUseChunkPrefix = false;
      }
      // The policy payload this boundary emitted is itself the turn's terminal.
      if (!responsesTerminal && payload && (policyPayload !== undefined || terminalStatusFromParsed(parsed, typedBareSeen))) {
        responsesTerminal = true;
        if (pendingDone) {
          emitOutbound(pendingDone.block, pendingDone.delimiter, pendingDone.decodedText);
          pendingDone = null;
          doneEmitted = true;
        }
      }
    }
    if (responsesTerminal) {
      terminal = true;
      framer.dispose();
    }
    if (
      canUseChunkPrefix
      && !responsesTerminal
      && prefixEnd !== null
      && sourceChunk !== undefined
      && maxInputBytes === undefined
      && emittedByteSum === prefixEnd
    ) {
      return prefixEnd === sourceChunk.byteLength ? sourceChunk : sourceChunk.subarray(0, prefixEnd);
    }
    return joinSseFrameBytes(output);
  };

  return {
    feed(chunk) {
      if (disposed || terminal) return EMPTY_BYTES;
      if (maxInputBytes === undefined) {
        const { frames, prefixEnd } = framer.feedWithPrefix(chunk);
        const stageA = runStageA(frames);
        return processStageBAndC(stageA.frames, prefixEnd, chunk, stageA.canUseChunkPrefix);
      }
      // A fetch implementation may hand us one multi-megabyte chunk containing thousands of
      // complete frames. Slice BEFORE framing so neither the frame array nor the final join can be
      // allocated past the explicit transcript budget. Once a valid terminal appears, trailing
      // bytes in the same network chunk retain the ordinary terminal-authoritative behavior.
      const slices: Uint8Array[] = [];
      for (let offset = 0; offset < chunk.byteLength && !terminal;) {
        const remaining = maxInputBytes - inputBytes;
        if (remaining <= 0) throw new SseAggregateLimitError(maxInputBytes);
        const length = Math.min(64 * 1024, remaining, chunk.byteLength - offset);
        const slice = chunk.subarray(offset, offset + length);
        inputBytes += slice.byteLength;
        offset += length;
        const { frames } = framer.feedWithPrefix(slice);
        const stageA = runStageA(frames);
        const processed = processStageBAndC(stageA.frames, null, undefined, false);
        if (processed.byteLength > 0) slices.push(processed);
        if (!terminal && offset < chunk.byteLength && inputBytes >= maxInputBytes) {
          throw new SseAggregateLimitError(maxInputBytes);
        }
      }
      return joinSseFrameBytes(slices);
    },
    finish() {
      if (disposed || terminal) return EMPTY_BYTES;
      const tail = framer.finish();
      if (tail.byteLength === 0) return EMPTY_BYTES;
      // EOF may cut off the final SSE block before its blank-line delimiter.
      // Feed it through the exact same parser/rewrite/terminal path as a
      // complete frame, using a synthetic delimiter so the client receives a
      // dispatchable event rather than an unterminated tail.
      const tailText = decoder.decode(tail);
      const delimiter = encoder.encode(tailText.includes("\r\n") ? "\r\n\r\n" : "\n\n");
      if (!preRewriteBlocks) {
        return processStageBAndC([{ block: tail, delimiter, decodedText: tailText }], null, undefined, false);
      }
      let tailBlocks: readonly string[];
      try {
        tailBlocks = preRewriteBlocks(tailText);
      } catch (err) {
        disposePreRewrite();
        framer.dispose();
        throw err;
      }
      if (tailBlocks.length === 0) return EMPTY_BYTES;
      const stageAFrames: BoundaryFrame[] = [];
      try {
        if (tailBlocks.length === 1 && tailBlocks[0] === tailText) {
          stageAFrames.push({ block: tail, delimiter, decodedText: tailText });
        } else {
          for (let i = 0; i < tailBlocks.length; i += 1) {
            const outText = tailBlocks[i]!;
            if (outText === tailText) {
              if (preRewriteBudget) {
                admitTransientBytes(preRewriteBudget, tail.byteLength + delimiter.byteLength);
              }
              stageAFrames.push({ block: tail, delimiter, decodedText: tailText });
              continue;
            }
            const byteLength = Buffer.byteLength(outText, "utf8");
            if (preRewriteBudget) {
              admitTransientBytes(preRewriteBudget, byteLength + delimiter.byteLength);
            }
            stageAFrames.push({ block: encoder.encode(outText), delimiter, decodedText: outText });
          }
        }
      } catch (err) {
        disposePreRewrite();
        framer.dispose();
        throw err;
      }
      return processStageBAndC(stageAFrames, null, undefined, false);
    },
    terminalSeen: () => terminal,
    doneSeen: () => done,
    upstreamError: () => upstreamError,
    upstreamRefusalCode: () => upstreamRefusalCode,
    upstreamErrorType: () => upstreamErrorType,
    upstreamErrorCode: () => upstreamErrorCode,
    upstreamVerdict: () => bareEvidence?.verdict,
    recognizedBareError: () => bareEvidence?.verdict.httpStatus !== undefined,
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingDone = null;
      framer.dispose();
      disposePreRewrite();
      disposePostRewrite();
    },
  };
}

type JsonRecord = Record<string, unknown>;

export function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringField(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Return a high-confidence policy error carried by an upstream terminal shape.
 * Deliberately inspect structured error fields and known refusal copy only — a
 * bare `cyber_policy` token in an unrelated payload is not sufficient.
 */
export function cyberPolicyTerminalError(parsed: unknown): { message: string; type?: string } | undefined {
  const root = asJsonRecord(parsed);
  if (!root) return undefined;
  const response = asJsonRecord(root.response);
  const candidates = [
    asJsonRecord(root.error),
    asJsonRecord(root.last_error),
    asJsonRecord(response?.error),
    asJsonRecord(response?.incomplete_details),
    root,
    response,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isCyberPolicyCode(stringField(candidate, "code"))) {
      return {
        message: stringField(candidate, "message")
          ?? CYBER_POLICY_FALLBACK_MESSAGE,
        ...(stringField(candidate, "type") ? { type: stringField(candidate, "type") } : {}),
      };
    }
  }
  for (const candidate of candidates) {
    const message = stringField(candidate, "message");
    if (message && isCyberPolicyMessage(message)) {
      return {
        message,
        ...(stringField(candidate, "type") ? { type: stringField(candidate, "type") } : {}),
      };
    }
  }
  return undefined;
}

export function parseSsePayload(payload: string): unknown | undefined {
  if (payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

export function isPolicyRewriteType(parsed: unknown, typedBareSeen = false): boolean {
  const type = asJsonRecord(parsed)?.type;
  return type === "response.failed" || type === "response.incomplete" || type === "error"
    || (!typedBareSeen && isUntypedBareUpstreamError(parsed) && isCyberPolicyCode(bareUpstreamError(parsed)?.errorCode));
}

/**
 * Codex emits its safety-buffering hint in the SSE body as well as in headers:
 * a `response.metadata` event whose `metadata.type` is `safety_buffering`, or a
 * `safety_buffering` field on another event. The metadata event is dropped whole;
 * the field is stripped so the carrying event is otherwise relayed unchanged.
 */
function codexSafetyBufferingBlockAction(parsed: unknown): "keep" | "drop" | "strip" {
  const root = asJsonRecord(parsed);
  if (!root) return "keep";
  if (root.type === "response.metadata") {
    const metadata = asJsonRecord(root.metadata);
    if (metadata?.type === "safety_buffering") return "drop";
  }
  return Object.hasOwn(root, "safety_buffering") ? "strip" : "keep";
}

function stripCodexSafetyBufferingField(block: string, parsed: unknown): string {
  const root = asJsonRecord(parsed);
  if (!root) return block;
  const { safety_buffering: _safetyBuffering, ...rest } = root;
  return replaceSseDataPayload(block, JSON.stringify(rest));
}

function rewritePolicyTerminalBlock(block: string, payload: string): string {
  const rewritten = replaceSseDataPayload(block, payload);
  const { newline, lines } = splitSseBlock(rewritten);
  let eventRewritten = false;
  const withEvent = lines.map(line => {
    if (!eventRewritten && line.startsWith("event:")) {
      eventRewritten = true;
      return "event: response.failed";
    }
    return line;
  });
  if (!eventRewritten) withEvent.unshift("event: response.failed");
  return withEvent.join(newline);
}

function policyFailurePayload(policyError: { message: string; type?: string }, parsed: unknown, mask?: (text: string) => string): string {
  // An untyped envelope has no protocol fields of its own: everything in it is upstream copy, so its
  // policy terminal keeps only the guarded message, the default policy type and the event sequence.
  const untyped = isUntypedBareUpstreamError(parsed);
  const error = {
    type: untyped ? cyberPolicyErrorType(undefined) : cyberPolicyErrorType(policyError.type),
    code: CYBER_POLICY_ERROR_CODE,
    // Mask before bounding: a slice first can keep a credential prefix the later rewrite misses.
    message: redactSecretString(guardBareCopy(policyError.message, mask)).slice(0, MAX_TAIL_ERROR_MESSAGE_CHARS),
  };
  const root = asJsonRecord(parsed);
  const originalResponse = untyped ? undefined : asJsonRecord(root?.response);
  const preservedResponse = Object.fromEntries(
    Object.entries(originalResponse ?? {}).filter(([key]) => key !== "incomplete_details"),
  );
  const response = {
    ...preservedResponse,
    status: "failed",
    error,
    last_error: error,
    retryable: false,
  };
  // Responses event metadata such as sequence_number is normally top-level.
  // Keep it (and any other non-error, non-response fields) while replacing only
  // the protocol type and error envelope.
  const preservedRoot = untyped
    // A sequence number that repeats a sent value is upstream copy like any other; it is omitted.
    ? (typeof root?.sequence_number === "number"
      && (mask === undefined || mask(String(root.sequence_number)) === String(root.sequence_number))
      ? { sequence_number: root.sequence_number } : {})
    : root
    ? Object.fromEntries(Object.entries(root).filter(([key]) => (
      key !== "type"
      && key !== "response"
      && key !== "error"
      && key !== "last_error"
      && key !== "retryable"
    )))
    : {};
  return JSON.stringify({
    ...preservedRoot,
    type: "response.failed",
    retryable: false,
    response,
  });
}

export function terminalStatusFromSsePayload(payload: string): ResponsesTerminalStatus | null {
  if (payload === "[DONE]") return null;
  return terminalStatusFromParsed(parseSsePayload(payload));
}

/**
 * `typedBareSeen`: an earlier typed bare `error` frame already owns the turn's verdict
 * (`reduceBareUpstreamEvidence`), so a later untyped policy envelope loses and is no terminal.
 * A stream reader uses {@link createTerminalStatusTracker} rather than passing this itself.
 */
export function terminalStatusFromParsed(parsed: unknown, typedBareSeen = false): ResponsesTerminalStatus | null {
  const type = asJsonRecord(parsed)?.type;
  if (!typedBareSeen && isUntypedBareUpstreamError(parsed) && isCyberPolicyCode(bareUpstreamError(parsed)?.errorCode)) return "failed";
  switch (type) {
    case "response.completed":
      return responsesCompletionError(parsed) == null ? "completed" : "failed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return cyberPolicyTerminalError(parsed) ? "failed" : "incomplete";
    case "error":
      return cyberPolicyTerminalError(parsed) ? "failed" : null;
    default:
      return null;
  }
}

/**
 * One stream's terminal classifier. It reduces bare evidence in order, so an untyped policy
 * envelope ends the turn only when it is the winning verdict, exactly as the client boundary,
 * the request row and the account inspector decide it.
 */
export function createTerminalStatusTracker(): (parsed: unknown) => ResponsesTerminalStatus | null {
  let evidence: BareUpstreamEvidence | undefined;
  return parsed => {
    evidence = reduceBareUpstreamEvidence(evidence, parsed);
    return terminalStatusFromParsed(parsed, evidence?.typed === true);
  };
}
