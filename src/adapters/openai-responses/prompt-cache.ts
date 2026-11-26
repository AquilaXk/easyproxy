import { createHash } from "node:crypto";
import type { EpxProviderConfig } from "../../types";
import { destinationHostOfUrl } from "./config-update-fallback";
import { isPlainObject } from "./internal";

export const MAX_PROMPT_CACHE_KEY_SHARD_CACHE = 4096;
const MAX_SHARD_INPUT_BYTES = 16 * 1024;
const PRINTABLE_KEY_PREFIX_RE = /^[A-Za-z0-9._:-]{1,51}$/;

const promptCacheKeyShardCache = new Map<string, string>();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveServingPoolIdentity(
  provider: EpxProviderConfig,
  providerName: string,
  url: string,
): string {
  const override = (provider as { _codexAccountOverride?: { chatgptAccountId?: string; kind?: string } })._codexAccountOverride;
  if (override?.chatgptAccountId && override.chatgptAccountId.trim()) {
    const kindPrefix = override.kind === "main-pool" ? "main:" : "";
    return `codex:${kindPrefix}${override.chatgptAccountId.trim()}`;
  }
  const attempt = provider._apiKeyAttempt;
  if (attempt?.entryId) return `key:${providerName}:${attempt.entryId}`;
  if (attempt?.reference) return `ref:${providerName}:${attempt.reference}`;
  if (typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0) {
    return `apikey:${providerName}:${sha256Hex(provider.apiKey).slice(0, 16)}`;
  }
  return `provider:${providerName}:${destinationHostOfUrl(url)}`;
}

/**
 * Deterministically shard an outbound `prompt_cache_key` by resolved post-affinity credential/account
 * lane so shared caller cohort keys or failovers stay cleanly isolated upstream, backed by a
 * bounded 4,096-entry LRU cache.
 */
export function shardOutboundPromptCacheKey(
  rawPromptCacheKey: unknown,
  context: { provider: EpxProviderConfig; providerName?: string; url: string },
): string | undefined {
  if (context.provider.promptCacheKeyLaneSharding !== true) return undefined;
  if (typeof rawPromptCacheKey !== "string") return undefined;
  const trimmed = rawPromptCacheKey.trim();
  if (trimmed.length === 0) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_SHARD_INPUT_BYTES) return undefined;

  const servingIdentity = resolveServingPoolIdentity(
    context.provider,
    context.providerName ?? "<unnamed>",
    context.url,
  );
  const lookupKey = trimmed.length <= 128
    ? `${servingIdentity}\0${trimmed}`
    : `${servingIdentity}\0#sha256:${sha256Hex(trimmed)}`;

  const cached = promptCacheKeyShardCache.get(lookupKey);
  if (cached !== undefined) {
    promptCacheKeyShardCache.delete(lookupKey);
    promptCacheKeyShardCache.set(lookupKey, cached);
    return cached;
  }

  const laneDigest = createHash("sha256")
    .update("epx-prompt-cache-lane-v1\0")
    .update(servingIdentity)
    .update("\0")
    .update(trimmed)
    .digest("hex")
    .slice(0, 12);

  const sharded = PRINTABLE_KEY_PREFIX_RE.test(trimmed)
    ? `${trimmed}:${laneDigest}`
    : `epx_${laneDigest}_${sha256Hex(trimmed).slice(0, 12)}`;

  promptCacheKeyShardCache.set(lookupKey, sharded);
  while (promptCacheKeyShardCache.size > MAX_PROMPT_CACHE_KEY_SHARD_CACHE) {
    promptCacheKeyShardCache.delete(promptCacheKeyShardCache.keys().next().value!);
  }
  return sharded;
}

export function applyOutboundPromptCacheKeyLaneSharding(
  body: unknown,
  context: { provider: EpxProviderConfig; providerName?: string; url: string },
): unknown {
  if (context.provider.promptCacheKeyLaneSharding !== true) return body;
  if (!isPlainObject(body) || typeof body.prompt_cache_key !== "string") return body;
  const sharded = shardOutboundPromptCacheKey(body.prompt_cache_key, context);
  if (!sharded || sharded === body.prompt_cache_key) return body;
  return { ...body, prompt_cache_key: sharded };
}

export function getPromptCacheKeyShardCacheSizeForTests(): number {
  return promptCacheKeyShardCache.size;
}

export function resetPromptCacheKeyShardCacheForTests(): void {
  promptCacheKeyShardCache.clear();
}

/**
 * GPT-5.6 retired the legacy 24-hour retention field, and the ChatGPT backend 400s the whole
 * request when that field is present (issue #2092).
 *
 * The retired field is NOT translated to the replacement: 5.6 carries a different TTL contract,
 * and implicit caching still applies when the caller sent no replacement options. Inventing a
 * value here would silently change a caching decision the caller never made.
 *
 * Deliberately narrow on both axes, because a wider strip is a behavior change rather than a fix:
 * only the gpt-5.6 family (an older model may still honor the field), and only on the canonical
 * ChatGPT backend, which is the deployment that rejects it. Matching is exact-or-dashed-prefix so
 * a future `gpt-5.60` is not swept up by a bare `startsWith`.
 */
export function stripDeprecatedPromptCacheRetention(body: unknown, modelId: unknown): unknown {
  if (!isPlainObject(body)) return body;
  if (typeof modelId !== "string") return body;
  if (modelId !== "gpt-5.6" && !modelId.startsWith("gpt-5.6-")) return body;
  if (!Object.hasOwn(body, "prompt_cache_retention")) return body;
  const { prompt_cache_retention: _retention, ...rest } = body;
  return rest;
}

/**
 * Public Responses clients can send `prompt_cache_options`, but the canonical ChatGPT Codex
 * backend rejects the top-level field before inference (issue #2765). Custom forward gateways and
 * API-key Responses providers own different wire contracts, so the caller applies this only after
 * the canonical destination predicate succeeds.
 */
export function stripCanonicalForwardPromptCacheOptions(body: unknown): unknown {
  if (!isPlainObject(body) || !Object.hasOwn(body, "prompt_cache_options")) return body;
  const { prompt_cache_options: _options, ...rest } = body;
  return rest;
}

const POSIT_CACHE_MARKER_MAX_DEPTH = 64;
const POSIT_CACHE_MARKER_MAX_NODES = 100_000;

type PromptCacheMarkerRewrite = {
  value: unknown;
  changed: boolean;
  complete: boolean;
};

/**
 * Remove Posit/Anthropic-style prompt-cache markers without trusting request nesting. The walk
 * aborts atomically when its depth or node budget is exceeded, so a hostile extension object can
 * neither overflow the stack nor receive a partially rewritten subtree.
 */
export function stripPromptCacheBreakpoints(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): PromptCacheMarkerRewrite {
  state.nodes += 1;
  if (depth > POSIT_CACHE_MARKER_MAX_DEPTH || state.nodes > POSIT_CACHE_MARKER_MAX_NODES) {
    return { value, changed: false, complete: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const entry of value) {
      const rewritten = stripPromptCacheBreakpoints(entry, state, depth + 1);
      if (!rewritten.complete) return { value, changed: false, complete: false };
      changed ||= rewritten.changed;
      next.push(rewritten.value);
    }
    return { value: changed ? next : value, changed, complete: true };
  }
  if (!isPlainObject(value)) return { value, changed: false, complete: true };

  let changed = Object.hasOwn(value, "prompt_cache_breakpoint");
  // Keep symbol provenance when rebuilding an input item or one of its nested fields.
  const next: Record<string, unknown> = { ...value };
  delete next.prompt_cache_breakpoint;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "prompt_cache_breakpoint") continue;
    const rewritten = stripPromptCacheBreakpoints(entry, state, depth + 1);
    if (!rewritten.complete) return { value, changed: false, complete: false };
    changed ||= rewritten.changed;
    next[key] = rewritten.value;
  }
  return { value: changed ? next : value, changed, complete: true };
}
