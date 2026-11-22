import { isCyberPolicyCode, isCyberPolicyMessage } from "../lib/errors";
import { sseDataPayload } from "./sse-payload-rewrite";

export const MAX_CLIENT_SSE_FRAME_BYTES = 4 * 1024 * 1024;
const REUSABLE_SCRATCH_BYTES = 16 * 1024;

export const EMPTY_BYTES = new Uint8Array(0);

// Intern every legal pair; a split CRLF may leave a framing-only LF continuation.
const DELIMITERS = new Map([
  "\n", "\n\n", "\n\r", "\n\r\n", "\r\r", "\r\r\n", "\r\n\n", "\r\n\r", "\r\n\r\n",
].map(text => [text, Uint8Array.from(text, char => char.charCodeAt(0))]));

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
  private delimiterTail: Uint8Array = EMPTY_BYTES;
  private candidate: Uint8Array = EMPTY_BYTES;
  private candidateBytes = 0;
  private disposed = false;
  private pendingLineFeed = false;

  constructor(maxFrameBytes = MAX_CLIENT_SSE_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.maxFrameBytes = maxFrameBytes;
    // Delimiter-only input otherwise creates an object-amplification path that
    // is independent of candidate bytes. Keep frame count proportional to the
    // configured byte budget while leaving ample room for real Responses events.
    this.maxFramesPerFeed = Math.max(1, Math.ceil(maxFrameBytes / 1024));
  }

  private clear(): void {
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

  private retain(slice: Uint8Array): void {
    if (slice.byteLength === 0) return;
    const nextBytes = this.candidateBytes + slice.byteLength;
    if (nextBytes > this.maxFrameBytes) {
      this.clear();
      this.disposed = true;
      throw new SseFrameTooLargeError(this.maxFrameBytes);
    }
    this.ensureCapacity(nextBytes);
    this.candidate.set(slice, this.candidateBytes);
    this.candidateBytes = nextBytes;
  }

  private takeCandidate(): Uint8Array {
    if (this.candidateBytes === 0) return EMPTY_BYTES;
    const block = this.candidate.slice(0, this.candidateBytes);
    // Keep a bounded scratch buffer across frames to avoid reallocating 4 KiB+
    // per SSE frame on long streams, while releasing rare multi-MiB frames.
    this.candidateBytes = 0;
    if (this.candidate.byteLength > REUSABLE_SCRATCH_BYTES) {
      this.candidate = EMPTY_BYTES;
    }
    return block;
  }

  feed(chunk: Uint8Array): BoundedSseFrame[] {
    if (this.disposed) return [];
    if (chunk.byteLength === 0) return [];

    const frames: BoundedSseFrame[] = [];
    let completedFrames = 0;
    const previousTail = this.delimiterTail;
    this.delimiterTail = EMPTY_BYTES;
    const tailLength = previousTail.byteLength;
    const totalLength = tailLength + chunk.byteLength;
    const byteAt = (index: number): number => index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;
    const retainRange = (start: number, end: number): void => {
      if (end <= start) return;
      if (start < tailLength) {
        this.retain(previousTail.subarray(start, Math.min(end, tailLength)));
      }
      if (end > tailLength) {
        this.retain(chunk.subarray(Math.max(0, start - tailLength), end - tailLength));
      }
    };

    try {
      let index = 0;
      if (this.pendingLineFeed && byteAt(0) === 10) {
        // The prior event was already dispatched on CR. Preserve its later LF without
        // charging it to the next event or letting it pair with another line ending.
        frames.push({ block: EMPTY_BYTES, delimiter: DELIMITERS.get("\n")!, continuation: true });
        index = 1;
      }
      this.pendingLineFeed = false;
      let retainedThrough = index;
      while (index < totalLength) {
        const delimiterLength = sseDelimiterLengthAt(index, totalLength, byteAt);
        if (delimiterLength === undefined) break;
        if (delimiterLength > 0) {
          if (completedFrames >= this.maxFramesPerFeed) {
            this.clear();
            this.disposed = true;
            throw new SseFrameCountLimitError(this.maxFramesPerFeed);
          }
          retainRange(retainedThrough, index);
          const block = this.takeCandidate();
          const delimiter = delimiterBytesAt(index, delimiterLength, byteAt);
          frames.push({ block, delimiter });
          completedFrames += 1;
          index += delimiterLength;
          this.pendingLineFeed = index === totalLength && byteAt(index - 1) === 13;
          retainedThrough = index;
          continue;
        }
        index += 1;
      }

      retainRange(retainedThrough, index);
      if (index < totalLength) {
        this.delimiterTail = copyRange(index, totalLength, tailLength, previousTail, chunk);
      }
      return frames;
    } catch (err) {
      const framingError = err instanceof SseFrameTooLargeError
        || err instanceof SseFrameCountLimitError;
      if (framingError && frames.some(frame => isResponsesTerminalFrame(frame.block))) {
        // A terminal frame is the Responses protocol boundary. Ignore malformed
        // or oversized bytes that occur later in the same upstream chunk rather
        // than retroactively replacing the committed terminal with a 502.
        this.clear();
        this.disposed = true;
        return frames;
      }
      throw err;
    }
  }

  /** Bytes retained for an unfinished frame, including a possible delimiter prefix. */
  get pendingBytes(): number {
    return this.candidateBytes + this.delimiterTail.byteLength;
  }

  /** Return the final unterminated block bytes and release all retained state. */
  finish(): Uint8Array {
    if (this.disposed) return EMPTY_BYTES;
    try {
      this.retain(this.delimiterTail);
      this.delimiterTail = EMPTY_BYTES;
      return this.takeCandidate();
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
