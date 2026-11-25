import { isCanonicalOpenAiForwardProvider, CODEX_FORWARD_BASE_URL } from "../../providers/openai-tiers";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import {
  isValidProviderName,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  providerHeadersConfigError,
  requestPacingConfigError,
  upstreamHttpVersionConfigError,
  validateConfigCandidate,
} from "../../config";
import {
  canonicalAutoReviewModelKey,
  contextTierRecordConfigError,
  mergeModelCapabilities,
  mergeModelPinnedEfforts,
  modelCapabilitiesConfigError,
  modelPinnedEffortsConfigError,
  pinnedReasoningEffortConfigError,
  providerEmptyToolOutputConfigError,
} from "../../config/provider-validation";
import { redactSecretString } from "../../lib/redact";
import { modelAutoCompactTokenLimitsConfigError } from "../../providers/auto-compact-budget";
import { forgetProviderContextCap } from "../../providers/context-cap";
import { providerConfigSeed } from "../../providers/derive";
import { dropProviderCustomModels } from "../../providers/provider-id-rewrite";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "../../providers/registry";
import { XAI_RESPONSES_DEFAULT_VERSION, XAI_RESPONSES_OPT_IN_MODELS } from "../../providers/xai-responses-opt-in";
import { DECLARABLE_HOSTED_TOOL_TYPES } from "../../responses/hosted-tool-policy";
import type { EpxConfig, EpxProviderConfig } from "../../types";
import { providerManagementConfigError, type ProviderEditorConfigDTO } from "../auth-cors";
import { comboDependsOnProviderRoute } from "./decision-model-validation";
import { providerCatalogCapabilityConfigError } from "./provider-capability-config";
import { anthropicInstancePublicationError, mergeProviderEditorRow } from "./provider-instance-ownership";
import { applyProviderCompatPatchFields } from "./provider-overwrite-carry";
import { applyThinkingDisplayPatchFields } from "./provider-thinking-display-patch";
import { isPlainRecord } from "./shared";

export type ProviderPatchApplication =
  | { error: string }
  | {
      next: EpxProviderConfig;
      touched: boolean;
      editorTouched: boolean;
      enablingOpenAi: boolean;
      headersTouched: boolean;
    };

export const PROVIDER_ALIAS_OVERLAY_FIELDS = ["alias", "modelAliases", "defaultAliases", "aliasTemplate"] as const;
type ProviderAliasOverlayField = typeof PROVIDER_ALIAS_OVERLAY_FIELDS[number];

/**
 * Alias overlays are owned by the dedicated alias management routes. A full provider POST
 * may round-trip an already-persisted value, but it must not create, clear, or change one.
 * PATCH is field-masked and rejects these keys outright below.
 */
export function providerAliasOverlayOwnershipError(
  submitted: Record<string, unknown>,
  existing: EpxProviderConfig | undefined,
): string | null {
  for (const field of PROVIDER_ALIAS_OVERLAY_FIELDS) {
    if (!Object.hasOwn(submitted, field)) continue;
    if (!existing || !Object.hasOwn(existing, field)) {
      return `${field} is managed by the dedicated alias API`;
    }
    const incoming = submitted[field];
    const persisted = existing[field];
    if (field === "modelAliases") {
      if (!isPlainRecord(incoming) || !isPlainRecord(persisted)) {
        return "modelAliases is managed by the dedicated alias API";
      }
      const incomingEntries = Object.entries(incoming);
      const persistedEntries = Object.entries(persisted);
      if (
        incomingEntries.length !== persistedEntries.length
        || incomingEntries.some(([model, alias]) => typeof alias !== "string" || persisted[model] !== alias)
      ) {
        return "modelAliases is managed by the dedicated alias API";
      }
      continue;
    }
    if (incoming !== persisted) return `${field} is managed by the dedicated alias API`;
  }
  return null;
}

/** Remove only alias overlays whose ownership has already been established by the caller. */
export function providerTransportValidationCandidate(provider: Record<string, unknown>): Record<string, unknown> {
  const candidate = { ...provider };
  for (const field of PROVIDER_ALIAS_OVERLAY_FIELDS) delete candidate[field];
  return candidate;
}

/** Preserve the authoritative alias values from the stored provider during a full edit. */
export function restorePersistedAliasOverlays(target: EpxProviderConfig, existing: EpxProviderConfig | undefined): void {
  for (const field of PROVIDER_ALIAS_OVERLAY_FIELDS) {
    delete (target as Record<ProviderAliasOverlayField, unknown>)[field];
    if (!existing || !Object.hasOwn(existing, field)) continue;
    const value = existing[field];
    (target as Record<ProviderAliasOverlayField, unknown>)[field] = field === "modelAliases"
      ? structuredClone(value)
      : value;
  }
}

export type ProviderEditorCandidateResult =
  | { ok: true; config: EpxConfig; removedProviders: string[] }
  | { ok: false; status: 400 | 409; error: string; code: string };

export type ProviderEditorMutationValue = ProviderEditorCandidateResult;

/** Build and validate a complete candidate without mutating the caller's snapshot. */
export function providerEditorCandidate(
  persisted: EpxConfig,
  baseline: ProviderEditorConfigDTO,
  next: ProviderEditorConfigDTO,
): ProviderEditorCandidateResult {
  const candidate = structuredClone(persisted);
  const removedProviders = Object.keys(persisted.providers)
    .filter(name => !Object.hasOwn(next.providers, name));

  for (const name of removedProviders) {
    const dependentCombos = Object.entries(persisted.combos ?? {})
      .filter(([, combo]) => comboDependsOnProviderRoute(persisted, combo, name))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    if (dependentCombos.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `cannot delete provider ${JSON.stringify(redactSecretString(name))} while combos depend on it`,
        code: "provider_has_dependent_combos",
      };
    }
  }

  const providers: Record<string, EpxProviderConfig> = Object.create(null);
  for (const [name, publicProvider] of Object.entries(next.providers)) {
    if (!isValidProviderName(name)) {
      return {
        ok: false,
        status: 400,
        error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key",
        code: "invalid_provider_name",
      };
    }
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(candidate.codexAccountNamespaces, name);
    if (namespaceCollision) return { ok: false, status: 409, error: namespaceCollision, code: "provider_namespace_conflict" };
    const merged = mergeProviderEditorRow(persisted.providers[name], baseline.providers[name], publicProvider);
    const markerCollision = anthropicInstancePublicationError(name, merged, persisted.providers[name]);
    if (markerCollision) return { ok: false, status: 409, error: markerCollision, code: "anthropic_instance_collision" };
    const transportCandidate = providerTransportValidationCandidate(merged as unknown as Record<string, unknown>);
    // The editor merges onto the persisted row, so stored operator overlays (selectedModels,
    // disabled, …) ride along in the candidate. They are owned by their own write boundaries;
    // the seed check must only pin the canonical transport/auth keys.
    const providerError = providerManagementConfigError(name, transportCandidate, { allowOperatorOverlays: true })
      ?? providerEmptyToolOutputConfigError(name, transportCandidate)
      ?? providerCatalogCapabilityConfigError(name, transportCandidate);
    if (providerError) return { ok: false, status: 400, error: providerError, code: "invalid_provider" };
    providers[name] = merged;
  }

  const defaultProvider = next.defaultProvider.trim();
  const selectedDefault = providers[defaultProvider];
  if (!selectedDefault) {
    return { ok: false, status: 400, error: "defaultProvider must name a configured provider", code: "invalid_default_provider" };
  }
  if (selectedDefault.disabled === true) {
    return { ok: false, status: 400, error: "defaultProvider cannot be disabled", code: "default_provider_disabled" };
  }

  candidate.defaultProvider = defaultProvider;
  candidate.providers = providers;
  for (const name of removedProviders) {
    dropProviderCustomModels(candidate, name);
    forgetProviderContextCap(candidate, name);
  }
  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error, code: "invalid_provider_editor_config" };
  }
  for (const [name, provider] of Object.entries(candidate.providers)) {
    if (provider.modelPinnedReasoningEfforts !== undefined) {
      provider.modelPinnedReasoningEfforts = validated.config.providers[name]!.modelPinnedReasoningEfforts;
    }
    const normalized = validated.config.providers[name]!;
    if (normalized.autoReviewModel === undefined) delete provider.autoReviewModel;
    else provider.autoReviewModel = normalized.autoReviewModel;
    if (normalized.autoReviewModelOverrides === undefined) delete provider.autoReviewModelOverrides;
    else provider.autoReviewModelOverrides = normalized.autoReviewModelOverrides;
    if (normalized.modelCapabilities === undefined) delete provider.modelCapabilities;
    else provider.modelCapabilities = normalized.modelCapabilities;
  }
  return { ok: true, config: candidate, removedProviders };
}

export function adoptProviderEditorCandidate(live: EpxConfig, persisted: EpxConfig): void {
  live.defaultProvider = persisted.defaultProvider;
  for (const name of Object.keys(live.providers)) {
    if (!Object.hasOwn(persisted.providers, name)) delete live.providers[name];
  }
  for (const [name, provider] of Object.entries(persisted.providers)) {
    live.providers[name] = structuredClone(provider);
  }
  if (persisted.customModels === undefined) delete live.customModels;
  else live.customModels = structuredClone(persisted.customModels);
  if (persisted.providerContextCaps === undefined) delete live.providerContextCaps;
  else live.providerContextCaps = structuredClone(persisted.providerContextCaps);
  if (persisted.providerContextCapValues === undefined) delete live.providerContextCapValues;
  else live.providerContextCapValues = structuredClone(persisted.providerContextCapValues);
  if (persisted.disabledModels === undefined) delete live.disabledModels;
  else live.disabledModels = [...persisted.disabledModels];
  if (persisted.modelDiscovery === undefined) delete live.modelDiscovery;
  else live.modelDiscovery = structuredClone(persisted.modelDiscovery);
}

/** Share pin merge/clear semantics between POST and the PATCH mask. */
export function applyProviderPinFields(
  next: EpxProviderConfig,
  patch: Record<string, unknown>,
  current: EpxProviderConfig | undefined,
): string | null {
  const scalarError = pinnedReasoningEffortConfigError(patch.pinnedReasoningEffort, true);
  const mapError = modelPinnedEffortsConfigError(patch.modelPinnedReasoningEfforts, "modelPinnedReasoningEfforts", true);
  if (scalarError || mapError) return scalarError ?? mapError;
  const scalar = Object.hasOwn(patch, "pinnedReasoningEffort")
    ? patch.pinnedReasoningEffort : current?.pinnedReasoningEffort;
  const map = Object.hasOwn(patch, "modelPinnedReasoningEfforts")
    ? mergeModelPinnedEfforts(current?.modelPinnedReasoningEfforts, patch.modelPinnedReasoningEfforts)
    : current?.modelPinnedReasoningEfforts;
  if (scalar === undefined || scalar === null || scalar === "") delete next.pinnedReasoningEffort;
  else next.pinnedReasoningEffort = scalar as string;
  if (map === undefined) delete next.modelPinnedReasoningEfforts;
  else next.modelPinnedReasoningEfforts = { ...map };
  return null;
}

/**
 * Apply the recognized PATCH field mask onto a provider copy. The caller runs this once
 * for validation and again inside the config mutation lock against the newest provider,
 * so a concurrent PATCH cannot be erased by a save of a stale snapshot. Only synchronous
 * checks live here; the async destination probe stays in the route.
 */
export function applyProviderPatchFields(
  name: string,
  provider: EpxProviderConfig,
  rawBody: Record<string, unknown>,
  keys: string[],
  config: EpxConfig,
): ProviderPatchApplication {
  const next: EpxProviderConfig = { ...provider };
  let touched = false;
  let headersTouched = false;

  if (Object.hasOwn(rawBody, "disabled")) {
    if (typeof rawBody.disabled !== "boolean") return { error: "disabled must be a boolean" };
    if (rawBody.disabled && name === config.defaultProvider) {
      return { error: "cannot disable the default provider; set another default first" };
    }
    next.disabled = rawBody.disabled;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "adapter")) {
    if (typeof rawBody.adapter !== "string" || !rawBody.adapter.trim()) return { error: "adapter must be a non-empty string" };
    next.adapter = rawBody.adapter.trim();
    touched = true;
  }
  if (Object.hasOwn(rawBody, "baseUrl")) {
    if (typeof rawBody.baseUrl !== "string" || !rawBody.baseUrl.trim()) return { error: "baseUrl must be a non-empty string" };
    next.baseUrl = rawBody.baseUrl.trim();
    touched = true;
  }
  if (Object.hasOwn(rawBody, "defaultModel")) {
    if (typeof rawBody.defaultModel !== "string") return { error: "defaultModel must be a string" };
    const dm = rawBody.defaultModel.trim();
    if (dm) next.defaultModel = dm;
    else delete next.defaultModel;
    touched = true;
  }
  for (const field of ["project", "location"] as const) {
    if (!Object.hasOwn(rawBody, field)) continue;
    const value = rawBody[field];
    if (typeof value !== "string") return { error: `${field} must be a string` };
    if (value.trim()) next[field] = value.trim();
    else delete next[field];
    touched = true;
  }
  if (Object.hasOwn(rawBody, "authMode")) {
    if (typeof rawBody.authMode !== "string") return { error: "authMode must be a string" };
    const mode = rawBody.authMode.trim();
    if (mode === "key" || mode === "forward" || mode === "oauth" || mode === "local") {
      next.authMode = mode;
      touched = true;
    } else if (mode === "") {
      delete next.authMode;
      touched = true;
    } else {
      return { error: "authMode must be key, forward, oauth, or local" };
    }
  }
  if (Object.hasOwn(rawBody, "apiKeyTransport")) {
    const transport = rawBody.apiKeyTransport;
    if (transport === "x-api-key" || transport === "bearer") {
      next.apiKeyTransport = transport;
      touched = true;
    } else if (transport === "") {
      delete next.apiKeyTransport;
      touched = true;
    } else {
      return { error: "apiKeyTransport must be x-api-key, bearer, or empty to clear" };
    }
  }
  if (Object.hasOwn(rawBody, "note")) {
    if (typeof rawBody.note !== "string") return { error: "note must be a string" };
    const note = rawBody.note.trim();
    if (note) next.note = note;
    else delete next.note;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "allowPrivateNetwork")) {
    if (typeof rawBody.allowPrivateNetwork !== "boolean") return { error: "allowPrivateNetwork must be a boolean" };
    next.allowPrivateNetwork = rawBody.allowPrivateNetwork;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "liveModels")) {
    if (typeof rawBody.liveModels !== "boolean") return { error: "liveModels must be a boolean" };
    next.liveModels = rawBody.liveModels;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "annotateEmptyToolOutputs")) {
    const value = rawBody.annotateEmptyToolOutputs;
    if (value === null) {
      delete next.annotateEmptyToolOutputs;
    } else if (typeof value === "boolean") {
      next.annotateEmptyToolOutputs = value;
    } else {
      return { error: "annotateEmptyToolOutputs must be a boolean or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "fastEnabled")) {
    const value = rawBody.fastEnabled;
    if (value === null) delete next.fastEnabled;
    else if (typeof value === "boolean") next.fastEnabled = value;
    else return { error: "fastEnabled must be a boolean or null" };
    touched = true;
  }
  if (Object.hasOwn(rawBody, "xaiResponsesOptIn")) {
    if (name !== "xai") return { error: "xaiResponsesOptIn is valid only for provider xai" };
    if (typeof rawBody.xaiResponsesOptIn !== "boolean") {
      return { error: "xaiResponsesOptIn must be a boolean" };
    }
    const modelAdapters = { ...(next.modelAdapters ?? {}) };
    for (const model of XAI_RESPONSES_OPT_IN_MODELS) {
      if (rawBody.xaiResponsesOptIn) modelAdapters[model] = "openai-responses";
      else modelAdapters[model] = "openai-chat";
    }
    if (Object.keys(modelAdapters).length > 0) next.modelAdapters = modelAdapters;
    else delete next.modelAdapters;
    next.xaiResponsesDefaultVersion = Math.max(next.xaiResponsesDefaultVersion ?? 0, XAI_RESPONSES_DEFAULT_VERSION);
    touched = true;
  }
  if (Object.hasOwn(rawBody, "requestPacing")) {
    const value = rawBody.requestPacing;
    if (value === null) {
      delete next.requestPacing;
    } else {
      if (!isPlainRecord(value)) return { error: "requestPacing must be a plain object or null" };
      const pacingError = requestPacingConfigError(value);
      if (pacingError) return { error: pacingError };
      // `requestPacingConfigError` is the runtime narrowing boundary above; keep the
      // assertion explicit because a generic plain record cannot express `enabled`.
      next.requestPacing = structuredClone(value) as unknown as EpxProviderConfig["requestPacing"];
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "upstreamHttpVersion")) {
    const value = rawBody.upstreamHttpVersion;
    if (value === null || value === "") {
      delete next.upstreamHttpVersion;
    } else {
      const versionError = upstreamHttpVersionConfigError(value);
      if (versionError) return { error: versionError };
      // `upstreamHttpVersionConfigError` is the shared write boundary; the assertion is
      // explicit because the incoming value is an unknown JSON scalar.
      next.upstreamHttpVersion = value as EpxProviderConfig["upstreamHttpVersion"];
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "upstreamWebsocket")) {
    if (typeof rawBody.upstreamWebsocket !== "boolean") return { error: "upstreamWebsocket must be a boolean" };
    next.upstreamWebsocket = rawBody.upstreamWebsocket;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "noProxy")) {
    const value = rawBody.noProxy;
    if (value === null || value === "") {
      delete next.noProxy;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) next.noProxy = trimmed;
      else delete next.noProxy;
    } else if (Array.isArray(value) && value.every(entry => typeof entry === "string")) {
      const cleaned = value.map(entry => entry.trim()).filter(Boolean);
      if (cleaned.length > 0) next.noProxy = cleaned;
      else delete next.noProxy;
    } else {
      return { error: "noProxy must be a string, string array, or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "tlsProfile")) {
    const value = rawBody.tlsProfile;
    if (value === null || value === "") {
      delete next.tlsProfile;
    } else if (value === "antigravity-browser") {
      next.tlsProfile = value;
    } else {
      return { error: "tlsProfile must be antigravity-browser or null" };
    }
    touched = true;
  }
  // The Models page edits the catalog hints in place; keep them on the existing
  // provider mutation path so validation, cache invalidation, and convergence stay unified (#1073).
  if (Object.hasOwn(rawBody, "contextWindow")) {
    const value = rawBody.contextWindow;
    if (value === null) {
      delete next.contextWindow;
    // `Number.isInteger(1e100)` is true, so an integer check alone admits a value that
    // serializes into the catalog as an enormous number and can make Codex reject the whole
    // file. Safe-integer is the real bound for something that ends up in a JSON int field.
    } else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      next.contextWindow = value;
    } else {
      return { error: "contextWindow must be a positive safe integer or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelCapabilities")) {
    const error = modelCapabilitiesConfigError(rawBody.modelCapabilities, true);
    if (error) return { error };
    const capabilities = mergeModelCapabilities(next.modelCapabilities, rawBody.modelCapabilities);
    if (capabilities === undefined) delete next.modelCapabilities;
    else next.modelCapabilities = capabilities;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelContextTiers")) {
    const error = contextTierRecordConfigError(rawBody.modelContextTiers, true);
    if (error) return { error };
    if (rawBody.modelContextTiers === null) delete next.modelContextTiers;
    else next.modelContextTiers = Object.assign(Object.create(null), next.modelContextTiers ?? {}, rawBody.modelContextTiers);
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelContextWindows")) {
    const value = rawBody.modelContextWindows;
    if (value === null) {
      delete next.modelContextWindows;
    } else {
      if (!isPlainRecord(value)) return { error: "modelContextWindows must be a plain object or null" };
      // A prototype-named model id must survive the merge: assigning
      // "__proto__" on an ordinary object invokes the inherited setter instead
      // of creating an own property, so the PATCH would report success while
      // silently dropping that override.
      const windows: Record<string, number> = Object.assign(
        Object.create(null),
        next.modelContextWindows ?? {},
      );
      for (const [model, window] of Object.entries(value)) {
        if (!model.trim()) return { error: "modelContextWindows keys must be nonblank model ids" };
        if (window === null) {
          delete windows[model];
          continue;
        }
        if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
          return { error: "modelContextWindows values must be positive safe integers or null" };
        }
        windows[model] = window;
      }
      if (Object.keys(windows).length > 0) next.modelContextWindows = windows;
      else delete next.modelContextWindows;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "pinnedReasoningEffort") || Object.hasOwn(rawBody, "modelPinnedReasoningEfforts")) {
    const error = applyProviderPinFields(next, rawBody, provider);
    if (error) return { error };
    touched = true;
  }
  if (Object.hasOwn(rawBody, "autoReviewModel")) {
    const value = rawBody.autoReviewModel;
    if (value === null || value === "") {
      delete next.autoReviewModel;
    } else if (typeof value === "string" && value.trim()) {
      next.autoReviewModel = value.trim();
    } else {
      return { error: "autoReviewModel must be a catalog selector string or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "autoReviewModelOverrides")) {
    const value = rawBody.autoReviewModelOverrides;
    if (value === null) {
      delete next.autoReviewModelOverrides;
    } else if (isPlainRecord(value)) {
      const merged: Record<string, string> = { ...(next.autoReviewModelOverrides ?? {}) };
      const existingByCanonical = new Map<string, string>();
      for (const existingKey of Object.keys(merged)) {
        existingByCanonical.set(canonicalAutoReviewModelKey(existingKey), existingKey);
      }
      const submittedCanonicalKeys = new Set<string>();
      for (const [model, target] of Object.entries(value)) {
        const key = model.trim();
        if (["__proto__", "prototype", "constructor"].includes(key)) {
          return { error: "autoReviewModelOverrides keys must be non-reserved model ids" };
        }
        const canonicalKey = canonicalAutoReviewModelKey(model);
        // Uniqueness is enforced before the tombstone branch: a clear and a set that normalize to
        // the same key would otherwise resolve in object order instead of being rejected.
        if (submittedCanonicalKeys.has(canonicalKey)) {
          return { error: "autoReviewModelOverrides keys must be unique after trimming and slash normalization" };
        }
        submittedCanonicalKeys.add(canonicalKey);
        if (target === null || target === "") {
          const previousKey = existingByCanonical.get(canonicalKey);
          if (previousKey !== undefined) delete merged[previousKey];
          if (Object.hasOwn(merged, key)) delete merged[key];
          continue;
        }
        if (typeof target !== "string" || !target.trim()) {
          return { error: "autoReviewModelOverrides values must be catalog selectors, null, or empty to remove" };
        }
        const previousKey = existingByCanonical.get(canonicalKey);
        if (previousKey !== undefined && previousKey !== key) delete merged[previousKey];
        merged[key] = target.trim();
        existingByCanonical.set(canonicalKey, key);
      }
      if (Object.keys(merged).length > 0) next.autoReviewModelOverrides = merged;
      else delete next.autoReviewModelOverrides;
    } else {
      return { error: "autoReviewModelOverrides must be a plain object or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelAutoCompactTokenLimits")) {
    const value = rawBody.modelAutoCompactTokenLimits;
    const error = modelAutoCompactTokenLimitsConfigError(value, {
      allowTombstones: true,
      requireNativeIds: name === "openai",
    });
    if (error) return { error };
    if (value === null) {
      delete next.modelAutoCompactTokenLimits;
    } else {
      const budgets: Record<string, number> = Object.assign(
        Object.create(null) as Record<string, number>,
        next.modelAutoCompactTokenLimits ?? {},
      );
      for (const [model, budget] of Object.entries(value as Record<string, number | null>)) {
        if (budget === null) delete budgets[model];
        else budgets[model] = budget;
      }
      if (Object.keys(budgets).length > 0) next.modelAutoCompactTokenLimits = budgets;
      else delete next.modelAutoCompactTokenLimits;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelSupportsServiceTier")) {
    const value = rawBody.modelSupportsServiceTier;
    if (value === null) {
      delete next.modelSupportsServiceTier;
    } else {
      if (!isPlainRecord(value)) return { error: "modelSupportsServiceTier must be a plain object or null" };
      const capabilities: Record<string, boolean> = { ...(next.modelSupportsServiceTier ?? {}) };
      for (const [model, supported] of Object.entries(value)) {
        if (!model.trim()) return { error: "modelSupportsServiceTier keys must be nonblank model ids" };
        if (supported === null) {
          delete capabilities[model];
          continue;
        }
        if (typeof supported !== "boolean") {
          return { error: "modelSupportsServiceTier values must be booleans or null" };
        }
        capabilities[model] = supported;
      }
      if (Object.keys(capabilities).length > 0) next.modelSupportsServiceTier = capabilities;
      else delete next.modelSupportsServiceTier;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelSuppressSyntheticMax")) {
    const value = rawBody.modelSuppressSyntheticMax;
    if (value === null) {
      delete next.modelSuppressSyntheticMax;
    } else {
      if (!isPlainRecord(value)) return { error: "modelSuppressSyntheticMax must be a plain object or null" };
      const capabilities: Record<string, boolean> = { ...(next.modelSuppressSyntheticMax ?? {}) };
      for (const [model, suppressed] of Object.entries(value)) {
        if (!model.trim()) return { error: "modelSuppressSyntheticMax keys must be nonblank model ids" };
        if (suppressed === null) {
          delete capabilities[model];
          continue;
        }
        if (typeof suppressed !== "boolean") {
          return { error: "modelSuppressSyntheticMax values must be booleans or null" };
        }
        capabilities[model] = suppressed;
      }
      if (Object.keys(capabilities).length > 0) next.modelSuppressSyntheticMax = capabilities;
      else delete next.modelSuppressSyntheticMax;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "thinkingDisplay") || Object.hasOwn(rawBody, "modelThinkingDisplay")) {
    const displayError = applyThinkingDisplayPatchFields(next, rawBody);
    if (displayError) return displayError;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "noStructuredOutputModels")) {
    const value = rawBody.noStructuredOutputModels;
    if (value === null) {
      delete next.noStructuredOutputModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "noStructuredOutputModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.noStructuredOutputModels = models;
      else delete next.noStructuredOutputModels;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "noJsonSchemaModels")) {
    const value = rawBody.noJsonSchemaModels;
    if (value === null) {
      delete next.noJsonSchemaModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "noJsonSchemaModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.noJsonSchemaModels = models;
      else delete next.noJsonSchemaModels;
    }
    touched = true;
  }
  // The conditional list (#8204) shares the unconditional list's vocabulary and clearing rules.
  for (const field of ["unsupportedHostedTools", "unsupportedHostedToolsWithClientTools"] as const) {
    if (!Object.hasOwn(rawBody, field)) continue;
    const value = rawBody[field];
    if (value === null) {
      delete next[field];
    } else {
      const error = nonBlankStringArrayConfigError(value, field);
      if (error) return { error };
      const tools = normalizeNonBlankStringArray(value as string[]);
      const unknownTool = tools.find(tool => !DECLARABLE_HOSTED_TOOL_TYPES.has(tool));
      if (unknownTool !== undefined) {
        return {
          error: `${field} must name only hosted tool types: `
            + `${[...DECLARABLE_HOSTED_TOOL_TYPES].join(", ")}`,
        };
      }
      if (tools.length > 0) next[field] = tools;
      else delete next[field];
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "retainModels")) {
    const value = rawBody.retainModels;
    if (value === null) {
      delete next.retainModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "retainModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.retainModels = models;
      else delete next.retainModels;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "omitReasoningEffortWithToolsModels")) {
    const value = rawBody.omitReasoningEffortWithToolsModels;
    if (value === null) {
      delete next.omitReasoningEffortWithToolsModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "omitReasoningEffortWithToolsModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.omitReasoningEffortWithToolsModels = models;
      else delete next.omitReasoningEffortWithToolsModels;
    }
    touched = true;
  }
  // The reasoning-replay lists, foldDeveloperRoleToSystem and reasoningWireFormat (#5563).
  const compat = applyProviderCompatPatchFields(rawBody, next);
  if ("error" in compat) return { error: compat.error };
  if (compat.touched) touched = true;

  // headers is the one object-valued field in the mask. PATCH semantics merge it
  // shallowly into the existing block so a single fingerprint header can be added
  // without wiping the rest; null or an empty object clears user-managed headers.
  if (Object.hasOwn(rawBody, "headers")) {
    const headersValue = rawBody.headers;
    if (headersValue === null || (isPlainRecord(headersValue) && Object.keys(headersValue).length === 0)) {
      // Registry-owned static metadata (e.g. meta-muse's x-api-version marker)
      // is not user-managed: restoring it keeps the upstream transport intact after a
      // clear instead of deleting the whole block.
      const entry = getProviderRegistryEntry(name);
      if (entry?.staticHeaders && providerMatchesRegistryTransport(name, next)) {
        next.headers = { ...entry.staticHeaders };
      } else {
        delete next.headers;
      }
    } else {
      if (!isPlainRecord(headersValue)) return { error: "headers must be an object" };
      const headersError = providerHeadersConfigError(headersValue);
      if (headersError) return { error: headersError };
      // Header names are case-insensitive on the wire. Drop any existing key whose
      // lowercase name collides with an incoming one, or Headers normalization would
      // send a combined "x-custom: v1, v2" value upstream.
      const incoming = new Map(
        Object.entries(headersValue as Record<string, string>).map(([key, value]) => [key.toLowerCase(), [key, value] as const]),
      );
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(next.headers ?? {})) {
        if (!incoming.has(key.toLowerCase())) merged[key] = value;
      }
      for (const [key, value] of incoming.values()) merged[key] = value;
      next.headers = merged;
    }
    touched = true;
    headersTouched = true;
  }

  if (!touched) return { error: "no recognized fields to update" };

  // A disabled-only toggle preserves the v2 fast lane for non-openai providers: it changes
  // routing eligibility, not the provider shape. Re-enabling `openai` is different — a
  // malformed disabled row must not come back online unchanged, so canonicalize/reject
  // against the same built-in gate used by mode PATCH and POST.
  const editorTouched = keys.some(key => key !== "disabled");
  const enablingOpenAi = name === "openai"
    && Object.hasOwn(rawBody, "disabled")
    && rawBody.disabled === false
    && provider.disabled === true;
  if (!editorTouched && enablingOpenAi) {
    if (!isCanonicalOpenAiForwardProvider(next)) {
      return { error: "provider openai must be the canonical built-in provider" };
    }
    // Persist the byte-identical canonical URL so config.ts startup checks (case-sensitive)
    // accept the row after we fill mode. Equivalent hosts like CHATGPT.com/:443 normalize here.
    next.baseUrl = CODEX_FORWARD_BASE_URL;
    // Fill missing mode so a disabled canonical row becomes a complete live openai entry.
    if (next.codexAccountMode !== "pool" && next.codexAccountMode !== "direct") {
      next.codexAccountMode = "pool";
    }
    if (next.disabled === false) delete next.disabled;
    // Canonical openai never uses private-network opt-in; drop a stale flag that
    // was ignored for the DNS probe so it cannot linger on the live row.
    delete next.allowPrivateNetwork;
  }
  return { next, touched, editorTouched, enablingOpenAi, headersTouched };
}

/** Validate the canonical OpenAI soft-budget overlay against a fresh registry seed. */
export function canonicalOpenAiBudgetPatchError(
  provider: EpxProviderConfig,
  rawBody: Record<string, unknown>,
  keys: string[],
  config: EpxConfig,
): string | null {
  if (!isCanonicalOpenAiForwardProvider(provider)) {
    return "provider openai must be the canonical built-in provider";
  }
  const entry = getProviderRegistryEntry("openai");
  if (!entry) return "provider openai registry seed is unavailable";
  const seed = providerConfigSeed(entry);
  if (provider.codexAccountMode !== undefined) seed.codexAccountMode = provider.codexAccountMode;
  if (provider.modelAutoCompactTokenLimits !== undefined) {
    seed.modelAutoCompactTokenLimits = { ...provider.modelAutoCompactTokenLimits };
  }
  const applied = applyProviderPatchFields("openai", seed, rawBody, keys, config);
  if ("error" in applied) return applied.error;
  return providerManagementConfigError("openai", applied.next)
    ?? providerEmptyToolOutputConfigError("openai", applied.next);
}
