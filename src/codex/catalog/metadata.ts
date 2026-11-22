import { codexAccountNamespaceEntries, isMainCodexAccountTarget } from "../account-namespaces";
import type { EpxConfig } from "../../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { isNativeAliasCombo } from "../../combos";
import { isPlainObject } from "../../lib/plain-data";
import {
  NATIVE_GPT56_CONTEXT_WINDOW,
  NATIVE_GPT56_MAX_INPUT_TOKENS,
  NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW,
  NATIVE_OPENAI_CONTEXT_OVERRIDES,
  UPSTREAM_NATIVE_ENTRIES,
  narrowNativeOpenAiContextWindow,
  nativeContextLimits,
  nativeDefaultReasoningEffort,
  nativeInputModalities,
  nativeMultiAgentVersion,
  nativeOpenAiAutoCompactTokenLimit,
  nativeOpenAiCapabilityDisplayName,
  nativeOpenAiConfiguredContextLimit,
  nativeOpenAiContextTier,
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
  nativeOpenAiMaxOutputTokens,
  nativeParallelToolCalls,
  nativeReasoningEfforts,
  neutralizeBorrowedInstructions,
  pinnedNativeCapabilityFlag,
  upstreamNativeEntry,
  type NativeContextLimits,
  type NativeContextLimitsInput,
} from "./native-capability-metadata";
export {
  NATIVE_GPT56_CONTEXT_WINDOW,
  NATIVE_GPT56_MAX_INPUT_TOKENS,
  NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW,
  NATIVE_OPENAI_CONTEXT_OVERRIDES,
  UPSTREAM_NATIVE_ENTRIES,
  narrowNativeOpenAiContextWindow,
  nativeContextLimits,
  nativeDefaultReasoningEffort,
  nativeInputModalities,
  nativeMultiAgentVersion,
  nativeOpenAiAutoCompactTokenLimit,
  nativeOpenAiCapabilityDisplayName,
  nativeOpenAiConfiguredContextLimit,
  nativeOpenAiContextTier,
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
  nativeOpenAiMaxOutputTokens,
  nativeParallelToolCalls,
  nativeReasoningEfforts,
  pinnedNativeCapabilityFlag,
  upstreamNativeEntry,
  type NativeContextLimits,
  type NativeContextLimitsInput,
};


import type { RawEntry } from "./parsing";
import { providerCodexAccountMode } from "../../providers/registry";
import { readCurrentCatalogOrCache, readCurrentCodexCatalog, readCurrentCodexModelsCache, unique } from "./bundled";
import { trustedAccountBoundNativeCatalogSlug, visibleCodexAccountSelectors } from "./account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { ROUTED_ORIGIN_FIELD } from "./ownership";
import { RESERVE_METADATA_SOURCE_FIELD } from "./reserve";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_GPT6_ASTRA_MINOR_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  NATIVE_GPT6_LUNA_MODEL,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_GPT61_SOL_MODEL,
  NATIVE_GPT61_TERRA_MODEL,
  NATIVE_GPT62_ASTRA_MODEL,
  NATIVE_GPT62_SOL_MODEL,
  NATIVE_RESERVE_MODEL,
  NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  RETIRED_NATIVE_OPENAI_MODELS,
  configuredNativeOpenAiModels,
  configuredNativeOpenAiDisplayName,
  discoveredNativeOpenAiModels,
  discoveredNativeOpenAiRow,
} from "./native-models";
import { cachedAvailableAccountGatedNativeModels } from "../model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
export { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
export {
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MINOR_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  NATIVE_GPT6_LUNA_MODEL,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_GPT61_SOL_MODEL,
  NATIVE_GPT61_TERRA_MODEL,
  NATIVE_GPT62_SOL_MODEL,
  NATIVE_GPT62_ASTRA_MODEL,
  NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS,
  NATIVE_OPENAI_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  RETIRED_NATIVE_OPENAI_MODELS,
  hasNativeOpenAiCapabilityMetadata,
  isNativeOpenAiCapabilityAliasModel,
  nativeOpenAiAliasPresentation,
  nativeOpenAiCapabilitySourceSlug,
} from "./native-models";

export const DOCUMENTED_NATIVE_OPENAI_ADDITIONS = [
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  // The shipped pin also backfills older installed Codex catalogs that predate Astra.
  NATIVE_GPT6_ASTRA_MODEL,
  // Same backfill for Sol and Luna from the roster pin: the live roster serves them only to
  // client_version >= 0.155.0, so an installed catalog built by an older client lacks them.
  // Astra Minor is deliberately absent: it is gated, and nativeOpenAiSlugs() would drop it anyway.
  NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL,
  // GPT-6.1 Sol needs client_version >= 0.153.0 upstream; older installed catalogs lack it.
  NATIVE_GPT61_SOL_MODEL,
  // Terra's pinned row has the same client floor and backfills older installed catalogs too.
  NATIVE_GPT61_TERRA_MODEL,
  NATIVE_GPT62_SOL_MODEL,
  NATIVE_GPT62_ASTRA_MODEL,
];

export function configuredNativeAliasSlugs(
  config: Pick<EpxConfig, "combos">,
): Set<string> {
  const aliases = new Set<string>();
  for (const raw of Object.values(config.combos ?? {})) {
    if (!isNativeAliasCombo(raw)) continue;
    const alias = raw.alias!.trim();
    if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(alias)) aliases.add(alias);
  }
  return aliases;
}

/**
 * Bare native rows omitted by native-alias compatibility or explicit native-omission opt-in.
 * Codex Desktop's remote allowlist can ignore `visibility: "hide"`.
 */
export function desktopAllowlistSuppressedNativeSlugs(
  config: Pick<EpxConfig, "combos" | "disabledModels" | "omitDisabledNativeModels">,
): Set<string> {
  const suppressed = configuredNativeAliasSlugs(config);
  if (suppressed.size === 0 && config.omitDisabledNativeModels !== true) return suppressed;
  const disabled = disabledNativeSlugs(config);
  for (const slug of NATIVE_OPENAI_MODELS) {
    if (disabled.has(slug)) suppressed.add(slug);
  }
  return suppressed;
}

export function isNativeAliasCatalogEntry(entry: RawEntry): boolean {
  return entry.easyproxy_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND;
}

export function isUnsupportedOpenAiNativeSlug(slug: string): boolean {
  if (slug.includes("/")) return false;
  if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) return false;
  return /^(?:gpt|codex)-/.test(slug);
}

export function hasComboTargets(config: { combos?: Record<string, { targets?: unknown[] }> }): boolean {
  const combos = config.combos;
  if (!combos) return false;
  return Object.values(combos).some(c => Array.isArray(c?.targets) && c!.targets!.length > 0);
}

export function disabledNativeSlugs(config: Pick<EpxConfig, "disabledModels">): Set<string> {
  return new Set((config.disabledModels ?? []).filter(id => !id.includes("/")));
}

export function visibleNativeSlugs(config: Pick<EpxConfig, "disabledModels" | "combos">): string[] {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config);
  return nativeOpenAiSlugs().filter(slug => !disabled.has(slug) && !shadowed.has(slug));
}

/** Whether an enabled canonical OpenAI provider can serve exact account-qualified routes. */
export function shouldIncludeAccountBoundNativeOpenAi(
  config: Pick<EpxConfig, "providers">,
): boolean {
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!provider || provider.disabled === true) return false;
  // Registry routing defaults an omitted authMode on the built-in OpenAI row to forward.
  const canonical = provider.authMode === undefined
    ? { ...provider, authMode: "forward" as const }
    : provider;
  return isCanonicalOpenAiForwardProvider(canonical);
}

/** Whether native ChatGPT/Codex rows belong in this provider configuration. */
export function shouldIncludeNativeOpenAi(config: Pick<EpxConfig, "providers">): boolean {
  const hasEnabledProvider = Object.values(config.providers)
    .some(provider => provider.disabled !== true);
  // Preserve the existing no-enabled-provider catalog bootstrap, but do not use that bootstrap
  // exception for account-qualified rows: exact-account routing requires a live OpenAI provider.
  return !hasEnabledProvider || shouldIncludeAccountBoundNativeOpenAi(config);
}

type AccountSelectorConfig = Pick<
  EpxConfig,
  "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled"
>;

function mainAccountSelectors(config: AccountSelectorConfig): string[] {
  const targets = new Map(codexAccountNamespaceEntries(config));
  return visibleCodexAccountSelectors(config).filter(selector =>
    isMainCodexAccountTarget(targets.get(selector) ?? ""));
}

/** Native slugs exposed to Claude Desktop show/export/apply (opt-out via claudeCode.desktopNativeModels). */
export function desktopVisibleNativeSlugs(
  config: Pick<EpxConfig, "claudeCode" | "disabledModels" | "combos" | "providers"
    | "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): string[] {
  if (config.claudeCode?.desktopNativeModels === false) return [];
  const visible = visibleNativeSlugs(config);
  if (!shouldIncludeAccountBoundNativeOpenAi(config)) return visible;
  const qualified = [...accountBoundNativeOpenAiSlugsBySelector(config).entries()].flatMap(([selector, slugs]) =>
    slugs
      .filter(slug => !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug))
      .map(slug => `${selector}/${slug}`),
  );
  const disabled = new Set(config.disabledModels ?? []);
  return unique([
    ...visible,
    ...qualified.filter(slug => !disabled.has(slug) && !disabled.has(slug.slice(slug.indexOf("/") + 1))),
  ]);
}

export function nativeModelRows(config: Pick<EpxConfig, "disabledModels" | "combos" | "providerContextCaps" | "providers">): Array<{ slug: string; disabled: boolean; contextWindow?: number; maxInputTokens?: number; autoCompactTokenLimit?: number }> {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config);
  // Both user levers, not just the cap: a per-model window set from the dashboard has to show
  // up on the row the dashboard itself renders.
  const limits = nativeContextLimits(config);
  const bareEligibleAccountIds = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers?.[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const availableGated = cachedAvailableAccountGatedNativeModels(Date.now(), bareEligibleAccountIds);
  return NATIVE_OPENAI_MODELS
    .filter(slug => !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableGated.has(slug))
    .filter(slug => !shadowed.has(slug)).map(slug => {
    const contextWindow = nativeOpenAiContextWindow(slug, limits);
    const maxInputTokens = nativeOpenAiMaxInputTokens(slug, limits);
    const autoCompactTokenLimit = nativeOpenAiAutoCompactTokenLimit(slug, limits);
    return {
      slug,
      disabled: disabled.has(slug),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
    };
  });
}

export function applyNativeVisibility(
  entries: RawEntry[],
  disabledModels: ReadonlySet<string>,
  hideBareNative = false,
  observedNativeSlugs: ReadonlySet<string> = new Set(),
): RawEntry[] {
  for (const entry of entries) {
    if (isNativeAliasCatalogEntry(entry)) continue;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const nativeSlug = accountBoundSlug ?? slug;
    if (!nativeSlug
      || (!accountBoundSlug && slug.includes("/"))
      || (!SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug) && !observedNativeSlugs.has(nativeSlug))) continue;
    const disabled = disabledModels.has(nativeSlug)
      || (accountBoundSlug !== undefined && disabledModels.has(slug));
    entry.visibility = disabled || (!accountBoundSlug && hideBareNative)
      ? "hide"
      : "list";
  }
  return entries;
}

const SELF_AUTHORED_NATIVE_ROWS: ReadonlySet<string> = new Set([NATIVE_GPT6_ASTRA_MODEL]);

export function shouldUpgradeToUpstreamEntry(entry: RawEntry): boolean {
  if (typeof entry.slug !== "string" || !UPSTREAM_NATIVE_ENTRIES.has(entry.slug)) return false;
  if (discoveredNativeOpenAiRow(entry.slug)) return true;
  if (entry.display_name === entry.slug) return true;
  if (isUnchangedHistoricalConfiguredFallback(entry)) return true;
  // A row this project authored from a guess is not evidence of upstream truth, however genuine
  // its display name looks. Replace it once, from the pin.
  return SELF_AUTHORED_NATIVE_ROWS.has(entry.slug)
    && entry.display_name !== UPSTREAM_NATIVE_ENTRIES.get(entry.slug)?.display_name;
}

// Before a model had its own pinned row (GPT-6.2 until #8893), a providers.openai.models entry for
// it borrowed an older Sol row. Promote that fallback to the model's own pin only while every
// field still holds what the earlier build wrote, so any user edit keeps the row: borrowed fields
// must equal the template, and build-derived fields must hold the exact values those builds wrote
// (checked against rows generated at c320932c19^, the commit before GPT-6.2 was pinned).
const HISTORICAL_CONFIGURED_TEMPLATES = [NATIVE_GPT61_SOL_MODEL, NATIVE_GPT6_SOL_MODEL] as const;
const HISTORICAL_CONFIGURED_DESCRIPTION = /^OpenAI native model added through providers\.openai\.models; uses GPT-[0-9.]+-Sol capabilities\.$/;
const IDENTITY_FALLBACK_FIELDS: ReadonlySet<string> = new Set(["slug", "display_name", "description"]);
// A Map, so a persisted key such as `constructor` never resolves to an inherited property.
const HISTORICAL_DERIVED_FALLBACK_VALUES: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map<string, ReadonlyArray<unknown>>([
  ["shell_type", ["unified_exec"]],
  ["effective_context_window_percent", [95]],
  ["easyproxy_native_source_priority", [1]],
  // 90% of the 272,000-token window configured natives received.
  ["auto_compact_token_limit", [244_800]],
  // Written only when WebSockets were enabled, and then as the template's own value.
  ["prefer_websockets", [undefined, true]],
  // Account prompts never reach a borrowed row.
  ["availability_nux", [undefined]],
]);

function isUnchangedHistoricalConfiguredFallback(entry: RawEntry): boolean {
  const slug = entry.slug as string;
  if (entry.display_name !== configuredNativeOpenAiDisplayName(slug)) return false;
  if (typeof entry.description !== "string" || !HISTORICAL_CONFIGURED_DESCRIPTION.test(entry.description)) return false;
  return HISTORICAL_CONFIGURED_TEMPLATES.some(template => {
    // The projected template is what an earlier build copied, minus fields catalog rows never carry.
    const borrowed = template === slug ? null : upstreamNativeEntry(template);
    if (!borrowed) return false;
    neutralizeBorrowedInstructions(borrowed);
    const fields = new Set([...Object.keys(entry), ...Object.keys(borrowed)]);
    return [...fields].every(field => {
      if (IDENTITY_FALLBACK_FIELDS.has(field)) return true;
      const derived = HISTORICAL_DERIVED_FALLBACK_VALUES.get(field);
      return derived ? derived.includes(entry[field]) : Bun.deepEquals(entry[field], borrowed[field]);
    });
  });
}

export function nativeOpenAiSlugs(): string[] {
  const live = catalogNativeSlugs();
  const availableGated = cachedAvailableAccountGatedNativeModels();
  const candidates = live.length > 0
    ? unique([...live, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS, ...configuredNativeOpenAiModels(), ...discoveredNativeOpenAiModels()])
    : NATIVE_OPENAI_MODELS;
  return candidates.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableGated.has(slug)
  ));
}

const ACCOUNT_BOUND_OPENAI_NATIVE_PREFIX = /^(?:gpt-|o1-|o3-|o4-)/;
const ACCOUNT_BOUND_OBSERVED_NATIVE_MARKER = "easyproxy_account_observed_native";
const ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER = "easyproxy_account_observed_selectors";

function isAccountBoundOpenAiNativeSlug(slug: string): boolean {
  return !slug.includes("/") && ACCOUNT_BOUND_OPENAI_NATIVE_PREFIX.test(slug);
}

/**
 * Shape/plausibility filter for a candidate account-native row. **This is not a trust control.**
 *
 * It checks that a row carries the field shape a real Codex catalog row has, which rejects
 * malformed and minimal hand-written rows. It cannot distinguish a genuine upstream observation
 * from a complete row typed by hand into `$CODEX_HOME/models_cache.json`: there is no signature,
 * source identity, or server attestation to check. A full-shape forged row is accepted, and
 * `observedFullShapeRowIsAccepted` in tests/codex-integration/native-model-toggle.test.ts pins that so nobody
 * later mistakes this predicate for a security boundary.
 *
 * That is acceptable here because the file is user-owned and written by Codex itself: anyone
 * able to rewrite it can already edit `config.json` or run `epx` directly, and `router.ts`
 * accepts any bare `gpt-*` id under an account namespace regardless of this catalog. What the
 * filter buys is that garbage rows do not get advertised through discovery — not that an
 * advertised row is proven genuine.
 */
function hasNativeCatalogRowShape(entry: RawEntry): boolean {
  const levels = entry.supported_reasoning_levels;
  const messages = entry.model_messages;
  return typeof entry.base_instructions === "string"
    && entry.base_instructions.length > 0
    && (typeof entry.comp_hash === "string" || entry.comp_hash === null)
    && (entry.shell_type === "unified_exec" || entry.shell_type === "shell_command")
    && Array.isArray(levels)
    && levels.length > 0
    && levels.every(level => typeof level === "object" && level !== null
      && typeof (level as { effort?: unknown }).effort === "string")
    && typeof messages === "object"
    && messages !== null
    && !Array.isArray(messages);
}

function observedAccountBoundNativeSlug(entry: RawEntry): string | undefined {
  const accountBound = trustedAccountBoundNativeCatalogSlug(entry);
  const slug = accountBound ?? (typeof entry.slug === "string" ? entry.slug : "");
  // A retired native is refused at this one choke point rather than at each call site: every
  // observation path funnels through here, and an admitted retired slug comes back as a real
  // catalog row — bare or account-qualified — with capabilities synthesized from the template.
  if (RETIRED_NATIVE_OPENAI_MODELS.has(slug)) return undefined;
  if (!isAccountBoundOpenAiNativeSlug(slug)
    || (entry.supported_in_api !== true && !(slug === NATIVE_RESERVE_MODEL && entry.supported_in_api === false))
    || (slug === NATIVE_RESERVE_MODEL && entry[RESERVE_METADATA_SOURCE_FIELD] !== undefined
      && entry[RESERVE_METADATA_SOURCE_FIELD] !== NATIVE_RESERVE_MODEL)
    || !hasNativeCatalogRowShape(entry)
    || (entry.visibility !== "list" && entry[ACCOUNT_BOUND_OBSERVED_NATIVE_MARKER] !== true
      && !(slug === NATIVE_RESERVE_MODEL && entry.visibility === "hide"))) {
    return undefined;
  }
  return slug;
}

/** Prefer a genuine bare observation; an adapted EPX row must never become native evidence. */
export function observedReserveCatalogSource(
  entries: readonly RawEntry[],
  mainSelectors: readonly string[],
): RawEntry | null {
  const actual = entries.filter(entry => observedAccountBoundNativeSlug(entry) === NATIVE_RESERVE_MODEL);
  const bare = actual.find(entry => entry.slug === NATIVE_RESERVE_MODEL);
  const qualified = actual.find(entry => entry[RESERVE_METADATA_SOURCE_FIELD] === NATIVE_RESERVE_MODEL
    && typeof entry.slug === "string"
    && mainSelectors.includes(entry.slug.slice(0, entry.slug.indexOf("/"))));
  const selected = bare ?? qualified;
  if (!selected) return null;
  const source = structuredClone(selected);
  if (!bare) {
    const prefix = `${String(source.slug).split("/")[0]} / `;
    if (typeof source.display_name === "string" && source.display_name.startsWith(prefix)) {
      source.display_name = source.display_name.slice(prefix.length);
    }
  }
  source.slug = NATIVE_RESERVE_MODEL;
  delete source.easyproxy_catalog_kind;
  delete source[ROUTED_ORIGIN_FIELD];
  delete source[RESERVE_METADATA_SOURCE_FIELD];
  delete source[ACCOUNT_BOUND_OBSERVED_NATIVE_MARKER];
  delete source[ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER];
  return source;
}

/**
 * Return exact, previously observed account-native rows that are not in the static release set.
 * The result is used only to carry a hidden observation across startup cache invalidation.
 */
export function observedAccountBoundNativeEntries(
  observedEntries: readonly RawEntry[],
): RawEntry[] {
  const seen = new Set<string>();
  return observedEntries.flatMap(entry => {
    const slug = observedAccountBoundNativeSlug(entry);
    // Only carry bare upstream observations across cache replacement. Account-qualified rows are
    // already a projection of the current selector map and must not preserve private/stale labels.
    if (!slug
      || typeof entry.slug !== "string"
      || entry.slug.includes("/")
      || SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
      || seen.has(slug)) return [];
    seen.add(slug);
    return [structuredClone(entry)];
  });
}

/**
 * Native ids observed in the user's Codex catalog/cache for account-qualified discovery.
 *
 * Unknown ids are deliberately returned only to callers that build selector-qualified rows. The
 * static bare set remains the source of truth for global/API-key discovery, while this preserves
 * exact account-scoped ids such as `gpt-daybreak-blue-latest` until the static set catches up.
 */
export function accountBoundNativeOpenAiSlugs(
  observedEntries: readonly RawEntry[] = [
    ...(readCurrentCodexModelsCache()?.models ?? []).filter(isPlainObject),
    // Existing generated rows are also safe to reuse after a process starts without a cache
    // invalidation pass; bare user-authored catalog rows are intentionally not trusted here.
    ...(readCurrentCodexCatalog()?.models ?? []).filter(entry =>
      isPlainObject(entry) && trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
  ],
): string[] {
  const observed = observedEntries.flatMap(entry => {
    const slug = observedAccountBoundNativeSlug(entry);
    // Reserve belongs only to the Codex-specific opt-in builder, not generic native exports.
    return slug === undefined || slug === NATIVE_RESERVE_MODEL ? [] : [slug];
  });
  return unique([...NATIVE_OPENAI_MODELS, ...observed]);
}

/**
 * Resolve account-native ids per public selector. Bare observations come from Codex's main
 * catalog/cache, so they are eligible only for selectors that target the main account. A
 * generated qualified row carries its own selector and never gets copied to an unrelated pool
 * account. An explicit observation marker is public selector metadata only; private account ids
 * never enter the catalog or cache.
 */
export function accountBoundNativeOpenAiSlugsBySelector(
  config: AccountSelectorConfig,
  observedEntries: readonly RawEntry[] = [
    ...(readCurrentCodexModelsCache()?.models ?? []).filter(isPlainObject),
    ...(readCurrentCodexCatalog()?.models ?? []).filter(entry =>
      isPlainObject(entry) && trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
  ],
): ReadonlyMap<string, readonly string[]> {
  const selectors = visibleCodexAccountSelectors(config);
  const mainSelectors = new Set(mainAccountSelectors(config));
  const result = new Map<string, Set<string>>(
    selectors.map(selector => [selector, new Set(NATIVE_OPENAI_MODELS)]),
  );
  for (const entry of observedEntries) {
    const slug = observedAccountBoundNativeSlug(entry);
    if (slug === undefined || slug === NATIVE_RESERVE_MODEL || SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) continue;
    const generated = trustedAccountBoundNativeCatalogSlug(entry);
    const generatedSelector = generated === undefined || typeof entry.slug !== "string"
      ? undefined
      : entry.slug.slice(0, entry.slug.indexOf("/"));
    const markedSelectors = Array.isArray(entry[ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER])
      ? entry[ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER].filter((value): value is string => typeof value === "string")
      : [];
    const eligible = generatedSelector !== undefined
      ? (mainSelectors.has(generatedSelector) ? [generatedSelector] : [])
      : markedSelectors.length > 0
        ? markedSelectors.filter(selector => mainSelectors.has(selector))
        : [...mainSelectors];
    for (const selector of eligible) {
      const rows = result.get(selector);
      if (rows) rows.add(slug);
    }
  }
  return new Map([...result.entries()].map(([selector, slugs]) => [selector, [...slugs]]));
}

/** Unknown native ids observed from Codex, excluding the static release set. */
export function observedAccountBoundNativeOpenAiSlugs(
  observedEntries?: readonly RawEntry[],
): string[] {
  const all = accountBoundNativeOpenAiSlugs(observedEntries);
  return all.filter(slug => !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug));
}

function catalogNativeSlugs(): string[] {
  const cat = readCurrentCatalogOrCache();
  const models = (cat?.models ?? []).filter(isPlainObject);
  const live = models.flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return !slug.includes("/") && SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug) ? [slug] : [];
  });
  const accountBound = models.flatMap(entry => {
    const slug = trustedAccountBoundNativeCatalogSlug(entry);
    return slug !== undefined && SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug) ? [slug] : [];
  });
  // Deliberately ignore `visibility`: it is a rendered projection of disabledModels and account
  // selectors, so treating it as fresh availability would shrink the supported set between syncs.
  // visibleNativeSlugs applies the current disabledModels source of truth for public consumers.
  return unique([...live, ...accountBound]);
}

export function listCatalogNativeSlugs(): string[] {
  // Ensure documented additions (e.g. gpt-6-astra) appear even when the bundled catalog
  // predates the slug — mirrors nativeOpenAiSlugs() which already merges them for /v1/models.
  return unique([...catalogNativeSlugs(), ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS, ...configuredNativeOpenAiModels(), ...discoveredNativeOpenAiModels()]);
}
