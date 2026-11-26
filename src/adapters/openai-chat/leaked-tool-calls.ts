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

function parseHarmonyCallAt(
  text: string,
  channelStart: number,
  spanStart: number,
  declaredTools: ReadonlyMap<string, DeclaredLeakedTool>,
): ParsedMatch | undefined {
  const headerStart = channelStart + "<|channel|>".length;
  const msgIdx = text.indexOf("<|message|>", headerStart);
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
  const callIdx = text.indexOf("<|call|>", argsStart);
  if (callIdx === -1) return undefined;
  const rawSlice = text.slice(argsStart, callIdx);
  const bytes = Buffer.byteLength(rawSlice, "utf8");
  if (bytes > MAX_CALL_BYTES) return undefined;
  if (rawSlice.includes("<|channel|>") || rawSlice.includes("<|message|>") || rawSlice.includes("<|start|>")) {
    return undefined;
  }

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
  const propSchema = props && isPlainJsonObject(props[paramName])
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
): ParsedMatch | undefined {
  const openerSlice = text.slice(pos, pos + MAX_XML_OPENER_CHARS);
  let tagClose: "</antml:invoke>" | "</function>";
  let match = ANTML_INVOKE_OPEN_RE.exec(openerSlice);
  if (match) {
    tagClose = "</antml:invoke>";
  } else {
    match = XML_FUNCTION_OPEN_RE.exec(openerSlice);
    if (!match) return undefined;
    tagClose = "</function>";
  }

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

  const closeIdx = text.indexOf(tagClose, bodyStart);
  if (closeIdx === -1) return undefined;
  const body = text.slice(bodyStart, closeIdx);
  if (Buffer.byteLength(body, "utf8") > MAX_CALL_BYTES) return undefined;
  if (body.includes("<antml:invoke") || /<function\s+name=/.test(body)) {
    return undefined;
  }

  const args: Record<string, unknown> = {};
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
    const paramCloseTag = isAntmlParam ? "</antml:parameter>" : "</parameter>";
    const valueStart = cursor + paramOpen[0].length;
    const paramCloseIdx = body.indexOf(paramCloseTag, valueStart);
    if (paramCloseIdx === -1) return undefined;

    const paramRaw = body.slice(valueStart, paramCloseIdx);
    if (paramRaw.includes(`<${isAntmlParam ? "antml:" : ""}parameter `)) return undefined;
    args[paramName] = coerceXmlParamValue(paramRaw, paramName, spec.parameters);
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
): { end: number; calls: ParsedMatch[] } | undefined {
  const wrapper = WRAPPER_TAG_PAIRS.find(pair => text.startsWith(pair.open, pos));
  if (!wrapper) return undefined;
  const innerStart = pos + wrapper.open.length;
  const closeIdx = text.indexOf(wrapper.close, innerStart);
  if (closeIdx === -1) return undefined;
  const body = text.slice(innerStart, closeIdx);
  if (Buffer.byteLength(body, "utf8") > MAX_TURN_RECOVERY_BYTES) return undefined;

  const calls: ParsedMatch[] = [];
  let cursor = 0;
  let totalBytes = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor += 1;
    if (cursor >= body.length) break;
    const match = parseXmlCallAt(body, cursor, declaredTools);
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
  return calls.length > 0 ? { end: closeIdx + wrapper.close.length, calls } : undefined;
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
  let ctx = initialContext;
  let ctxOffset = 0;
  let cursor = 0;
  let totalRecoveredBytes = 0;

  while (cursor < text.length) {
    const pos = text.indexOf("<", cursor);
    if (pos === -1) break;
    if (pos > ctxOffset) {
      ctx = contextAfter(text.slice(ctxOffset, pos), ctx);
      ctxOffset = pos;
    }
    if (isLiteralTextContext(ctx)) {
      cursor = pos + 1;
      continue;
    }

    if (options.enableXml) {
      const wrapped = parseXmlWrapperAt(text, pos, options.declaredTools);
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
        matched = parseHarmonyCallAt(text, pos + "<|start|>assistant".length, pos, options.declaredTools);
      } else if (text.startsWith("<|channel|>", pos)) {
        matched = parseHarmonyCallAt(text, pos, pos, options.declaredTools);
      }
    }
    if (!matched && options.enableXml) {
      if (text.startsWith("<antml:invoke", pos) || text.startsWith("<function", pos)) {
        matched = parseXmlCallAt(text, pos, options.declaredTools);
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
  "<function ",
  "<function_calls>",
  "<tool_calls>",
] as const;

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
        || text.startsWith("<function ", pos)
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

/**
 * Composes `StandaloneBareToolCallBuffer` with bounded streaming hold for Harmony/XML leaked calls
 * when enabled for `gpt-oss` or `leakedToolCallModels`.
 */
export class LeakedToolCallStreamBuffer implements OpenAIChatToolContentBuffer {
  private readonly inner: StandaloneBareToolCallBuffer;
  private readonly queued: Array<{ offset: number; event: AdapterEvent }> = [];
  private heldText = "";
  private heldBytes = 0;
  private startCtx: TextContext = { fence: null, lineStart: true };
  private streamCtx: TextContext = { fence: null, lineStart: true };
  private holding = false;
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

  private replaceHeld(next: string): void {
    const nextBytes = Buffer.byteLength(next, "utf8");
    const reservation = this.budget.reserveTransient(nextBytes, { kind: "live_transient" });
    try {
      reservation.commitRetained();
      this.budget.releaseRetained(this.heldBytes, { kind: "live_transient" });
      this.heldText = next;
      this.heldBytes = nextBytes;
    } catch (err) {
      reservation.release();
      throw err;
    }
  }

  private releaseAllHeldEvents(): AdapterEvent[] {
    const out: AdapterEvent[] = [];
    let cursor = 0;
    for (const item of this.queued) {
      if (item.offset > cursor) {
        const piece = this.heldText.slice(cursor, item.offset);
        if (piece) out.push(...this.inner.ingestStreaming(piece));
        cursor = item.offset;
      }
      out.push(...this.inner.hold(item.event));
    }
    if (cursor < this.heldText.length) {
      out.push(...this.inner.ingestStreaming(this.heldText.slice(cursor)));
    }
    this.queued.length = 0;
    this.replaceHeld("");
    this.holding = false;
    return out;
  }

  hasHeldEvents(): boolean {
    return this.holding || this.inner.hasHeldEvents();
  }

  current(): string {
    return this.inner.current() + this.heldText;
  }

  hold(event: AdapterEvent): AdapterEvent[] {
    if (!this.holding) return this.inner.hold(event);
    this.queued.push({ offset: this.heldText.length, event });
    return [];
  }

  ingestStreaming(delta: string): AdapterEvent[] {
    if (!delta) return [];
    if (this.disabled) {
      this.streamCtx = contextAfter(delta, this.streamCtx);
      return this.inner.ingestStreaming(delta);
    }
    if (!this.holding) {
      const opener = findFirstLeakedOpener(delta, this.streamCtx, this.options.enableHarmony, this.options.enableXml);
      if (opener) {
        const prefix = delta.slice(0, opener.index);
        const rest = delta.slice(opener.index);
        const out = prefix ? this.inner.ingestStreaming(prefix) : [];
        this.startCtx = opener.ctxBefore;
        this.streamCtx = contextAfter(rest, opener.ctxBefore);
        this.holding = true;
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
          this.replaceHeld(tail);
          return out;
        }
      }
      this.streamCtx = contextAfter(delta, this.streamCtx);
      return this.inner.ingestStreaming(delta);
    }

    const nextText = this.heldText + delta;
    this.streamCtx = contextAfter(delta, this.streamCtx);
    const nextBytes = Buffer.byteLength(nextText, "utf8");
    if (nextBytes > MAX_TURN_RECOVERY_BYTES) {
      this.replaceHeld(nextText);
      this.disabled = true;
      return this.releaseAllHeldEvents();
    }
    this.replaceHeld(nextText);
    // If only a partial `<...` tail was held and failed to complete any opener, flush promptly.
    if (!findFirstLeakedOpener(this.heldText, this.startCtx, this.options.enableHarmony, this.options.enableXml)
      && partialOpenerStart(this.heldText, this.options.enableXml) === -1) {
      return this.releaseAllHeldEvents();
    }
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
    const result = recoverLeakedToolCallsFromText(this.heldText, this.options, nextCallId, this.startCtx);
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
          if (range.start > textCursor) emitTextSlice(this.heldText.slice(textCursor, range.start));
          textCursor = Math.max(textCursor, range.end);
          if (targetOffset >= range.end) {
            rangeIdx += 1;
            continue;
          }
          break;
        }
        emitTextSlice(this.heldText.slice(textCursor, targetOffset));
        textCursor = targetOffset;
      }
    };
    for (const item of this.queued) {
      emitUpTo(item.offset);
      out.push(...this.inner.hold(item.event));
    }
    emitUpTo(this.heldText.length);
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
    return out;
  }

  drain(structuredCalls: readonly StructuredToolCallReference[]): AdapterEvent[] {
    if (!this.holding) return this.inner.drain(structuredCalls);
    const out: AdapterEvent[] = [];
    let cursor = 0;
    for (const item of this.queued) {
      if (item.offset > cursor) {
        const piece = this.heldText.slice(cursor, item.offset);
        if (piece) {
          this.inner.ingest(piece);
        }
        cursor = item.offset;
      }
      out.push(...this.inner.hold(item.event));
    }
    if (cursor < this.heldText.length) {
      this.inner.ingest(this.heldText.slice(cursor));
    }
    this.queued.length = 0;
    this.replaceHeld("");
    this.holding = false;
    return [...out, ...this.inner.drain(structuredCalls)];
  }

  dispose(): void {
    this.budget.releaseRetained(this.heldBytes, { kind: "live_transient" });
    this.heldBytes = 0;
    this.heldText = "";
    this.queued.length = 0;
    this.holding = false;
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
