export const DEFAULT_MAX_JSON_NESTING_DEPTH = 256;

export class JsonNestingDepthExceededError extends Error {
  readonly code = "json_nesting_depth_exceeded";

  constructor(
    readonly depth: number,
    readonly maxDepth: number = DEFAULT_MAX_JSON_NESTING_DEPTH,
  ) {
    super(`JSON nesting depth exceeds maximum of ${maxDepth}`);
    this.name = "JsonNestingDepthExceededError";
  }
}

/**
 * Single-pass RFC 8259 UTF-8 byte scanner that rejects nesting beyond `maxDepth`
 * before `JSON.parse` allocates AST or stack frames. Uses O(1) auxiliary space.
 */
export function assertJsonNestingDepth(
  bytes: Uint8Array,
  maxDepth: number = DEFAULT_MAX_JSON_NESTING_DEPTH,
): void {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError("maxDepth must be a positive safe integer");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (b === 0x5c) {
        escaped = true;
      } else if (b === 0x22) {
        inString = false;
      }
      continue;
    }
    if (b === 0x22) {
      inString = true;
    } else if (b === 0x7b || b === 0x5b) {
      depth += 1;
      if (depth > maxDepth) {
        throw new JsonNestingDepthExceededError(depth, maxDepth);
      }
    } else if (b === 0x7d || b === 0x5d) {
      if (depth > 0) depth -= 1;
    }
  }
}
