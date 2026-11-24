import type { EpxScenarioKind, EpxScenarioRoutingConfig } from "../types";

export const SCENARIO_KINDS = ["longContext", "think", "background", "webSearch"] as const;
export const DEFAULT_SCENARIO_PRECEDENCE: readonly EpxScenarioKind[] = [
  "background",
  "longContext",
  "webSearch",
  "think",
];

export const DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS = 60_000;
export const MIN_LONG_CONTEXT_THRESHOLD_TOKENS = 1_000;
export const MAX_LONG_CONTEXT_THRESHOLD_TOKENS = 10_000_000;
export const DEFAULT_THINK_BUDGET_THRESHOLD = 1;
export const MIN_THINK_BUDGET_THRESHOLD = 1;
export const MAX_THINK_BUDGET_THRESHOLD = 1_000_000;

const CHARS_PER_TOKEN = 4;
const MEDIA_TOKEN_CHAR_ESTIMATE = 4_000; // ~1k tokens; prevents inflating base64 blobs as 250k text tokens
const DOCUMENT_TOKEN_CHAR_ESTIMATE = 12_000;
const MAX_SCAN_ITEMS = 512;
const MAX_SCAN_PARTS_PER_ITEM = 32;
const MAX_SCAN_TOOLS = 64;
const MAX_SYSTEM_PREFIX_INSPECT_CHARS = 512;

const THINK_EFFORTS = new Set(["high", "xhigh", "max", "ultra"]);
const BACKGROUND_SYSTEM_MARKERS = [
  "summarize this conversation",
  "summarize the conversation",
  "generate a concise title",
  "generate a short title",
  "please write a 5-10 word title",
  "is this a new topic",
  "extract a concise topic",
];

export interface ScenarioClassification {
  matched: EpxScenarioKind | null;
  matchedScenarios: EpxScenarioKind[];
  estimatedTokens: number;
  signals: Record<EpxScenarioKind, boolean>;
  truncated: boolean;
}

export interface ScenarioClassifyInput {
  body: unknown;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  isCompaction?: boolean;
  selector?: string;
  config?: EpxScenarioRoutingConfig;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHeaderValue(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return typeof value === "string" ? value.trim().slice(0, 128) : undefined;
  }
  const rec = headers as Readonly<Record<string, string | undefined>>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v.trim().slice(0, 128);
  }
  return undefined;
}

function isScenarioKind(value: string): value is EpxScenarioKind {
  return value === "longContext" || value === "think" || value === "background" || value === "webSearch";
}

function isDataOrBase64Blob(text: string): boolean {
  if (text.length < 128) return false;
  return text.startsWith("data:") && text.slice(0, 96).includes(";base64,");
}

function stringCharCost(text: string): number {
  return isDataOrBase64Blob(text) ? MEDIA_TOKEN_CHAR_ESTIMATE : text.length;
}

function hasWebSearchTool(body: Record<string, unknown>): boolean {
  const toolChoice = body.tool_choice;
  if (isPlainRecord(toolChoice)) {
    const tcType = typeof toolChoice.type === "string" ? toolChoice.type.toLowerCase() : "";
    const tcName = typeof toolChoice.name === "string" ? toolChoice.name.toLowerCase() : "";
    if (tcType.startsWith("web_search") || tcType === "google_search" || tcName === "web_search" || tcName === "google_search") {
      return true;
    }
  }
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  const limit = Math.min(tools.length, MAX_SCAN_TOOLS);
  for (let i = 0; i < limit; i++) {
    const tool = tools[i];
    if (!isPlainRecord(tool)) continue;
    const type = typeof tool.type === "string" ? tool.type.toLowerCase() : "";
    const name = typeof tool.name === "string" ? tool.name.toLowerCase() : "";
    if (
      type.startsWith("web_search")
      || type === "google_search"
      || type === "google_search_retrieval"
      || Object.hasOwn(tool, "google_search")
      || Object.hasOwn(tool, "google_search_retrieval")
      || name === "web_search"
      || name === "google_search"
    ) {
      return true;
    }
    const fn = tool.function;
    if (isPlainRecord(fn) && typeof fn.name === "string") {
      const fnName = fn.name.toLowerCase();
      if (fnName === "web_search" || fnName === "google_search") return true;
    }
  }
  return false;
}

function hasHighThinkSignal(body: Record<string, unknown>, budgetThreshold: number): boolean {
  const thinking = body.thinking;
  if (isPlainRecord(thinking)) {
    const type = typeof thinking.type === "string" ? thinking.type.toLowerCase() : "";
    if (type === "adaptive") return true;
    if (type === "enabled") {
      if (typeof thinking.budget_tokens === "number" && Number.isFinite(thinking.budget_tokens)) {
        return thinking.budget_tokens >= budgetThreshold;
      }
      return true;
    }
  }
  const reasoning = body.reasoning;
  if (isPlainRecord(reasoning) && typeof reasoning.effort === "string") {
    if (THINK_EFFORTS.has(reasoning.effort.trim().toLowerCase())) return true;
  }
  if (typeof body.reasoning_effort === "string" && THINK_EFFORTS.has(body.reasoning_effort.trim().toLowerCase())) {
    return true;
  }
  const outputConfig = body.output_config;
  if (isPlainRecord(outputConfig) && typeof outputConfig.effort === "string") {
    if (THINK_EFFORTS.has(outputConfig.effort.trim().toLowerCase())) return true;
  }
  return false;
}

function systemOpeningPrefix(body: Record<string, unknown>): string {
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    return body.instructions.slice(0, MAX_SYSTEM_PREFIX_INSPECT_CHARS).toLowerCase();
  }
  if (typeof body.system === "string" && body.system.length > 0) {
    return body.system.slice(0, MAX_SYSTEM_PREFIX_INSPECT_CHARS).toLowerCase();
  }
  if (Array.isArray(body.system)) {
    for (let i = 0; i < Math.min(body.system.length, 4); i++) {
      const block = body.system[i];
      if (isPlainRecord(block) && typeof block.text === "string" && block.text.length > 0) {
        return block.text.slice(0, MAX_SYSTEM_PREFIX_INSPECT_CHARS).toLowerCase();
      }
    }
  }
  const container = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : undefined;
  if (container && container.length > 0) {
    const first = container[0];
    if (isPlainRecord(first) && (first.role === "system" || first.role === "developer")) {
      if (typeof first.content === "string") {
        return first.content.slice(0, MAX_SYSTEM_PREFIX_INSPECT_CHARS).toLowerCase();
      }
      if (Array.isArray(first.content)) {
        for (let i = 0; i < Math.min(first.content.length, 4); i++) {
          const part = first.content[i];
          if (isPlainRecord(part) && typeof part.text === "string" && part.text.length > 0) {
            return part.text.slice(0, MAX_SYSTEM_PREFIX_INSPECT_CHARS).toLowerCase();
          }
        }
      }
    }
  }
  return "";
}

function hasBackgroundSignal(
  body: Record<string, unknown>,
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
  isCompaction: boolean | undefined,
): boolean {
  if (isCompaction === true || body.background === true) return true;
  const priority = readHeaderValue(headers, "x-epx-priority")?.toLowerCase();
  if (priority === "background") return true;
  const metadata = body.metadata;
  if (isPlainRecord(metadata)) {
    for (const key of ["priority", "scenario", "task"] as const) {
      if (typeof metadata[key] === "string" && metadata[key].trim().toLowerCase() === "background") {
        return true;
      }
    }
  }
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) return false;
  const prefix = systemOpeningPrefix(body);
  if (!prefix) return false;
  return BACKGROUND_SYSTEM_MARKERS.some(marker => prefix.includes(marker));
}

function estimateContentPartChars(part: unknown): number {
  if (typeof part === "string") return stringCharCost(part);
  if (!isPlainRecord(part)) return 0;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "input_image" || type === "image_url" || type === "image"
    || type === "input_audio" || type === "audio"
    || type === "input_video" || type === "video") {
    return MEDIA_TOKEN_CHAR_ESTIMATE;
  }
  if (type === "input_file" || type === "document") {
    if (typeof part.file_data === "string" || isPlainRecord(part.source)) {
      return DOCUMENT_TOKEN_CHAR_ESTIMATE;
    }
    return 512;
  }
  let chars = 0;
  if (typeof part.text === "string") chars += stringCharCost(part.text);
  if (typeof part.thinking === "string") chars += part.thinking.length;
  if (typeof part.refusal === "string") chars += part.refusal.length;
  if (typeof part.arguments === "string") chars += part.arguments.length;
  if (typeof part.content === "string") chars += stringCharCost(part.content);
  return chars;
}

function estimateBodyInputChars(
  body: Record<string, unknown>,
  stopAtChars: number,
): { chars: number; truncated: boolean } {
  let chars = 0;
  let truncated = false;

  if (typeof body.instructions === "string") {
    chars += stringCharCost(body.instructions);
    if (chars >= stopAtChars) return { chars, truncated };
  }
  if (typeof body.system === "string") {
    chars += stringCharCost(body.system);
    if (chars >= stopAtChars) return { chars, truncated };
  } else if (Array.isArray(body.system)) {
    const limit = Math.min(body.system.length, MAX_SCAN_ITEMS);
    if (limit < body.system.length) truncated = true;
    for (let i = 0; i < limit; i++) {
      chars += estimateContentPartChars(body.system[i]);
      if (chars >= stopAtChars) return { chars, truncated };
    }
  }

  if (typeof body.input === "string") {
    chars += stringCharCost(body.input);
    if (chars >= stopAtChars) return { chars, truncated };
  }

  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : undefined;
  if (items) {
    const itemLimit = Math.min(items.length, MAX_SCAN_ITEMS);
    if (itemLimit < items.length) truncated = true;
    for (let i = 0; i < itemLimit; i++) {
      const item = items[i];
      if (typeof item === "string") {
        chars += stringCharCost(item);
      } else if (isPlainRecord(item)) {
        if (typeof item.content === "string") {
          chars += stringCharCost(item.content);
        } else if (Array.isArray(item.content)) {
          const partLimit = Math.min(item.content.length, MAX_SCAN_PARTS_PER_ITEM);
          if (partLimit < item.content.length) truncated = true;
          for (let j = 0; j < partLimit; j++) {
            chars += estimateContentPartChars(item.content[j]);
            if (chars >= stopAtChars) return { chars, truncated };
          }
        }
        if (typeof item.text === "string") chars += stringCharCost(item.text);
        if (typeof item.arguments === "string") chars += item.arguments.length;
        if (typeof item.output === "string") chars += stringCharCost(item.output);
        else if (Array.isArray(item.output)) {
          const partLimit = Math.min(item.output.length, MAX_SCAN_PARTS_PER_ITEM);
          if (partLimit < item.output.length) truncated = true;
          for (let j = 0; j < partLimit; j++) {
            chars += estimateContentPartChars(item.output[j]);
            if (chars >= stopAtChars) return { chars, truncated };
          }
        }
      }
      if (chars >= stopAtChars) return { chars, truncated };
    }
  }

  if (Array.isArray(body.tools)) {
    const limit = Math.min(body.tools.length, MAX_SCAN_TOOLS);
    if (limit < body.tools.length) truncated = true;
    for (let i = 0; i < limit; i++) {
      const t = body.tools[i];
      if (!isPlainRecord(t)) continue;
      if (typeof t.name === "string") chars += t.name.length;
      if (typeof t.description === "string") chars += t.description.length;
      const fn = t.function;
      if (isPlainRecord(fn)) {
        if (typeof fn.name === "string") chars += fn.name.length;
        if (typeof fn.description === "string") chars += fn.description.length;
      }
      if (chars >= stopAtChars) return { chars, truncated };
    }
  }

  return { chars, truncated };
}

export function selectorMatchesScenarioPatterns(selector: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  const trimmed = selector.trim();
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) {
      if (trimmed.startsWith(pattern.slice(0, -1))) return true;
    } else if (trimmed === pattern) {
      return true;
    }
  }
  return false;
}

const EMPTY_CLASSIFICATION: ScenarioClassification = {
  matched: null,
  matchedScenarios: [],
  estimatedTokens: 0,
  signals: { longContext: false, think: false, background: false, webSearch: false },
  truncated: false,
};

/**
 * Single-pass, zero-allocation-heavy bounded heuristic scenario classifier.
 * When `config.enabled` is false or no routes are configured, exits in O(1) without scanning `body`.
 */
export function classifyRequestScenario(input: ScenarioClassifyInput): ScenarioClassification {
  const cfg = input.config;
  if (cfg && cfg.enabled !== true) return EMPTY_CLASSIFICATION;

  const configuredRoutes = cfg?.routes;
  const hasConfiguredFilter = cfg !== undefined;
  const activeScenarios = new Set<EpxScenarioKind>();
  if (configuredRoutes) {
    for (const kind of SCENARIO_KINDS) {
      const target = configuredRoutes[kind];
      if (typeof target === "string" && target.trim().length > 0) {
        activeScenarios.add(kind);
      }
    }
  }
  if (hasConfiguredFilter && activeScenarios.size === 0) return EMPTY_CLASSIFICATION;
  if (hasConfiguredFilter && input.selector && !selectorMatchesScenarioPatterns(input.selector, cfg?.matchModels)) {
    return EMPTY_CLASSIFICATION;
  }

  const body = isPlainRecord(input.body) ? input.body : {};
  const precedence = (cfg?.precedence?.length ? cfg.precedence : DEFAULT_SCENARIO_PRECEDENCE);
  const tokenThreshold = typeof cfg?.longContextThresholdTokens === "number" && Number.isFinite(cfg.longContextThresholdTokens)
    ? Math.min(MAX_LONG_CONTEXT_THRESHOLD_TOKENS, Math.max(MIN_LONG_CONTEXT_THRESHOLD_TOKENS, Math.trunc(cfg.longContextThresholdTokens)))
    : DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS;
  const thinkBudgetThreshold = typeof cfg?.thinkBudgetThreshold === "number" && Number.isFinite(cfg.thinkBudgetThreshold)
    ? Math.min(MAX_THINK_BUDGET_THRESHOLD, Math.max(MIN_THINK_BUDGET_THRESHOLD, Math.trunc(cfg.thinkBudgetThreshold)))
    : DEFAULT_THINK_BUDGET_THRESHOLD;

  const explicitScenarioRaw = readHeaderValue(input.headers, "x-epx-scenario")?.trim();
  const explicitScenario = explicitScenarioRaw && isScenarioKind(explicitScenarioRaw) ? explicitScenarioRaw : undefined;

  const needBackground = !hasConfiguredFilter || activeScenarios.has("background");
  const needWebSearch = !hasConfiguredFilter || activeScenarios.has("webSearch");
  const needThink = !hasConfiguredFilter || activeScenarios.has("think");
  const needLongContext = !hasConfiguredFilter || activeScenarios.has("longContext");

  const signals: Record<EpxScenarioKind, boolean> = {
    background: needBackground && (explicitScenario === "background" || hasBackgroundSignal(body, input.headers, input.isCompaction)),
    webSearch: needWebSearch && (explicitScenario === "webSearch" || hasWebSearchTool(body)),
    think: needThink && (explicitScenario === "think" || hasHighThinkSignal(body, thinkBudgetThreshold)),
    longContext: needLongContext && explicitScenario === "longContext",
  };

  let estimatedTokens = 0;
  let truncated = false;
  if (needLongContext && !signals.longContext) {
    const charThreshold = tokenThreshold * CHARS_PER_TOKEN;
    const estimate = estimateBodyInputChars(body, charThreshold);
    estimatedTokens = Math.ceil(estimate.chars / CHARS_PER_TOKEN);
    truncated = estimate.truncated;
    if (estimate.chars >= charThreshold || estimatedTokens >= tokenThreshold) {
      signals.longContext = true;
    }
  }

  const orderedPrecedence: EpxScenarioKind[] = [...precedence];
  for (const kind of DEFAULT_SCENARIO_PRECEDENCE) {
    if (!orderedPrecedence.includes(kind)) orderedPrecedence.push(kind);
  }
  const matchedScenarios: EpxScenarioKind[] = [];
  for (const kind of orderedPrecedence) {
    if (signals[kind]) matchedScenarios.push(kind);
  }
  const matched = matchedScenarios.find(kind => !hasConfiguredFilter || activeScenarios.has(kind)) ?? null;
  return { matched, matchedScenarios, estimatedTokens, signals, truncated };
}
