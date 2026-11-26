/**
 * Opt-in provider-aware prompt-cache breakpoint injection and volatile prefix hygiene.
 *
 * Adapted from Apache-2.0 and MIT gateway reference designs (see `THIRD_PARTY_NOTICES.md`):
 * - Respects Anthropic's 4-breakpoint ceiling (`MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4`).
 * - Enforces non-increasing TTL ordering across `tools -> system -> messages` so a `1h`
 *   entry is never placed after a `5m` entry.
 * - Skips `thinking`, `redacted_thinking`, empty text blocks, and turn-scoped
 *   `<system-reminder>` blocks that would churn cache writes every turn.
 * - Optionally normalizes per-second wall-clock timestamps on explicit system clock
 *   lines (`Current time: 2026-11-27T03:14:22Z` -> `Current time: 2026-11-27`) to
 *   prevent needless byte-prefix cache invalidation.
 */

export type PromptCacheInjectionTtl = "auto" | "5m" | "1h";

export interface PromptCacheInjectionConfig {
  enabled?: boolean;
  ttl?: PromptCacheInjectionTtl;
  stripVolatileSystemTimestamps?: boolean;
}

export interface PromptCacheInjectionResult {
  injectedBreakpoints: number;
  existingBreakpoints: number;
  normalizedTimestamps: number;
}

export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
const MAX_SCAN_DEPTH = 16;
const MAX_SCAN_NODES = 4_096;
const MIN_CACHEABLE_SECTION_CHARS = 2_048;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DATA_KEYS = new Set(["cache_control", "input", "input_schema", "input_examples"]);

const VOLATILE_SYSTEM_CLOCK_LINE_RE =
  /^(\s*(?:[-*]\s*)?(?:current|system|local|utc)\s+(?:date\s*(?:and|&)?\s*time|datetime|time|timestamp)\s*:\s*)(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:\s*(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?(\s*)$/gim;

function normalizeSystemClockText(text: string): { text: string; count: number } {
  if (text.length === 0 || text.length > 512 * 1024 || !/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(text)) {
    return { text, count: 0 };
  }
  let count = 0;
  const next = text.replace(VOLATILE_SYSTEM_CLOCK_LINE_RE, (_full, prefix: string, date: string, suffix: string) => {
    count += 1;
    return `${prefix}${date}${suffix}`;
  });
  return { text: next, count };
}

export function normalizeVolatileSystemTimestampsInPlace(body: Rec): number {
  let normalized = 0;

  if (typeof body.instructions === "string") {
    const res = normalizeSystemClockText(body.instructions);
    if (res.count > 0) {
      body.instructions = res.text;
      normalized += res.count;
    }
  }

  if (typeof body.system === "string") {
    const res = normalizeSystemClockText(body.system);
    if (res.count > 0) {
      body.system = res.text;
      normalized += res.count;
    }
  } else if (Array.isArray(body.system)) {
    const limit = Math.min(body.system.length, 32);
    for (let i = 0; i < limit; i++) {
      const block = body.system[i];
      if (isRec(block) && block.type === "text" && typeof block.text === "string") {
        const res = normalizeSystemClockText(block.text);
        if (res.count > 0) {
          block.text = res.text;
          normalized += res.count;
        }
      }
    }
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const first = body.messages[0];
    if (isRec(first) && (first.role === "system" || first.role === "developer")) {
      if (typeof first.content === "string") {
        const res = normalizeSystemClockText(first.content);
        if (res.count > 0) {
          first.content = res.text;
          normalized += res.count;
        }
      } else if (Array.isArray(first.content)) {
        const limit = Math.min(first.content.length, 16);
        for (let i = 0; i < limit; i++) {
          const part = first.content[i];
          if (isRec(part) && typeof part.text === "string") {
            const res = normalizeSystemClockText(part.text);
            if (res.count > 0) {
              part.text = res.text;
              normalized += res.count;
            }
          }
        }
      }
    }
  }

  return normalized;
}

type NormalizedTtlRank = 1 | 2; // 2 = "1h", 1 = "5m" (or default ephemeral)

function ttlRank(ttl: unknown): NormalizedTtlRank {
  return ttl === "1h" ? 2 : 1;
}

interface SectionScan {
  count: number;
  ranks: NormalizedTtlRank[];
  aborted: boolean;
}

function scanSectionBreakpoints(node: unknown): SectionScan {
  let visited = 0;
  let aborted = false;
  const ranks: NormalizedTtlRank[] = [];

  const visit = (cur: unknown, depth: number): void => {
    if (aborted) return;
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_NODES) {
      aborted = true;
      return;
    }
    visited += 1;
    if (Array.isArray(cur)) {
      for (const item of cur) visit(item, depth + 1);
      return;
    }
    if (!isRec(cur)) return;
    if (isRec(cur.cache_control)) {
      ranks.push(ttlRank(cur.cache_control.ttl));
    }
    for (const [k, v] of Object.entries(cur)) {
      if (!DATA_KEYS.has(k) && (Array.isArray(v) || isRec(v))) {
        visit(v, depth + 1);
      }
    }
  };

  if (node !== undefined) visit(node, 0);
  return { count: ranks.length, ranks, aborted };
}

function isCacheUnsupportedAnthropicModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const lower = model.trim().toLowerCase();
  if (!lower) return false;
  return lower.includes("claude-2") || lower.includes("claude-instant");
}

function rejectsOneHourCacheTtl(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const lower = model.trim().toLowerCase();
  // Vertex-addressed Claude 3.x IDs (`claude-3-7-sonnet@20250219`, `claude-3-5-sonnet-v2@...`, `claude-3-opus@...`)
  // reject the 1-hour TTL; downgrade explicit `"1h"` to `"5m"` on those IDs.
  if (!lower.includes("@")) return false;
  const base = lower.split("@")[0] ?? "";
  return (
    base.endsWith("claude-3-7-sonnet")
    || base.endsWith("claude-3-5-sonnet-v2")
    || base.endsWith("claude-3-5-sonnet")
    || base.endsWith("claude-3-opus")
  );
}

function looksLikeAnthropicMessagesWire(body: Rec): boolean {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  if (Array.isArray(body.input)) return false;
  if (isCacheUnsupportedAnthropicModel(body.model)) return false;

  let hasAnthropicCue = typeof body.max_tokens === "number" || body.system !== undefined || isRec(body.thinking);
  const scanLimit = Math.min(body.messages.length, 64);
  for (let i = 0; i < scanLimit; i++) {
    const msg = body.messages[i];
    if (!isRec(msg)) return false;
    const role = msg.role;
    // OpenAI Chat Completions roles (`system`, `developer`, `tool`, `function`) or `tool_calls`
    // never belong in native Anthropic `/v1/messages` wire payloads.
    if (role !== "user" && role !== "assistant") return false;
    if (Array.isArray(msg.tool_calls) || msg.function_call !== undefined) return false;
    if (Array.isArray(msg.content)) {
      for (let j = 0; j < Math.min(msg.content.length, 16); j++) {
        const block = msg.content[j];
        if (isRec(block) && (block.type === "tool_use" || block.type === "tool_result" || block.type === "thinking")) {
          hasAnthropicCue = true;
        }
      }
    }
  }
  return hasAnthropicCue;
}

function estimateBoundedChars(node: unknown, cap = 16_384): number {
  let total = 0;
  let visited = 0;
  const walk = (cur: unknown, depth: number): void => {
    if (total >= cap || depth > 12 || visited >= 512) return;
    visited += 1;
    if (typeof cur === "string") {
      total += cur.length;
      return;
    }
    if (Array.isArray(cur)) {
      for (const item of cur) {
        walk(item, depth + 1);
        if (total >= cap) return;
      }
      return;
    }
    if (isRec(cur)) {
      for (const [k, v] of Object.entries(cur)) {
        total += k.length;
        walk(v, depth + 1);
        if (total >= cap) return;
      }
    }
  };
  walk(node, 0);
  return total;
}

function isTurnScopedReminderText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<ephemeral-reminder>")
    || trimmed.startsWith("<turn-context>")
  );
}

function makeCacheControl(
  preferredTtl: PromptCacheInjectionTtl,
  minAllowedRank: NormalizedTtlRank,
  maxAllowedRank: NormalizedTtlRank,
): Rec | null {
  if (minAllowedRank > maxAllowedRank) return null;
  if (preferredTtl === "1h") {
    if (maxAllowedRank >= 2) return { type: "ephemeral", ttl: "1h" };
    return minAllowedRank <= 1 ? { type: "ephemeral", ttl: "5m" } : null;
  }
  if (preferredTtl === "5m") {
    if (minAllowedRank >= 2) return { type: "ephemeral", ttl: "1h" };
    return { type: "ephemeral", ttl: "5m" };
  }
  // "auto": omit explicit ttl unless a downstream caller breakpoint already pinned "1h",
  // in which case we must also emit "1h" upstream to preserve non-increasing TTL order.
  if (minAllowedRank >= 2) return { type: "ephemeral", ttl: "1h" };
  return { type: "ephemeral" };
}

function isEligibleMessageBlock(block: Rec): boolean {
  const type = block.type;
  if (type === "thinking" || type === "redacted_thinking") return false;
  if (type === "text") {
    return typeof block.text === "string"
      && block.text.trim().length > 0
      && !isTurnScopedReminderText(block.text);
  }
  return type === "tool_result" || type === "document" || type === "image" || type === "tool_use";
}

function uncachedMessagesTailChars(messages: unknown[]): number {
  let charsAfterLastBp = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRec(msg)) continue;
    if (isRec(msg.cache_control)) {
      charsAfterLastBp = 0;
      continue;
    }
    if (typeof msg.content === "string") {
      charsAfterLastBp += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (let b = 0; b < msg.content.length; b++) {
        const block = msg.content[b];
        if (!isRec(block)) continue;
        if (isRec(block.cache_control)) {
          charsAfterLastBp = 0;
        } else if (charsAfterLastBp < MIN_CACHEABLE_SECTION_CHARS) {
          charsAfterLastBp += estimateBoundedChars(block, MIN_CACHEABLE_SECTION_CHARS);
        }
      }
    }
  }
  return charsAfterLastBp;
}

export function injectPromptCacheBreakpointsInPlace(
  body: unknown,
  config?: PromptCacheInjectionConfig,
): PromptCacheInjectionResult {
  if (!isRec(body)) {
    return { injectedBreakpoints: 0, existingBreakpoints: 0, normalizedTimestamps: 0 };
  }

  const normalizedTimestamps = config?.stripVolatileSystemTimestamps === true
    ? normalizeVolatileSystemTimestampsInPlace(body)
    : 0;

  if (config?.enabled !== true || !looksLikeAnthropicMessagesWire(body)) {
    return { injectedBreakpoints: 0, existingBreakpoints: 0, normalizedTimestamps };
  }
  if (isRec(body.cache_control)) {
    return { injectedBreakpoints: 0, existingBreakpoints: 1, normalizedTimestamps };
  }

  const toolsScan = scanSectionBreakpoints(body.tools);
  const systemScan = scanSectionBreakpoints(body.system);
  const messagesScan = scanSectionBreakpoints(body.messages);
  if (toolsScan.aborted || systemScan.aborted || messagesScan.aborted) {
    return { injectedBreakpoints: 0, existingBreakpoints: 0, normalizedTimestamps };
  }

  const existingBreakpoints = toolsScan.count + systemScan.count + messagesScan.count;
  let remaining = MAX_ANTHROPIC_CACHE_BREAKPOINTS - existingBreakpoints;
  if (remaining <= 0) {
    return { injectedBreakpoints: 0, existingBreakpoints, normalizedTimestamps };
  }

  // Anthropic wire evaluation order for TTL non-increasing check: tools -> system -> messages.
  const rawPreferred: PromptCacheInjectionTtl = config.ttl ?? "auto";
  const preferredTtl: PromptCacheInjectionTtl =
    rawPreferred === "1h" && rejectsOneHourCacheTtl(body.model) ? "5m" : rawPreferred;
  let injected = 0;

  const maxDownstreamOfTools: NormalizedTtlRank = Math.max(
    1,
    ...systemScan.ranks,
    ...messagesScan.ranks,
  ) as NormalizedTtlRank;
  let minSeenInTools: NormalizedTtlRank = toolsScan.ranks.length > 0
    ? (Math.min(...toolsScan.ranks) as NormalizedTtlRank)
    : 2;

  // 1. Static tool definitions tail
  if (
    remaining > 0
    && toolsScan.count === 0
    && Array.isArray(body.tools)
    && body.tools.length > 0
    && estimateBoundedChars(body.tools, MIN_CACHEABLE_SECTION_CHARS) >= MIN_CACHEABLE_SECTION_CHARS
  ) {
    for (let i = body.tools.length - 1; i >= 0; i--) {
      const tool = body.tools[i];
      if (!isRec(tool) || isRec(tool.cache_control)) continue;
      // Skip provider-executed server tools whose schema may reject client cache_control.
      const toolType = typeof tool.type === "string" ? tool.type : "custom";
      if (toolType !== "custom" && !("input_schema" in tool)) continue;
      const cc = makeCacheControl(preferredTtl, maxDownstreamOfTools, 2);
      if (cc) {
        tool.cache_control = cc;
        minSeenInTools = ttlRank(cc.ttl);
        injected += 1;
        remaining -= 1;
      }
      break;
    }
  }

  const maxDownstreamOfSystem: NormalizedTtlRank = messagesScan.ranks.length > 0
    ? (Math.max(...messagesScan.ranks) as NormalizedTtlRank)
    : 1;
  let minSeenUpToSystem: NormalizedTtlRank = systemScan.ranks.length > 0
    ? (Math.min(minSeenInTools, ...systemScan.ranks) as NormalizedTtlRank)
    : minSeenInTools;

  // 2. Static system instructions tail
  if (
    remaining > 0
    && systemScan.count === 0
    && body.system !== undefined
    && estimateBoundedChars(body.system, MIN_CACHEABLE_SECTION_CHARS) >= MIN_CACHEABLE_SECTION_CHARS
  ) {
    const cc = makeCacheControl(preferredTtl, maxDownstreamOfSystem, minSeenInTools);
    if (cc) {
      if (typeof body.system === "string" && !isTurnScopedReminderText(body.system)) {
        body.system = [{ type: "text", text: body.system, cache_control: cc }];
        minSeenUpToSystem = Math.min(minSeenUpToSystem, ttlRank(cc.ttl)) as NormalizedTtlRank;
        injected += 1;
        remaining -= 1;
      } else if (Array.isArray(body.system)) {
        for (let i = body.system.length - 1; i >= 0; i--) {
          const block = body.system[i];
          if (!isRec(block) || isRec(block.cache_control)) continue;
          if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0 && !isTurnScopedReminderText(block.text)) {
            block.cache_control = cc;
            minSeenUpToSystem = Math.min(minSeenUpToSystem, ttlRank(cc.ttl)) as NormalizedTtlRank;
            injected += 1;
            remaining -= 1;
            break;
          }
        }
      }
    }
  }

  // 3. Conversation messages tail (latest eligible non-thinking block, even if an earlier turn had a breakpoint)
  const minSeenBeforeTail: NormalizedTtlRank = messagesScan.ranks.length > 0
    ? (Math.min(minSeenUpToSystem, ...messagesScan.ranks) as NormalizedTtlRank)
    : minSeenUpToSystem;
  if (
    remaining > 0
    && Array.isArray(body.messages)
    && body.messages.length > 0
    && (messagesScan.count === 0
      ? estimateBoundedChars(body.messages, MIN_CACHEABLE_SECTION_CHARS) >= MIN_CACHEABLE_SECTION_CHARS
      : uncachedMessagesTailChars(body.messages) >= MIN_CACHEABLE_SECTION_CHARS)
  ) {
    const cc = makeCacheControl(preferredTtl, 1, minSeenBeforeTail);
    if (cc) {
      outer: for (let mIdx = body.messages.length - 1; mIdx >= 0; mIdx--) {
        const msg = body.messages[mIdx];
        if (!isRec(msg)) continue;
        if (isRec(msg.cache_control)) break outer;
        if (typeof msg.content === "string") {
          if (msg.content.trim().length > 0 && !isTurnScopedReminderText(msg.content)) {
            msg.content = [{ type: "text", text: msg.content, cache_control: cc }];
            injected += 1;
            remaining -= 1;
            break;
          }
        } else if (Array.isArray(msg.content)) {
          for (let bIdx = msg.content.length - 1; bIdx >= 0; bIdx--) {
            const block = msg.content[bIdx];
            if (!isRec(block)) continue;
            if (isRec(block.cache_control)) break outer;
            if (isEligibleMessageBlock(block)) {
              block.cache_control = cc;
              injected += 1;
              remaining -= 1;
              break outer;
            }
          }
        }
      }
    }
  }

  return {
    injectedBreakpoints: injected,
    existingBreakpoints,
    normalizedTimestamps,
  };
}
