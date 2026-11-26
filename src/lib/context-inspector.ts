/**
 * Pure, zero-I/O request context composition and prompt-cache prefix analyzer.
 *
 * Adapted from Apache-2.0 gateway context-dock reference patterns (see
 * `THIRD_PARTY_NOTICES.md`): decomposes OpenAI Responses, OpenAI Chat Completions,
 * and Anthropic Messages payloads into 8 token categories, a 128-cell proportional
 * block map (distinguishing cacheable static/breakpoint prefix cells from dynamic
 * tail cells), ranked heavy entries, and actionable prefix-stability diagnostics.
 */

export const CONTEXT_CATEGORIES = [
  "system",
  "tools",
  "mcp",
  "user",
  "assistant",
  "toolResults",
  "reasoning",
  "attachments",
] as const;

export type ContextCategoryId = (typeof CONTEXT_CATEGORIES)[number];
export type ContextCellKind = ContextCategoryId | "free";
export type ContextWireFormat = "anthropic-messages" | "openai-responses" | "openai-chat" | "unknown";

export type ContextWarningCode =
  | "volatile_iso_timestamp_in_system"
  | "missing_anthropic_cache_breakpoints"
  | "ttl_ordering_hazard"
  | "tool_schema_heavy"
  | "duplicate_tool_outputs"
  | "oversized_tool_output";

export interface ContextCategorySummary {
  id: ContextCategoryId;
  tokens: number;
  cachedTokens: number;
  itemCount: number;
  shareOfUsed: number;
  shareOfWindow: number;
}

export interface ContextEntryItem {
  id: string;
  category: ContextCategoryId;
  label: string;
  tokens: number;
  shareOfUsed: number;
  cached: boolean;
  preview?: string;
  previewTruncated?: boolean;
}

export interface ContextGridCell {
  index: number;
  kind: ContextCellKind;
  cached: boolean;
}

export interface ContextCacheDiagnostics {
  wireFormat: ContextWireFormat;
  explicitBreakpoints: number;
  cacheablePrefixTokens: number;
  uncachedActiveTokens: number;
  cacheablePrefixShare: number;
  hasPromptCacheKey: boolean;
  promptCacheRetention: string | null;
  warnings: ContextWarningCode[];
}

export interface ContextInspectionReport {
  ok: boolean;
  error?: string;
  model: string | null;
  contextWindowTokens: number;
  usedTokens: number;
  freeTokens: number;
  utilizationRatio: number;
  categories: ContextCategorySummary[];
  /** 128-cell map scaled to full `contextWindowTokens` (includes `free` tail cells). */
  cells: ContextGridCell[];
  /** 128-cell map magnifying occupied `usedTokens` across all 128 cells (`Fit` mode). */
  cellsFit: ContextGridCell[];
  topEntries: ContextEntryItem[];
  entries: ContextEntryItem[];
  cache: ContextCacheDiagnostics;
}

export const CONTEXT_GRID_CELLS = 128;
export const MAX_CONTEXT_INSPECT_CHARS = 2 * 1024 * 1024;
export const MAX_CONTEXT_JSON_DEPTH = 48;
export const MAX_ENTRY_PREVIEW_CHARS = 8_192;
const MAX_SCAN_ITEMS = 2_048;
const CHARS_PER_TOKEN = 4;
const MEDIA_ATTACHMENT_TOKENS = 1_000;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSafeJsonDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > maxDepth) return false;
    } else if (ch === 0x7d || ch === 0x5d) {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return !inString && depth === 0;
}

export function inferContextWindowTokens(model: string | null | undefined, explicitWindow?: number): number {
  if (typeof explicitWindow === "number" && Number.isFinite(explicitWindow) && explicitWindow >= 4_096) {
    return Math.min(10_000_000, Math.trunc(explicitWindow));
  }
  const lower = (model ?? "").trim().toLowerCase();
  if (!lower) return 200_000;
  if (lower.includes("1m") || lower.includes("gemini-2.5") || lower.includes("gemini-2.0") || lower.includes("gemini-1.5")) {
    return 1_000_000;
  }
  if (lower.includes("gpt-5") || lower.includes("gpt-4.1")) return 400_000;
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gpt-4o") || lower.includes("o3") || lower.includes("o4") || lower.includes("deepseek")) {
    return 128_000;
  }
  return 200_000;
}

function isDataUri(text: string): boolean {
  return text.length >= 128 && text.startsWith("data:") && text.slice(0, 96).includes(";base64,");
}

function tokensFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

function estimateNodeTokens(node: unknown, maxDepth = 14): { tokens: number; isMedia: boolean } {
  let chars = 0;
  let mediaTokens = 0;
  let visited = 0;

  const walk = (cur: unknown, depth: number): void => {
    if (depth > maxDepth || visited >= 512) return;
    visited += 1;
    if (typeof cur === "string") {
      if (isDataUri(cur)) mediaTokens += MEDIA_ATTACHMENT_TOKENS;
      else chars += cur.length;
      return;
    }
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item, depth + 1);
      return;
    }
    if (isRec(cur)) {
      const t = typeof cur.type === "string" ? cur.type : "";
      if (t === "image" || t === "image_url" || t === "input_image" || t === "document" || t === "input_file" || t === "audio" || t === "input_audio") {
        mediaTokens += MEDIA_ATTACHMENT_TOKENS;
        return;
      }
      for (const [k, v] of Object.entries(cur)) {
        if (k === "data" && typeof v === "string" && v.length > 256) {
          mediaTokens += MEDIA_ATTACHMENT_TOKENS;
          continue;
        }
        chars += k.length;
        walk(v, depth + 1);
      }
    }
  };
  walk(node, 0);
  return { tokens: tokensFromChars(chars) + mediaTokens, isMedia: mediaTokens > 0 && chars < 64 };
}

function detectWireFormat(body: Rec): ContextWireFormat {
  if (Array.isArray(body.input) || typeof body.instructions === "string") return "openai-responses";
  if (Array.isArray(body.messages)) {
    if (body.system !== undefined || typeof body.max_tokens === "number" || isRec(body.thinking)) {
      const hasOpenAiOnlyRole = body.messages.slice(0, 32).some(
        (m) => isRec(m) && (m.role === "system" || m.role === "developer" || m.role === "tool" || Array.isArray(m.tool_calls)),
      );
      if (!hasOpenAiOnlyRole) return "anthropic-messages";
    }
    return "openai-chat";
  }
  if (body.system !== undefined) return "anthropic-messages";
  return "unknown";
}

function isMcpTool(tool: Rec, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    tool.type === "mcp"
    || typeof tool.server_label === "string"
    || lower.startsWith("mcp__")
    || lower.startsWith("mcp_")
    || lower.includes("::mcp")
  );
}

function extractToolName(tool: Rec, idx: number): string {
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  if (typeof tool.server_label === "string" && tool.server_label.trim()) return `mcp:${tool.server_label.trim()}`;
  if (isRec(tool.function) && typeof tool.function.name === "string" && tool.function.name.trim()) {
    return tool.function.name.trim();
  }
  if (typeof tool.type === "string" && tool.type.trim()) return tool.type.trim();
  return `tool_${idx + 1}`;
}

interface SegmentRecord {
  id: string;
  category: ContextCategoryId;
  label: string;
  tokens: number;
  hasExplicitBreakpoint: boolean;
  breakpointTtlRank?: 1 | 2;
  cached: boolean;
  preview?: string;
  previewTruncated?: boolean;
}

const VOLATILE_TIMESTAMP_RE = /\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}|\s*UTC)?\b/;
const OPAQUE_SECRET_KEY = new Set(["signature", "encrypted_content", "data", "file_data"]);

function truncateLabel(text: string, fallback: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 52 ? `${clean.slice(0, 49)}...` : clean;
}

function sanitizePreviewValue(node: unknown, depth = 0): unknown {
  if (depth > 8) return "[...]";
  if (typeof node === "string") {
    if (isDataUri(node)) return `[data-uri omitted (${node.length} chars)]`;
    return node.length > MAX_ENTRY_PREVIEW_CHARS + 64 ? node.slice(0, MAX_ENTRY_PREVIEW_CHARS + 64) : node;
  }
  if (Array.isArray(node)) {
    return node.slice(0, 32).map(item => sanitizePreviewValue(item, depth + 1));
  }
  if (isRec(node)) {
    const out: Rec = {};
    for (const [k, v] of Object.entries(node).slice(0, 32)) {
      if (OPAQUE_SECRET_KEY.has(k) && typeof v === "string" && v.length > 48) {
        out[k] = `[opaque ${k} omitted (${v.length} chars)]`;
      } else {
        out[k] = sanitizePreviewValue(v, depth + 1);
      }
    }
    return out;
  }
  return node;
}

function buildSafePreview(raw: unknown): { preview?: string; previewTruncated?: boolean } {
  if (raw === undefined || raw === null) return {};
  let text = "";
  if (typeof raw === "string") {
    text = isDataUri(raw) ? `[data-uri attachment (${raw.length} chars)]` : raw;
  } else {
    try {
      text = JSON.stringify(sanitizePreviewValue(raw), null, 2) ?? "";
    } catch {
      text = "";
    }
  }
  // Strip terminal C0 control bytes (except \t and \n) so preview stays clean text.
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  if (!cleaned) return {};
  if (cleaned.length > MAX_ENTRY_PREVIEW_CHARS) {
    return { preview: cleaned.slice(0, MAX_ENTRY_PREVIEW_CHARS), previewTruncated: true };
  }
  return { preview: cleaned };
}

function buildProportionalCells(
  segments: readonly SegmentRecord[],
  usedTokens: number,
  usedCellBudget: number,
): ContextGridCell[] {
  const cells: ContextGridCell[] = [];
  if (usedCellBudget > 0 && usedTokens > 0 && segments.length > 0) {
    let accTokens = 0;
    let prevCellEnd = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      accTokens += seg.tokens;
      const targetEnd = i === segments.length - 1
        ? usedCellBudget
        : Math.min(usedCellBudget, Math.round((accTokens / usedTokens) * usedCellBudget));
      for (let c = prevCellEnd; c < targetEnd; c++) {
        cells.push({ index: c, kind: seg.category, cached: seg.cached });
      }
      prevCellEnd = targetEnd;
    }
  }
  while (cells.length < CONTEXT_GRID_CELLS) {
    cells.push({ index: cells.length, kind: "free", cached: false });
  }
  return cells;
}

export function inspectPromptContextJson(
  jsonText: string,
  options?: { contextWindowTokens?: number },
): ContextInspectionReport {
  if (typeof jsonText !== "string" || jsonText.trim().length === 0) {
    return emptyErrorReport("Paste a JSON request payload to inspect context composition.", options?.contextWindowTokens);
  }
  if (jsonText.length > MAX_CONTEXT_INSPECT_CHARS) {
    return emptyErrorReport(
      `Payload exceeds maximum inspection size (${MAX_CONTEXT_INSPECT_CHARS.toLocaleString()} chars).`,
      options?.contextWindowTokens,
    );
  }
  const trimmed = jsonText.trim();
  if (!hasSafeJsonDepth(trimmed, MAX_CONTEXT_JSON_DEPTH)) {
    return emptyErrorReport("Invalid JSON syntax or nesting depth exceeds safe limit.", options?.contextWindowTokens);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return emptyErrorReport("Invalid JSON payload.", options?.contextWindowTokens);
  }
  return inspectPromptContextPayload(parsed, options);
}

function emptyErrorReport(error: string, explicitWindow?: number): ContextInspectionReport {
  const windowTokens = inferContextWindowTokens(null, explicitWindow);
  const emptyCells = Array.from({ length: CONTEXT_GRID_CELLS }, (_, index) => ({
    index,
    kind: "free" as const,
    cached: false,
  }));
  return {
    ok: false,
    error,
    model: null,
    contextWindowTokens: windowTokens,
    usedTokens: 0,
    freeTokens: windowTokens,
    utilizationRatio: 0,
    categories: CONTEXT_CATEGORIES.map((id) => ({
      id,
      tokens: 0,
      cachedTokens: 0,
      itemCount: 0,
      shareOfUsed: 0,
      shareOfWindow: 0,
    })),
    cells: emptyCells,
    cellsFit: emptyCells.map(c => ({ ...c })),
    topEntries: [],
    entries: [],
    cache: {
      wireFormat: "unknown",
      explicitBreakpoints: 0,
      cacheablePrefixTokens: 0,
      uncachedActiveTokens: 0,
      cacheablePrefixShare: 0,
      hasPromptCacheKey: false,
      promptCacheRetention: null,
      warnings: [],
    },
  };
}

export function inspectPromptContextPayload(
  payload: unknown,
  options?: { contextWindowTokens?: number },
): ContextInspectionReport {
  if (!isRec(payload)) {
    return emptyErrorReport("Request payload must be a JSON object.", options?.contextWindowTokens);
  }

  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : null;
  const contextWindowTokens = inferContextWindowTokens(model, options?.contextWindowTokens);
  const wireFormat = detectWireFormat(payload);
  const segments: SegmentRecord[] = [];
  const warnings = new Set<ContextWarningCode>();
  const toolResultFingerprints = new Set<string>();
  let explicitBreakpoints = 0;
  const breakpointRanksInOrder: Array<1 | 2> = [];
  let seq = 0;

  const pushSegment = (
    category: ContextCategoryId,
    label: string,
    tokens: number,
    bpObj?: unknown,
    previewRaw?: unknown,
  ): void => {
    if (tokens <= 0 || segments.length >= MAX_SCAN_ITEMS) return;
    seq += 1;
    const hasBp = isRec(bpObj);
    let rank: 1 | 2 | undefined;
    if (hasBp) {
      explicitBreakpoints += 1;
      rank = bpObj.ttl === "1h" ? 2 : 1;
      breakpointRanksInOrder.push(rank);
    }
    const prev = segments.length < 128 ? buildSafePreview(previewRaw) : {};
    segments.push({
      id: `seg-${seq}`,
      category,
      label,
      tokens,
      hasExplicitBreakpoint: hasBp,
      breakpointTtlRank: rank,
      cached: false,
      ...prev,
    });
  };

  // 1. Tools (wire prefix order for Anthropic and OpenAI)
  if (Array.isArray(payload.tools)) {
    const limit = Math.min(payload.tools.length, 256);
    for (let i = 0; i < limit; i++) {
      const tool = payload.tools[i];
      if (!isRec(tool)) continue;
      const name = extractToolName(tool, i);
      const cat: ContextCategoryId = isMcpTool(tool, name) ? "mcp" : "tools";
      const { tokens } = estimateNodeTokens(tool);
      pushSegment(cat, name, tokens, tool.cache_control, tool);
    }
  }

  // 2. Top-level instructions / system
  if (typeof payload.instructions === "string" && payload.instructions.length > 0) {
    if (VOLATILE_TIMESTAMP_RE.test(payload.instructions)) warnings.add("volatile_iso_timestamp_in_system");
    pushSegment("system", truncateLabel(payload.instructions, "instructions"), tokensFromChars(payload.instructions.length), undefined, payload.instructions);
  }
  if (typeof payload.system === "string" && payload.system.length > 0) {
    if (VOLATILE_TIMESTAMP_RE.test(payload.system)) warnings.add("volatile_iso_timestamp_in_system");
    pushSegment("system", truncateLabel(payload.system, "system"), tokensFromChars(payload.system.length), undefined, payload.system);
  } else if (Array.isArray(payload.system)) {
    const limit = Math.min(payload.system.length, 64);
    for (let i = 0; i < limit; i++) {
      const block = payload.system[i];
      if (!isRec(block)) continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text && VOLATILE_TIMESTAMP_RE.test(text)) warnings.add("volatile_iso_timestamp_in_system");
      const { tokens } = estimateNodeTokens(block);
      pushSegment("system", truncateLabel(text, `system[${i}]`), tokens, block.cache_control, text || block);
    }
  }

  const recordToolResult = (rawText: string, label: string, tokens: number, bp?: unknown): void => {
    if (tokens >= 3_000) warnings.add("oversized_tool_output");
    if (rawText.length >= 256) {
      const key = `${rawText.length}:${rawText.slice(0, 96)}:${rawText.slice(-96)}`;
      if (toolResultFingerprints.has(key)) warnings.add("duplicate_tool_outputs");
      else if (toolResultFingerprints.size < 256) toolResultFingerprints.add(key);
    }
    pushSegment("toolResults", label, tokens, bp, rawText);
  };

  // 3. Responses `input[]`
  if (Array.isArray(payload.input)) {
    const limit = Math.min(payload.input.length, 512);
    for (let i = 0; i < limit; i++) {
      const item = payload.input[i];
      if (typeof item === "string") {
        pushSegment("user", truncateLabel(item, `input[${i}]`), tokensFromChars(item.length), undefined, item);
        continue;
      }
      if (!isRec(item)) continue;
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        const outStr = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        const callLabel = typeof item.call_id === "string" ? `output:${item.call_id}` : `tool_output[${i}]`;
        recordToolResult(outStr, callLabel, estimateNodeTokens(item.output).tokens);
      } else if (itemType === "reasoning") {
        pushSegment("reasoning", `reasoning[${i}]`, estimateNodeTokens(item).tokens, undefined, item);
      } else if (itemType === "function_call" || itemType === "custom_tool_call") {
        const name = typeof item.name === "string" ? `call:${item.name}` : `tool_call[${i}]`;
        pushSegment("assistant", name, estimateNodeTokens(item).tokens, undefined, item);
      } else {
        const role = typeof item.role === "string" ? item.role : "user";
        if (role === "system" || role === "developer") {
          const textSample = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "").slice(0, 256);
          if (VOLATILE_TIMESTAMP_RE.test(textSample)) warnings.add("volatile_iso_timestamp_in_system");
          pushSegment("system", truncateLabel(textSample, `${role}[${i}]`), estimateNodeTokens(item.content).tokens, undefined, item.content ?? item);
        } else {
          const est = estimateNodeTokens(item.content ?? item);
          const cat: ContextCategoryId = est.isMedia ? "attachments" : role === "assistant" ? "assistant" : "user";
          const label = typeof item.content === "string" ? truncateLabel(item.content, `${role}[${i}]`) : `${role}[${i}]`;
          pushSegment(cat, label, est.tokens, undefined, item.content ?? item);
        }
      }
    }
  }

  // 4. Chat / Anthropic `messages[]`
  if (Array.isArray(payload.messages)) {
    const limit = Math.min(payload.messages.length, 512);
    for (let i = 0; i < limit; i++) {
      const msg = payload.messages[i];
      if (!isRec(msg)) continue;
      const role = typeof msg.role === "string" ? msg.role : "user";

      if (role === "system" || role === "developer") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "").slice(0, 256);
        if (VOLATILE_TIMESTAMP_RE.test(text)) warnings.add("volatile_iso_timestamp_in_system");
        pushSegment("system", truncateLabel(text, `${role}[${i}]`), estimateNodeTokens(msg.content).tokens, msg.cache_control, msg.content);
        continue;
      }
      if (role === "tool" || role === "function") {
        const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
        const idLabel = typeof msg.tool_call_id === "string" ? `tool:${msg.tool_call_id}` : `tool[${i}]`;
        recordToolResult(raw, idLabel, estimateNodeTokens(msg.content).tokens, msg.cache_control);
        continue;
      }

      if (typeof msg.content === "string") {
        const cat: ContextCategoryId = role === "assistant" ? "assistant" : "user";
        pushSegment(cat, truncateLabel(msg.content, `${role}[${i}]`), tokensFromChars(msg.content.length), msg.cache_control, msg.content);
      } else if (Array.isArray(msg.content)) {
        const bLimit = Math.min(msg.content.length, 64);
        for (let b = 0; b < bLimit; b++) {
          const block = msg.content[b];
          if (!isRec(block)) continue;
          const bType = typeof block.type === "string" ? block.type : "text";
          if (bType === "tool_result") {
            const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            const idLabel = typeof block.tool_use_id === "string" ? `tool_result:${block.tool_use_id}` : `tool_result[${i}.${b}]`;
            recordToolResult(raw, idLabel, estimateNodeTokens(block.content).tokens, block.cache_control);
          } else if (bType === "thinking" || bType === "redacted_thinking") {
            const previewSrc = typeof block.thinking === "string" ? block.thinking : `[${bType}]`;
            pushSegment("reasoning", `${bType}[${i}]`, estimateNodeTokens(block).tokens, block.cache_control, previewSrc);
          } else if (bType === "image" || bType === "image_url" || bType === "document" || bType === "audio") {
            pushSegment("attachments", `${bType}[${i}]`, MEDIA_ATTACHMENT_TOKENS, block.cache_control, `[${bType} attachment]`);
          } else if (bType === "tool_use") {
            const tName = typeof block.name === "string" ? `tool_use:${block.name}` : `tool_use[${i}]`;
            pushSegment("assistant", tName, estimateNodeTokens(block).tokens, block.cache_control, block);
          } else {
            const txt = typeof block.text === "string" ? block.text : "";
            const cat: ContextCategoryId = role === "assistant" ? "assistant" : "user";
            pushSegment(cat, truncateLabel(txt, `${role}[${i}]`), estimateNodeTokens(block).tokens, block.cache_control, txt || block);
          }
        }
      }
      if (Array.isArray(msg.tool_calls)) {
        pushSegment("assistant", `tool_calls[${i}] (${msg.tool_calls.length})`, estimateNodeTokens(msg.tool_calls).tokens, undefined, msg.tool_calls);
      }
    }
  }

  // Top-level automatic `cache_control` sits at the end of `tools -> system -> messages` on Anthropic's wire.
  if (isRec(payload.cache_control)) {
    explicitBreakpoints += 1;
    breakpointRanksInOrder.push(payload.cache_control.ttl === "1h" ? 2 : 1);
  }

  // Mark cached prefix segments according to wire semantics
  const usedTokens = segments.reduce((sum, s) => sum + s.tokens, 0);
  if (wireFormat === "anthropic-messages") {
    if (isRec(payload.cache_control)) {
      // Automatic top-level caching covers prefix up to the final turn
      const cutoff = Math.max(0, segments.length - 1);
      for (let i = 0; i <= cutoff && i < segments.length; i++) segments[i]!.cached = true;
    } else {
      let lastBpIdx = -1;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i]!.hasExplicitBreakpoint) lastBpIdx = i;
      }
      if (lastBpIdx >= 0) {
        for (let i = 0; i <= lastBpIdx; i++) segments[i]!.cached = true;
      } else if (usedTokens >= 1_024) {
        warnings.add("missing_anthropic_cache_breakpoints");
      }
    }
    for (let i = 1; i < breakpointRanksInOrder.length; i++) {
      if (breakpointRanksInOrder[i]! > breakpointRanksInOrder[i - 1]!) {
        warnings.add("ttl_ordering_hazard");
        break;
      }
    }
  } else if (wireFormat === "openai-responses" || wireFormat === "openai-chat") {
    // OpenAI automatic prompt caching caches static prefix >= 1,024 tokens (tools + system + prior turns before final user turn)
    if (usedTokens >= 1_024 && segments.length > 0) {
      const prefixLimit = segments.length > 1 ? segments.length - 1 : 1;
      let prefixSum = 0;
      for (let i = 0; i < prefixLimit; i++) prefixSum += segments[i]!.tokens;
      if (prefixSum >= 1_024 && !warnings.has("volatile_iso_timestamp_in_system")) {
        for (let i = 0; i < prefixLimit; i++) segments[i]!.cached = true;
      }
    }
  }

  const byCat = new Map<ContextCategoryId, { tokens: number; cachedTokens: number; count: number }>();
  for (const id of CONTEXT_CATEGORIES) byCat.set(id, { tokens: 0, cachedTokens: 0, count: 0 });
  for (const seg of segments) {
    const bucket = byCat.get(seg.category)!;
    bucket.tokens += seg.tokens;
    if (seg.cached) bucket.cachedTokens += seg.tokens;
    bucket.count += 1;
  }

  const toolSchemaTokens = (byCat.get("tools")?.tokens ?? 0) + (byCat.get("mcp")?.tokens ?? 0);
  if (usedTokens >= 2_000 && toolSchemaTokens / usedTokens >= 0.35) {
    warnings.add("tool_schema_heavy");
  }

  const categories: ContextCategorySummary[] = CONTEXT_CATEGORIES.map((id) => {
    const b = byCat.get(id)!;
    return {
      id,
      tokens: b.tokens,
      cachedTokens: b.cachedTokens,
      itemCount: b.count,
      shareOfUsed: usedTokens > 0 ? b.tokens / usedTokens : 0,
      shareOfWindow: contextWindowTokens > 0 ? Math.min(1, b.tokens / contextWindowTokens) : 0,
    };
  });

  // Build 128-cell proportional grids preserving wire sequence (Window mode + Fit mode)
  const effectiveDenom = Math.max(contextWindowTokens, usedTokens, 1);
  const usedCellBudget = usedTokens <= 0
    ? 0
    : Math.min(CONTEXT_GRID_CELLS, Math.max(1, Math.round((usedTokens / effectiveDenom) * CONTEXT_GRID_CELLS)));

  const cells = buildProportionalCells(segments, usedTokens, usedCellBudget);
  const cellsFit = buildProportionalCells(segments, usedTokens, usedTokens > 0 ? CONTEXT_GRID_CELLS : 0);

  const cacheablePrefixTokens = segments.reduce((sum, s) => sum + (s.cached ? s.tokens : 0), 0);
  const uncachedActiveTokens = Math.max(0, usedTokens - cacheablePrefixTokens);
  const freeTokens = Math.max(0, contextWindowTokens - usedTokens);

  const toEntryItem = (s: SegmentRecord): ContextEntryItem => ({
    id: s.id,
    category: s.category,
    label: s.label,
    tokens: s.tokens,
    shareOfUsed: usedTokens > 0 ? s.tokens / usedTokens : 0,
    cached: s.cached,
    ...(s.preview !== undefined ? { preview: s.preview } : {}),
    ...(s.previewTruncated ? { previewTruncated: true } : {}),
  });

  const entries: ContextEntryItem[] = segments.slice(0, 128).map(toEntryItem);
  const topEntries: ContextEntryItem[] = [...segments]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20)
    .map(toEntryItem);

  const hasPromptCacheKey = typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0;
  const promptCacheRetention = typeof payload.prompt_cache_retention === "string" ? payload.prompt_cache_retention : null;

  return {
    ok: true,
    model,
    contextWindowTokens,
    usedTokens,
    freeTokens,
    utilizationRatio: Math.min(1, usedTokens / Math.max(1, contextWindowTokens)),
    categories,
    cells,
    cellsFit,
    topEntries,
    entries,
    cache: {
      wireFormat,
      explicitBreakpoints,
      cacheablePrefixTokens,
      uncachedActiveTokens,
      cacheablePrefixShare: usedTokens > 0 ? cacheablePrefixTokens / usedTokens : 0,
      hasPromptCacheKey,
      promptCacheRetention,
      warnings: [...warnings],
    },
  };
}
