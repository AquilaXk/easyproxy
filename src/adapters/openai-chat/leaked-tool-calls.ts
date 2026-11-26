import { coerceIntegerToolArguments } from "../../lib/tool-argument-integers";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { modelInList, namespacedToolName, type AdapterEvent, type EpxProviderConfig, type EpxTool } from "../../types";
import {
  MAX_STANDALONE_CANDIDATES,
  SerializedToolCallContentBuffer,
  type FreeformToolIdentity,
  type StructuredToolCallReference,
} from "./serialized-tool-call-content";
import { contextAfter, type TextContext } from "./serialized-tool-call-markup";
import { StandaloneBareToolCallBuffer } from "./standalone-bare-tool-calls";
import type { OpenAIChatToolNameRegistry } from "./tool-name-registry";

const MAX_HARMONY_HEADER_CHARS = 512;
const MAX_XML_OPENER_CHARS = 256;
const MAX_CALL_BYTES = 2 * 1024 * 1024;
const MAX_TURN_RECOVERY_BYTES = 4 * 1024 * 1024;
const MAX_XML_PARAMETERS_PER_CALL = 128;
const RESERVED_XML_PARAM_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const XML_FUNCTION_PREFIX = "<function";
const XML_WS_RE = /\s/;

const GPT_OSS_MODEL_RE = /(?:^|[/-])gpt-oss(?=$|[-.:/])/i;
const HARMONY_TO_RE = /\bto=functions\.([A-Za-z0-9_.:-]+)(?:\s*(?:<\|constrain\|>[A-Za-z0-9_-]*\s*)?)?$/;
const ANTML_INVOKE_OPEN_RE = /^<antml:invoke\s+name=(?:"([A-Za-z0-9_.:-]+)"|'([A-Za-z0-9_.:-]+)')\s*(\/?)>/;
const XML_FUNCTION_OPEN_RE = /^<function\s+name=(?:"([A-Za-z0-9_.:-]+)"|'([A-Za-z0-9_.:-]+)')\s*(\/?)>/;
const PARAMETER_OPEN_RE = /^<(antml:)?parameter\s+name=(?:"([^"\r\n<>]+)"|'([^'\r\n<>]+)')\s*>/;
const WRAPPER_TAG_PAIRS = [
  { open: "<antml:function_calls>", close: "</antml:function_calls>" },
  { open: "<function_calls>", close: "</function_calls>" },
  { open: "<tool_calls>", close: "</tool_calls>" },
] as const;

export interface DeclaredLeakedTool {
  readonly wireName: string;
  readonly emitName: string;
  readonly parameters?: Record<string, unknown>;
}

export interface LeakedToolCallOptions {
  readonly enableHarmony: boolean;
  readonly enableXml: boolean;
  readonly declaredTools: ReadonlyMap<string, DeclaredLeakedTool>;
}

export interface RecoveredLeakedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly start: number;
  readonly end: number;
}

export interface LeakedToolCallRecoveryResult {
  readonly calls: RecoveredLeakedToolCall[];
  readonly removedRanges: Array<{ start: number; end: number }>;
  readonly remainingText: string;
  readonly overflowed: boolean;
}

export function isGptOssModel(modelId: string | undefined): boolean {
  return typeof modelId === "string" && GPT_OSS_MODEL_RE.test(modelId.trim());
}

/**
 * Enable leaked-markup tool-call recovery only when tools are declared and either the
 * model is a `gpt-oss` family model (Harmony) or explicitly listed in `leakedToolCallModels`
 * (XML `<antml:invoke>` / `<function name=...>` plus Harmony).
 */
export function resolveLeakedToolCallOptions(
  provider: Pick<EpxProviderConfig, "leakedToolCallModels">,
  modelId: string | undefined,
  tools: readonly EpxTool[] | undefined,
  registry: OpenAIChatToolNameRegistry,
): LeakedToolCallOptions | undefined {
  if (!modelId || !tools || tools.length === 0) return undefined;
  const enableXml = modelInList(provider.leakedToolCallModels, modelId);
  const enableHarmony = isGptOssModel(modelId) || enableXml;
  if (!enableHarmony && !enableXml) return undefined;

  const declaredTools = new Map<string, DeclaredLeakedTool>();
  const rawNameOwners = new Map<string, DeclaredLeakedTool | null>();
  for (const tool of tools) {
    const wireName = registry.alias(tool);
    const rawName = namespacedToolName(tool.namespace, tool.name);
    const parameters = tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
      ? tool.parameters as Record<string, unknown>
      : undefined;
    const spec: DeclaredLeakedTool = { wireName, emitName: rawName, parameters };
    declaredTools.set(wireName, spec);
    if (rawName !== wireName) {
      const existing = rawNameOwners.get(rawName);
      rawNameOwners.set(rawName, existing === undefined ? spec : null);
    }
  }
  for (const [rawName, spec] of rawNameOwners) {
    if (spec && !declaredTools.has(rawName)) {
      declaredTools.set(rawName, spec);
    }
  }
  return declaredTools.size > 0 ? { enableHarmony, enableXml, declaredTools } : undefined;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ParsedMatch {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly arguments: string;
  readonly bytes: number;
}

interface ScanRun {
  s: number;
  m: number;
}

/**
 * Forward-progress token scanner that caches `(from, firstMatch)` runs so repeated
 * unclosed or nested openers never re-scan already inspected text.
 */
class ForwardTokenMatcher {
  private runs: ScanRun[] = [];
  private head = 0;

  constructor(private readonly findNext: (from: number, stopAt: number | undefined) => number) {}

  nextAtOrAfter(from: number, floor: number): number {
    while (this.head < this.runs.length) {
      const first = this.runs[this.head]!;
      if (first.m !== -1 && first.m < floor) {
        this.head += 1;
      } else {
        break;
      }
    }
    if (this.head > 1024 && this.head * 2 >= this.runs.length) {
      this.runs = this.runs.slice(this.head);
      this.head = 0;
    }

    const len = this.runs.length;
    if (this.head < len) {
      const last = this.runs[len - 1]!;
      if (from >= last.s) {
        if (last.m === -1 || from <= last.m) return last.m;
        const m = this.findNext(from, undefined);
        if (this.head === len - 1 && last.m < floor) {
          last.s = from;
          last.m = m;
        } else {
          this.runs.push({ s: from, m });
        }
        return m;
      }
      let lo = this.head;
      let hi = len - 1;
      let prevIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (this.runs[mid]!.s <= from) {
          prevIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (prevIdx !== -1) {
        const prev = this.runs[prevIdx]!;
        if (prev.m === -1 || from <= prev.m) return prev.m;
      }
      const nextIdx = prevIdx === -1 ? this.head : prevIdx + 1;
      const nextRun = nextIdx < len ? this.runs[nextIdx] : undefined;
      if (nextRun) {
        const foundBeforeNext = this.findNext(from, nextRun.s);
        if (foundBeforeNext === -1) {
          nextRun.s = from;
          return nextRun.m;
        }
        this.runs.splice(nextIdx, 0, { s: from, m: foundBeforeNext });
        return foundBeforeNext;
      }
    }

    const m = this.findNext(from, undefined);
    this.runs.push({ s: from, m });
    return m;
  }

  isExhaustedAfter(floor: number): boolean {
    const last = this.runs[this.runs.length - 1];
    return last !== undefined && last.m === -1 && last.s <= floor;
  }
}

function isXmlWhitespaceChar(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code === 32 || code === 9 || code === 10 || code === 13) return true;
  if (code < 128) return code === 11 || code === 12;
  return XML_WS_RE.test(text[index]!);
}

function isXmlWhitespacePos(text: string, index: number): boolean {
  return index < text.length && isXmlWhitespaceChar(text, index);
}

function findXmlFunctionNameOpener(text: string, from: number, stopAt: number | undefined): number {
  let cursor = from;
  const limit = stopAt ?? text.length;
  const sliceEnd = stopAt === undefined ? text.length : Math.min(text.length, stopAt + XML_FUNCTION_PREFIX.length - 1);
  if (from >= sliceEnd) return -1;
  const window = stopAt === undefined ? text : text.slice(from, sliceEnd);
  const windowBase = stopAt === undefined ? 0 : from;
  while (cursor < limit) {
    const rel = window.indexOf(XML_FUNCTION_PREFIX, cursor - windowBase);
    const idx = rel === -1 ? -1 : windowBase + rel;
    if (idx === -1 || idx >= limit) return -1;
    let i = idx + XML_FUNCTION_PREFIX.length;
    const wsStart = i;
    while (i < text.length && isXmlWhitespaceChar(text, i)) i += 1;
    if (i > wsStart && text.startsWith("name=", i)) return idx;
    cursor = i > wsStart ? i : idx + XML_FUNCTION_PREFIX.length;
  }
  return -1;
}

class LeakedScanCursor {
  private readonly matchers = new Map<string, ForwardTokenMatcher>();
  private xmlFunctionOpenerMatcher: ForwardTokenMatcher | undefined;

  constructor(private readonly text: string) {}

  nextLiteral(token: string, from: number, floor: number): number {
    let matcher = this.matchers.get(token);
    if (!matcher) {
      const text = this.text;
      matcher = new ForwardTokenMatcher((start, stopAt) => {
        if (stopAt === undefined) return text.indexOf(token, start);
        const end = Math.min(text.length, stopAt + token.length - 1);
        if (start >= end) return -1;
        const rel = text.slice(start, end).indexOf(token);
        return rel === -1 ? -1 : start + rel;
      });
      this.matchers.set(token, matcher);
    }
    return matcher.nextAtOrAfter(from, floor);
  }

  nextXmlFunctionOpener(from: number, floor: number): number {
    if (!this.xmlFunctionOpenerMatcher) {
      const text = this.text;
      this.xmlFunctionOpenerMatcher = new ForwardTokenMatcher((start, stopAt) => findXmlFunctionNameOpener(text, start, stopAt));
    }
    return this.xmlFunctionOpenerMatcher.nextAtOrAfter(from, floor);
  }

  isExhausted(token: string, floor: number): boolean {
    const matcher = this.matchers.get(token);
    return matcher ? matcher.isExhaustedAfter(floor) : false;
  }
}

function parseHarmonyCallAt(
  text: string,
  channelStart: number,
  spanStart: number,
  declaredTools: ReadonlyMap<string, DeclaredLeakedTool>,
  scanner: LeakedScanCursor,
): ParsedMatch | undefined {
  const headerStart = channelStart + "<|channel|>".length;
  if (scanner.isExhausted("<|message|>", headerStart) || scanner.isExhausted("<|call|>", headerStart)) {
    return undefined;
  }
  const msgIdx = scanner.nextLiteral("<|message|>", headerStart, spanStart);
  if (msgIdx === -1 || msgIdx - headerStart > MAX_HARMONY_HEADER_CHARS) return undefined;

  const header = text.slice(headerStart, msgIdx);
  if (header.includes("<|channel|>") || header.includes("<|end|>") || header.includes("<|call|>") || header.includes("<|start|>")) {
    return undefined;
  }
  const toMatch = HARMONY_TO_RE.exec(header.trim());
  if (!toMatch) return undefined;
  const toolName = toMatch[1]!;
  const spec = declaredTools.get(toolName);
  if (!spec) return undefined;

  const argsStart = msgIdx + "<|message|>".length;
  const callIdx = scanner.nextLiteral("<|call|>", argsStart, spanStart);
  if (callIdx === -1 || callIdx - argsStart > MAX_CALL_BYTES) return undefined;
  const nextChannel = scanner.nextLiteral("<|channel|>", argsStart, spanStart);
  if (nextChannel !== -1 && nextChannel < callIdx) return undefined;
  const nextMsg = scanner.nextLiteral("<|message|>", argsStart, spanStart);
  if (nextMsg !== -1 && nextMsg < callIdx) return undefined;
  const nextStart = scanner.nextLiteral("<|start|>", argsStart, spanStart);
  if (nextStart !== -1 && nextStart < callIdx) return undefined;

  const rawSlice = text.slice(argsStart, callIdx);
  const bytes = Buffer.byteLength(rawSlice, "utf8");
  if (bytes > MAX_CALL_BYTES) return undefined;

  const trimmedArgs = rawSlice.trim();
  if (!trimmedArgs.startsWith("{")) return undefined;
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(trimmedArgs);
  } catch {
    return undefined;
  }
  if (!isPlainJsonObject(parsedArgs)) return undefined;
  const argumentsText = coerceIntegerToolArguments(trimmedArgs, spec.parameters, spec.emitName);
  return {
    start: spanStart,
    end: callIdx + "<|call|>".length,
    name: spec.emitName,
    arguments: argumentsText,
    bytes: Buffer.byteLength(argumentsText, "utf8"),
  };
}

function coerceXmlParamValue(
  rawValue: string,
  paramName: string,
  parameters: Record<string, unknown> | undefined,
): unknown {
  const props = parameters && isPlainJsonObject(parameters.properties)
    ? parameters.properties
    : undefined;
  const propSchema = props && Object.hasOwn(props, paramName) && isPlainJsonObject(props[paramName])
    ? props[paramName]
    : undefined;
  const schemaType = typeof propSchema?.type === "string"
    ? propSchema.type
    : Array.isArray(propSchema?.type)
      ? propSchema.type.find(t => t !== "null")
      : undefined;

  const trimmed = rawValue.trim();
  if (schemaType === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return rawValue;
  }
  if (schemaType === "integer" || schemaType === "number") {
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return schemaType === "integer" && Number.isInteger(n) ? n : schemaType === "number" ? n : rawValue;
    }
    return rawValue;
  }
  if (schemaType === "object" || schemaType === "array") {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (schemaType === "array" ? Array.isArray(parsed) : isPlainJsonObject(parsed)) {
        return parsed;
      }
    } catch {
      return rawValue;
    }
    return rawValue;
  }
  if (schemaType === undefined && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isPlainJsonObject(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      // Keep raw string when not valid structured JSON.
    }
  }
  return rawValue;
}

function parseXmlCallAt(
  text: string,
  pos: number,
  declaredTools: ReadonlyMap<string, DeclaredLeakedTool>,
  scanner: LeakedScanCursor,
  floor: number,
  limit = text.length,
): ParsedMatch | undefined {
  const isAntml = text.startsWith("<antml:invoke", pos);
  const tagClose: "</antml:invoke>" | "</function>" = isAntml ? "</antml:invoke>" : "</function>";
  if (scanner.isExhausted(tagClose, pos)) {
    const gt = scanner.nextLiteral(">", pos + (isAntml ? "<antml:invoke".length : XML_FUNCTION_PREFIX.length), floor);
    if (gt === -1 || gt >= limit || gt - pos >= MAX_XML_OPENER_CHARS || text[gt - 1] !== "/") {
      return undefined;
    }
  }
  const openerSlice = text.slice(pos, Math.min(limit, pos + MAX_XML_OPENER_CHARS));
  const match = isAntml ? ANTML_INVOKE_OPEN_RE.exec(openerSlice) : XML_FUNCTION_OPEN_RE.exec(openerSlice);
  if (!match) return undefined;

  const toolName = (match[1] ?? match[2] ?? "").trim();
  const selfClosing = match[3] === "/";
  const spec = declaredTools.get(toolName);
  if (!spec) return undefined;

  const bodyStart = pos + match[0].length;
  if (selfClosing) {
    return {
      start: pos,
      end: bodyStart,
      name: spec.emitName,
      arguments: "{}",
      bytes: 2,
    };
  }

  const closeIdx = scanner.nextLiteral(tagClose, bodyStart, floor);
  if (closeIdx === -1 || closeIdx + tagClose.length > limit || closeIdx - bodyStart > MAX_CALL_BYTES) {
    return undefined;
  }
  const nextAntml = scanner.nextLiteral("<antml:invoke", bodyStart, floor);
  if (nextAntml !== -1 && nextAntml < closeIdx) return undefined;
  const nextXmlFn = scanner.nextXmlFunctionOpener(bodyStart, floor);
  if (nextXmlFn !== -1 && nextXmlFn < closeIdx) return undefined;

  const body = text.slice(bodyStart, closeIdx);
  if (Buffer.byteLength(body, "utf8") > MAX_CALL_BYTES) return undefined;

  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let cursor = 0;
  let paramCount = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor += 1;
    if (cursor >= body.length) break;
    const paramOpen = PARAMETER_OPEN_RE.exec(body.slice(cursor, cursor + MAX_XML_OPENER_CHARS));
    if (!paramOpen) return undefined;
    paramCount += 1;
    if (paramCount > MAX_XML_PARAMETERS_PER_CALL) return undefined;

    const isAntmlParam = paramOpen[1] === "antml:";
    const paramName = paramOpen[2] ?? paramOpen[3] ?? "";
    if (!paramName || RESERVED_XML_PARAM_KEYS.has(paramName)) return undefined;
    const paramCloseTag = isAntmlParam ? "</antml:parameter>" : "</parameter>";
    const valueStart = cursor + paramOpen[0].length;
    const paramCloseIdx = body.indexOf(paramCloseTag, valueStart);
    if (paramCloseIdx === -1) return undefined;

    const paramRaw = body.slice(valueStart, paramCloseIdx);
    if ((isAntmlParam ? /<antml:parameter\s/ : /<parameter\s/).test(paramRaw)) return undefined;
    Object.defineProperty(args, paramName, {
      value: coerceXmlParamValue(paramRaw, paramName, spec.parameters),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    cursor = paramCloseIdx + paramCloseTag.length;
  }

  const serialized = JSON.stringify(args);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CALL_BYTES) return undefined;
  const argumentsText = coerceIntegerToolArguments(serialized, spec.parameters, spec.emitName);
  return {
    start: pos,
    end: closeIdx + tagClose.length,
    name: spec.emitName,
    arguments: argumentsText,
    bytes: Buffer.byteLength(argumentsText, "utf8"),
  };
}

export function removeTextRanges(
  text: string,
  removed: readonly { start: number; end: number }[],
): string {
  if (removed.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of removed) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join("");
}

function isLiteralTextContext(ctx: TextContext): boolean {
  return ctx.fence !== null || (ctx.inlineTicks ?? 0) > 0 || ctx.literalLine === true;
}

function parseXmlWrapperAt(
  text: string,
  pos: number,
  declaredTools: ReadonlyMap<string, DeclaredLeakedTool>,
  scanner: LeakedScanCursor,
): { end: number; calls: ParsedMatch[] } | undefined {
  const wrapper = WRAPPER_TAG_PAIRS.find(pair => text.startsWith(pair.open, pos));
  if (!wrapper) return undefined;
  const innerStart = pos + wrapper.open.length;
  const closeIdx = scanner.nextLiteral(wrapper.close, innerStart, pos);
  if (closeIdx === -1 || closeIdx - innerStart > MAX_TURN_RECOVERY_BYTES) return undefined;

  const calls: ParsedMatch[] = [];
  let cursor = innerStart;
  let totalBytes = 0;
  while (cursor < closeIdx) {
    while (cursor < closeIdx && /\s/.test(text[cursor]!)) cursor += 1;
    if (cursor >= closeIdx) break;
    const match = parseXmlCallAt(text, cursor, declaredTools, scanner, pos, closeIdx);
    if (!match) return undefined;
    totalBytes += match.bytes;
    if (calls.length >= MAX_STANDALONE_CANDIDATES || totalBytes > MAX_TURN_RECOVERY_BYTES) return undefined;
    calls.push({
      ...match,
      start: pos,
      end: closeIdx + wrapper.close.length,
    });
    cursor = match.end;
  }
  if (calls.length === 0) return undefined;
  if (closeIdx - innerStart > Math.floor(MAX_TURN_RECOVERY_BYTES / 3)
    && Buffer.byteLength(text.slice(innerStart, closeIdx), "utf8") > MAX_TURN_RECOVERY_BYTES) {
    return undefined;
  }
  return { end: closeIdx + wrapper.close.length, calls };
}

/**
 * Scan completed assistant text outside code fences and inline code for leaked tool call markup.
 * Fails closed on unclosed tags, unknown tool names, malformed JSON, or exceeded batch caps.
 */
export function recoverLeakedToolCallsFromText(
  text: string,
  options: LeakedToolCallOptions | undefined,
  nextCallId: () => string,
  initialContext: TextContext = { fence: null, lineStart: true },
): LeakedToolCallRecoveryResult {
  if (!options || !text) {
    return { calls: [], removedRanges: [], remainingText: text, overflowed: false };
  }
  const matches: ParsedMatch[] = [];
  const removedRanges: Array<{ start: number; end: number }> = [];
  const scanner = new LeakedScanCursor(text);
  let ctx = initialContext;
  let ctxOffset = 0;
  let cursor = 0;
  let totalRecoveredBytes = 0;

  while (cursor < text.length) {
    const pos = text.indexOf("<", cursor);
    if (pos === -1) break;
    const isXmlFunctionOpener = options.enableXml && startsWithXmlFunctionOpener(text, pos);
    const isAntmlOpener = options.enableXml && (
      text.startsWith("<antml:function_calls>", pos)
      || (text.startsWith("<antml:invoke", pos) && isXmlWhitespacePos(text, pos + "<antml:invoke".length))
    );
    const isCandidateOpener =
      (options.enableXml && (
        isAntmlOpener
        || isXmlFunctionOpener
        || text.startsWith("<function_calls>", pos)
        || text.startsWith("<tool_calls>", pos)
      ))
      || (options.enableHarmony && (
        text.startsWith("<|channel|>", pos)
        || text.startsWith("<|start|>assistant<|channel|>", pos)
      ));
    if (!isCandidateOpener) {
      cursor = pos + 1;
      continue;
    }
    if (pos > ctxOffset) {
      const needsContextScan = ctx.lineStart
        || ctx.fence !== null
        || (ctx.inlineTicks ?? 0) > 0
        || ctx.literalLine === true
        || (() => {
          const nl = scanner.nextLiteral("\n", ctxOffset, ctxOffset);
          if (nl !== -1 && nl < pos) return true;
          const bt = scanner.nextLiteral("`", ctxOffset, ctxOffset);
          if (bt !== -1 && bt < pos) return true;
          if (pos - ctxOffset >= "<tool_call>".length) {
            const tc = scanner.nextLiteral("<tool_call", ctxOffset, ctxOffset);
            if (tc !== -1 && tc < pos) return true;
          }
          return false;
        })();
      if (needsContextScan) {
        ctx = contextAfter(text.slice(ctxOffset, pos), ctx);
      }
      ctxOffset = pos;
    }
    if (isLiteralTextContext(ctx)) {
      cursor = pos + 1;
      continue;
    }

    if (options.enableXml) {
      const wrapped = parseXmlWrapperAt(text, pos, options.declaredTools, scanner);
      if (wrapped) {
        const wrapperBytes = wrapped.calls.reduce((sum, c) => sum + c.bytes, 0);
        totalRecoveredBytes += wrapperBytes;
        if (matches.length + wrapped.calls.length > MAX_STANDALONE_CANDIDATES || totalRecoveredBytes > MAX_TURN_RECOVERY_BYTES) {
          return { calls: [], removedRanges: [], remainingText: text, overflowed: true };
        }
        matches.push(...wrapped.calls);
        removedRanges.push({ start: pos, end: wrapped.end });
        ctxOffset = wrapped.end;
        cursor = wrapped.end;
        continue;
      }
    }

    let matched: ParsedMatch | undefined;
    if (options.enableHarmony) {
      if (text.startsWith("<|start|>assistant<|channel|>", pos)) {
        matched = parseHarmonyCallAt(text, pos + "<|start|>assistant".length, pos, options.declaredTools, scanner);
      } else if (text.startsWith("<|channel|>", pos)) {
        matched = parseHarmonyCallAt(text, pos, pos, options.declaredTools, scanner);
      }
    }
    if (!matched && options.enableXml) {
      if (isXmlFunctionOpener || (text.startsWith("<antml:invoke", pos) && isXmlWhitespacePos(text, pos + "<antml:invoke".length))) {
        matched = parseXmlCallAt(text, pos, options.declaredTools, scanner, pos);
      }
    }
    if (!matched) {
      cursor = pos + 1;
      continue;
    }

    totalRecoveredBytes += matched.bytes;
    if (matches.length >= MAX_STANDALONE_CANDIDATES || totalRecoveredBytes > MAX_TURN_RECOVERY_BYTES) {
      return { calls: [], removedRanges: [], remainingText: text, overflowed: true };
    }
    matches.push(matched);
    removedRanges.push({ start: matched.start, end: matched.end });
    // Keep matched control bodies opaque to outer Markdown delimiters.
    ctxOffset = matched.end;
    cursor = matched.end;
  }

  if (matches.length === 0) {
    return { calls: [], removedRanges: [], remainingText: text, overflowed: false };
  }
  const calls: RecoveredLeakedToolCall[] = matches.map(m => ({
    id: nextCallId(),
    name: m.name,
    arguments: m.arguments,
    start: m.start,
    end: m.end,
  }));
  return {
    calls,
    removedRanges,
    remainingText: removeTextRanges(text, removedRanges),
    overflowed: false,
  };
}

function removeTextRangesInSpan(
  piece: string,
  spanStart: number,
  removed: readonly { start: number; end: number }[],
): string {
  const spanEnd = spanStart + piece.length;
  const local: Array<{ start: number; end: number }> = [];
  for (const range of removed) {
    if (range.end <= spanStart || range.start >= spanEnd) continue;
    local.push({
      start: Math.max(0, range.start - spanStart),
      end: Math.min(piece.length, range.end - spanStart),
    });
  }
  return removeTextRanges(piece, local);
}

/** Buffered response reconciliation companion to `reconcileStandaloneBareToolCallEvents`. */
export function reconcileLeakedToolCallEvents(
  events: AdapterEvent[],
  contentStart: number,
  contentEnd: number,
  references: readonly StructuredToolCallReference[],
  budget: TranslatorBudget,
  options: LeakedToolCallOptions | undefined,
  stopReason: "max_tokens" | "content_filter" | undefined,
): void {
  if (!options || references.length > 0 || stopReason !== undefined) return;
  const segment = events.slice(contentStart, contentEnd);
  if (segment.some(event => event.type === "tool_call_start")) return;
  const textParts: string[] = [];
  let answerTextLength = 0;
  const spans = new Map<number, { start: number; end: number }>();
  for (let i = 0; i < segment.length; i += 1) {
    const event = segment[i]!;
    if (event.type !== "text_delta") continue;
    const start = answerTextLength;
    answerTextLength += event.text.length;
    spans.set(i, { start, end: answerTextLength });
    textParts.push(event.text);
  }
  const answerText = textParts.join("");
  if (answerText.length === 0 || Buffer.byteLength(answerText, "utf8") > MAX_TURN_RECOVERY_BYTES) return;
  let seq = 0;
  const result = recoverLeakedToolCallsFromText(answerText, options, () => `call_${++seq}`);
  if (result.overflowed || result.calls.length === 0) return;

  const replacement: AdapterEvent[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    const event = segment[i]!;
    if (event.type !== "text_delta") {
      replacement.push(event);
      continue;
    }
    const span = spans.get(i)!;
    const cleaned = removeTextRangesInSpan(event.text, span.start, result.removedRanges);
    if (cleaned.length > 0) replacement.push({ type: "text_delta", text: cleaned });
  }
  for (const call of result.calls) {
    budget.reserveTransient(Buffer.byteLength(call.arguments, "utf8"), { kind: "live_transient" }).release();
    replacement.push(
      { type: "tool_call_start", id: call.id, name: call.name },
      { type: "tool_call_delta", arguments: call.arguments },
      { type: "tool_call_end" },
    );
  }
  events.splice(contentStart, contentEnd - contentStart, ...replacement);
}

const STREAM_OPENERS = [
  "<|start|>assistant<|channel|>",
  "<|channel|>",
  "<antml:function_calls>",
  "<antml:invoke",
  XML_FUNCTION_PREFIX,
  "<function_calls>",
  "<tool_calls>",
] as const;

function startsWithXmlFunctionOpener(text: string, pos: number): boolean {
  return text.startsWith(XML_FUNCTION_PREFIX, pos) && isXmlWhitespacePos(text, pos + XML_FUNCTION_PREFIX.length);
}

function partialOpenerStart(text: string, enableXml: boolean): number {
  const tailStart = Math.max(0, text.length - 32);
  const tail = text.slice(tailStart);
  for (let i = 0; i < tail.length; i += 1) {
    if (tail[i] !== "<") continue;
    const suffix = tail.slice(i);
    if (suffix === "<") return tailStart + i;
    if (suffix.startsWith("<|") && ("<|start|>assistant<|channel|>".startsWith(suffix) || "<|channel|>".startsWith(suffix))) {
      return tailStart + i;
    }
    if (enableXml) {
      for (const opener of STREAM_OPENERS) {
        if (!opener.startsWith("<|") && opener.startsWith(suffix)) return tailStart + i;
      }
    }
  }
  return -1;
}

function findFirstLeakedOpener(text: string, ctx: TextContext, enableHarmony: boolean, enableXml: boolean): { index: number; ctxBefore: TextContext } | undefined {
  let currentCtx = ctx;
  let ctxOffset = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const pos = text.indexOf("<", cursor);
    if (pos === -1) break;
    if (pos > ctxOffset) {
      currentCtx = contextAfter(text.slice(ctxOffset, pos), currentCtx);
      ctxOffset = pos;
    }
    if (!isLiteralTextContext(currentCtx)) {
      if (enableHarmony && (text.startsWith("<|channel|>", pos) || text.startsWith("<|start|>assistant<|channel|>", pos))) {
        return { index: pos, ctxBefore: currentCtx };
      }
      if (enableXml && (
        text.startsWith("<antml:function_calls>", pos)
        || text.startsWith("<antml:invoke", pos)
        || startsWithXmlFunctionOpener(text, pos)
        || text.startsWith("<function_calls>", pos)
        || text.startsWith("<tool_calls>", pos)
      )) {
        return { index: pos, ctxBefore: currentCtx };
      }
    }
    cursor = pos + 1;
  }
  return undefined;
}

export interface OpenAIChatToolContentBuffer {
  readonly releasedAnswerText: boolean;
  ingestStreaming(delta: string): AdapterEvent[];
  hold(event: AdapterEvent): AdapterEvent[];
  hasHeldEvents(): boolean;
  current(): string;
  recoverStandalone(eligible: boolean, nextCallId: () => string, restore: (name: string) => string): Iterable<AdapterEvent>;
  drain(structuredCalls: readonly StructuredToolCallReference[]): AdapterEvent[];
  dispose(): void;
}

function appendedByteLength(tailCode: number, delta: string): number {
  let bytes = Buffer.byteLength(delta, "utf8");
  if (tailCode >= 0xd800 && tailCode <= 0xdbff && delta.length > 0) {
    const headCode = delta.charCodeAt(0);
    if (headCode >= 0xdc00 && headCode <= 0xdfff) {
      bytes += Buffer.byteLength(String.fromCharCode(tailCode, headCode), "utf8") - 6;
    }
  }
  return bytes;
}

/**
 * Composes `StandaloneBareToolCallBuffer` with bounded streaming hold for Harmony/XML leaked calls
 * when enabled for `gpt-oss` or `leakedToolCallModels`.
 */
export class LeakedToolCallStreamBuffer implements OpenAIChatToolContentBuffer {
  private readonly inner: StandaloneBareToolCallBuffer;
  private readonly queued: Array<{ offset: number; event: AdapterEvent }> = [];
  private heldChunks: string[] = [];
  private heldChars = 0;
  private heldTailCharCode = -1;
  private heldBytes = 0;
  private startCtx: TextContext = { fence: null, lineStart: true };
  private streamCtx: TextContext = { fence: null, lineStart: true };
  private holding = false;
  private confirmedOpener = false;
  private disabled = false;

  constructor(
    private readonly budget: TranslatorBudget,
    model: string | undefined,
    freeformTools: ReadonlyMap<string, FreeformToolIdentity>,
    private readonly options: LeakedToolCallOptions,
  ) {
    this.inner = new StandaloneBareToolCallBuffer(budget, model, freeformTools);
  }

  get releasedAnswerText(): boolean {
    return this.inner.releasedAnswerText;
  }

  private materializeHeld(): string {
    if (this.heldChunks.length === 0) return "";
    if (this.heldChunks.length === 1) return this.heldChunks[0]!;
    const joined = this.heldChunks.join("");
    this.heldChunks = [joined];
    return joined;
  }

  private replaceHeld(next: string): void {
    const nextBytes = next.length === 0 ? 0 : Buffer.byteLength(next, "utf8");
    if (nextBytes === this.heldBytes) {
      this.heldChunks = next.length === 0 ? [] : [next];
      this.heldChars = next.length;
      this.heldTailCharCode = next.length > 0 ? next.charCodeAt(next.length - 1) : -1;
      return;
    }
    if (nextBytes === 0) {
      this.budget.releaseRetained(this.heldBytes, { kind: "live_transient" });
      this.heldChunks = [];
      this.heldChars = 0;
      this.heldTailCharCode = -1;
      this.heldBytes = 0;
      return;
    }
    const reservation = this.budget.reserveTransient(nextBytes, { kind: "live_transient" });
    try {
      reservation.commitRetained();
      this.budget.releaseRetained(this.heldBytes, { kind: "live_transient" });
      this.heldChunks = [next];
      this.heldChars = next.length;
      this.heldTailCharCode = next.charCodeAt(next.length - 1);
      this.heldBytes = nextBytes;
    } catch (err) {
      reservation.release();
      throw err;
    }
  }

  private appendHeld(delta: string, deltaBytes: number): void {
    const reservation = this.budget.reserveTransient(deltaBytes, { kind: "live_transient" });
    try {
      reservation.commitRetained();
      if (delta.length > 0) {
        this.heldChunks.push(delta);
        this.heldChars += delta.length;
        this.heldTailCharCode = delta.charCodeAt(delta.length - 1);
      }
      this.heldBytes += deltaBytes;
    } catch (err) {
      reservation.release();
      throw err;
    }
  }

  private releaseAllHeldEvents(): AdapterEvent[] {
    const out: AdapterEvent[] = [];
    const heldText = this.materializeHeld();
    let cursor = 0;
    for (const item of this.queued) {
      if (item.offset > cursor) {
        const piece = heldText.slice(cursor, item.offset);
        if (piece) out.push(...this.inner.ingestStreaming(piece));
        cursor = item.offset;
      }
      out.push(...this.inner.hold(item.event));
    }
    if (cursor < heldText.length) {
      out.push(...this.inner.ingestStreaming(heldText.slice(cursor)));
    }
    this.queued.length = 0;
    this.replaceHeld("");
    this.holding = false;
    this.confirmedOpener = false;
    return out;
  }

  private releaseHeldPrefix(tailIdx: number): AdapterEvent[] {
    const out: AdapterEvent[] = [];
    const heldText = this.materializeHeld();
    let cursor = 0;
    let remainingStart = 0;
    for (let i = 0; i < this.queued.length; i += 1) {
      const item = this.queued[i]!;
      if (item.offset > tailIdx) break;
      if (item.offset > cursor) {
        const piece = heldText.slice(cursor, item.offset);
        if (piece) out.push(...this.inner.ingestStreaming(piece));
        cursor = item.offset;
      }
      out.push(...this.inner.hold(item.event));
      remainingStart = i + 1;
    }
    if (cursor < tailIdx) {
      const piece = heldText.slice(cursor, tailIdx);
      if (piece) out.push(...this.inner.ingestStreaming(piece));
    }
    if (remainingStart > 0) this.queued.splice(0, remainingStart);
    for (const item of this.queued) item.offset -= tailIdx;
    const prefix = heldText.slice(0, tailIdx);
    const tail = heldText.slice(tailIdx);
    this.startCtx = contextAfter(prefix, this.startCtx);
    this.replaceHeld(tail);
    if (isLiteralTextContext(this.startCtx)) {
      return [...out, ...this.releaseAllHeldEvents()];
    }
    return out;
  }

  hasHeldEvents(): boolean {
    return this.holding || this.inner.hasHeldEvents();
  }

  current(): string {
    return this.inner.current() + this.materializeHeld();
  }

  hold(event: AdapterEvent): AdapterEvent[] {
    if (!this.holding) return this.inner.hold(event);
    this.queued.push({ offset: this.heldChars, event });
    return [];
  }

  ingestStreaming(delta: string): AdapterEvent[] {
    if (!delta) return [];
    if (this.disabled) {
      return this.inner.ingestStreaming(delta);
    }
    if (!this.holding) {
      const opener = findFirstLeakedOpener(delta, this.streamCtx, this.options.enableHarmony, this.options.enableXml);
      if (opener) {
        const prefix = delta.slice(0, opener.index);
        const rest = delta.slice(opener.index);
        const out = prefix ? this.inner.ingestStreaming(prefix) : [];
        if (Buffer.byteLength(rest, "utf8") > MAX_TURN_RECOVERY_BYTES) {
          this.disabled = true;
          return [...out, ...this.inner.ingestStreaming(rest)];
        }
        this.startCtx = opener.ctxBefore;
        this.holding = true;
        this.confirmedOpener = true;
        this.replaceHeld(rest);
        return out;
      }
      const tailIdx = partialOpenerStart(delta, this.options.enableXml);
      if (tailIdx !== -1) {
        const prefix = delta.slice(0, tailIdx);
        const tail = delta.slice(tailIdx);
        const prefixCtx = contextAfter(prefix, this.streamCtx);
        if (!isLiteralTextContext(prefixCtx)) {
          const out = prefix ? this.inner.ingestStreaming(prefix) : [];
          this.startCtx = prefixCtx;
          this.streamCtx = contextAfter(tail, prefixCtx);
          this.holding = true;
          this.confirmedOpener = false;
          this.replaceHeld(tail);
          return out;
        }
      }
      this.streamCtx = contextAfter(delta, this.streamCtx);
      return this.inner.ingestStreaming(delta);
    }

    const deltaBytes = appendedByteLength(this.heldTailCharCode, delta);
    if (this.heldBytes + deltaBytes > MAX_TURN_RECOVERY_BYTES) {
      this.disabled = true;
      const released = this.releaseAllHeldEvents();
      return [...released, ...this.inner.ingestStreaming(delta)];
    }
    if (this.confirmedOpener) {
      this.appendHeld(delta, deltaBytes);
      return [];
    }
    this.streamCtx = contextAfter(delta, this.streamCtx);
    const prevHeld = this.materializeHeld();
    const candidate = prevHeld + delta;
    if (findFirstLeakedOpener(candidate, this.startCtx, this.options.enableHarmony, this.options.enableXml)) {
      this.appendHeld(delta, deltaBytes);
      this.confirmedOpener = true;
      return [];
    }
    const tailIdx = partialOpenerStart(candidate, this.options.enableXml);
    if (tailIdx === -1) {
      const released = this.releaseAllHeldEvents();
      return [...released, ...this.inner.ingestStreaming(delta)];
    }
    if (tailIdx === prevHeld.length && this.queued.length === 0) {
      this.startCtx = contextAfter(prevHeld, this.startCtx);
      if (isLiteralTextContext(this.startCtx)) {
        const released = this.releaseAllHeldEvents();
        return [...released, ...this.inner.ingestStreaming(delta)];
      }
      const out = prevHeld ? this.inner.ingestStreaming(prevHeld) : [];
      this.replaceHeld(delta);
      return out;
    }
    this.appendHeld(delta, deltaBytes);
    if (tailIdx > 0) return this.releaseHeldPrefix(tailIdx);
    return [];
  }

  recoverStandalone(
    eligible: boolean,
    nextCallId: () => string,
    restore: (name: string) => string,
  ): AdapterEvent[] {
    if (!eligible || this.disabled || !this.holding) {
      const pre = this.holding ? this.releaseAllHeldEvents() : [];
      return [...pre, ...this.inner.recoverStandalone(eligible, nextCallId, restore)];
    }
    const heldText = this.materializeHeld();
    const result = recoverLeakedToolCallsFromText(heldText, this.options, nextCallId, this.startCtx);
    if (result.overflowed || result.calls.length === 0) {
      const pre = this.releaseAllHeldEvents();
      return [...pre, ...this.inner.recoverStandalone(eligible, nextCallId, restore)];
    }

    const out: AdapterEvent[] = [];
    // Remap queued non-text events past removed spans and keep them behind leading text slices.
    let textCursor = 0;
    let rangeIdx = 0;
    const emitTextSlice = (slice: string): void => {
      if (!slice) return;
      out.push(...this.inner.ingestStreaming(slice));
    };
    const emitUpTo = (targetOffset: number): void => {
      while (textCursor < targetOffset) {
        if (rangeIdx < result.removedRanges.length && result.removedRanges[rangeIdx]!.start < targetOffset) {
          const range = result.removedRanges[rangeIdx]!;
          if (range.start > textCursor) emitTextSlice(heldText.slice(textCursor, range.start));
          textCursor = Math.max(textCursor, range.end);
          if (targetOffset >= range.end) {
            rangeIdx += 1;
            continue;
          }
          break;
        }
        emitTextSlice(heldText.slice(textCursor, targetOffset));
        textCursor = targetOffset;
      }
    };
    for (const item of this.queued) {
      emitUpTo(item.offset);
      out.push(...this.inner.hold(item.event));
    }
    emitUpTo(heldText.length);
    out.push(...this.inner.drain([]));
    for (const call of result.calls) {
      out.push(
        { type: "tool_call_start", id: call.id, name: call.name },
        { type: "tool_call_delta", arguments: call.arguments },
        { type: "tool_call_end" },
      );
    }
    this.queued.length = 0;
    this.replaceHeld("");
    this.holding = false;
    this.confirmedOpener = false;
    return out;
  }

  drain(structuredCalls: readonly StructuredToolCallReference[]): AdapterEvent[] {
    if (!this.holding) return this.inner.drain(structuredCalls);
    const out: AdapterEvent[] = [];
    const heldText = this.materializeHeld();
    let cursor = 0;
    for (const item of this.queued) {
      if (item.offset > cursor) {
        const piece = heldText.slice(cursor, item.offset);
        if (piece) {
          this.inner.ingest(piece);
        }
        cursor = item.offset;
      }
      out.push(...this.inner.hold(item.event));
    }
    if (cursor < heldText.length) {
      this.inner.ingest(heldText.slice(cursor));
    }
    this.queued.length = 0;
    this.replaceHeld("");
    this.holding = false;
    this.confirmedOpener = false;
    return [...out, ...this.inner.drain(structuredCalls)];
  }

  dispose(): void {
    this.budget.releaseRetained(this.heldBytes, { kind: "live_transient" });
    this.heldBytes = 0;
    this.heldChunks = [];
    this.heldChars = 0;
    this.heldTailCharCode = -1;
    this.queued.length = 0;
    this.holding = false;
    this.confirmedOpener = false;
    this.inner.dispose();
  }
}

export function createOpenAIChatToolContentBuffer(
  budget: TranslatorBudget,
  model: string | undefined,
  freeformTools: ReadonlyMap<string, FreeformToolIdentity>,
  leakedOptions?: LeakedToolCallOptions,
): OpenAIChatToolContentBuffer {
  return leakedOptions
    ? new LeakedToolCallStreamBuffer(budget, model, freeformTools, leakedOptions)
    : new StandaloneBareToolCallBuffer(budget, model, freeformTools);
}
