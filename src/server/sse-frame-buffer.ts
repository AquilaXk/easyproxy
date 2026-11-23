import { isCyberPolicyCode, isCyberPolicyMessage } from "../lib/errors";
import type { TranslatorBudget } from "../lib/translator-budget";
import { sseDataPayload } from "./sse-payload-rewrite";

export const MAX_CLIENT_SSE_FRAME_BYTES = 4 * 1024 * 1024;
const REUSABLE_SCRATCH_BYTES = 16 * 1024;
const LIVE_TRANSIENT_SCOPE = { kind: "live_transient" as const };

export const EMPTY_BYTES = new Uint8Array(0);

// Intern every legal pair; a split CRLF may leave a framing-only LF continuation.
const DELIMITERS = new Map([
  "\n", "\n\n", "\n\r", "\n\r\n", "\r\r", "\r\r\n", "\r\n\n", "\r\n\r", "\r\n\r\n",
].map(text => [text, Uint8Array.from(text, char => char.charCodeAt(0))]));
const DELIMITER_NL_CR_LF = DELIMITERS.get("\n\r\n")!;
const DELIMITER_CR_CR_LF = DELIMITERS.get("\r\r\n")!;
const DELIMITER_CRLF_CR_LF = DELIMITERS.get("\r\n\r\n")!;

/** Settle a trailing CR delimiter before appending another block after it. */
export function settledCrDelimiter(delimiter: Uint8Array): Uint8Array {
  const len = delimiter.byteLength;
  if (len === 0 || delimiter[len - 1] !== 13) return delimiter;
  if (len === 2) return delimiter[0] === 10 ? DELIMITER_NL_CR_LF : DELIMITER_CR_CR_LF;
  if (len === 3 && delimiter[0] === 13 && delimiter[1] === 10) return DELIMITER_CRLF_CR_LF;
  const settled = new Uint8Array(len + 1);
  settled.set(delimiter);
  settled[len] = 10;
  return settled;
}

/** Skip non-delimiter payload bytes using native byte search across tail + chunk. */
export function findNextSseDelimiterCandidate(
  startIndex: number,
  tailLength: number,
  chunk: Uint8Array,
): number {
  if (startIndex < tailLength) return startIndex;
  const offset = startIndex - tailLength;
  const lf = chunk.indexOf(10, offset);
  const cr = chunk.indexOf(13, offset);
  if (lf === -1) return tailLength + (cr === -1 ? chunk.byteLength : cr);
  if (cr === -1) return tailLength + lf;
  return tailLength + (lf < cr ? lf : cr);
}

export class SseFrameTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upstream SSE frame exceeded ${maxBytes} bytes`);
    this.name = "SseFrameTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class SseFrameCountLimitError extends Error {
  readonly maxFrames: number;

  constructor(maxFrames: number) {
    super(`upstream SSE chunk exceeded ${maxFrames} frame limit`);
    this.name = "SseFrameCountLimitError";
    this.maxFrames = maxFrames;
  }
}

export type BoundedSseFrame = {
  block: Uint8Array;
  delimiter: Uint8Array;
  /** A late LF extending a previously returned CR; no new event. */
  continuation?: true;
};

/**
 * Classify the bytes at `index` as an SSE block delimiter.
 *
 * Returns the delimiter length in bytes, `0` when `index` does not start a
 * delimiter, and `undefined` when more bytes are required to decide.
 */
export function sseDelimiterLengthAt(
  index: number,
  length: number,
  byteAt: (index: number) => number,
): number | undefined {
  const first = byteAt(index);
  if (first !== 10 && first !== 13) return 0;
  let next = index + 1;
  if (next >= length) return undefined;
  if (first === 13 && byteAt(next) === 10) next += 1;
  if (next >= length) return undefined;
  const second = byteAt(next);
  if (second !== 10 && second !== 13) return 0;
  next += 1;
  if (second === 13 && next < length && byteAt(next) === 10) next += 1;
  return next - index;
}

function delimiterBytesAt(
  index: number,
  delimiterLength: number,
  byteAt: (index: number) => number,
): Uint8Array {
  let text = "";
  for (let offset = 0; offset < delimiterLength; offset++) text += String.fromCharCode(byteAt(index + offset));
  return DELIMITERS.get(text)!;
}

function copyRange(
  start: number,
  end: number,
  tailLength: number,
  previousTail: Uint8Array,
  chunk: Uint8Array,
): Uint8Array {
  if (end <= start) return EMPTY_BYTES;
  if (start >= tailLength) return chunk.slice(start - tailLength, end - tailLength);
  const out = new Uint8Array(end - start);
  const tailEnd = Math.min(end, tailLength);
  out.set(previousTail.subarray(start, tailEnd), 0);
  if (end > tailLength) {
    out.set(chunk.subarray(0, end - tailLength), tailLength - start);
  }
  return out;
}

const UTF8_DECODER = new TextDecoder();
const BACKSLASH_U_BYTES = Uint8Array.from([0x5c, 0x75]);
const DONE_MARKER_BYTES = Uint8Array.from([0x5b, 0x44, 0x4f, 0x4e, 0x45, 0x5d]); // "[DONE]"
const SAFETY_BUFFERING_BYTES = Uint8Array.from([
  0x73, 0x61, 0x66, 0x65, 0x74, 0x79, 0x5f, 0x62, 0x75, 0x66, 0x66, 0x65, 0x72, 0x69, 0x6e, 0x67,
]); // "safety_buffering"
const QUOTED_ERROR_BYTES = Uint8Array.from([0x22, 0x65, 0x72, 0x72, 0x6f, 0x72, 0x22]); // "\"error\""
const QUOTED_RESPONSE_DOT_BYTES = Uint8Array.from([
  0x22, 0x72, 0x65, 0x73, 0x70, 0x6f, 0x6e, 0x73, 0x65, 0x2e,
]); // "\"response."
const SUFFIX_COMPLETED_QUOTE = Uint8Array.from([0x63, 0x6f, 0x6d, 0x70, 0x6c, 0x65, 0x74, 0x65, 0x64, 0x22]);
const SUFFIX_FAILED_QUOTE = Uint8Array.from([0x66, 0x61, 0x69, 0x6c, 0x65, 0x64, 0x22]);
const SUFFIX_INCOMPLETE_QUOTE = Uint8Array.from([
  0x69, 0x6e, 0x63, 0x6f, 0x6d, 0x70, 0x6c, 0x65, 0x74, 0x65, 0x22,
]);

function matchesAt(haystack: Uint8Array, offset: number, suffix: Uint8Array): boolean {
  if (offset + suffix.length > haystack.length) return false;
  for (let i = 0; i < suffix.length; i += 1) {
    if (haystack[offset + i] !== suffix[i]) return false;
  }
  return true;
}

function blockContainsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
  const nLen = needle.length;
  const limit = haystack.length - nLen;
  if (limit < 0) return false;
  const first = needle[0]!;
  let pos = 0;
  while (pos <= limit) {
    const idx = haystack.indexOf(first, pos);
    if (idx === -1 || idx > limit) return false;
    let matched = true;
    for (let j = 1; j < nLen; j += 1) {
      if (haystack[idx + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
    pos = idx + 1;
  }
  return false;
}

function mayCarryResponsesTerminalEvent(block: Uint8Array): boolean {
  if (blockContainsSubarray(block, QUOTED_ERROR_BYTES) || blockContainsSubarray(block, BACKSLASH_U_BYTES)) {
    return true;
  }
  const nLen = QUOTED_RESPONSE_DOT_BYTES.length;
  const limit = block.length - nLen;
  let pos = 0;
  while (pos <= limit) {
    const idx = block.indexOf(0x22, pos);
    if (idx === -1 || idx > limit) return false;
    if (matchesAt(block, idx + 1, QUOTED_RESPONSE_DOT_BYTES.subarray(1))) {
      const suffixOffset = idx + nLen;
      if (
        matchesAt(block, suffixOffset, SUFFIX_COMPLETED_QUOTE)
        || matchesAt(block, suffixOffset, SUFFIX_FAILED_QUOTE)
        || matchesAt(block, suffixOffset, SUFFIX_INCOMPLETE_QUOTE)
      ) {
        return true;
      }
    }
    pos = idx + 1;
  }
  return false;
}

function isDataFieldLineStart(block: Uint8Array, lineStart: number, lineEnd: number): boolean {
  const lineLen = lineEnd - lineStart;
  if (lineLen < 4) return false;
  if (
    block[lineStart] !== 0x64
    || block[lineStart + 1] !== 0x61
    || block[lineStart + 2] !== 0x74
    || block[lineStart + 3] !== 0x61
  ) {
    return false;
  }
  return lineLen === 4 || block[lineStart + 4] === 0x3a;
}

/**
 * Zero-decode byte precheck for terminal boundary inspection.
 *
 * Returns `false` for ordinary single-data delta and keepalive frames so
 * callers can skip UTF-8 decoding and `JSON.parse`. Any multi-line `data:`
 * block returns `true` so split tokens (`[DO\ndata: NE]` or `"response.\ndata: completed"`)
 * can never bypass inspection.
 */
export function mayRequireTerminalBoundaryInspection(
  block: Uint8Array,
  dropSafetyBuffering: boolean,
): boolean {
  const len = block.byteLength;
  if (len === 0) return false;
  let dataLineCount = 0;
  let lineStart = 0;
  const hasCr = block.indexOf(13) !== -1;
  while (lineStart < len) {
    const lf = block.indexOf(10, lineStart);
    let lineEnd: number;
    if (!hasCr) {
      lineEnd = lf === -1 ? len : lf;
    } else {
      const cr = block.indexOf(13, lineStart);
      lineEnd = lf === -1 ? (cr === -1 ? len : cr) : (cr === -1 ? lf : (lf < cr ? lf : cr));
    }
    if (isDataFieldLineStart(block, lineStart, lineEnd)) {
      dataLineCount += 1;
      if (dataLineCount > 1) return true;
    }
    if (lineEnd >= len) break;
    lineStart = hasCr && block[lineEnd] === 13 && lineEnd + 1 < len && block[lineEnd + 1] === 10
      ? lineEnd + 2
      : lineEnd + 1;
  }
  if (mayCarryResponsesTerminalEvent(block)) return true;
  if (blockContainsSubarray(block, DONE_MARKER_BYTES)) return true;
  if (dropSafetyBuffering && blockContainsSubarray(block, SAFETY_BUFFERING_BYTES)) return true;
  return false;
}

/**
 * True when a complete SSE block already commits a Responses terminal event.
 *
 * Framing errors in bytes *after* such a block must not retroactively turn an
 * already-completed/failed/incomplete model turn into a transport failure. This
 * helper runs a zero-alloc byte scan on ordinary delta frames so decoding and
 * JSON parsing only run on candidate terminal/error blocks.
 */
function isResponsesTerminalFrame(block: Uint8Array): boolean {
  if (!mayCarryResponsesTerminalEvent(block)) return false;
  const payload = sseDataPayload(UTF8_DECODER.decode(block));
  if (payload === null) return false;
  if (payload === "[DONE]") return false;
  try {
    const parsed = JSON.parse(payload) as {
      type?: unknown;
      code?: unknown;
      message?: unknown;
      error?: unknown;
      last_error?: unknown;
      response?: { error?: unknown; incomplete_details?: unknown };
    };
    if (parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete") return true;
    if (parsed.type !== "error") return false;
    // A top-level error is terminal for this boundary only when it carries the
    // same high-confidence cyber-policy evidence used by relay.ts. Ordinary
    // upstream errors remain transport failures and still become a bounded 502.
    const candidates = [
      parsed,
      parsed.error,
      parsed.last_error,
      parsed.response?.error,
      parsed.response?.incomplete_details,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as { code?: unknown; message?: unknown };
      if (isCyberPolicyCode(typeof record.code === "string" ? record.code : undefined)) return true;
      if (typeof record.message === "string" && isCyberPolicyMessage(record.message)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Byte-bounded SSE block framer for client-facing protocol paths.
 *
 * The delimiter scanner works on raw bytes, so fragmented UTF-8 cannot change
 * accounting and a hostile upstream cannot grow an unterminated JS string
 * without limit. Candidate bytes live in one geometrically grown buffer rather
 * than one allocation per upstream chunk, bounding both bytes and object count.
 * Complete blocks are returned without their delimiter; the exact delimiter
 * bytes are returned separately so callers can relay bytes unchanged.
 */
export class BoundedSseFrameBuffer {
  private readonly maxFrameBytes: number;
  private readonly maxFramesPerFeed: number;
  private readonly transientBudget?: TranslatorBudget;
  private delimiterTail: Uint8Array = EMPTY_BYTES;
  private candidate: Uint8Array = EMPTY_BYTES;
  private candidateBytes = 0;
  private budgetChargedBytes = 0;
  private disposed = false;
  private pendingLineFeed = false;

  constructor(maxFrameBytes = MAX_CLIENT_SSE_FRAME_BYTES, transientBudget?: TranslatorBudget) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.maxFrameBytes = maxFrameBytes;
    // Delimiter-only input otherwise creates an object-amplification path that
    // is independent of candidate bytes. Keep frame count proportional to the
    // configured byte budget while leaving ample room for real Responses events.
    this.maxFramesPerFeed = Math.max(1, Math.ceil(maxFrameBytes / 1024));
    this.transientBudget = transientBudget;
  }

  private syncBudget(targetBytes: number): void {
    const budget = this.transientBudget;
    if (!budget) return;
    const prevBytes = this.budgetChargedBytes;
    if (targetBytes === prevBytes) return;
    if (targetBytes === 0) {
      budget.releaseRetained(prevBytes, LIVE_TRANSIENT_SCOPE);
      this.budgetChargedBytes = 0;
      return;
    }
    if (targetBytes < prevBytes) {
      budget.releaseRetained(prevBytes - targetBytes, LIVE_TRANSIENT_SCOPE);
      this.budgetChargedBytes = targetBytes;
      return;
    }
    let reservation: ReturnType<TranslatorBudget["reserveTransient"]>;
    try {
      reservation = budget.reserveTransient(targetBytes, LIVE_TRANSIENT_SCOPE);
    } catch (err) {
      this.clear();
      this.disposed = true;
      throw err;
    }
    try {
      reservation.commitRetained();
      if (prevBytes > 0) budget.releaseRetained(prevBytes, LIVE_TRANSIENT_SCOPE);
      this.budgetChargedBytes = targetBytes;
    } catch (err) {
      reservation.release();
      this.clear();
      this.disposed = true;
      throw err;
    }
  }

  private clear(): void {
    if (this.transientBudget && this.budgetChargedBytes > 0) {
      this.transientBudget.releaseRetained(this.budgetChargedBytes, LIVE_TRANSIENT_SCOPE);
      this.budgetChargedBytes = 0;
    }
    this.delimiterTail = EMPTY_BYTES;
    this.candidate = EMPTY_BYTES;
    this.candidateBytes = 0;
    this.pendingLineFeed = false;
  }

  private ensureCapacity(requiredBytes: number): void {
    if (this.candidate.byteLength >= requiredBytes) return;
    if (requiredBytes > this.maxFrameBytes) {
      throw new SseFrameTooLargeError(this.maxFrameBytes);
    }
    let capacity = this.candidate.byteLength === 0
      ? Math.min(this.maxFrameBytes, Math.max(requiredBytes, 4096))
      : this.candidate.byteLength;
    while (capacity < requiredBytes) {
      capacity = Math.min(this.maxFrameBytes, Math.max(requiredBytes, capacity * 2));
    }
    const grown = new Uint8Array(capacity);
    if (this.candidateBytes > 0) {
      grown.set(this.candidate.subarray(0, this.candidateBytes));
    }
    this.candidate = grown;
  }

  private retainSliceRange(
    start: number,
    end: number,
    tailLength: number,
    previousTail: Uint8Array,
    chunk: Uint8Array,
  ): void {
    const sliceLen = end - start;
    if (sliceLen <= 0) return;
    const nextBytes = this.candidateBytes + sliceLen;
    if (nextBytes > this.maxFrameBytes) {
      this.clear();
      this.disposed = true;
      throw new SseFrameTooLargeError(this.maxFrameBytes);
    }
    const remainingTailAfter = Math.max(0, tailLength - end);
    this.syncBudget(nextBytes + remainingTailAfter);
    this.ensureCapacity(nextBytes);
    let writeAt = this.candidateBytes;
    if (start < tailLength) {
      const tailPart = previousTail.subarray(start, Math.min(end, tailLength));
      this.candidate.set(tailPart, writeAt);
      writeAt += tailPart.byteLength;
    }
    if (end > tailLength) {
      const chunkPart = chunk.subarray(Math.max(0, start - tailLength), end - tailLength);
      this.candidate.set(chunkPart, writeAt);
    }
    this.candidateBytes = nextBytes;
  }

  private takeCandidate(remainingTail = 0): Uint8Array {
    if (this.candidateBytes === 0) {
      this.syncBudget(remainingTail);
      return EMPTY_BYTES;
    }
    const block = this.candidate.slice(0, this.candidateBytes);
    // Keep a bounded scratch buffer across frames to avoid reallocating 4 KiB+
    // per SSE frame on long streams, while releasing rare multi-MiB frames.
    this.candidateBytes = 0;
    if (this.candidate.byteLength > REUSABLE_SCRATCH_BYTES) {
      this.candidate = EMPTY_BYTES;
    }
    this.syncBudget(remainingTail);
    return block;
  }

  feedWithPrefix(chunk: Uint8Array): { frames: BoundedSseFrame[]; prefixEnd: number | null } {
    if (this.disposed || chunk.byteLength === 0) {
      return { frames: [], prefixEnd: null };
    }

    const frames: BoundedSseFrame[] = [];
    let completedFrames = 0;
    const previousTail = this.delimiterTail;
    this.delimiterTail = EMPTY_BYTES;
    const tailLength = previousTail.byteLength;
    const entryCandidateBytes = this.candidateBytes;
    const totalLength = tailLength + chunk.byteLength;
    let hadContinuation = false;
    let lastFrameEnd = 0;
    const byteAt = (index: number): number => index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;

    try {
      let index = 0;
      if (this.pendingLineFeed && byteAt(0) === 10) {
        // The prior event was already dispatched on CR. Preserve its later LF without
        // charging it to the next event or letting it pair with another line ending.
        frames.push({ block: EMPTY_BYTES, delimiter: DELIMITERS.get("\n")!, continuation: true });
        hadContinuation = true;
        index = 1;
      }
      this.pendingLineFeed = false;
      let retainedThrough = index;
      while (index < totalLength) {
        index = findNextSseDelimiterCandidate(index, tailLength, chunk);
        if (index >= totalLength) break;
        const delimiterLength = sseDelimiterLengthAt(index, totalLength, byteAt);
        if (delimiterLength === undefined) break;
        if (delimiterLength > 0) {
          if (completedFrames >= this.maxFramesPerFeed) {
            this.clear();
            this.disposed = true;
            throw new SseFrameCountLimitError(this.maxFramesPerFeed);
          }
          let block: Uint8Array;
          if (this.candidateBytes === 0 && retainedThrough >= tailLength) {
            const blockLen = index - retainedThrough;
            if (blockLen > this.maxFrameBytes) {
              this.clear();
              this.disposed = true;
              throw new SseFrameTooLargeError(this.maxFrameBytes);
            }
            const totalSliceBytes = blockLen + delimiterLength;
            if (this.transientBudget && totalSliceBytes > 0) {
              let reservation: ReturnType<TranslatorBudget["reserveTransient"]>;
              try {
                reservation = this.transientBudget.reserveTransient(totalSliceBytes, LIVE_TRANSIENT_SCOPE);
              } catch (err) {
                this.clear();
                this.disposed = true;
                throw err;
              }
              try {
                reservation.commitRetained();
                this.transientBudget.releaseRetained(totalSliceBytes, LIVE_TRANSIENT_SCOPE);
              } catch (err) {
                reservation.release();
                this.clear();
                this.disposed = true;
                throw err;
              }
            }
            block = blockLen === 0
              ? EMPTY_BYTES
              : chunk.subarray(retainedThrough - tailLength, index - tailLength);
          } else {
            this.retainSliceRange(retainedThrough, index, tailLength, previousTail, chunk);
            const remainingTailAfter = Math.max(0, tailLength - (index + delimiterLength));
            block = this.takeCandidate(remainingTailAfter);
          }
          const delimiter = delimiterBytesAt(index, delimiterLength, byteAt);
          frames.push({ block, delimiter });
          completedFrames += 1;
          index += delimiterLength;
          this.pendingLineFeed = index === totalLength && byteAt(index - 1) === 13;
          lastFrameEnd = index;
          retainedThrough = index;
          continue;
        }
        index += 1;
      }

      this.retainSliceRange(retainedThrough, index, tailLength, previousTail, chunk);
      if (index < totalLength) {
        const nextTail = copyRange(index, totalLength, tailLength, previousTail, chunk);
        this.syncBudget(this.candidateBytes + nextTail.byteLength);
        this.delimiterTail = nextTail;
      } else {
        this.syncBudget(this.candidateBytes);
      }
      const prefixEnd = tailLength === 0 && entryCandidateBytes === 0 && !hadContinuation && lastFrameEnd > 0
        ? lastFrameEnd
        : null;
      return { frames, prefixEnd };
    } catch (err) {
      const framingError = err instanceof SseFrameTooLargeError
        || err instanceof SseFrameCountLimitError;
      if (framingError && frames.some(frame => isResponsesTerminalFrame(frame.block))) {
        // A terminal frame is the Responses protocol boundary. Ignore malformed
        // or oversized bytes that occur later in the same upstream chunk rather
        // than retroactively replacing the committed terminal with a 502.
        this.clear();
        this.disposed = true;
        const prefixEnd = tailLength === 0 && entryCandidateBytes === 0 && !hadContinuation && lastFrameEnd > 0
          ? lastFrameEnd
          : null;
        return { frames, prefixEnd };
      }
      throw err;
    }
  }

  feed(chunk: Uint8Array): BoundedSseFrame[] {
    return this.feedWithPrefix(chunk).frames;
  }

  /** Bytes retained for an unfinished frame, including a possible delimiter prefix. */
  get pendingBytes(): number {
    return this.candidateBytes + this.delimiterTail.byteLength;
  }

  /** Return the final unterminated block bytes and release all retained state. */
  finish(): Uint8Array {
    if (this.disposed) return EMPTY_BYTES;
    try {
      if (this.delimiterTail.byteLength > 0) {
        const nextBytes = this.candidateBytes + this.delimiterTail.byteLength;
        if (nextBytes > this.maxFrameBytes) {
          this.clear();
          this.disposed = true;
          throw new SseFrameTooLargeError(this.maxFrameBytes);
        }
        this.ensureCapacity(nextBytes);
        this.candidate.set(this.delimiterTail, this.candidateBytes);
        this.candidateBytes = nextBytes;
        this.delimiterTail = EMPTY_BYTES;
      }
      return this.takeCandidate(0);
    } finally {
      this.clear();
      this.disposed = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }
}

export function joinSseFrameBytes(parts: readonly Uint8Array[]): Uint8Array {
  let byteLength = 0;
  for (const part of parts) byteLength += part.byteLength;
  if (byteLength === 0) return EMPTY_BYTES;
  if (parts.length === 1 && parts[0]!.byteLength === byteLength) return parts[0]!;
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}
