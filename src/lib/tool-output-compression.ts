/**
 * Outbound tool-output token efficiency pipeline:
 * 1. Linear-time ANSI CSI/OSC stripping and carriage-return progress folding.
 * 2. Bounded, depth-checked lossless JSON minification for pretty-printed tool payloads.
 * 3. Repetitive CLI/build/test log line & progress-counter folding with strict
 *    unified-diff and error/stack-trace preservation.
 * 4. Cross-turn identical non-error tool-output deduplication with unambiguous call-ID guards
 *    (adapted from Apache-2.0 reference gateway patterns — see `THIRD_PARTY_NOTICES.md`).
 * 5. Line-boundary-aware head/tail excerpt slicing with UTF-16 surrogate safety
 *    (adapted from Apache-2.0 reference gateway patterns — see `THIRD_PARTY_NOTICES.md`).
 */
import { createHash } from "node:crypto";
import { CopyOnWriteMutator, type CopyOnWriteSegment } from "./mutable-json-copy";

export interface ToolOutputCompressionConfig {
  enabled?: boolean;
  minChars?: number;
  headChars?: number;
  tailChars?: number;
  stripAnsi?: boolean;
  compactJson?: boolean;
  foldRepetitiveLines?: boolean;
  deduplicateIdentical?: boolean;
  dedupMinChars?: number;
}

export interface ToolOutputCompressionResult {
  compressedItems: number;
  savedChars: number;
  compactedJsonItems?: number;
  foldedLogItems?: number;
  deduplicatedItems?: number;
  estimatedSavedTokens?: number;
  body?: unknown;
}

export const MAX_COMPRESSIBLE_STRING_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_COMPACT_BYTES = 512 * 1024;
export const MAX_JSON_NESTING_DEPTH = 64;
export const MAX_FOLD_LINES = 8_192;
const MAX_SCAN_ITEMS = 4_096;
const MAX_DEDUP_TRACKED = 512;
const MAX_CSI_SEQUENCE_LEN = 256;
const MAX_OSC_SEQUENCE_LEN = 4_096;
const DEFAULT_MIN_CHARS = 12_000;
const DEFAULT_HEAD_CHARS = 4_000;
const DEFAULT_TAIL_CHARS = 4_000;
const DEFAULT_DEDUP_MIN_CHARS = 512;
const MIN_USEFUL_SAVINGS = 64;
const MIN_JSON_COMPACT_SAVINGS = 32;
const SAFE_CALL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEDUP_MARKER_PREFIX = "[easyproxy deduplicated tool output:";
const COMPRESSED_MARKER_FRAGMENT = "...[easyproxy compressed ";

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

const RFC_OBJ_FIRST = 1;
const RFC_OBJ_KEY   = 2;
const RFC_OBJ_COLON = 3;
const RFC_OBJ_VAL   = 4;
const RFC_OBJ_NEXT  = 5;
const RFC_ARR_FIRST = 6;
const RFC_ARR_VAL   = 7;
const RFC_ARR_NEXT  = 8;

function isRfc8259Whitespace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function isHexDigit(ch: number): boolean {
  return (ch >= 0x30 && ch <= 0x39)
    || (ch >= 0x41 && ch <= 0x46)
    || (ch >= 0x61 && ch <= 0x66);
}

function scanJsonStringEnd(src: string, start: number): number {
  const len = src.length;
  let i = start + 1;
  while (i < len) {
    const ch = src.charCodeAt(i);
    if (ch === 0x22) return i + 1;
    if (ch < 0x20) return -1;
    if (ch === 0x5c) {
      if (i + 1 >= len) return -1;
      const esc = src.charCodeAt(i + 1);
      if (esc === 0x75) {
        if (i + 5 >= len) return -1;
        if (
          !isHexDigit(src.charCodeAt(i + 2))
          || !isHexDigit(src.charCodeAt(i + 3))
          || !isHexDigit(src.charCodeAt(i + 4))
          || !isHexDigit(src.charCodeAt(i + 5))
        ) {
          return -1;
        }
        i += 6;
        continue;
      }
      if (
        esc !== 0x22 && esc !== 0x5c && esc !== 0x2f && esc !== 0x62
        && esc !== 0x66 && esc !== 0x6e && esc !== 0x72 && esc !== 0x74
      ) {
        return -1;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

function scanJsonNumberEnd(src: string, start: number): number {
  const len = src.length;
  let i = start;
  if (i < len && src.charCodeAt(i) === 0x2d) i += 1;
  if (i >= len) return -1;
  const firstDigit = src.charCodeAt(i);
  if (firstDigit === 0x30) {
    i += 1;
    if (i < len) {
      const next = src.charCodeAt(i);
      if (next >= 0x30 && next <= 0x39) return -1;
    }
  } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
    i += 1;
    while (i < len) {
      const ch = src.charCodeAt(i);
      if (ch < 0x30 || ch > 0x39) break;
      i += 1;
    }
  } else {
    return -1;
  }
  if (i < len && src.charCodeAt(i) === 0x2e) {
    i += 1;
    if (i >= len) return -1;
    const fracDigit = src.charCodeAt(i);
    if (fracDigit < 0x30 || fracDigit > 0x39) return -1;
    i += 1;
    while (i < len) {
      const ch = src.charCodeAt(i);
      if (ch < 0x30 || ch > 0x39) break;
      i += 1;
    }
  }
  if (i < len) {
    const exp = src.charCodeAt(i);
    if (exp === 0x65 || exp === 0x45) {
      i += 1;
      if (i < len) {
        const sign = src.charCodeAt(i);
        if (sign === 0x2b || sign === 0x2d) i += 1;
      }
      if (i >= len) return -1;
      const expDigit = src.charCodeAt(i);
      if (expDigit < 0x30 || expDigit > 0x39) return -1;
      i += 1;
      while (i < len) {
        const ch = src.charCodeAt(i);
        if (ch < 0x30 || ch > 0x39) break;
        i += 1;
      }
    }
  }
  return i;
}

/**
 * Single-pass iterative RFC 8259 JSON validator and lossless lexical minifier.
 * Preserves exact original number, escape, and duplicate-key token substrings verbatim.
 */
function minifyRfc8259JsonBounded(input: string, maxDepth: number): string | null {
  const len = input.length;
  let i = 0;
  while (i < len && isRfc8259Whitespace(input.charCodeAt(i))) i += 1;
  if (i >= len) return null;

  const first = input.charCodeAt(i);
  if (first !== 0x7b && first !== 0x5b) return null;

  const stack = new Uint8Array(maxDepth);
  stack[0] = first === 0x7b ? RFC_OBJ_FIRST : RFC_ARR_FIRST;
  let depth = 1;
  let keepStart = i;
  i += 1;
  let out = "";

  const finishValue = () => {
    if (depth === 0) return;
    const top = stack[depth - 1]!;
    if (top === RFC_OBJ_VAL) stack[depth - 1] = RFC_OBJ_NEXT;
    else if (top === RFC_ARR_FIRST || top === RFC_ARR_VAL) stack[depth - 1] = RFC_ARR_NEXT;
  };

  while (i < len) {
    if (isRfc8259Whitespace(input.charCodeAt(i))) {
      if (i > keepStart) out += input.slice(keepStart, i);
      while (i < len && isRfc8259Whitespace(input.charCodeAt(i))) i += 1;
      keepStart = i;
      if (i >= len) break;
    }

    if (depth === 0) return null;
    const ch = input.charCodeAt(i);
    const state = stack[depth - 1]!;

    if (state === RFC_OBJ_FIRST || state === RFC_OBJ_KEY) {
      if (ch === 0x7d && state === RFC_OBJ_FIRST) {
        depth -= 1;
        i += 1;
        if (depth === 0) break;
        finishValue();
        continue;
      }
      if (ch !== 0x22) return null;
      const end = scanJsonStringEnd(input, i);
      if (end < 0) return null;
      i = end;
      stack[depth - 1] = RFC_OBJ_COLON;
      continue;
    }

    if (state === RFC_OBJ_COLON) {
      if (ch !== 0x3a) return null;
      i += 1;
      stack[depth - 1] = RFC_OBJ_VAL;
      continue;
    }

    if (state === RFC_OBJ_NEXT) {
      if (ch === 0x2c) {
        i += 1;
        stack[depth - 1] = RFC_OBJ_KEY;
        continue;
      }
      if (ch === 0x7d) {
        depth -= 1;
        i += 1;
        if (depth === 0) break;
        finishValue();
        continue;
      }
      return null;
    }

    if (state === RFC_ARR_NEXT) {
      if (ch === 0x2c) {
        i += 1;
        stack[depth - 1] = RFC_ARR_VAL;
        continue;
      }
      if (ch === 0x5d) {
        depth -= 1;
        i += 1;
        if (depth === 0) break;
        finishValue();
        continue;
      }
      return null;
    }

    if (ch === 0x5d && state === RFC_ARR_FIRST) {
      depth -= 1;
      i += 1;
      if (depth === 0) break;
      finishValue();
      continue;
    }
    if (ch === 0x7b) {
      if (depth >= maxDepth) return null;
      stack[depth++] = RFC_OBJ_FIRST;
      i += 1;
      continue;
    }
    if (ch === 0x5b) {
      if (depth >= maxDepth) return null;
      stack[depth++] = RFC_ARR_FIRST;
      i += 1;
      continue;
    }
    if (ch === 0x22) {
      const end = scanJsonStringEnd(input, i);
      if (end < 0) return null;
      i = end;
      finishValue();
      continue;
    }
    if (ch === 0x74 && input.startsWith("true", i)) {
      i += 4;
      finishValue();
      continue;
    }
    if (ch === 0x66 && input.startsWith("false", i)) {
      i += 5;
      finishValue();
      continue;
    }
    if (ch === 0x6e && input.startsWith("null", i)) {
      i += 4;
      finishValue();
      continue;
    }
    if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
      const end = scanJsonNumberEnd(input, i);
      if (end < 0) return null;
      i = end;
      finishValue();
      continue;
    }
    return null;
  }

  if (depth !== 0) return null;
  if (i > keepStart) out += input.slice(keepStart, i);
  while (i < len) {
    if (!isRfc8259Whitespace(input.charCodeAt(i))) return null;
    i += 1;
  }
  return out;
}

/**
 * Losslessly minifies pretty-printed JSON tool payloads when within strict byte
 * and nesting-depth bounds and when minification saves meaningful characters.
 */
export function compactJsonToolText(input: string): { text: string; compacted: boolean } {
  if (input.length < 64 || input.length > MAX_JSON_COMPACT_BYTES) {
    return { text: input, compacted: false };
  }
  if (input.indexOf("\n") === -1 && input.indexOf("  ") === -1 && input.indexOf("\t") === -1) {
    return { text: input, compacted: false };
  }
  if (input.length * 3 > MAX_JSON_COMPACT_BYTES && Buffer.byteLength(input, "utf8") > MAX_JSON_COMPACT_BYTES) {
    return { text: input, compacted: false };
  }
  const minified = minifyRfc8259JsonBounded(input, MAX_JSON_NESTING_DEPTH);
  if (minified !== null && input.length - minified.length >= MIN_JSON_COMPACT_SAVINGS) {
    return { text: minified, compacted: true };
  }
  return { text: input, compacted: false };
}

function snapSliceBounds(text: string, headChars: number, tailChars: number): { headEnd: number; tailStart: number } {
  let headEnd = headChars;
  if (headEnd > 0 && headEnd < text.length) {
    const nl = text.lastIndexOf("\n", headEnd);
    if (nl > 0 && nl >= Math.floor(headEnd * 0.75)) {
      headEnd = nl;
    } else {
      const last = text.charCodeAt(headEnd - 1);
      if (last >= 0xd800 && last <= 0xdbff) headEnd -= 1;
    }
  }

  let tailStart = tailChars > 0 ? text.length - tailChars : text.length;
  if (tailStart > 0 && tailStart < text.length) {
    const nl = text.indexOf("\n", tailStart);
    if (nl !== -1 && nl + 1 < text.length && nl + 1 <= tailStart + Math.floor(tailChars * 0.25)) {
      tailStart = nl + 1;
    } else {
      const first = text.charCodeAt(tailStart);
      if (first >= 0xdc00 && first <= 0xdfff) tailStart += 1;
    }
  }
  return { headEnd, tailStart };
}

const PROGRESS_SKELETON_HAZARD_RE =
  /(?:error|err!|warn|fail|panic|exception|assert|traceback|fatal|undefined reference|symbol\(s\) not found|unresolved|cannot find|collect2:|(?:\s|^)ld:|segfault|segmentation fault|killed|aborted|permission denied|non-zero|exit status\s+[1-9]|exit code\s*[:=]?\s*[1-9])/i;
const STACK_FRAME_LINE_RE = /^(?:\s+at\s+\S|\s*File\s+"[^"]+",\s+line\s+\d+|Caused by:|Traceback\s+\()/;
const BUILD_STEP_LEADING_RE =
  /^[[(](\d{1,6})\s*\/\s*(\d{1,6})[\])]\s+(Compiling|Building|Linking|Bundling|Transforming|Fetching|Downloading|Extracting|Uploading|Checking|Scanning|Processing|Installing|Unpacking|Copying|Generating)\b/i;
const BUILD_STEP_VERB_RATIO_RE =
  /^(Compiling|Building|Linking|Bundling|Transforming|Fetching|Downloading|Extracting|Uploading|Checking|Scanning|Processing|Installing|Unpacking|Copying|Generating)\s+\S+(?:\s+v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)?\s+[[(](\d{1,6})\s*\/\s*(\d{1,6})[\])]$/i;

interface ParsedProgressLine {
  skeleton: string;
  value: number;
}

function looksLikeUnifiedDiffText(text: string): boolean {
  if (
    text.startsWith("diff --git ")
    || text.startsWith("--- ")
    || text.startsWith("Index: ")
    || text.startsWith("@@ ")
  ) {
    return true;
  }
  return (
    text.includes("\ndiff --git ")
    || (text.includes("\n--- ") && text.includes("\n+++ "))
    || text.includes("\n@@ -")
  );
}

function parseProgressLine(line: string): ParsedProgressLine | null {
  const trimmed = line.trim();
  if (trimmed.length < 16 || trimmed.length > 240) return null;
  const first = trimmed.charCodeAt(0);
  // Never treat diff hunk lines, markdown table rows, or stack frames as progress lines.
  if (first === 0x2b || first === 0x2d || first === 0x40 || first === 0x7c) return null;
  if (STACK_FRAME_LINE_RE.test(line) || PROGRESS_SKELETON_HAZARD_RE.test(trimmed)) return null;

  // 1. Multi-file build step counters (`[12/400] Building ...` or `Compiling foo v1.0 (12/42)`)
  //    keyed by exact build verb + fixed total denominator, requiring monotonic step progression.
  const leadMatch = BUILD_STEP_LEADING_RE.exec(trimmed);
  if (leadMatch) {
    const step = Number(leadMatch[1]);
    const total = Number(leadMatch[2]);
    if (total >= 4 && step >= 1 && step <= total) {
      return { skeleton: `build:${leadMatch[3]!.toLowerCase()}/${total}`, value: step };
    }
  }
  const verbMatch = BUILD_STEP_VERB_RATIO_RE.exec(trimmed);
  if (verbMatch) {
    const step = Number(verbMatch[2]);
    const total = Number(verbMatch[3]);
    if (total >= 4 && step >= 1 && step <= total) {
      return { skeleton: `build:${verbMatch[1]!.toLowerCase()}/${total}`, value: step };
    }
  }

  // 2. Single-subject progress redraws (`Downloading bundle (1/18) 6%`, `Uploading [===>  ] 45% 12MB/s`):
  //    non-progress subject words/identifiers (`node-1`, `row 2`) are NEVER wildcarded, denominator
  //    in `step/total` stays fixed, and progress value must advance monotonically.
  let hasProgressToken = false;
  let ratioStep: number | null = null;
  let pctValue: number | null = null;
  let barFillValue: number | null = null;
  let invalidRatio = false;

  const skeleton = trimmed
    .replace(/\b(\d{1,3}(?:\.\d+)?)%/g, (_m, num: string) => {
      const parsed = Number(num);
      if (parsed > 100) return _m;
      hasProgressToken = true;
      if (pctValue === null) pctValue = parsed;
      return "<pct>";
    })
    .replace(/([([ ])(\d{1,6})\s*\/\s*(\d{1,6})([)\]\s]|$)/g, (full, pre: string, sRaw: string, tRaw: string, post: string) => {
      const step = Number(sRaw);
      const total = Number(tRaw);
      if (total < 4 || step < 0 || step > total) {
        invalidRatio = true;
        return full;
      }
      hasProgressToken = true;
      if (ratioStep === null) ratioStep = step;
      return `${pre}<step>/${total}${post}`;
    })
    .replace(/\[([#=>.\-\s]{5,40})\]/g, (_m, inner: string) => {
      hasProgressToken = true;
      if (barFillValue === null) {
        let filled = 0;
        for (let k = 0; k < inner.length; k++) {
          const ch = inner.charCodeAt(k);
          if (ch === 0x23 || ch === 0x3d || ch === 0x3e) filled += 1;
        }
        barFillValue = filled;
      }
      return "[<bar>]";
    });

  if (!hasProgressToken || invalidRatio) return null;
  // Normalize only unit-qualified telemetry figures (e.g. `14ms`, `4.2 MB/s`), never bare entity IDs (`node-1`).
  const normalizedSkeleton = skeleton.replace(
    /\b\d+(?:\.\d+)?\s*(?:ms|s|kb|mb|gb|tb|kib|mib|gib|b\/s|kb\/s|mb\/s|gb\/s)\b/gi,
    "<unit>",
  );
  const value = ratioStep ?? pctValue ?? barFillValue ?? 0;
  return { skeleton: `redraw:${normalizedSkeleton}`, value };
}

// Command-aware consecutive passing test line matcher (adapted from rtk-ai/rtk, Apache-2.0).
// Explicitly matches unambiguous passing test status lines across Bun/Vitest/Jest/Cargo/Pytest/Go,
// while leaving failures, skips, stack traces, warnings, and summaries completely untouched.
const PASS_TRAILING_HAZARD_RE = /\b(?:FAIL(?:ED)?|SKIP(?:PED)?|TODO|IGNORED|XFAIL|ERROR)\s*$/i;
const PASS_BUN_VITEST_MARK_RE = /^\s*(?:✓|✔)\s+\S.{1,260}$/;
const PASS_BUN_ASCII_RE = /^\s*\(pass\)\s+\S.{1,260}$/;
const PASS_JEST_FILE_RE = /^\s*PASS\s+(?:\S+\/)?\S+\.(?:(?:test|spec)\.[A-Za-z0-9]{1,8}|js|ts|jsx|tsx|mjs|cjs)(?:\s+\([^)]+\))?\s*$/;
const PASS_CARGO_TEST_RE = /^\s*test\s+[A-Za-z0-9_:<>.,/-]+(?:\s+\([^)]*\))?\s+\.\.\.\s+ok\s*$/;
const PASS_PYTEST_VERBOSE_RE = /^\s*\S+\.py::\S+\s+PASSED(?:\s+\[\s*\d+%\s*\])?\s*$/;
const PASS_PYTEST_DOTS_RE = /^\s*\S+\.py\s+\.{3,}\s*(?:\[\s*\d+%\s*\])?\s*$/;
const PASS_GO_RUN_RE = /^\s*===\s+RUN\s+(\S+)\s*$/;
const PASS_GO_PASS_RE = /^\s*---\s+PASS:\s+(\S+)(?:\s+\([^)]*\))?\s*$/;
const PASS_GO_PKG_RE = /^\s*ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))(?:\s+coverage:[^\r\n]*)?\s*$/;

interface PassingTestUnit {
  family: string;
  lineCount: number;
}

function classifyPassingTestUnit(lines: string[], index: number): PassingTestUnit | null {
  const line = lines[index]!;
  if (line.length === 0 || line.length > 320 || line.indexOf("\x00") !== -1) return null;
  if (STACK_FRAME_LINE_RE.test(line)) return null;

  // Go verbose pair: exact `=== RUN <name>` immediately followed by `--- PASS: <name>`.
  if (index + 1 < lines.length) {
    const runMatch = PASS_GO_RUN_RE.exec(line);
    if (runMatch) {
      const passMatch = PASS_GO_PASS_RE.exec(lines[index + 1]!);
      if (passMatch && passMatch[1] === runMatch[1]) {
        return { family: "go_test_case", lineCount: 2 };
      }
      return null;
    }
  }

  if (line.indexOf("✗") !== -1 || line.indexOf("×") !== -1 || PASS_TRAILING_HAZARD_RE.test(line)) {
    return null;
  }

  if (PASS_BUN_VITEST_MARK_RE.test(line)) return { family: "bun_vitest_mark", lineCount: 1 };
  if (PASS_BUN_ASCII_RE.test(line)) return { family: "bun_ascii_pass", lineCount: 1 };
  if (PASS_JEST_FILE_RE.test(line)) return { family: "jest_vitest_file", lineCount: 1 };
  if (PASS_CARGO_TEST_RE.test(line)) return { family: "cargo_test", lineCount: 1 };
  if (PASS_PYTEST_VERBOSE_RE.test(line)) return { family: "pytest_verbose", lineCount: 1 };
  if (PASS_PYTEST_DOTS_RE.test(line)) return { family: "pytest_dots", lineCount: 1 };
  if (PASS_GO_PASS_RE.test(line)) return { family: "go_test_case", lineCount: 1 };
  if (PASS_GO_PKG_RE.test(line)) return { family: "go_test_pkg", lineCount: 1 };
  return null;
}

/**
 * Folds runs of identical non-error CLI/log lines (3+), multi-step progress counter
 * sequences (4+), and consecutive passing test lines (4+) in O(N) time while strictly
 * preserving unified diffs, stack traces, and error outputs.
 */
export function foldRepetitiveLogLines(input: string): { text: string; folded: boolean } {
  if (input.length < 160 || input.indexOf("\n") === -1) {
    return { text: input, folded: false };
  }
  if (looksLikeUnifiedDiffText(input)) {
    return { text: input, folded: false };
  }

  let newlineCount = 0;
  for (let pos = input.indexOf("\n"); pos !== -1; pos = input.indexOf("\n", pos + 1)) {
    newlineCount += 1;
    if (newlineCount > MAX_FOLD_LINES) {
      return { text: input, folded: false };
    }
  }
  if (newlineCount < 2) return { text: input, folded: false };

  const lines = input.split("\n");
  let hasStackFrame = false;
  for (let i = 0; i < lines.length; i++) {
    if (STACK_FRAME_LINE_RE.test(lines[i]!)) {
      hasStackFrame = true;
      break;
    }
  }

  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!hasStackFrame) {
      // 1. Fold 3+ consecutive byte-identical non-trivial lines.
      if (trimmed.length >= 4 && !PROGRESS_SKELETON_HAZARD_RE.test(trimmed)) {
        let runEnd = i + 1;
        while (runEnd < lines.length && lines[runEnd] === line) {
          runEnd += 1;
        }
        const count = runEnd - i;
        if (count >= 3) {
          out.push(line);
          out.push(`[... repeated ${count - 1} more times]`);
          changed = true;
          i = runEnd;
          continue;
        }
      }

      // 2. Fold 4+ consecutive monotonic progress/counter lines sharing an identical skeleton, keeping first & last.
      const firstProg = parseProgressLine(line);
      if (firstProg !== null) {
        let runEnd = i + 1;
        let lastValue = firstProg.value;
        while (runEnd < lines.length) {
          const nextProg = parseProgressLine(lines[runEnd]!);
          if (nextProg === null || nextProg.skeleton !== firstProg.skeleton || nextProg.value < lastValue) {
            break;
          }
          lastValue = nextProg.value;
          runEnd += 1;
        }
        const count = runEnd - i;
        if (count >= 4 && lastValue > firstProg.value) {
          out.push(line);
          out.push(`[... ${count - 2} intermediate progress lines folded]`);
          out.push(lines[runEnd - 1]!);
          changed = true;
          i = runEnd;
          continue;
        }
      }
    }

    // 3. Fold 4+ consecutive unambiguous passing test units from the same runner family,
    //    preserving the first, last, and any subsequent failure/summary blocks losslessly.
    const firstPass = classifyPassingTestUnit(lines, i);
    if (firstPass !== null) {
      const units: Array<{ start: number; end: number }> = [{ start: i, end: i + firstPass.lineCount }];
      let cursor = i + firstPass.lineCount;
      while (cursor < lines.length) {
        const nextPass = classifyPassingTestUnit(lines, cursor);
        if (nextPass === null || nextPass.family !== firstPass.family) break;
        units.push({ start: cursor, end: cursor + nextPass.lineCount });
        cursor += nextPass.lineCount;
      }
      if (units.length >= 4) {
        const firstUnit = units[0]!;
        const lastUnit = units[units.length - 1]!;
        for (let k = firstUnit.start; k < firstUnit.end; k++) out.push(lines[k]!);
        out.push(`[... ${units.length - 2} intermediate passing tests folded]`);
        for (let k = lastUnit.start; k < lastUnit.end; k++) out.push(lines[k]!);
        changed = true;
        i = cursor;
        continue;
      }
    }

    out.push(line);
    i += 1;
  }

  if (!changed) return { text: input, folded: false };
  const candidate = out.join("\n");
  if (input.length - candidate.length < MIN_USEFUL_SAVINGS) {
    return { text: input, folded: false };
  }
  return { text: candidate, folded: true };
}

function canonicalizeToolText(
  text: string,
  stripAnsi: boolean,
  compactJson: boolean,
  foldRepetitiveLines: boolean,
  skipFolding = false,
): { canonical: string; compactedJson: boolean; foldedLog: boolean } {
  let canonical = normalizeToolLogText(text, stripAnsi);
  let compactedJson = false;
  let foldedLog = false;
  if (compactJson) {
    const jsonPass = compactJsonToolText(canonical);
    canonical = jsonPass.text;
    compactedJson = jsonPass.compacted;
  }
  if (!compactedJson && foldRepetitiveLines && !skipFolding) {
    const foldPass = foldRepetitiveLogLines(canonical);
    canonical = foldPass.text;
    foldedLog = foldPass.folded;
  }
  return { canonical, compactedJson, foldedLog };
}

function truncateCanonicalToolText(
  canonical: string,
  compactedJson: boolean,
  foldedLog: boolean,
  config: ToolOutputCompressionConfig,
): { text: string; compactedJson: boolean; foldedLog: boolean } {
  const minChars = clampInt(config.minChars, DEFAULT_MIN_CHARS, 512, 500_000);
  const headChars = clampInt(config.headChars, DEFAULT_HEAD_CHARS, 0, 100_000);
  const tailChars = clampInt(config.tailChars, DEFAULT_TAIL_CHARS, 0, 100_000);

  if (canonical.length <= minChars) return { text: canonical, compactedJson, foldedLog };
  if (headChars + tailChars + MIN_USEFUL_SAVINGS >= canonical.length) {
    return { text: canonical, compactedJson, foldedLog };
  }

  const { headEnd, tailStart } = snapSliceBounds(canonical, headChars, tailChars);
  const omitted = tailStart - headEnd;
  if (omitted <= MIN_USEFUL_SAVINGS) return { text: canonical, compactedJson, foldedLog };
  const marker = `\n\n...[easyproxy compressed ${omitted} chars]...\n\n`;
  if (headEnd + (canonical.length - tailStart) + marker.length >= canonical.length) {
    return { text: canonical, compactedJson, foldedLog };
  }

  return {
    text: `${canonical.slice(0, headEnd)}${marker}${canonical.slice(tailStart)}`,
    compactedJson,
    foldedLog,
  };
}

function compressSingleTextWithStats(
  text: string,
  config?: ToolOutputCompressionConfig,
): { text: string; compactedJson: boolean; foldedLog: boolean } {
  if (!config?.enabled) return { text, compactedJson: false, foldedLog: false };
  if (text.length === 0 || text.length > MAX_COMPRESSIBLE_STRING_BYTES) return { text, compactedJson: false, foldedLog: false };
  if (text.length * 3 > MAX_COMPRESSIBLE_STRING_BYTES && Buffer.byteLength(text, "utf8") > MAX_COMPRESSIBLE_STRING_BYTES) {
    return { text, compactedJson: false, foldedLog: false };
  }

  const isErrHead = looksLikeErrorOutput({}, text.slice(0, 256));
  const { canonical, compactedJson, foldedLog } = canonicalizeToolText(
    text,
    config.stripAnsi !== false,
    config.compactJson !== false,
    config.foldRepetitiveLines !== false,
    isErrHead,
  );
  return truncateCanonicalToolText(canonical, compactedJson, foldedLog, config);
}

export function compressToolOutputText(
  text: string,
  config?: ToolOutputCompressionConfig,
): string {
  return compressSingleTextWithStats(text, config).text;
}

const JSON_ERROR_HEAD_RE = /^\{\s*"(?:error|is_error)"\s*:\s*(?:true|"|\{)/;
const NONZERO_EXIT_HEAD_RE = /^exit\s+code\s*:\s*[1-9]/i;

function hasContainerErrorFlag(container?: Record<string, unknown>): boolean {
  return container !== undefined
    && (container.is_error === true || container.status === "error" || container.status === "failed");
}

function looksLikeErrorOutput(
  container: Record<string, unknown>,
  normalizedText: string,
  parentContainer?: Record<string, unknown>,
): boolean {
  if (hasContainerErrorFlag(container) || hasContainerErrorFlag(parentContainer)) {
    return true;
  }
  const head = normalizedText.slice(0, 192).trimStart();
  if (!head) return false;
  return (
    head.startsWith("Error:")
    || head.startsWith("error:")
    || head.startsWith("ERROR:")
    || head.startsWith("Traceback (most recent call last)")
    || head.startsWith("Exception:")
    || head.startsWith("Fatal:")
    || head.startsWith("FAIL ")
    || head.startsWith("[error]")
    || head.startsWith("npm ERR!")
    || head.startsWith("panic:")
    || JSON_ERROR_HEAD_RE.test(head)
    || NONZERO_EXIT_HEAD_RE.test(head)
  );
}

interface DedupSeenEntry {
  callId: string;
  canonicalText: string;
  wireChars: number;
}

interface CompressionWalkState {
  compressedItems: number;
  savedChars: number;
  compactedJsonItems: number;
  foldedLogItems: number;
  deduplicatedItems: number;
  visited: number;
  dedupScanComplete: boolean;
  resultIdCounts: Map<string, number>;
  assistantCallCounts: Map<string, number>;
  seenByDigest: Map<string, DedupSeenEntry>;
}

function recordCallId(counts: Map<string, number>, rawId: unknown): void {
  if (typeof rawId !== "string" || !SAFE_CALL_ID_RE.test(rawId)) return;
  counts.set(rawId, (counts.get(rawId) ?? 0) + 1);
}

/**
 * Counts tool-call and tool-result IDs across the scanned prefix (up to `MAX_SCAN_ITEMS`)
 * so prefix tool outputs remain deterministically deduplicated even when a conversation
 * grows beyond `MAX_SCAN_ITEMS`, while any IDs beyond the horizon remain unrecorded.
 */
function precountToolCallIds(
  record: Record<string, unknown>,
  resultCounts: Map<string, number>,
  assistantCallCounts: Map<string, number>,
): boolean {
  let visited = 0;
  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      if (visited >= MAX_SCAN_ITEMS) return false;
      visited += 1;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.type === "function_call_output" || entry.type === "custom_tool_call_output") {
        recordCallId(resultCounts, entry.call_id);
      } else if (entry.type === "function_call" || entry.type === "custom_tool_call") {
        recordCallId(assistantCallCounts, entry.call_id);
      }
    }
  }
  if (Array.isArray(record.messages)) {
    for (const msg of record.messages) {
      if (visited >= MAX_SCAN_ITEMS) return false;
      visited += 1;
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
      const entry = msg as Record<string, unknown>;
      if (entry.role === "tool") {
        recordCallId(resultCounts, entry.tool_call_id);
      } else if (entry.role === "assistant") {
        if (Array.isArray(entry.tool_calls)) {
          for (const tc of entry.tool_calls) {
            if (visited >= MAX_SCAN_ITEMS) return false;
            visited += 1;
            if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
            recordCallId(assistantCallCounts, (tc as Record<string, unknown>).id);
          }
        }
        if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (visited >= MAX_SCAN_ITEMS) return false;
            visited += 1;
            if (!block || typeof block !== "object" || Array.isArray(block)) continue;
            const blockRec = block as Record<string, unknown>;
            if (blockRec.type === "tool_use") {
              recordCallId(assistantCallCounts, blockRec.id);
            }
          }
        }
      } else if (entry.role === "user" && Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (visited >= MAX_SCAN_ITEMS) return false;
          visited += 1;
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          const blockRec = block as Record<string, unknown>;
          if (blockRec.type === "tool_result") {
            recordCallId(resultCounts, blockRec.tool_use_id);
          }
        }
      }
    }
  }
  if (Array.isArray(record.contents)) {
    for (const content of record.contents) {
      if (visited >= MAX_SCAN_ITEMS) return false;
      visited += 1;
      if (!content || typeof content !== "object" || Array.isArray(content)) continue;
      const parts = (content as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (visited >= MAX_SCAN_ITEMS) return false;
        visited += 1;
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const partRec = part as Record<string, unknown>;
        const fnCall = partRec.functionCall;
        if (fnCall && typeof fnCall === "object" && !Array.isArray(fnCall)) {
          recordCallId(assistantCallCounts, (fnCall as Record<string, unknown>).id);
        }
        const fnResp = partRec.functionResponse;
        if (fnResp && typeof fnResp === "object" && !Array.isArray(fnResp)) {
          recordCallId(resultCounts, (fnResp as Record<string, unknown>).id);
        }
      }
    }
  }
  return true;
}

function isUnambiguousCallId(callId: unknown, state: CompressionWalkState): callId is string {
  if (typeof callId !== "string" || !SAFE_CALL_ID_RE.test(callId)) return false;
  if (state.resultIdCounts.get(callId) !== 1) return false;
  return (state.assistantCallCounts.get(callId) ?? 0) <= 1;
}

function compressOutputPart(
  obj: Record<string, unknown>,
  field: string,
  config: ToolOutputCompressionConfig,
  state: CompressionWalkState,
  callId?: unknown,
  parentContainer?: Record<string, unknown>,
  mutator?: CopyOnWriteMutator,
  path?: readonly CopyOnWriteSegment[],
): void {
  const value = obj[field];
  if (typeof value !== "string") return;
  if (value.length === 0 || value.length > MAX_COMPRESSIBLE_STRING_BYTES) return;
  if (value.length * 3 > MAX_COMPRESSIBLE_STRING_BYTES && Buffer.byteLength(value, "utf8") > MAX_COMPRESSIBLE_STRING_BYTES) {
    return;
  }

  const isErrorLike = looksLikeErrorOutput(obj, value.slice(0, 256), parentContainer);
  const { canonical, compactedJson, foldedLog } = canonicalizeToolText(
    value,
    config.stripAnsi !== false,
    config.compactJson !== false,
    config.foldRepetitiveLines !== false,
    isErrorLike,
  );

  let recordedEntry: DedupSeenEntry | undefined;
  if (
    callId !== undefined
    && config.deduplicateIdentical !== false
    && isUnambiguousCallId(callId, state)
    && !value.startsWith(DEDUP_MARKER_PREFIX)
    && !value.includes(COMPRESSED_MARKER_FRAGMENT)
    && !isErrorLike
    && !looksLikeErrorOutput(obj, canonical, parentContainer)
  ) {
    const dedupMinChars = clampInt(config.dedupMinChars, DEFAULT_DEDUP_MIN_CHARS, 128, 500_000);
    if (canonical.length >= dedupMinChars) {
      const digest = createHash("sha256").update(canonical).digest("hex");
      const prior = state.seenByDigest.get(digest);
      if (prior && prior.callId !== callId && prior.canonicalText === canonical) {
        const stub = `${DEDUP_MARKER_PREFIX} identical to call_id=${prior.callId} (${prior.wireChars} chars)]`;
        if (value.length - stub.length >= MIN_USEFUL_SAVINGS) {
          if (mutator && path) mutator.write(path, stub);
          else obj[field] = stub;
          state.compressedItems += 1;
          state.deduplicatedItems += 1;
          state.savedChars += value.length - stub.length;
          return;
        }
      } else if (!prior && state.seenByDigest.size < MAX_DEDUP_TRACKED) {
        recordedEntry = { callId, canonicalText: canonical, wireChars: canonical.length };
        state.seenByDigest.set(digest, recordedEntry);
      }
    }
  }

  const { text: compressed } = truncateCanonicalToolText(canonical, compactedJson, foldedLog, config);
  if (recordedEntry) {
    recordedEntry.wireChars = compressed !== value ? compressed.length : value.length;
  }
  if (compressed === value) return;
  if (mutator && path) mutator.write(path, compressed);
  else obj[field] = compressed;
  const saved = Math.max(0, value.length - compressed.length);
  if (saved > 0) {
    state.compressedItems += 1;
    state.savedChars += saved;
    if (compactedJson) state.compactedJsonItems += 1;
    if (foldedLog) state.foldedLogItems += 1;
  }
}

function compressTextBlocks(
  blocks: unknown[],
  config: ToolOutputCompressionConfig,
  state: CompressionWalkState,
  singleTextCallId?: unknown,
  parentContainer?: Record<string, unknown>,
  mutator?: CopyOnWriteMutator,
  blocksPath?: readonly CopyOnWriteSegment[],
): void {
  const canDedupSinglePart = singleTextCallId !== undefined
    && parentContainer !== undefined
    && blocks.length === 1;
  for (let i = 0; i < blocks.length; i += 1) {
    const part = blocks[i];
    if (state.visited >= MAX_SCAN_ITEMS) break;
    state.visited += 1;
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const partRec = part as Record<string, unknown>;
    if (partRec.type !== "input_text" && partRec.type !== "output_text" && partRec.type !== "text") continue;
    compressOutputPart(
      partRec,
      "text",
      config,
      state,
      canDedupSinglePart ? singleTextCallId : undefined,
      parentContainer,
      mutator,
      blocksPath ? [...blocksPath, { container: blocks, key: i }, { container: partRec, key: "text" }] : undefined,
    );
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
    return {
      compressedItems: 0,
      savedChars: 0,
      compactedJsonItems: 0,
      foldedLogItems: 0,
      deduplicatedItems: 0,
      estimatedSavedTokens: 0,
      body,
    };
  }

  const record = body as Record<string, unknown>;
  const mutator = new CopyOnWriteMutator(body);
  const state: CompressionWalkState = {
    compressedItems: 0,
    savedChars: 0,
    compactedJsonItems: 0,
    foldedLogItems: 0,
    deduplicatedItems: 0,
    visited: 0,
    dedupScanComplete: false,
    resultIdCounts: new Map(),
    assistantCallCounts: new Map(),
    seenByDigest: new Map(),
  };

  if (config.deduplicateIdentical !== false) {
    state.dedupScanComplete = precountToolCallIds(record, state.resultIdCounts, state.assistantCallCounts);
  }

  if (Array.isArray(record.input)) {
    for (let i = 0; i < record.input.length; i += 1) {
      const item = record.input[i];
      if (state.visited >= MAX_SCAN_ITEMS) break;
      state.visited += 1;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (entry.type !== "function_call_output" && entry.type !== "custom_tool_call_output") {
        continue;
      }
      const entryPath: CopyOnWriteSegment[] = [
        { container: record, key: "input" },
        { container: record.input, key: i },
      ];
      if (typeof entry.output === "string") {
        compressOutputPart(
          entry,
          "output",
          config,
          state,
          entry.call_id,
          undefined,
          mutator,
          [...entryPath, { container: entry, key: "output" }],
        );
      } else if (Array.isArray(entry.output)) {
        compressTextBlocks(
          entry.output,
          config,
          state,
          entry.call_id,
          entry,
          mutator,
          [...entryPath, { container: entry, key: "output" }],
        );
      }
    }
  }

  if (Array.isArray(record.messages)) {
    for (let i = 0; i < record.messages.length; i += 1) {
      const msg = record.messages[i];
      if (state.visited >= MAX_SCAN_ITEMS) break;
      state.visited += 1;
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
      const entry = msg as Record<string, unknown>;
      const msgPath: CopyOnWriteSegment[] = [
        { container: record, key: "messages" },
        { container: record.messages, key: i },
      ];
      if (entry.role === "tool") {
        if (typeof entry.content === "string") {
          compressOutputPart(
            entry,
            "content",
            config,
            state,
            entry.tool_call_id,
            undefined,
            mutator,
            [...msgPath, { container: entry, key: "content" }],
          );
        } else if (Array.isArray(entry.content)) {
          compressTextBlocks(
            entry.content,
            config,
            state,
            entry.tool_call_id,
            entry,
            mutator,
            [...msgPath, { container: entry, key: "content" }],
          );
        }
      } else if (entry.role === "user" && Array.isArray(entry.content)) {
        for (let j = 0; j < entry.content.length; j += 1) {
          const block = entry.content[j];
          if (state.visited >= MAX_SCAN_ITEMS) break;
          state.visited += 1;
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          const blockRec = block as Record<string, unknown>;
          if (blockRec.type !== "tool_result") continue;
          const blockPath: CopyOnWriteSegment[] = [
            ...msgPath,
            { container: entry, key: "content" },
            { container: entry.content, key: j },
          ];
          if (typeof blockRec.content === "string") {
            compressOutputPart(
              blockRec,
              "content",
              config,
              state,
              blockRec.tool_use_id,
              undefined,
              mutator,
              [...blockPath, { container: blockRec, key: "content" }],
            );
          } else if (Array.isArray(blockRec.content)) {
            compressTextBlocks(
              blockRec.content,
              config,
              state,
              blockRec.tool_use_id,
              blockRec,
              mutator,
              [...blockPath, { container: blockRec, key: "content" }],
            );
          }
        }
      }
    }
  }

  if (Array.isArray(record.contents)) {
    for (let i = 0; i < record.contents.length; i += 1) {
      const content = record.contents[i];
      if (state.visited >= MAX_SCAN_ITEMS) break;
      state.visited += 1;
      if (!content || typeof content !== "object" || Array.isArray(content)) continue;
      const contentRec = content as Record<string, unknown>;
      if (!Array.isArray(contentRec.parts)) continue;
      const contentPath: CopyOnWriteSegment[] = [
        { container: record, key: "contents" },
        { container: record.contents, key: i },
        { container: contentRec, key: "parts" },
      ];
      for (let j = 0; j < contentRec.parts.length; j += 1) {
        const part = contentRec.parts[j];
        if (state.visited >= MAX_SCAN_ITEMS) break;
        state.visited += 1;
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const partRec = part as Record<string, unknown>;
        const fnResp = partRec.functionResponse;
        if (!fnResp || typeof fnResp !== "object" || Array.isArray(fnResp)) continue;
        const fnRespRec = fnResp as Record<string, unknown>;
        const respObj = fnRespRec.response;
        if (!respObj || typeof respObj !== "object" || Array.isArray(respObj)) continue;
        const respRec = respObj as Record<string, unknown>;
        const respPath: CopyOnWriteSegment[] = [
          ...contentPath,
          { container: contentRec.parts, key: j },
          { container: partRec, key: "functionResponse" },
          { container: fnRespRec, key: "response" },
        ];
        const hasErrorField = respRec.error !== undefined || respRec.is_error === true;
        const errorHint = hasErrorField ? { ...fnRespRec, is_error: true } : fnRespRec;
        const callId = typeof fnRespRec.id === "string" ? fnRespRec.id : undefined;
        const stringKeys = Object.keys(respRec).filter(k => typeof respRec[k] === "string");
        const canDedupField = callId !== undefined && stringKeys.length === 1;
        for (const key of stringKeys) {
          compressOutputPart(
            respRec,
            key,
            config,
            state,
            canDedupField ? callId : undefined,
            errorHint,
            mutator,
            [...respPath, { container: respRec, key }],
          );
        }
      }
    }
  }

  return {
    compressedItems: state.compressedItems,
    savedChars: state.savedChars,
    compactedJsonItems: state.compactedJsonItems,
    foldedLogItems: state.foldedLogItems,
    deduplicatedItems: state.deduplicatedItems,
    estimatedSavedTokens: Math.floor(state.savedChars / 4),
    body: mutator.root,
  };
}
