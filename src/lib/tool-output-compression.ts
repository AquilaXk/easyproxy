export interface ToolOutputCompressionConfig {
  enabled?: boolean;
  minChars?: number;
  headChars?: number;
  tailChars?: number;
  stripAnsi?: boolean;
}

export interface ToolOutputCompressionResult {
  compressedItems: number;
  savedChars: number;
}

export const MAX_COMPRESSIBLE_STRING_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_ITEMS = 4_096;
const MAX_CSI_SEQUENCE_LEN = 256;
const MAX_OSC_SEQUENCE_LEN = 4_096;
const DEFAULT_MIN_CHARS = 12_000;
const DEFAULT_HEAD_CHARS = 4_000;
const DEFAULT_TAIL_CHARS = 4_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Strips ANSI CSI (`ESC [ ... final`) and OSC (`ESC ] ... BEL/ST`) control
 * sequences in a single linear pass with zero regular-expression backtracking.
 */
export function stripAnsiControlSequences(input: string): string {
  const firstEsc = input.indexOf("\x1b");
  if (firstEsc === -1) return input;

  let out = input.slice(0, firstEsc);
  let i = firstEsc;
  const len = input.length;

  while (i < len) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b) {
      const nextEsc = input.indexOf("\x1b", i);
      if (nextEsc === -1) {
        out += input.slice(i);
        break;
      }
      out += input.slice(i, nextEsc);
      i = nextEsc;
      continue;
    }

    const next = i + 1 < len ? input.charCodeAt(i + 1) : -1;
    if (next === 0x5b) {
      // CSI sequence: ESC [ <params/intermediates 0x20..0x3F> <final 0x40..0x7E>
      const csiLimit = Math.min(len, i + MAX_CSI_SEQUENCE_LEN);
      let j = i + 2;
      while (j < csiLimit) {
        const ch = input.charCodeAt(j);
        if (ch >= 0x20 && ch <= 0x3f) {
          j += 1;
          continue;
        }
        break;
      }
      if (j < csiLimit && j < len) {
        const finalByte = input.charCodeAt(j);
        if (finalByte >= 0x40 && finalByte <= 0x7e) {
          i = j + 1;
          continue;
        }
      }
      i += 2;
    } else if (next === 0x5d) {
      // OSC sequence terminated by BEL (0x07) or ST (ESC \), bounded and never crossing newlines.
      const oscLimit = Math.min(len, i + MAX_OSC_SEQUENCE_LEN);
      let j = i + 2;
      let terminated = false;
      while (j < oscLimit) {
        const ch = input.charCodeAt(j);
        if (ch === 0x0a || ch === 0x0d) break;
        if (ch === 0x07) {
          j += 1;
          terminated = true;
          break;
        }
        if (ch === 0x1b && j + 1 < len && input.charCodeAt(j + 1) === 0x5c) {
          j += 2;
          terminated = true;
          break;
        }
        j += 1;
      }
      i = terminated ? j : i + 2;
    } else if (next === 0x0a || next === 0x0d) {
      i += 1;
    } else {
      i += next === -1 ? 1 : 2;
    }
  }
  return out;
}

/**
 * Collapses standalone carriage-return (`\r`) progress bar overwrites per line
 * and normalizes 4+ consecutive newlines to 2 blank lines (`\n\n\n`).
 */
export function normalizeToolLogText(input: string, stripAnsi: boolean): string {
  let text = stripAnsi ? stripAnsiControlSequences(input) : input;

  if (text.indexOf("\r") !== -1) {
    let out = "";
    let lineStart = 0;
    const len = text.length;
    while (lineStart <= len) {
      const nl = text.indexOf("\n", lineStart);
      const rawEnd = nl === -1 ? len : nl;
      let end = rawEnd;
      while (end > lineStart && text.charCodeAt(end - 1) === 0x0d) end -= 1;
      const lastCr = text.lastIndexOf("\r", end - 1);
      const keepStart = lastCr >= lineStart ? lastCr + 1 : lineStart;
      out += nl === -1 ? text.slice(keepStart, end) : `${text.slice(keepStart, end)}\n`;
      if (nl === -1) break;
      lineStart = nl + 1;
    }
    text = out;
  }

  return text.indexOf("\n\n\n\n") === -1 ? text : text.replace(/\n{4,}/g, "\n\n\n");
}

export function compressToolOutputText(
  text: string,
  config?: ToolOutputCompressionConfig,
): string {
  if (!config?.enabled) return text;
  if (text.length === 0 || text.length > MAX_COMPRESSIBLE_STRING_BYTES) return text;
  if (text.length * 3 > MAX_COMPRESSIBLE_STRING_BYTES && Buffer.byteLength(text, "utf8") > MAX_COMPRESSIBLE_STRING_BYTES) return text;

  const stripAnsi = config.stripAnsi !== false;
  const minChars = clampInt(config.minChars, DEFAULT_MIN_CHARS, 512, 500_000);
  const headChars = clampInt(config.headChars, DEFAULT_HEAD_CHARS, 0, 100_000);
  const tailChars = clampInt(config.tailChars, DEFAULT_TAIL_CHARS, 0, 100_000);

  let normalized = normalizeToolLogText(text, stripAnsi);
  if (normalized.length <= minChars) return normalized;

  const minUsefulSavings = 64;
  if (headChars + tailChars + minUsefulSavings >= normalized.length) {
    return normalized;
  }

  let headEnd = headChars;
  if (headEnd > 0 && headEnd < normalized.length) {
    const last = normalized.charCodeAt(headEnd - 1);
    if (last >= 0xd800 && last <= 0xdbff) headEnd -= 1;
  }
  let tailStart = tailChars > 0 ? normalized.length - tailChars : normalized.length;
  if (tailStart > 0 && tailStart < normalized.length) {
    const first = normalized.charCodeAt(tailStart);
    if (first >= 0xdc00 && first <= 0xdfff) tailStart += 1;
  }

  const omitted = tailStart - headEnd;
  if (omitted <= minUsefulSavings) return normalized;
  const marker = `\n\n...[easyproxy compressed ${omitted} chars]...\n\n`;
  if (headEnd + (normalized.length - tailStart) + marker.length >= normalized.length) return normalized;

  normalized = `${normalized.slice(0, headEnd)}${marker}${normalized.slice(tailStart)}`;
  return normalized;
}

function compressOutputPart(
  obj: Record<string, unknown>,
  field: string,
  config: ToolOutputCompressionConfig,
): number {
  const value = obj[field];
  if (typeof value !== "string") return 0;
  const compressed = compressToolOutputText(value, config);
  if (compressed === value) return 0;
  obj[field] = compressed;
  return Math.max(0, value.length - compressed.length);
}

function compressTextBlocks(
  blocks: unknown[],
  config: ToolOutputCompressionConfig,
  state: { compressedItems: number; savedChars: number; visited: number },
): void {
  for (const part of blocks) {
    if (state.visited >= MAX_SCAN_ITEMS) break;
    state.visited += 1;
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const partRec = part as Record<string, unknown>;
    if (partRec.type !== "input_text" && partRec.type !== "output_text" && partRec.type !== "text") continue;
    const saved = compressOutputPart(partRec, "text", config);
    if (saved > 0) {
      state.compressedItems += 1;
      state.savedChars += saved;
    }
  }
}

/**
 * Deterministically compresses historical tool-output entries inside Responses `input[]`
 * or Chat/Messages `messages[]` (including Anthropic `tool_result` blocks) without mutating
 * system instructions, developer/user prompts, or tool definitions.
 */
export function compressResponsesToolOutputsInPlace(
  body: unknown,
  config?: ToolOutputCompressionConfig,
): ToolOutputCompressionResult {
  if (!config?.enabled || !body || typeof body !== "object" || Array.isArray(body)) {
    return { compressedItems: 0, savedChars: 0 };
  }

  const record = body as Record<string, unknown>;
  const state = { compressedItems: 0, savedChars: 0, visited: 0 };

  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      if (state.visited >= MAX_SCAN_ITEMS) break;
      state.visited += 1;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.type !== "function_call_output" && entry.type !== "custom_tool_call_output") {
        continue;
      }
      if (typeof entry.output === "string") {
        const saved = compressOutputPart(entry, "output", config);
        if (saved > 0) {
          state.compressedItems += 1;
          state.savedChars += saved;
        }
      } else if (Array.isArray(entry.output)) {
        compressTextBlocks(entry.output, config, state);
      }
    }
  }

  if (Array.isArray(record.messages)) {
    for (const msg of record.messages) {
      if (state.visited >= MAX_SCAN_ITEMS) break;
      state.visited += 1;
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
      const entry = msg as Record<string, unknown>;
      if (entry.role === "tool") {
        if (typeof entry.content === "string") {
          const saved = compressOutputPart(entry, "content", config);
          if (saved > 0) {
            state.compressedItems += 1;
            state.savedChars += saved;
          }
        } else if (Array.isArray(entry.content)) {
          compressTextBlocks(entry.content, config, state);
        }
      } else if (entry.role === "user" && Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (state.visited >= MAX_SCAN_ITEMS) break;
          state.visited += 1;
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          const blockRec = block as Record<string, unknown>;
          if (blockRec.type !== "tool_result") continue;
          if (typeof blockRec.content === "string") {
            const saved = compressOutputPart(blockRec, "content", config);
            if (saved > 0) {
              state.compressedItems += 1;
              state.savedChars += saved;
            }
          } else if (Array.isArray(blockRec.content)) {
            compressTextBlocks(blockRec.content, config, state);
          }
        }
      }
    }
  }

  return { compressedItems: state.compressedItems, savedChars: state.savedChars };
}
