import type { AnthropicCacheRetention } from "../adapters/anthropic/cache-retention";

export interface EpxCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "turn" | "global";
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse and bound an inbound Anthropic `cache_control` marker.
 *
 * Accepts only Anthropic's documented `"ephemeral"` breakpoint shape with optional
 * `"5m" | "1h"` TTL and `"turn" | "global"` scope; non-ephemeral or malformed objects
 * fail closed (return `undefined`) so arbitrary client fields cannot cross bridges.
 */
export function parseEpxCacheControl(raw: unknown): EpxCacheControl | undefined {
  if (!isRec(raw) || raw.type !== "ephemeral") return undefined;
  const ttl = raw.ttl === "5m" || raw.ttl === "1h" ? raw.ttl : undefined;
  const scope = raw.scope === "turn" || raw.scope === "global" ? raw.scope : undefined;
  return {
    type: "ephemeral",
    ...(ttl !== undefined ? { ttl } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

export function cacheControlWireField(raw: unknown): { cache_control?: EpxCacheControl } {
  const parsed = parseEpxCacheControl(raw);
  return parsed ? { cache_control: parsed } : {};
}

export function sameEpxCacheControl(a: EpxCacheControl | undefined, b: EpxCacheControl | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.ttl === b.ttl && a.scope === b.scope;
}

/**
 * Normalize one preserved `cache_control` against the target destination's resolved retention.
 *
 * - `"none"`: strips all breakpoints.
 * - `"short"`: omits `ttl` so 5m defaults apply across both 1st-party and 3p endpoints that reject explicit `ttl`.
 * - `"long"`: upgrades TTL-less `{ type: "ephemeral" }` breakpoints to `ttl: "1h"`, preserving explicit `"5m"` or `"1h"`.
 */
export function resolvePreservedAnthropicCacheControl(
  raw: EpxCacheControl | undefined,
  retention: AnthropicCacheRetention,
): EpxCacheControl | undefined {
  if (!raw || retention === "none") return undefined;
  if (retention === "short") {
    return {
      type: "ephemeral",
      ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
    };
  }
  return {
    type: "ephemeral",
    ttl: raw.ttl ?? "1h",
    ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
  };
}

const RESPONSES_STRIP_MAX_DEPTH = 12;
const RESPONSES_STRIP_MAX_NODES = 100_000;

function stripCacheControlFromPart(value: unknown, state: { nodes: number }, depth: number): { value: unknown; changed: boolean } {
  state.nodes += 1;
  if (depth > RESPONSES_STRIP_MAX_DEPTH || state.nodes > RESPONSES_STRIP_MAX_NODES) {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const stripped = stripCacheControlFromPart(item, state, depth + 1);
      if (stripped.changed) changed = true;
      out.push(stripped.value);
    }
    return { value: changed ? out : value, changed };
  }
  if (!isRec(value)) return { value, changed: false };
  let changed = Object.hasOwn(value, "cache_control");
  let next: Rec | undefined;
  if (changed) {
    next = { ...value };
    delete next.cache_control;
  }
  // Recurse only into structural Responses content/output containers (never tool schemas/arguments).
  for (const key of ["content", "output"] as const) {
    if (!(key in value)) continue;
    const child = stripCacheControlFromPart(value[key], state, depth + 1);
    if (child.changed) {
      changed = true;
      (next ??= { ...value })[key] = child.value;
    }
  }
  return { value: next ?? value, changed };
}

/**
 * Strip bridge-carried `cache_control` and internal `_anthropic*` hints before an OpenAI Responses
 * passthrough forwards a body upstream. Copy-on-write, allocation-free when absent.
 */
export function stripBridgeCacheControlsForResponsesWire(body: unknown): unknown {
  if (!isRec(body)) return body;
  const state = { nodes: 0 };
  let next: Rec | undefined;
  for (const topKey of [
    "cache_control",
    "_anthropicSystemCachePrefixControl",
    "_anthropicSystemBlocks",
    "_anthropicAutomaticCacheControl",
  ] as const) {
    if (Object.hasOwn(body, topKey)) {
      (next ??= { ...body });
      delete next[topKey];
    }
  }
  if (Array.isArray(body.tools)) {
    let toolsChanged = false;
    const nextTools = body.tools.map((tool) => {
      if (!isRec(tool) || !Object.hasOwn(tool, "cache_control")) return tool;
      toolsChanged = true;
      const { cache_control: _cc, ...rest } = tool;
      return rest;
    });
    if (toolsChanged) (next ??= { ...body }).tools = nextTools;
  }
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const nextInput = body.input.map((item) => {
      const stripped = stripCacheControlFromPart(item, state, 0);
      if (stripped.changed) inputChanged = true;
      return stripped.value;
    });
    if (inputChanged) (next ??= { ...body }).input = nextInput;
  }
  return next ?? body;
}
