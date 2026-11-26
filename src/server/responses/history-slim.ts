import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { EpxConfig } from "../../types";
import { isPlainObject } from "../../adapters/openai-responses/internal";
import { ToolOutputDedupTracker } from "../../adapters/openai-responses/tool-output-dedup";
import { codexWsIncrementalUploadEnabled } from "../../config/codex-ws-incremental-setting";
import { CODEX_RESPONSES_HTTP_URL } from "./codex-ws-request";

/**
 * Shorten stale screenshots and fat tool outputs on the outbound ChatGPT Codex
 * body. The local session and previous_response_id cache keep the originals;
 * only the string about to be sent is replaced.
 *
 * Full-context HTTP turns repeat prior inline images, which barely shrink
 * under transport compression. This optional policy changes only outbound
 * history before the latest user message; it is not a lossless image cache.
 */
export type UpstreamHistorySlim = "off" | "codex";

const TEXT_LIMIT = 32 * 1024;
const TEXT_HEAD = 2 * 1024;
const TEXT_TAIL = 1024;
/** Inline image payloads only. A file id or a short URL is not the metered cost. */
const IMAGE_INLINE_MIN_BYTES = 1024;
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const TEXT_KEYS = new Set(["text", "output", "content", "refusal"]);
const STRUCTURAL_KEYS = new Set(["call_id", "id", "name", "type", "status", "role", "file_id"]);

export const HISTORY_SLIM_SHORT_TTL_MS = 5 * 60_000;
export const HISTORY_SLIM_LONG_TTL_MS = 60 * 60_000;
const DIGEST_BOOK_MAX_ENTRIES = 1024;
const DIGEST_BOOK_MAX_BYTES = 256 * 1024;
const DIGEST_ENTRY_BYTES = 256;
const DIGEST_BOOK_HARD_EXPIRY_MS = 2 * 60 * 60_000;

interface SessionDigestEntry {
  lastSentAt: number;
  ttlMs: number;
  slimmedBoundary: number;
  slimmedPrefixHash: string;
  cachedPrefixLen: number;
  cachedPrefixHash: string;
}

const sessionDigestBook = new Map<string, SessionDigestEntry>();
let sessionDigestBookBytes = 0;

let boundConfig: Pick<EpxConfig, "upstreamHistorySlim" | "cacheRetention"> | null = null;
let slimmedRequests = 0;
let slimmedBytes = 0;

/** Clear process-local history slimming digest book state (intended for tests). */
export function resetHistorySlimDigestBookForTest(): void {
  sessionDigestBook.clear();
  sessionDigestBookBytes = 0;
}

/** Current entry/byte metrics for the content-free session digest book (no text stored). */
export function historySlimDigestBookStats(): { entries: number; bytes: number } {
  return { entries: sessionDigestBook.size, bytes: sessionDigestBookBytes };
}

/** Scalar counters only. They do not retain request text or image bytes. */
export function upstreamHistorySlimCounters(): { requests: number; bytes: number } {
  return { requests: slimmedRequests, bytes: slimmedBytes };
}

export function bindUpstreamHistorySlimConfig(
  config: Pick<EpxConfig, "upstreamHistorySlim" | "cacheRetention"> | null,
): void {
  boundConfig = config;
}

export function resolveUpstreamHistorySlim(value: unknown): UpstreamHistorySlim {
  return value === "codex" ? "codex" : "off";
}

export function currentUpstreamHistorySlim(): UpstreamHistorySlim {
  return resolveUpstreamHistorySlim(boundConfig?.upstreamHistorySlim);
}

function utf8(text: string, start: number, end: number): string {
  const bytes = Buffer.from(text, "utf8");
  let from = Math.max(0, Math.min(start, bytes.length));
  let to = Math.max(from, Math.min(end, bytes.length));
  if (from > 0) {
    while (from < to && (bytes[from]! & 0xc0) === 0x80) from += 1;
  }
  if (to < bytes.length) {
    while (to > from && (bytes[to]! & 0xc0) === 0x80) to -= 1;
  }
  return bytes.subarray(from, to).toString("utf8");
}

function imageInlineBytes(part: Record<string, unknown>): number {
  const url = part.image_url;
  const value = typeof url === "string" ? url : isPlainObject(url) ? url.url : undefined;
  return typeof value === "string" && /^data:/i.test(value) ? Buffer.byteLength(value) : 0;
}

function imageStub(bytes: number): Record<string, unknown> {
  return {
    type: "input_text",
    text: `[image omitted, ${bytes} bytes, original remains in the local session]`,
  };
}

/** Replace inline images. Returns whether any part changed. */
function stripInlineImages(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(entry => {
      const stripped = stripInlineImages(entry);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };
  if (value.type === "input_image") {
    const bytes = imageInlineBytes(value);
    if (bytes > IMAGE_INLINE_MIN_BYTES) return { value: imageStub(bytes), changed: true };
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (STRUCTURAL_KEYS.has(key) && typeof entry !== "object") {
      next[key] = entry;
      continue;
    }
    const stripped = stripInlineImages(entry);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return changed ? { value: next, changed } : { value, changed: false };
}

type TextSlot = { parent: Record<string, unknown>; key: string; bytes: number };

function collectTextSlots(value: unknown, slots: TextSlot[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectTextSlots(entry, slots);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (typeof entry === "string" && TEXT_KEYS.has(key)) {
      slots.push({ parent: value, key, bytes: Buffer.byteLength(entry) });
    } else if (entry && typeof entry === "object") {
      collectTextSlots(entry, slots);
    }
  }
}

function excerptText(text: string, size: number): string {
  const head = utf8(text, 0, TEXT_HEAD);
  const tail = utf8(text, Math.max(0, size - TEXT_TAIL), size);
  return `[tool output shortened, original ${size} bytes, full output remains in the local session]\n${head}\n[${size} bytes omitted]\n${tail}`;
}

/**
 * Budget against the whole serialized tool output, not one field: an output split into many
 * text parts below 32 KiB each still has its largest parts excerpted until the item fits.
 */
function trimToolOutput(item: Record<string, unknown>): boolean {
  if (typeof item.type !== "string" || !TOOL_OUTPUT_TYPES.has(item.type)) return false;
  let total = Buffer.byteLength(JSON.stringify(item));
  if (total <= TEXT_LIMIT) return false;
  const slots: TextSlot[] = [];
  collectTextSlots(item, slots);
  slots.sort((a, b) => b.bytes - a.bytes);
  let changed = false;
  for (const slot of slots) {
    if (total <= TEXT_LIMIT) break;
    const current = slot.parent[slot.key];
    if (typeof current !== "string") continue;
    const next = excerptText(current, slot.bytes);
    const saved = Buffer.byteLength(JSON.stringify(current)) - Buffer.byteLength(JSON.stringify(next));
    if (saved <= 0) continue;
    slot.parent[slot.key] = next;
    total -= saved;
    changed = true;
  }
  return changed;
}

function isUserMessage(item: unknown): boolean {
  if (!isPlainObject(item) || item.role !== "user") return false;
  return item.type === undefined || item.type === "message";
}

const SESSION_HEADER_KEYS = [
  "x-codex-turn-state",
  "session_id",
  "session-id",
  "x-session-id",
  "conversation_id",
  "thread-id",
  "x-codex-parent-thread-id",
] as const;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveSessionKeyDigest(
  target: string,
  parsed: Record<string, unknown>,
  headers?: HeadersInit,
): string | undefined {
  let rawId: string | undefined;
  if (headers) {
    const parsedHeaders = headers instanceof Headers ? headers : new Headers(headers);
    for (const key of SESSION_HEADER_KEYS) {
      const value = parsedHeaders.get(key)?.trim();
      if (value) {
        rawId = `${key}:${value}`;
        break;
      }
    }
  }
  if (!rawId && typeof parsed.prompt_cache_key === "string" && parsed.prompt_cache_key.trim()) {
    rawId = `pck:${parsed.prompt_cache_key.trim()}`;
  }
  return rawId ? sha256Hex(`${target}\0${rawId}`) : undefined;
}

function resolveCacheTtlMs(parsed: Record<string, unknown>, headers?: HeadersInit): number {
  if (boundConfig?.cacheRetention === "long") return HISTORY_SLIM_LONG_TTL_MS;
  const retention = parsed.prompt_cache_retention;
  if (typeof retention === "string") {
    const normalized = retention.trim().toLowerCase();
    if (normalized === "1h" || normalized === "long" || normalized === "24h") return HISTORY_SLIM_LONG_TTL_MS;
  } else if (typeof retention === "number" && Number.isFinite(retention) && retention >= 3600) {
    return HISTORY_SLIM_LONG_TTL_MS;
  }
  if (headers) {
    const beta = (headers instanceof Headers ? headers : new Headers(headers)).get("anthropic-beta");
    if (beta && beta.toLowerCase().includes("extended-cache-ttl")) return HISTORY_SLIM_LONG_TTL_MS;
  }
  return HISTORY_SLIM_SHORT_TTL_MS;
}

function computePrefixHashes(
  items: readonly unknown[],
  checkpoints: readonly number[],
): Map<number, string> {
  const sorted = new Set(checkpoints.filter(n => n >= 0 && n <= items.length));
  const out = new Map<number, string>();
  let rolling = sha256Hex("epx-history-v1");
  if (sorted.has(0)) out.set(0, rolling);
  for (let i = 0; i < items.length; i += 1) {
    const itemDigest = sha256Hex(JSON.stringify(items[i]));
    rolling = sha256Hex(`${rolling}:${itemDigest}`);
    const len = i + 1;
    if (sorted.has(len)) out.set(len, rolling);
  }
  return out;
}

function getDigestEntry(keyDigest: string, now: number): SessionDigestEntry | undefined {
  const entry = sessionDigestBook.get(keyDigest);
  if (!entry) return undefined;
  if (now - entry.lastSentAt > DIGEST_BOOK_HARD_EXPIRY_MS) {
    sessionDigestBook.delete(keyDigest);
    sessionDigestBookBytes = Math.max(0, sessionDigestBookBytes - DIGEST_ENTRY_BYTES);
    return undefined;
  }
  return entry;
}

function putDigestEntry(keyDigest: string, entry: SessionDigestEntry, now: number): void {
  if (sessionDigestBook.has(keyDigest)) {
    sessionDigestBook.delete(keyDigest);
    sessionDigestBookBytes = Math.max(0, sessionDigestBookBytes - DIGEST_ENTRY_BYTES);
  }
  sessionDigestBook.set(keyDigest, entry);
  sessionDigestBookBytes += DIGEST_ENTRY_BYTES;
  if (sessionDigestBook.size > DIGEST_BOOK_MAX_ENTRIES || sessionDigestBookBytes > DIGEST_BOOK_MAX_BYTES) {
    for (const [k, candidate] of sessionDigestBook) {
      if (k !== keyDigest && now - candidate.lastSentAt > DIGEST_BOOK_HARD_EXPIRY_MS) {
        sessionDigestBook.delete(k);
        sessionDigestBookBytes = Math.max(0, sessionDigestBookBytes - DIGEST_ENTRY_BYTES);
      }
      if (sessionDigestBook.size <= DIGEST_BOOK_MAX_ENTRIES && sessionDigestBookBytes <= DIGEST_BOOK_MAX_BYTES) break;
    }
    while (sessionDigestBook.size > DIGEST_BOOK_MAX_ENTRIES || sessionDigestBookBytes > DIGEST_BOOK_MAX_BYTES) {
      const oldest = sessionDigestBook.keys().next().value;
      if (oldest === undefined || oldest === keyDigest) break;
      sessionDigestBook.delete(oldest);
      sessionDigestBookBytes = Math.max(0, sessionDigestBookBytes - DIGEST_ENTRY_BYTES);
    }
  }
}

export interface SlimCodexHistoryOptions {
  target?: string;
  headers?: HeadersInit;
  useDigestBook?: boolean;
  now?: number;
}

/**
 * Returns a new JSON body when a prefix item was shortened/deduplicated, or null when the
 * outbound body should be sent unchanged. Null keeps the caller's bytes intact
 * so an unchanged turn does not get a fresh serialization.
 */
export function slimCodexHistoryJson(body: string, options?: SlimCodexHistoryOptions): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.input)) return null;
  let lastUser = -1;
  for (let index = 0; index < parsed.input.length; index += 1) {
    if (isUserMessage(parsed.input[index])) lastUser = index;
  }
  const coldBoundary = Math.max(0, lastUser);

  const now = options?.now ?? Date.now();
  const useBook = options?.useDigestBook === true && !codexWsIncrementalUploadEnabled();
  const sessionDigest = useBook
    ? resolveSessionKeyDigest(options?.target ?? CODEX_RESPONSES_HTTP_URL, parsed, options?.headers)
    : undefined;
  const ttlMs = resolveCacheTtlMs(parsed, options?.headers);

  let effectiveBoundary = coldBoundary;
  if (sessionDigest !== undefined) {
    const previous = getDigestEntry(sessionDigest, now);
    if (
      previous
      && now >= previous.lastSentAt
      && now - previous.lastSentAt <= Math.min(previous.ttlMs, ttlMs)
      && parsed.input.length >= previous.cachedPrefixLen
      && previous.slimmedBoundary <= coldBoundary
    ) {
      const hashes = computePrefixHashes(parsed.input, [
        previous.slimmedBoundary,
        previous.cachedPrefixLen,
        parsed.input.length,
      ]);
      const matchesSlimPrefix = hashes.get(previous.slimmedBoundary) === previous.slimmedPrefixHash;
      const matchesCachedPrefix = hashes.get(previous.cachedPrefixLen) === previous.cachedPrefixHash;
      if (matchesSlimPrefix && matchesCachedPrefix) {
        // Warm cache: keep exact prior slim/dedup boundary frozen to preserve 100% cache prefix.
        effectiveBoundary = previous.slimmedBoundary;
        putDigestEntry(sessionDigest, {
          lastSentAt: now,
          ttlMs,
          slimmedBoundary: previous.slimmedBoundary,
          slimmedPrefixHash: previous.slimmedPrefixHash,
          cachedPrefixLen: parsed.input.length,
          cachedPrefixHash: hashes.get(parsed.input.length) ?? previous.cachedPrefixHash,
        }, now);
      } else {
        const freshHashes = computePrefixHashes(parsed.input, [coldBoundary, parsed.input.length]);
        putDigestEntry(sessionDigest, {
          lastSentAt: now,
          ttlMs,
          slimmedBoundary: coldBoundary,
          slimmedPrefixHash: freshHashes.get(coldBoundary) ?? sha256Hex(""),
          cachedPrefixLen: parsed.input.length,
          cachedPrefixHash: freshHashes.get(parsed.input.length) ?? sha256Hex(""),
        }, now);
      }
    } else {
      const freshHashes = computePrefixHashes(parsed.input, [coldBoundary, parsed.input.length]);
      putDigestEntry(sessionDigest, {
        lastSentAt: now,
        ttlMs,
        slimmedBoundary: coldBoundary,
        slimmedPrefixHash: freshHashes.get(coldBoundary) ?? sha256Hex(""),
        cachedPrefixLen: parsed.input.length,
        cachedPrefixHash: freshHashes.get(parsed.input.length) ?? sha256Hex(""),
      }, now);
    }
  }

  if (effectiveBoundary <= 0) return null;
  let changed = false;
  const dedupTracker = new ToolOutputDedupTracker(TOOL_OUTPUT_TYPES);
  const input = parsed.input.map((item, index) => {
    if (index >= effectiveBoundary) return item;
    const stripped = stripInlineImages(item);
    let next = stripped.value;
    changed ||= stripped.changed;
    const deduped = dedupTracker.deduplicateItem(next);
    if (deduped.changed) {
      next = deduped.value;
      changed = true;
    }
    if (isPlainObject(next) && trimToolOutput(next)) changed = true;
    return next;
  });
  if (!changed) return null;
  const next = JSON.stringify({ ...parsed, input });
  slimmedRequests += 1;
  slimmedBytes += Math.max(0, Buffer.byteLength(body) - Buffer.byteLength(next));
  return next;
}

/** Slim ordinary Codex creates. The compact endpoint receives the complete context. */
export function slimOutboundCodexHistory(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
  options?: { now?: number },
): RequestInit | undefined {
  if (!init || currentUpstreamHistorySlim() !== "codex" || typeof init.body !== "string") return init;
  const target = input instanceof Request ? input.url : String(input);
  if (target !== CODEX_RESPONSES_HTTP_URL) return init;
  const next = slimCodexHistoryJson(init.body, {
    target,
    headers: init.headers ?? (input instanceof Request ? input.headers : undefined),
    useDigestBook: !codexWsIncrementalUploadEnabled(),
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });
  if (next === null) return init;
  return { ...init, body: next };
}
