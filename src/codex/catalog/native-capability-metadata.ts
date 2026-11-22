import type { RawEntry } from "./parsing";
import type { EpxConfig } from "../../types";
import { neutralizeIdentity } from "../../adapters/identity";
import { getModelMetadata } from "../../generated/model-metadata";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { providerContextCap } from "../../providers/context-cap";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MINOR_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  NATIVE_GPT6_CONTEXT,
  NATIVE_GPT6_LUNA_MODEL,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_GPT61_SOL_CONTEXT,
  NATIVE_GPT61_SOL_MODEL,
  NATIVE_GPT61_TERRA_CONTEXT,
  NATIVE_GPT61_TERRA_MODEL,
  NATIVE_GPT62_ASTRA_MODEL,
  NATIVE_GPT62_SOL_MODEL,
  NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS,
  NATIVE_OPENAI_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
  discoveredNativeOpenAiRow,
  isConfiguredNativeOpenAiModel,
  nativeOpenAiAliasPresentation,
  nativeOpenAiCapabilitySourceSlug,
  subscribeConfiguredNativeOpenAiModels,
} from "./native-models";
import { pinnedNativeModelRows } from "./pinned-models";

/**
 * Advertised context for the Codex-login native GPT-5.6 family.
 */
export const NATIVE_GPT56_CONTEXT_WINDOW = 272_000;

/**
 * Hard ceiling: the largest input the native GPT-5.6 family actually accepts (measured).
 */
export const NATIVE_GPT56_MAX_INPUT_TOKENS = 922_000;

/** User-facing 1M opt-in: the largest window the native 5.6 family may advertise. */
export const NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW = NATIVE_GPT56_MAX_INPUT_TOKENS;

const NATIVE_GPT56_FAMILY = new Set<string>([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  NATIVE_DAYBREAK_BLUE_MODEL,
]);

export const NATIVE_OPENAI_CONTEXT_OVERRIDES: Record<string, { contextWindow?: number; maxContextWindow?: number; maxInputTokens?: number }> = {
  "gpt-5.5": { contextWindow: 272_000, maxContextWindow: 272_000 },
  "gpt-5.6-sol": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  "gpt-5.6-terra": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  "gpt-5.6-luna": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  [NATIVE_DAYBREAK_BLUE_MODEL]: { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  [NATIVE_GPT6_ASTRA_MODEL]: { ...NATIVE_GPT6_CONTEXT },
  [NATIVE_GPT6_SOL_MODEL]: { ...NATIVE_GPT6_CONTEXT },
  [NATIVE_GPT6_LUNA_MODEL]: { ...NATIVE_GPT6_CONTEXT },
  [NATIVE_GPT61_SOL_MODEL]: { ...NATIVE_GPT61_SOL_CONTEXT },
  [NATIVE_GPT61_TERRA_MODEL]: { ...NATIVE_GPT61_TERRA_CONTEXT },
  [NATIVE_GPT62_SOL_MODEL]: { ...NATIVE_GPT6_CONTEXT, contextWindow: 500_000 },
  [NATIVE_GPT62_ASTRA_MODEL]: { ...NATIVE_GPT6_CONTEXT },
  [NATIVE_GPT6_ASTRA_MINOR_MODEL]: { ...NATIVE_GPT6_CONTEXT },
};

export function withDerivedBaseInstructions(entry: RawEntry): RawEntry {
  if (typeof entry.base_instructions === "string" && entry.base_instructions.length > 0) return entry;
  const messages = entry.model_messages;
  const template = messages && typeof messages === "object" && !Array.isArray(messages)
    ? (messages as Record<string, unknown>).instructions_template
    : undefined;
  if (typeof template !== "string" || template.length === 0) return entry;
  return { ...entry, base_instructions: template };
}

export function neutralizeBorrowedInstructions(alias: RawEntry): void {
  if (typeof alias.base_instructions === "string") {
    alias.base_instructions = neutralizeIdentity(alias.base_instructions);
  }
  if (alias.model_messages && typeof alias.model_messages === "object" && !Array.isArray(alias.model_messages)) {
    const modelMessages = alias.model_messages as Record<string, unknown>;
    if (typeof modelMessages.instructions_template === "string") {
      alias.model_messages = {
        ...modelMessages,
        instructions_template: neutralizeIdentity(modelMessages.instructions_template),
      };
    }
  }
}

export function discoveredNativeCapabilityEntry(row: RawEntry): RawEntry {
  const entry = withDerivedBaseInstructions(structuredClone(row));
  delete entry.available_access_programs;
  delete entry.availability_nux;
  return entry;
}

const PINNED_UPSTREAM_MODELS: Map<string, RawEntry> = new Map(
  (pinnedNativeModelRows() as unknown as ReadonlyArray<RawEntry>)
    .flatMap(model => typeof model.slug === "string" ? [[model.slug, withDerivedBaseInstructions(model)] as const] : []),
);

function pinnedNativeCapabilityEntry(slug: string): RawEntry | undefined {
  const discovered = discoveredNativeOpenAiRow(slug);
  return discovered ? discoveredNativeCapabilityEntry(discovered)
    : PINNED_UPSTREAM_MODELS.get(nativeOpenAiCapabilitySourceSlug(slug));
}

const PINNED_NATIVE_CAPABILITY_ENTRIES: Map<string, RawEntry> = new Map(
  [...NATIVE_OPENAI_MODELS, ...NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS].flatMap(slug => {
    const entry = pinnedNativeCapabilityEntry(slug);
    return entry ? [[slug, entry] as const] : [];
  }),
);

export function pinnedNativeCapabilityFlag(
  slug: string, flag: "supports_reasoning_effort_updates" | "supports_experimental_context",
): boolean | undefined {
  const value = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.[flag];
  return typeof value === "boolean" ? value : undefined;
}

export interface NativeContextLimits {
  readonly cap?: number;
  readonly providerWindow?: number;
  readonly modelWindows?: Readonly<Record<string, number>>;
  readonly modelAutoCompactTokenLimits?: Readonly<Record<string, number>>;
}

export type NativeContextLimitsInput = NativeContextLimits | number | undefined;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function asLimits(input: NativeContextLimitsInput): NativeContextLimits {
  if (input === undefined) return {};
  return typeof input === "number" ? { cap: input } : input;
}

export function nativeOpenAiConfiguredContextLimit(slug: string, input?: NativeContextLimitsInput): number | undefined {
  const limits = asLimits(input);
  const overlay = positiveInt(limits.modelWindows?.[slug]) ?? positiveInt(limits.providerWindow);
  const cap = positiveInt(limits.cap);
  return overlay === undefined ? cap : cap === undefined ? overlay : Math.min(overlay, cap);
}

export function nativeContextLimits(
  config: Pick<EpxConfig, "providers" | "providerContextCaps">,
): NativeContextLimits {
  const provider = config.providers?.[OPENAI_CODEX_PROVIDER_ID];
  const modelWindows: Record<string, number> = {};
  for (const [slug, value] of Object.entries(provider?.modelContextWindows ?? {})) {
    const window = positiveInt(value);
    if (window !== undefined) modelWindows[slug] = window;
  }
  const modelAutoCompactTokenLimits: Record<string, number> = {};
  for (const [slug, value] of Object.entries(provider?.modelAutoCompactTokenLimits ?? {})) {
    const budget = positiveInt(value);
    if (budget !== undefined) modelAutoCompactTokenLimits[slug] = budget;
  }
  return {
    ...(positiveInt(providerContextCap(config, OPENAI_CODEX_PROVIDER_ID)) !== undefined
      ? { cap: providerContextCap(config, OPENAI_CODEX_PROVIDER_ID) }
      : {}),
    ...(positiveInt(provider?.contextWindow) !== undefined ? { providerWindow: provider!.contextWindow } : {}),
    ...(Object.keys(modelWindows).length > 0 ? { modelWindows } : {}),
    ...(Object.keys(modelAutoCompactTokenLimits).length > 0 ? { modelAutoCompactTokenLimits } : {}),
  };
}

function longWindowOptInCeiling(slug: string): number | undefined {
  if (NATIVE_GPT56_FAMILY.has(slug)) return NATIVE_GPT56_MAX_INPUT_TOKENS;
  const override = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  const defaultWindow = positiveInt(override?.contextWindow);
  const longWindow = positiveInt(override?.maxContextWindow);
  if (defaultWindow === undefined || longWindow === undefined || longWindow <= defaultWindow) {
    return undefined;
  }
  return longWindow;
}

export function narrowNativeOpenAiContextWindow(raw: number | undefined, slug: string, input: NativeContextLimitsInput): number | undefined {
  if (raw === undefined) return undefined;
  const limit = nativeOpenAiConfiguredContextLimit(slug, input);
  if (limit === undefined || limit <= raw) return limit ?? raw;
  const optInCeiling = longWindowOptInCeiling(slug);
  return optInCeiling === undefined ? raw : Math.max(raw, Math.min(limit, optInCeiling));
}

export function nativeOpenAiContextWindow(slug: string, limits?: NativeContextLimitsInput): number | undefined {
  const raw = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.contextWindow
    ?? (typeof PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.context_window === "number"
      ? PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)!.context_window as number
      : undefined);
  return narrowNativeOpenAiContextWindow(raw, slug, limits);
}

export function nativeOpenAiMaxOutputTokens(slug: string): number | undefined {
  const sourceSlug = nativeOpenAiCapabilitySourceSlug(slug);
  return positiveInt(getModelMetadata("openai", sourceSlug)?.maxTokens);
}

export function nativeOpenAiContextTier(
  slug: string,
  limits?: NativeContextLimitsInput,
): { defaultWindow: number; longWindow: number } | undefined {
  const override = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  const defaultWindow = positiveInt(override?.contextWindow);
  const longWindow = positiveInt(override?.maxContextWindow);
  if (defaultWindow === undefined || longWindow === undefined || longWindow <= defaultWindow) return undefined;
  const resolved = asLimits(limits);
  const levers = [
    positiveInt(resolved.modelWindows?.[slug]),
    positiveInt(resolved.providerWindow),
    positiveInt(resolved.cap),
  ];
  if (levers.some(lever => lever !== undefined && lever < longWindow)) return undefined;
  return { defaultWindow, longWindow };
}

export function nativeOpenAiMaxInputTokens(slug: string, limits?: NativeContextLimitsInput): number | undefined {
  const raw = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.maxInputTokens;
  if (raw === undefined) return undefined;
  const window = nativeOpenAiContextWindow(slug, limits);
  const narrowed = narrowNativeOpenAiContextWindow(raw, slug, limits) ?? raw;
  return window === undefined ? narrowed : Math.min(narrowed, window);
}

export function nativeOpenAiAutoCompactTokenLimit(
  slug: string,
  limits?: NativeContextLimitsInput,
): number | undefined {
  const contextWindow = nativeOpenAiContextWindow(slug, limits);
  if (contextWindow === undefined) return undefined;
  const configured = positiveInt(asLimits(limits).modelAutoCompactTokenLimits?.[slug]);
  return clampAutoCompactTokenLimit(
    contextWindow,
    nativeOpenAiMaxInputTokens(slug, limits),
    configured,
  );
}

export function nativeInputModalities(slug: string): string[] {
  const upstream = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug);
  if (Array.isArray(upstream?.input_modalities) && upstream!.input_modalities!.length > 0) {
    return [...upstream!.input_modalities as string[]];
  }
  return ["text", "image"];
}

export function nativeReasoningEfforts(slug: string): string[] {
  const upstream = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug);
  const levels = Array.isArray(upstream?.supported_reasoning_levels)
    ? upstream!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length > 0 || discoveredNativeOpenAiRow(slug)) {
    return levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
  }
  return ["low", "medium", "high", "xhigh"];
}

export function nativeDefaultReasoningEffort(slug: string): string | undefined {
  const level = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.default_reasoning_level;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}

export function nativeMultiAgentVersion(slug: string): string | undefined {
  const version = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.multi_agent_version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

export function nativeParallelToolCalls(slug: string): boolean {
  return PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.supports_parallel_tool_calls === true
    || false;
}

function upstreamNativeEntryForSlug(slug: string): RawEntry | undefined {
  const discovered = discoveredNativeOpenAiRow(slug);
  if (discovered) return discoveredNativeCapabilityEntry(discovered);
  const sourceSlug = nativeOpenAiCapabilitySourceSlug(slug);
  if (!sourceSlug.startsWith("gpt-5.6-") && !SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(sourceSlug)
    && !isConfiguredNativeOpenAiModel(slug)) {
    return undefined;
  }
  const source = PINNED_UPSTREAM_MODELS.get(sourceSlug);
  if (!source) return undefined;
  if (slug === sourceSlug) return withDerivedBaseInstructions(source);

  const alias = structuredClone(withDerivedBaseInstructions(source)) as RawEntry;
  alias.slug = slug;
  const presentation = nativeOpenAiAliasPresentation(slug);
  if (!presentation) return undefined;
  alias.display_name = presentation.displayName;
  alias.description = presentation.description;
  neutralizeBorrowedInstructions(alias);
  delete alias.availability_nux;
  return alias;
}

export const UPSTREAM_NATIVE_ENTRIES: Map<string, RawEntry> = new Map(
  [...NATIVE_OPENAI_MODELS, ...NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS].flatMap(slug => {
    const entry = upstreamNativeEntryForSlug(slug);
    return entry ? [[slug, entry] as const] : [];
  }),
);

subscribeConfiguredNativeOpenAiModels((current, removed) => {
  for (const slug of removed) {
    PINNED_NATIVE_CAPABILITY_ENTRIES.delete(slug);
    UPSTREAM_NATIVE_ENTRIES.delete(slug);
    delete NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  }
  for (const slug of current) {
    const pinned = pinnedNativeCapabilityEntry(slug);
    if (pinned) PINNED_NATIVE_CAPABILITY_ENTRIES.set(slug, pinned);
    const upstream = upstreamNativeEntryForSlug(slug);
    if (upstream) UPSTREAM_NATIVE_ENTRIES.set(slug, upstream);
    const discovered = discoveredNativeOpenAiRow(slug);
    const contextWindow = positiveInt(discovered?.context_window) ?? NATIVE_GPT6_CONTEXT.contextWindow;
    const maxContextWindow = Math.max(contextWindow,
      positiveInt(discovered?.max_context_window) ?? NATIVE_GPT6_CONTEXT.maxContextWindow);
    NATIVE_OPENAI_CONTEXT_OVERRIDES[slug] = { contextWindow, maxContextWindow, maxInputTokens: maxContextWindow };
  }
});

export function upstreamNativeEntry(slug: string): RawEntry | null {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (!entry) return null;
  const clone = JSON.parse(JSON.stringify(entry)) as RawEntry;
  delete clone.minimal_client_version;
  return clone;
}

export function nativeOpenAiCapabilityDisplayName(slug: string): string | undefined {
  const presentation = nativeOpenAiAliasPresentation(slug);
  if (presentation) return presentation.displayName;
  const pinned = UPSTREAM_NATIVE_ENTRIES.get(slug);
  return typeof pinned?.display_name === "string" ? pinned.display_name : undefined;
}
