import { contextTierRecordConfigError, modelCapabilitiesConfigError, mergeModelCapabilities } from "../../config/provider-validation";
import { preserveOmittedLiveProviderFields } from "./provider-omitted-fields";
import { DECLARABLE_HOSTED_TOOL_TYPES } from "../../responses/hosted-tool-policy";
import { randomUUID } from "node:crypto";
import { cleanupRemovedGcpCredentials, providerGcpCredentialMarkers, snapshotProviderGcpCredentialMarkers } from "../../providers/gcp-credential-cleanup";
import { providerHasStoredApiKey } from "../../providers/api-keys";
import { providerGcpCredentialInputResponse, removeProviderWithGcpCredentials } from "./provider-gcp-credential-routes";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/provider-fetch";
import {
  DEFAULT_SUBAGENT_MODELS,
  adoptPersistedProviderIntoLiveConfig,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  modelDisplayNamesConfigError,
  multiAgentGuidanceEnabled,
  mutatePersistedConfig,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  normalizeAutoReviewModelOverrides,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  requestPacingConfigError,
  readConfigAdmissionSnapshot,
  saveConfigPreservingClaudeCode,
  upstreamHttpVersionConfigError,
  validateConfigCandidate,
  withConfigMutationLockSync,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { commitProviderPatch } from "./provider-patch-transaction";
import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import { canonicalAutoReviewModelKey, mergeModelPinnedEfforts, modelPinnedEffortsConfigError, pinnedReasoningEffortConfigError } from "../../config/provider-validation";
import { releaseRemovedProviderCredentials } from "./provider-credential-release";
import { captureModelsOAuthTarget, mayResolveModelsOAuth, modelsOAuthTargetMatches } from "../../oauth/model-discovery-auth";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { ProviderOutboundPolicyError, providerOutboundGet, providerOutboundPost, providerRedirectError } from "../../lib/provider-outbound";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { fetchDevinUsableModels } from "../../adapters/devin/live-models";
import { resolveDevinApiBaseUrl } from "../../oauth/devin/api-base";
import { parseAntigravityAvailableModels } from "../../providers/antigravity-models";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import {
  applyProviderCompatPatchFields,
  carryProviderCompatFields,
  providerCompatFieldConfigError,
  providerOverwriteKeepsDestination,
  sampleProviderOverwrite,
} from "./provider-overwrite-carry";
import { shadowInterceptProviderDependency } from "./shadow-call-validation";
import { deriveProviderPresets, providerConfigSeed } from "../../providers/derive";
import { initializeProviderModelSelection } from "../../providers/initial-model-selection";
import { invalidModelDiscoveryHint } from "../../providers/model-discovery-diagnostic";
import { effectiveGoogleMode, providerCodexAccountMode, providerMatchesRegistryTransport } from "../../providers/registry";
import {
  extractModelEnvelopeRows,
  extractProviderModelItems,
  isRegistryModelDiscoveryUrl,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
} from "../../providers/model-discovery";
import {
  buildVertexProviderModelsRequest,
  collectVertexPublisherModelPages,
  countDiscoveryResponseBytes,
  extractGoogleNativeModelItems,
  resolveVertexDiscoveryAuth,
  vertexDiscoveryAuthIsCurrent,
  vertexDiscoveryDeadline,
  type VertexDiscoveryAuth,
} from "../../providers/google-vertex-model-discovery";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { isXaiGrokOAuth, readXaiLegacyPrivacyError, XAI_LEGACY_PRIVACY_MESSAGE } from "../../providers/xai-privacy-mode";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { clearPassiveKeyLimits, listPassiveKeyLimits, passiveProviderOwnership } from "../../providers/passive-key-observation";
import { providerRoutingQuota } from "./provider-routing-quota";
import { probeJevDecisionProvider } from "../../combos/jev";
import { comboDependsOnProviderRoute } from "./decision-model-validation";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../providers/key-failover";
import { handleProviderKeyPacingRoutes } from "./provider-key-pacing-routes";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { clearModelCache, getProviderDiscoveryStatus } from "../../codex/model-cache";
import { getCodexModelEntitlementStatus } from "../../codex/model-entitlements";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, selectedProviderContextCaps, forgetProviderContextCap, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { modelAutoCompactTokenLimitsConfigError } from "../../providers/auto-compact-budget";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import type { EpxClaudeCodeConfig, EpxConfig, EpxCustomModel, EpxProviderConfig } from "../../types";
import { drainAndShutdown } from "../lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import {
  isAllowedRequestOrigin,
  jsonResponse,
  parseProviderEditorConfigDTO,
  providerEditorConfigDTO,
  providerManagementConfigError,
  publicProviderBaseUrl,
  safeConfigDTO,
  type ProviderEditorConfigDTO,
} from "../auth-cors";
import { providerCatalogCapabilityConfigError } from "./provider-capability-config";
import { providerEmptyToolOutputConfigError } from "../../config/provider-validation";
import { applyThinkingDisplayPatchFields } from "./provider-thinking-display-patch";
import { applySystemEnvToggle } from "../system-env";
import {
  LOCAL_PROVIDER_RELOAD_NAME_HEADER,
  LOCAL_PROVIDER_RELOAD_PATH,
} from "../../lib/local-provider-reload-contract";
import { refreshConfigDerivedRegistries } from "../../config/derived-registries";
import { redactSecretString } from "../../lib/redact";
import {
  XAI_RESPONSES_OPT_IN_MODELS,
  XAI_RESPONSES_DEFAULT_VERSION,
  xaiResponsesOptInState,
} from "../../providers/xai-responses-opt-in";
import { ZAI_PROVIDER_ID } from "../../providers/zai-responses-migration";
import { dropProviderCustomModels } from "../../providers/provider-id-rewrite";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { anthropicInstancePublicationError, mergeProviderEditorRow, preserveAnthropicInstanceMarker } from "./provider-instance-ownership";
import { providerTlsProfileDiagnostic } from "../../lib/provider-tls-profile";
import { handleProviderTestRoute } from "./provider-connection-test";
import {
  adoptProviderEditorCandidate,
  applyProviderPatchFields,
  applyProviderPinFields,
  canonicalOpenAiBudgetPatchError,
  PROVIDER_ALIAS_OVERLAY_FIELDS,
  providerAliasOverlayOwnershipError,
  providerEditorCandidate,
  type ProviderEditorMutationValue,
  providerTransportValidationCandidate,
  restorePersistedAliasOverlays,
} from "./provider-patch-fields";

export async function handleProviderRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, principal, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    const snapshot = await fetchProviderQuotaReports(config, forceRefresh);
    const now = Date.now();
    return jsonResponse({
      ...snapshot,
      passiveKeyLimits: listPassiveKeyLimits(config),
      reports: snapshot.reports.map(report => ({
        ...report,
        routingQuota: providerRoutingQuota(config, report.provider, now),
      })),
    });
  }

  const keyPacingResponse = handleProviderKeyPacingRoutes(ctx);
  if (keyPacingResponse) return keyPacingResponse;

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      hasApiKey: providerHasStoredApiKey(p),
      // Presence only (#959 review): header names and values never leave the process.
      hasHeaders: !!p.headers && Object.keys(p.headers).length > 0,
      allowPrivateNetwork: p.allowPrivateNetwork === true,
      preserveResponsesReasoningContent: p.preserveResponsesReasoningContent,
      promoteAdditionalTools: p.promoteAdditionalTools,
      forwardAdvisorTool: p.forwardAdvisorTool,
      liveModels: p.liveModels !== false,
      requestPacing: p.requestPacing,
      models: p.models ?? [],
      contextWindow: p.contextWindow,
      inferContextWindow: p.inferContextWindow,
      modelContextWindows: p.modelContextWindows,
      modelContextTiers: p.modelContextTiers,
      modelCapabilities: p.modelCapabilities,
      pinnedReasoningEffort: p.pinnedReasoningEffort,
      modelPinnedReasoningEfforts: p.modelPinnedReasoningEfforts,
      modelAutoCompactTokenLimits: p.modelAutoCompactTokenLimits,
      modelSupportsServiceTier: p.modelSupportsServiceTier,
      modelSuppressSyntheticMax: p.modelSuppressSyntheticMax,
      noStructuredOutputModels: p.noStructuredOutputModels,
      noJsonSchemaModels: p.noJsonSchemaModels,
      unsupportedHostedTools: p.unsupportedHostedTools,
      unsupportedHostedToolsWithClientTools: p.unsupportedHostedToolsWithClientTools,
      retainModels: p.retainModels,
      omitReasoningEffortWithToolsModels: p.omitReasoningEffortWithToolsModels,
      upstreamHttpVersion: p.upstreamHttpVersion,
      transientRetryOn5xx: p.transientRetryOn5xx,
      upstreamWebsocket: p.upstreamWebsocket, // Unset keeps upstream WebSocket enabled for canonical OpenAI.
      authMode: p.authMode,
      apiKeyTransport: p.apiKeyTransport,
      disabled: p.disabled === true,
      codexAccountMode: providerCodexAccountMode(name, p),
      ...(name === "xai" ? { xaiResponsesOptInState: xaiResponsesOptInState(p) } : {}),
      // Only opt-in Fast lanes (Anthropic fast mode bills usage credits) get a dashboard switch.
      ...(getProviderRegistryEntry(name)?.fastOptIn === true ? { fastOptIn: { enabled: p.fastEnabled === true } } : {}),
      discovery: p.liveModels === false ? undefined : getProviderDiscoveryStatus(name), ...providerTlsProfileDiagnostic(name, p),
      ...(name === "openai" && isCanonicalOpenAiForwardProvider(p)
        ? { entitlement: getCodexModelEntitlementStatus(config) }
        : {}),
    })));
  }

  if (url.pathname === LOCAL_PROVIDER_RELOAD_PATH && req.method === "POST") {
    if (principal !== "local-provider-reload-capability") {
      return jsonResponse({ error: "provider reload capability required" }, 403);
    }
    const name = req.headers.get(LOCAL_PROVIDER_RELOAD_NAME_HEADER) ?? "";
    if (!isValidProviderName(name)) return jsonResponse({ error: "invalid provider reload target" }, 400);

    const admitted = readConfigAdmissionSnapshot();
    if (
      admitted.kind !== "read"
      || admitted.diagnostics.source !== "file"
      || admitted.diagnostics.error !== null
    ) {
      return jsonResponse({ error: "provider reload source unavailable" }, 409);
    }
    const diskConfig = admitted.diagnostics.config;
    if (!hasOwnProvider(diskConfig.providers, name)) {
      return jsonResponse({ error: "provider reload target unavailable" }, 404);
    }
    const provider = diskConfig.providers[name]!;
    const providerError = providerManagementConfigError(
      name,
      providerTransportValidationCandidate(provider as unknown as Record<string, unknown>),
      // Reload validates a row straight off disk, which legitimately carries stored
      // operator overlays; only the canonical transport/auth keys need to match the seed.
      { allowOperatorOverlays: true },
    )
      ?? providerEmptyToolOutputConfigError(name, provider);
    if (providerError) return jsonResponse({ error: "provider reload target invalid" }, 409);
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(
      diskConfig.codexAccountNamespaces,
      name,
    );
    if (namespaceCollision) return jsonResponse({ error: "provider reload target conflicts with routing" }, 409);
    const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(provider);
    const resolvedError = await providerDestinationResolvedError(name, provider, { allowBenchmarkAddresses });
    if (resolvedError) return jsonResponse({ error: "provider reload target rejected" }, 409);

    // Destination validation awaits DNS. A cooperating writer holds the same SQLite
    // mutation lock, so the final exact-byte check and live adoption happen as one
    // synchronous authority decision. The route does not save or reserialize disk.
    let currentDiskConfig: EpxConfig | null = null;
    let sourceChanged = false;
    withConfigMutationLockSync(() => {
      const current = readConfigAdmissionSnapshot();
      if (
        current.kind !== "read"
        || current.diagnostics.source !== "file"
        || current.diagnostics.error !== null
        || current.contentSha256 !== admitted.contentSha256
      ) {
        sourceChanged = true;
        return;
      }
      currentDiskConfig = current.diagnostics.config;
      adoptPersistedProviderIntoLiveConfig(
        config,
        name,
        current.diagnostics.config.providers[name]!,
        current.diagnostics.config,
      );
    });
    if (sourceChanged || currentDiskConfig === null) {
      return jsonResponse({ error: "provider reload source changed" }, 409);
    }
    clearPassiveKeyLimits(name);
    reconcileLiveStateStores();
    // The complete disk snapshot owns display overlays, including providers that this
    // live routing instance deliberately does not adopt.
    refreshConfigDerivedRegistries(currentDiskConfig);
    clearGatherRoutedModelsInflight();
    (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
    clearAccountQuotaCache(name);
    clearKeyCooldowns(name);
    // The rotation cursor describes a pool this edit just changed; keeping it would let a
    // stale position steer the next proactive pick.
    forgetApiKeyRotationCursor(name);
    clearModelCache(name);
    if (name === "openai") (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, name, catalogRefresh });
  }

  if (url.pathname === "/api/providers" && req.method === "PUT") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "provider batch body must be a plain object", code: "invalid_provider_editor_body" }, 400);
    }
    const bodyKeys = Object.keys(rawBody);
    if (bodyKeys.length !== 2 || !Object.hasOwn(rawBody, "baseline") || !Object.hasOwn(rawBody, "next")) {
      return jsonResponse({ error: "provider batch body must contain only baseline and next", code: "invalid_provider_editor_body" }, 400);
    }
    const baselineResult = parseProviderEditorConfigDTO(rawBody.baseline);
    if (!baselineResult.ok) return jsonResponse({ error: baselineResult.error, code: baselineResult.code }, 400);
    const nextResult = parseProviderEditorConfigDTO(rawBody.next);
    if (!nextResult.ok) return jsonResponse({ error: nextResult.error, code: nextResult.code }, 400);

    const observed = readConfigAdmissionSnapshot();
    if (observed.kind !== "read" || observed.diagnostics.source !== "file" || observed.diagnostics.error !== null) {
      return jsonResponse({ error: "provider config is unavailable", code: "provider_config_unavailable" }, 409);
    }
    if (!isDeepStrictEqual(providerEditorConfigDTO(observed.diagnostics.config), baselineResult.value)) {
      return jsonResponse({ error: "provider editor baseline is stale", code: "stale_provider_editor_baseline" }, 409);
    }
    const preview = providerEditorCandidate(observed.diagnostics.config, baselineResult.value, nextResult.value);
    if (!preview.ok) return jsonResponse({ error: preview.error, code: preview.code }, preview.status);

    // DNS/SSRF validation happens before the persistence callback. The callback repeats every
    // synchronous check against a fresh snapshot and rejects a changed baseline, so this awaited
    // phase can never authorize a stale provider set.
    for (const [name, provider] of Object.entries(preview.config.providers)) {
      const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(provider);
      const resolvedError = await providerDestinationResolvedError(name, provider, { allowBenchmarkAddresses });
      if (resolvedError) return jsonResponse({ error: resolvedError, code: "invalid_provider_destination" }, 400);
    }

    let removedCredentials: string[] = [];
    const outcome = mutatePersistedConfig<ProviderEditorMutationValue>(persisted => {
      if (!isDeepStrictEqual(providerEditorConfigDTO(persisted), baselineResult.value)) {
        return {
          changed: false,
          value: {
            ok: false,
            status: 409,
            error: "provider editor baseline is stale",
            code: "stale_provider_editor_baseline",
          },
        };
      }
      const candidate = providerEditorCandidate(persisted, baselineResult.value, nextResult.value);
      if (!candidate.ok) return { changed: false, value: candidate };
      const changed = !isDeepStrictEqual(providerEditorConfigDTO(persisted), nextResult.value);
      if (!changed) return { changed: false, value: candidate };

      for (const [name, provider] of Object.entries(candidate.config.providers)) {
        if (!Object.hasOwn(persisted.providers, name)) {
          initializeProviderModelSelection(name, provider, undefined, candidate.config);
        }
      }
      removedCredentials = Object.values(persisted.providers).flatMap(providerGcpCredentialMarkers);
      persisted.defaultProvider = candidate.config.defaultProvider;
      persisted.providers = structuredClone(candidate.config.providers);
      persisted.disabledModels = candidate.config.disabledModels;
      persisted.modelDiscovery = candidate.config.modelDiscovery;
      for (const name of candidate.removedProviders) {
        dropProviderCustomModels(persisted, name);
        forgetProviderContextCap(persisted, name);
      }
      return {
        changed: true,
        value: {
          ok: true,
          config: structuredClone(persisted),
          removedProviders: candidate.removedProviders,
        },
      };
    });
    if (outcome.status === "unavailable") {
      const code = outcome.reason === "conflict" ? "provider_config_conflict" : "provider_config_unavailable";
      return jsonResponse({ error: "provider config changed before it could be saved", code }, 409);
    }
    if (!outcome.value.ok) {
      return jsonResponse({ error: outcome.value.error, code: outcome.value.code }, outcome.value.status);
    }

    cleanupRemovedGcpCredentials(removedCredentials);
    adoptProviderEditorCandidate(config, outcome.value.config);
    clearPassiveKeyLimits();
    reconcileLiveStateStores();
    refreshConfigDerivedRegistries(outcome.value.config);
    clearGatherRoutedModelsInflight();
    (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
    clearAccountQuotaCache();
    clearKeyCooldowns();
    // Cursors too, for the same reason the cooldown clear above takes no name: this PUT
    // replaces the whole roster, and a cursor that outlives it still names a real id, so
    // round-robin would resume after the pre-edit position instead of the new roster head.
    forgetApiKeyRotationCursor();
    clearModelCache();
    (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, catalogRefresh });
  }

  // Provider POST merges directly; existing secrets never round-trip through masked DTOs.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: unknown; provider?: unknown; setDefault?: boolean };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isPlainRecord(body.provider)) return jsonResponse({ error: "provider must be a plain object" }, 400);
    const credentialResponse = providerGcpCredentialInputResponse(body.provider);
    if (credentialResponse) return credentialResponse;
    // Reject canonical-row clears before normalization hides their ownership.
    if (name === "openai" && (Object.hasOwn(body.provider, "autoReviewModel") || Object.hasOwn(body.provider, "autoReviewModelOverrides"))) {
      return jsonResponse({ error: "provider openai must not include autoReviewModel or autoReviewModelOverrides" }, 400);
    }
    const existing = config.providers[name];
    const aliasOwnershipError = providerAliasOverlayOwnershipError(body.provider, existing);
    if (aliasOwnershipError) return jsonResponse({ error: aliasOwnershipError }, 400);
    const transportCandidate = providerTransportValidationCandidate(body.provider);
    preserveAnthropicInstanceMarker(name, transportCandidate as unknown as EpxProviderConfig, existing);
    const markerCollision = anthropicInstancePublicationError(name, transportCandidate as unknown as EpxProviderConfig, existing);
    if (markerCollision) return jsonResponse({ error: markerCollision }, 409);
    const pinError = applyProviderPinFields(transportCandidate as unknown as EpxProviderConfig, body.provider, existing);
    if (pinError) return jsonResponse({ error: pinError }, 400);
    const providerError = providerManagementConfigError(name, transportCandidate)
      ?? providerEmptyToolOutputConfigError(name, transportCandidate)
      ?? providerCompatFieldConfigError(body.provider as Record<string, unknown>);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    const rawProvider = body.provider as Record<string, unknown>;
    if (rawProvider.upstreamWebsocket !== undefined && typeof rawProvider.upstreamWebsocket !== "boolean") {
      return jsonResponse({ error: "upstreamWebsocket must be a boolean" }, 400);
    }
    const catalogCapabilityError = providerCatalogCapabilityConfigError(name, transportCandidate);
    if (catalogCapabilityError) return jsonResponse({ error: catalogCapabilityError }, 400);
    const prov = stripCodexRuntimeProviderFields(transportCandidate as unknown as EpxProviderConfig);
    // PATCH already clears on null; POST persisted the body as submitted, so a `null` here
    // reached disk and the next loadConfig() refused it. Canonicalize to absent, which is what
    // "clear" means everywhere else.
    if (prov && prov.upstreamHttpVersion === null) delete prov.upstreamHttpVersion;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    const displayNamesError = modelDisplayNamesConfigError(prov.modelDisplayNames);
    if (displayNamesError) return jsonResponse({ error: displayNamesError }, 400);
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, name);
    if (namespaceCollision) {
      return jsonResponse({ error: namespaceCollision }, 409);
    }
    // Hostname destinations additionally get a DNS-resolved SSRF check at write time —
    // the sync check above only classifies literal IPs (review finding, PR #96).
    // Canonical openai still runs the resolver: only Clash fake-IP (198.18.0.0/15)
    // answers are ignored; loopback/RFC1918/metadata/mixed sets still fail.
    const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(prov);
    const resolvedError = await providerDestinationResolvedError(name, prov, { allowBenchmarkAddresses });
    if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    if (body.setDefault !== undefined && typeof body.setDefault !== "boolean") {
      return jsonResponse({ error: "setDefault must be a boolean" }, 400);
    }
    if (body.setDefault === true && prov.disabled) {
      return jsonResponse({ error: "cannot set a disabled provider as default", code: "default_provider_disabled" }, 400);
    }
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    // Sample request ownership BEFORE enrichment. Enrichment fills absent fields from the
    // registry seed, after which "the client omitted this" and "the registry supplied it" are
    // indistinguishable — so a carry-over guard written as `prov.x === undefined` after this
    // call can never fire.
    const submittedContextWindow = Object.hasOwn(prov, "contextWindow");
    const submittedModelContextWindows = Object.hasOwn(prov, "modelContextWindows");
    const submittedModelContextTiers = Object.hasOwn(prov, "modelContextTiers");
    const submittedModelAutoCompactTokenLimits = Object.hasOwn(prov, "modelAutoCompactTokenLimits");
    const submittedModelDisplayNames = Object.hasOwn(prov, "modelDisplayNames");
    const submittedRequestPacing = Object.hasOwn(prov, "requestPacing");
    const submittedUpstreamWebsocket = Object.hasOwn(prov, "upstreamWebsocket");
    const submittedFastEnabled = Object.hasOwn(prov, "fastEnabled");
    // Same trap, one more field: DeepSeek carries a registry default of `true` for
    // annotateEmptyToolOutputs, so enrichment cannot distinguish "the client omitted it"
    // from "the registry supplied it" either. Without this sample, an unrelated edit that
    // omits the key resurrects the registry default over an operator's explicit `false`.
    const submittedAnnotateEmptyToolOutputs = Object.hasOwn(prov, "annotateEmptyToolOutputs");
    // And for the compatibility settings, several of which enrichment fills from the registry
    // seed (#5563); the sample also records whether the request named an auth mode.
    const overwriteSample = sampleProviderOverwrite(prov);
    enrichProviderFromCatalog(name, prov);
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    // Overwriting an existing provider must not drop its multi-key pool: carry it over, then
    // let the (possibly new) apiKey join the pool as the active entry. Only while the provider
    // keeps its destination: those keys were issued for the previous upstream.
    const existingPool = config.providers[name]?.apiKeyPool;
    if (existingPool && !prov.apiKeyPool
      && providerOverwriteKeepsDestination(prov, config.providers[name], overwriteSample)) prov.apiKeyPool = existingPool;
    // The same rule applies to user-configured price overlays: the dashboard's
    // add/edit form does not send modelCosts, so an overwrite must not silently
    // erase hand-edited per-model prices from Logs/Usage estimates.
    const existingCosts = config.providers[name]?.modelCosts;
    if (existingCosts && !prov.modelCosts) prov.modelCosts = existingCosts;
    // The add/edit form also omits auto-review selectors. Preserve hand-configured
    // provider-wide and per-model targets across an unrelated overwrite; clearing is
    // explicit through PATCH with null.
    const submittedAutoReviewModel = Object.hasOwn(body.provider, "autoReviewModel");
    const submittedAutoReviewOverrides = Object.hasOwn(body.provider, "autoReviewModelOverrides");
    const existingAutoReviewModel = config.providers[name]?.autoReviewModel;
    if (!submittedAutoReviewModel && existingAutoReviewModel && !prov.autoReviewModel) prov.autoReviewModel = existingAutoReviewModel;
    const existingAutoReviewOverrides = config.providers[name]?.autoReviewModelOverrides;
    if (!submittedAutoReviewOverrides && existingAutoReviewOverrides && !prov.autoReviewModelOverrides) {
      prov.autoReviewModelOverrides = { ...existingAutoReviewOverrides };
    }
    if (prov.autoReviewModel !== undefined) {
      if (typeof prov.autoReviewModel === "string" && prov.autoReviewModel.trim()) {
        prov.autoReviewModel = prov.autoReviewModel.trim();
      } else {
        delete prov.autoReviewModel;
      }
    }
    if (prov.autoReviewModelOverrides !== undefined) {
      const normalizedOverrides = normalizeAutoReviewModelOverrides(prov.autoReviewModelOverrides);
      if (normalizedOverrides) prov.autoReviewModelOverrides = normalizedOverrides;
      else delete prov.autoReviewModelOverrides;
    }
    // And to the per-provider account-failover opt-out (#2568d). `ProviderPayload` has no
    // member for it either, so an add/edit save structurally cannot carry it — and dropping it
    // silently ENABLES rotation, because activation is presence-driven once the knob is gone.
    // An overwrite must not spend a second subscription account's quota as a side effect.
    const existingFailover = config.providers[name]?.oauthAccountFailover;
    if (existingFailover && !prov.oauthAccountFailover) prov.oauthAccountFailover = existingFailover;

    if (!Object.hasOwn(body.provider, "cacheAffinity") && config.providers[name]?.cacheAffinity !== undefined) {
      prov.cacheAffinity = config.providers[name]!.cacheAffinity;
    }
    // ...and to hand-edited context windows. `ProviderPayload` (gui/src/provider-payload.ts)
    // has no member for either field, so the add/edit form structurally cannot send them:
    // absence in the request means "not carried", never "the user deleted it". Deletion goes
    // through PATCH with an explicit null (#1409).
    if (!submittedModelDisplayNames && existing?.modelDisplayNames) {
      prov.modelDisplayNames = { ...existing.modelDisplayNames };
    }
    if (!submittedRequestPacing && existing?.requestPacing) {
      prov.requestPacing = structuredClone(existing.requestPacing);
    }
    if (!submittedContextWindow && existing?.contextWindow !== undefined) {
      prov.contextWindow = existing.contextWindow;
    }
    // `!== undefined` rather than a truthiness test: the whole point of this field is that
    // an explicit `false` must survive, and `false` is falsy.
    if (!submittedAnnotateEmptyToolOutputs && existing?.annotateEmptyToolOutputs !== undefined) {
      prov.annotateEmptyToolOutputs = existing.annotateEmptyToolOutputs;
    }
    // The provider add/edit form may omit this transport option. Preserve the stored value
    // during a full overwrite; PATCH remains the explicit mutation path, and `!== undefined`
    // keeps an operator's explicit false from being treated as absent.
    if (!submittedUpstreamWebsocket && existing?.upstreamWebsocket !== undefined) {
      prov.upstreamWebsocket = existing.upstreamWebsocket;
    }
    // The Models-page Fast switch is PATCH-owned and the provider form never sends it, so an
    // unrelated full save must not silently turn an opted-in Anthropic Fast lane back off.
    const liveFastEnabled = config.providers[name]?.fastEnabled;
    if (!submittedFastEnabled && liveFastEnabled !== undefined) prov.fastEnabled = liveFastEnabled;
    // The form sends none of the compatibility settings either (#5563). Read the live row rather
    // than `existing`, like the alias overlays below: a PATCH that saved one of them while DNS
    // validation awaited must not be undone. Only the hideRawReasoning display policy follows the
    // provider to a new destination; the upstream compatibility settings do not.
    carryProviderCompatFields(prov, config.providers[name], overwriteSample);
    if (existing?.modelContextWindows) {
      // When the client did send a map, its keys win and the user's other keys survive. When
      // it did not, the stored value is the user's map alone: merging the registry seed in
      // would persist seed keys into user config as a side effect of an unrelated save, and
      // router.ts already fills registry values beneath user entries at resolve time.
      prov.modelContextWindows = submittedModelContextWindows
        ? { ...existing.modelContextWindows, ...(prov.modelContextWindows ?? {}) }
        : { ...existing.modelContextWindows };
    }
    if (existing?.modelAutoCompactTokenLimits) {
      prov.modelAutoCompactTokenLimits = submittedModelAutoCompactTokenLimits
        ? { ...existing.modelAutoCompactTokenLimits, ...(prov.modelAutoCompactTokenLimits ?? {}) }
        : { ...existing.modelAutoCompactTokenLimits };
    }
    // DNS validation above awaits. Re-read the live row so a dedicated alias write that
    // completed during that wait remains authoritative instead of being overwritten by the
    // older ownership snapshot used to admit this POST.
    const lateMarkerCollision = anthropicInstancePublicationError(name, prov, config.providers[name]);
    if (lateMarkerCollision) return jsonResponse({ error: lateMarkerCollision }, 409);
    preserveAnthropicInstanceMarker(name, prov, config.providers[name]);
    restorePersistedAliasOverlays(prov, config.providers[name]);
    const capabilities = Object.hasOwn(body.provider, "modelCapabilities")
      ? mergeModelCapabilities(undefined, prov.modelCapabilities)
      : mergeModelCapabilities(config.providers[name]?.modelCapabilities, undefined);
    if (capabilities === undefined) delete prov.modelCapabilities;
    else prov.modelCapabilities = capabilities;
    // The add/edit form omits wire choices. Read after DNS so a concurrent switch
    // remains authoritative, including the marker that protects it on the next boot.
    if (name === "xai") {
      const latest = config.providers[name];
      if (!Object.hasOwn(body.provider, "modelAdapters") && latest?.modelAdapters) {
        prov.modelAdapters = { ...latest.modelAdapters };
      }
      if (latest?.xaiResponsesDefaultVersion !== undefined) {
        prov.xaiResponsesDefaultVersion = latest.xaiResponsesDefaultVersion;
      }
    }
    // Same reason for the Z.AI marker: the provider form never carries it, and losing it on an
    // unrelated edit would let the one-time wire rewrite run a second time.
    if (name === ZAI_PROVIDER_ID) {
      const latest = config.providers[name];
      if (latest?.zaiResponsesDefaultVersion !== undefined) {
        prov.zaiResponsesDefaultVersion = latest.zaiResponsesDefaultVersion;
      }
    }
    // Reapply pins after DNS/import awaits; validate the complete draft before adoption.
    const latest = config.providers[name];
    const latestPinError = applyProviderPinFields(prov, body.provider, latest);
    if (latestPinError) return jsonResponse({ error: latestPinError }, 400);
    const pinsOwned = Object.hasOwn(body.provider, "pinnedReasoningEffort")
      || Object.hasOwn(body.provider, "modelPinnedReasoningEfforts")
      || latest?.pinnedReasoningEffort !== undefined || latest?.modelPinnedReasoningEfforts !== undefined;
    // Stage new-registration discovery state in a draft until validation passes.
    const registrationDraft = !latest ? {
      ...config,
      ...(config.modelDiscovery === undefined ? {} : { modelDiscovery: structuredClone(config.modelDiscovery) }),
    } : undefined;
    initializeProviderModelSelection(name, prov, latest, registrationDraft ?? config);
    const candidate = stripRegistryOnlyStaticHeaders(name, prov);
    const previous = Object.getOwnPropertyDescriptor(config.providers, name);
    const rollback = pinsOwned ? captureConfigTopLevelRollback(config, ["defaultProvider", "modelDiscovery", "disabledModels"]) : undefined;
    let validationError: string | undefined, removedCredentials: string[] = [];
    withConfigMutationLockSync(() => {
      validationError = anthropicInstancePublicationError(name, candidate, config.providers[name]);
      if (validationError) return;
      const liveTiers = config.providers[name]?.modelContextTiers;
      if (submittedModelContextTiers && liveTiers) candidate.modelContextTiers = Object.assign(Object.create(null), liveTiers, candidate.modelContextTiers ?? {});
      else if (!submittedModelContextTiers && liveTiers) candidate.modelContextTiers = { ...liveTiers };
      else if (!submittedModelContextTiers) delete candidate.modelContextTiers;
      preserveOmittedLiveProviderFields(candidate, rawProvider, config.providers[name]);
      const draft = { ...(registrationDraft ?? config), providers: { ...config.providers, [name]: candidate }, ...(body.setDefault === true ? { defaultProvider: name } : {}) };
      const validation = validateConfigCandidate(draft); if (!validation.ok) { validationError = validation.error; return; }
      try {
        if (registrationDraft) {
          for (const key of ["modelDiscovery", "disabledModels"] as const) {
            if (Object.hasOwn(registrationDraft, key)) Object.defineProperty(config, key, {
              value: registrationDraft[key], writable: true, enumerable: true, configurable: true,
            });
          }
        }
        removedCredentials = snapshotProviderGcpCredentialMarkers(name, config.providers[name]);
        config.providers[name] = candidate;
        if (body.setDefault === true) config.defaultProvider = name;
        (deps.saveConfigPreservingClaudeCode ?? save)(config);
      } catch (error) {
        if (rollback) {
          if (previous) Object.defineProperty(config.providers, name, previous);
          else delete config.providers[name];
          rollback();
        }
        throw error;
      }
    });
    if (validationError !== undefined) return jsonResponse({ error: validationError }, 400);
    clearPassiveKeyLimits(name);
    cleanupRemovedGcpCredentials(removedCredentials);
    reconcileLiveStateStores();
    if (prov.apiKey && prov.apiKeyPool) {
      const { addProviderApiKey } = await import("../../providers/api-keys");
      addProviderApiKey(config, name, prov.apiKey);
    }
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, name, catalogRefresh });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "provider patch body must be a plain object" }, 400);
    const keys = Object.keys(rawBody);
    const aliasField = PROVIDER_ALIAS_OVERLAY_FIELDS.find(field => Object.hasOwn(rawBody, field));
    if (aliasField) return jsonResponse({ error: `${aliasField} is managed by the dedicated alias API` }, 400);
    const hasMode = Object.hasOwn(rawBody, "codexAccountMode");
    const hasSetDefault = Object.hasOwn(rawBody, "setDefault");
    const canonicalBudgetOnly = name === "openai"
      && keys.length === 1
      && keys[0] === "modelAutoCompactTokenLimits";

    // codexAccountMode keeps its dedicated side-effect path (quota cache clear, thread map
    // clear, pool prime) and is mutually exclusive with every other patch field.
    if (hasMode) {
      if (keys.length !== 1) {
        return jsonResponse({ error: "codexAccountMode cannot be combined with other patch fields" }, 400);
      }
      if (name !== "openai") return jsonResponse({ error: "codexAccountMode is valid only for provider openai" }, 400);
      const mode = rawBody.codexAccountMode;
      if (mode !== "pool" && mode !== "direct") {
        return jsonResponse({ error: "codexAccountMode must be pool or direct" }, 400);
      }
      const provider = config.providers.openai;
      if (!provider || !isCanonicalOpenAiForwardProvider(provider)) {
        return jsonResponse({ error: "provider openai must be the canonical built-in provider" }, 400);
      }
      commitProviderPatch(config, () => {
        config.providers.openai = { ...provider, codexAccountMode: mode };
      }, deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode);
      reconcileLiveStateStores();
      (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
      (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
      if (mode === "pool") {
        try {
          const prime = deps.primeCodexPoolQuotas ?? primeCodexPoolQuotas;
          void Promise.resolve(prime(config, "mode-change")).catch(() => undefined);
        } catch {
          // Quota priming is best-effort; the persisted live mode is already authoritative.
        }
      }
      return jsonResponse({ success: true, name: "openai", codexAccountMode: mode });
    }

    // Default-provider changes must be a deliberate, standalone action. This keeps
    // routing changes out of ordinary provider edits and lets the dashboard expose a
    // simple "Set as default" control without round-tripping the full config.
    if (hasSetDefault) {
      if (keys.length !== 1 || rawBody.setDefault !== true) {
        return jsonResponse({ error: "setDefault must be true and cannot be combined with other patch fields" }, 400);
      }
      if (config.providers[name]!.disabled) {
        return jsonResponse({ error: "cannot set a disabled provider as default", code: "default_provider_disabled" }, 400);
      }
      commitProviderPatch(config, () => {
        config.defaultProvider = name;
      }, deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode);
      reconcileLiveStateStores();
      return jsonResponse({ success: true, name, defaultProvider: name });
    }

    // Field-mask editor: apply recognized fields onto a copy, then validate the MERGED
    // provider (canonical-seed guard covers openai; local-guard covers registry key providers).
    // API keys are never writable here — the api-keys endpoints own pool-integrated key writes.
    if (Object.hasOwn(rawBody, "apiKey")) {
      return jsonResponse({ error: "apiKey cannot be patched here; use the provider API-key endpoints" }, 400);
    }
    // The canonical OpenAI row rejects these fields outright on create. A PATCH that only clears
    // or restates them would otherwise slip past the merged-row guard and answer 200, which reads
    // as acceptance for a field the provider does not support.
    if (name === "openai" && (Object.hasOwn(rawBody, "autoReviewModel") || Object.hasOwn(rawBody, "autoReviewModelOverrides"))) {
      return jsonResponse({ error: "provider openai must not include autoReviewModel or autoReviewModelOverrides" }, 400);
    }
    const applied = applyProviderPatchFields(name, config.providers[name]!, rawBody, keys, config);
    if ("error" in applied) return jsonResponse({ error: applied.error }, 400);
    const next = applied.next;

    const pacingOnly = keys.every(key => key === "requestPacing");
    // A combo naming this row as its decisionProvider is only as valid as the row: an adapter
    // or baseUrl edit could fail the combo's load-time checks and get it salvaged away on the
    // next reload. Disabling the row stays allowed (not editorTouched; runtime fails open).
    const decisionDependent = () => Object.values(config.combos ?? {})
      .some(combo => (typeof combo.decisionProvider === "string" && combo.decisionProvider.trim() === name)
        || (typeof combo.decisionModel === "string" && combo.decisionModel.trim().startsWith(`${name}/`)));
    const { decisionModelProviderPatchError } = await import("./decision-model-validation");
    const decisionModelError = applied.editorTouched ? decisionModelProviderPatchError(config, name, next) : null;
    if (decisionModelError) return jsonResponse({ error: decisionModelError }, 400);
    if (applied.editorTouched && !pacingOnly) {
      const providerError = canonicalBudgetOnly
        ? canonicalOpenAiBudgetPatchError(next, rawBody, keys, config)
        : providerManagementConfigError(
            name,
            providerTransportValidationCandidate(next as unknown as Record<string, unknown>),
            // PATCH merges the mask onto the persisted row, which legitimately carries
            // stored operator overlays (selectedModels, disabled, …); only the canonical
            // transport/auth keys need to match the seed.
            { allowOperatorOverlays: true },
          )
          ?? providerEmptyToolOutputConfigError(name, next);
      if (providerError) return jsonResponse({ error: providerError }, 400);
      if (!canonicalBudgetOnly) {
        const catalogCapabilityError = providerCatalogCapabilityConfigError(name, next);
        if (catalogCapabilityError) return jsonResponse({ error: catalogCapabilityError }, 400);
        // Same DNS gate as POST and re-enable: the canonical built-in OpenAI forward
        // provider may resolve through Clash/Mihomo fake-IP DNS (198.18.0.0/15), so the
        // ordinary PATCH must not reject the very same destination the provider was
        // created with. Loopback, RFC1918, metadata, and mixed dangerous answers still
        // fail closed; nothing else gains the exception.
        const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(next);
        const resolvedError = await providerDestinationResolvedError(name, next, { allowBenchmarkAddresses });
        if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
      }
      if (decisionDependent()) {
        const validation = validateConfigCandidate({ ...config, providers: { ...config.providers, [name]: next } });
        if (!validation.ok) return jsonResponse({ error: validation.error }, 400);
      }
    } else if (applied.enablingOpenAi) {
      // Same DNS gate as POST: Clash fake-IP only. Never honor a persisted
      // allowPrivateNetwork on this path — it must not bypass the built-in guard.
      const resolvedError = await providerDestinationResolvedError(
        "openai",
        { baseUrl: CODEX_FORWARD_BASE_URL },
        { allowBenchmarkAddresses: true },
      );
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    }

    // The live config is shared and the destination probe above is awaited. Re-apply the
    // mask onto the newest provider under the mutation lock right before saving, so two
    // concurrent PATCHes updating different fields/headers both survive instead of the
    // later save clobbering the earlier snapshot.
    // Read before the save: once the provider is disabled the target no longer resolves (#5618).
    const shadowDependency = rawBody.disabled === true && config.providers[name]!.disabled !== true
      ? shadowInterceptProviderDependency(config, name)
      : null;
    let replayError: string | undefined;
    withConfigMutationLockSync(() => {
      const replay = applyProviderPatchFields(name, config.providers[name]!, rawBody, keys, config);
      if ("error" in replay) {
        replayError = replay.error;
        return;
      }
      if (replay.editorTouched && !pacingOnly) {
        const syncError = canonicalBudgetOnly
          ? canonicalOpenAiBudgetPatchError(replay.next, rawBody, keys, config)
          : providerManagementConfigError(
              name,
              providerTransportValidationCandidate(replay.next as unknown as Record<string, unknown>),
              { allowOperatorOverlays: true },
            )
            ?? providerEmptyToolOutputConfigError(name, replay.next);
        if (syncError) {
          replayError = syncError;
          return;
        }
        if (!canonicalBudgetOnly) {
          const catalogCapabilityError = providerCatalogCapabilityConfigError(name, replay.next);
          if (catalogCapabilityError) {
            replayError = catalogCapabilityError;
            return;
          }
        }
      } else if (replay.enablingOpenAi && !isCanonicalOpenAiForwardProvider(replay.next)) {
        replayError = "provider openai must be the canonical built-in provider";
        return;
      }
      // A PATCH that managed headers owns the resulting block: the clear path restores
      // registry static headers, so exact-match stripping must not erase them again.
      const candidate = replay.headersTouched ? replay.next : stripRegistryOnlyStaticHeaders(name, replay.next);
      const decisionModelError = replay.editorTouched ? decisionModelProviderPatchError(config, name, candidate) : null;
      if (decisionModelError) { replayError = decisionModelError; return; }
      const pinsTouched = Object.hasOwn(rawBody, "pinnedReasoningEffort") || Object.hasOwn(rawBody, "modelPinnedReasoningEfforts");
      if (pinsTouched || (replay.editorTouched && !pacingOnly && decisionDependent())) {
        const validation = validateConfigCandidate({ ...config, providers: { ...config.providers, [name]: candidate } });
        if (!validation.ok) { replayError = validation.error; return; }
      }
      const previousOwnership = passiveProviderOwnership(config.providers[name]);
      try {
        commitProviderPatch(config, () => {
          config.providers[name] = candidate;
        }, deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode);
      } finally {
        // Persistence may rebase the row or publish before throwing. Compare the resulting
        // live owner under the lock, after rollback when the save did not publish.
        if (!isDeepStrictEqual(previousOwnership, passiveProviderOwnership(config.providers[name]))) {
          clearPassiveKeyLimits(name);
        }
      }
    });
    if (replayError !== undefined) return jsonResponse({ error: replayError }, 409);
    reconcileLiveStateStores();
    if (applied.editorTouched && !pacingOnly) {
      const { clearModelCache } = await import("../../codex/model-cache");
      clearModelCache(name);
    }
    const catalogRefresh = pacingOnly ? null : await convergeCodexCatalog();
    return jsonResponse({
      success: true,
      name,
      disabled: config.providers[name]!.disabled === true,
      hasApiKey: providerHasStoredApiKey(config.providers[name]!),
      ...(shadowDependency ? { dependentShadowIntercept: shadowDependency } : {}),
      ...(name === "xai"
        ? { xaiResponsesOptInState: xaiResponsesOptInState(config.providers[name]!) }
        : {}),
      catalogRefresh,
    });
  }

  if (url.pathname === "/api/providers/test-completion" && req.method === "POST") return (await import("./provider-completion-test")).handleProviderCompletionTestRoute(ctx);

  if (url.pathname === "/api/providers/test" && req.method === "POST") {
    return handleProviderTestRoute(ctx);
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    // Config validation requires a default provider. Reassigning before deletion keeps
    // the persisted config valid and makes removal of the current default a one-step UI
    // operation. Prefer the first remaining *enabled* provider so DELETE cannot leave a
    // disabled default that setDefault / disable already refuse. Object-key order is the
    // documented configuration order and is stable through JSON persistence.
    const fallbackDefault = name === config.defaultProvider
      ? Object.entries(config.providers)
        .find(([provider, providerConfig]) => provider !== name && providerConfig.disabled !== true)
        ?.[0]
      : undefined;
    if (name === config.defaultProvider && !fallbackDefault) {
      return jsonResponse({
        error: "cannot delete the default provider when no enabled replacement remains",
        code: "last_provider",
      }, 409);
    }
    const dependentCombos = Object.entries(config.combos ?? {})
      .filter(([, combo]) => comboDependsOnProviderRoute(config, combo, name))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    if (dependentCombos.length > 0) {
      return jsonResponse({
        error: `cannot delete provider "${name}" while combos depend on it`,
        code: "provider_has_dependent_combos",
        combos: dependentCombos,
      }, 409);
    }
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    // Deleting still succeeds; the response names the shadow-call target left without a provider.
    const shadowDependency = shadowInterceptProviderDependency(config, name);
    const droppedCustomModels = removeProviderWithGcpCredentials(config, name, fallbackDefault, save);
    await releaseRemovedProviderCredentials(config, name);
    reconcileLiveStateStores();
    const { clearModelCache: clearCache } = await import("../../codex/model-cache");
    clearCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({
      success: true,
      ...(fallbackDefault ? { defaultProvider: fallbackDefault } : {}),
      ...(droppedCustomModels > 0 ? { droppedCustomModels } : {}),
      ...(shadowDependency ? { dependentShadowIntercept: shadowDependency } : {}),
      catalogRefresh,
    });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config), values: selectedProviderContextCaps(config) });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    // Reject non-object payloads (e.g. `{"provider": true}` or a bare array) before any
    // property access, with the route's consistent 400 response.
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "provider-context-caps body must be a plain object" }, 400);
    const body = rawBody as { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    const { clearModelCache } = await import("../../codex/model-cache");
    const respond = (catalogRefresh: Awaited<ReturnType<typeof convergeCodexCatalog>>) => jsonResponse({
      ok: true,
      cap: DEFAULT_PROVIDER_CONTEXT_CAP,
      value: globalContextCapValue(config),
      caps: providerContextCaps(config), values: selectedProviderContextCaps(config),
      catalogRefresh,
    });

    // Reject malformed and mixed payloads before branch selection: `provider` and `enabled`
    // must appear together with their expected types, and provider updates cannot be
    // combined with `setAll` (which would otherwise be silently ignored).
    const hasProviderFields = Object.hasOwn(body, "provider") || Object.hasOwn(body, "enabled");
    if (hasProviderFields) {
      if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
        return jsonResponse({ error: "provider and enabled are required together" }, 400);
      }
      if (Object.hasOwn(body, "setAll")) {
        return jsonResponse({ error: "setAll cannot be combined with provider updates" }, 400);
      }
    }

    // Branch 1: per-provider toggle (checked first: a per-provider request may carry an
    // explicit `value`, which must never fall through to the global-value branch). Enable
    // restores the selected provider value, then the global default, unless an explicit
    // per-provider value is supplied; that value is never copied to other providers.
    if (typeof body.provider === "string" && typeof body.enabled === "boolean") {
      const provider = body.provider.trim();
      if (!isValidProviderName(provider)) {
        return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
      }
      if (!hasOwnProvider(config.providers, provider)) {
        return jsonResponse({ error: "unknown provider" }, 404);
      }
      // Validate a supplied per-provider value before mutating anything: it must be a
      // finite number, and after flooring it must still be >= 1 — a value like 0.5 would
      // otherwise floor to 0 and silently fall back to the global default.
      if (body.value !== undefined && (typeof body.value !== "number" || !Number.isFinite(body.value))) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const perProviderValue = typeof body.value === "number" ? Math.floor(body.value) : undefined;
      if (perProviderValue !== undefined && perProviderValue < 1) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      setProviderContextCap(config, provider, body.enabled, perProviderValue);
      save(config);
      reconcileLiveStateStores();
      clearModelCache(provider);
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Branch 2: set the global cap value. When `setAll` accompanies it (dashboard "apply to
    // every routed provider" toggle), re-point every enabled provider; otherwise keep each
    // provider's own cap value and only change the default for future toggles.
    if (body.value !== undefined) {
      // Same normalization as the per-provider branch: floor before validating so a value
      // that floors to zero is rejected rather than silently stored.
      if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const normalizedValue = Math.floor(body.value);
      if (normalizedValue < 1) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      if (body.setAll !== undefined && typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const affected = Object.keys(providerContextCaps(config));
      const applyToAll = body.setAll === true;
      setGlobalContextCapValue(config, normalizedValue, applyToAll);
      save(config);
      reconcileLiveStateStores();
      if (applyToAll) {
        for (const provider of affected) clearModelCache(provider);
      }
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Branch 3: enable/clear the cap for every provider at once.
    if (body.setAll !== undefined) {
      if (typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setAllProviderContextCaps(config, names, body.setAll);
      save(config);
      reconcileLiveStateStores();
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Unrecognized payload: reject rather than silently succeeding.
    return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
  }

  // The standalone Vite GUI consumes these canonical registry presets through the API.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }

  if (url.pathname === "/api/providers/share-url" && req.method === "GET") {
    const providerName = url.searchParams.get("provider")?.trim() ?? "";
    if (!providerName || !isValidProviderName(providerName)) {
      return jsonResponse({ error: "valid provider query parameter is required", code: "invalid_provider_name" }, 400);
    }
    if (!hasOwnProvider(config.providers, providerName)) {
      return jsonResponse({ error: `unknown provider: ${providerName}`, code: "unknown_provider" }, 404);
    }
    const { buildProviderShareDeepLink, DeepLinkImportError } = await import("../../providers/deep-link-import");
    try {
      const shareUrl = buildProviderShareDeepLink(providerName, config.providers[providerName]!);
      return jsonResponse({ schemaVersion: 1, provider: providerName, url: shareUrl });
    } catch (error) {
      if (error instanceof DeepLinkImportError) {
        return jsonResponse({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }

  if (url.pathname === "/api/providers/import-url/preview" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body", code: "invalid_json" }, 400);
    }
    if (!isPlainRecord(rawBody) || typeof rawBody.url !== "string") {
      return jsonResponse({ error: "url string is required", code: "invalid_request" }, 400);
    }
    const { previewProviderDeepLink, DeepLinkImportError } = await import("../../providers/deep-link-import");
    try {
      const preview = await previewProviderDeepLink(rawBody.url, {
        allowPrivateNetwork: rawBody.allowPrivateNetwork === true,
        overwrite: rawBody.overwrite === true,
        existingProviders: config.providers,
      });
      return jsonResponse(preview);
    } catch (error) {
      if (error instanceof DeepLinkImportError) {
        return jsonResponse({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }

  if (url.pathname === "/api/providers/import-url" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body", code: "invalid_json" }, 400);
    }
    if (!isPlainRecord(rawBody) || typeof rawBody.url !== "string") {
      return jsonResponse({ error: "url string is required", code: "invalid_request" }, 400);
    }
    const { applyProviderDeepLink, DeepLinkImportError } = await import("../../providers/deep-link-import");
    try {
      let committedProvider: EpxProviderConfig | undefined;
      let committedConfig: EpxConfig | undefined;
      const result = await applyProviderDeepLink(rawBody.url, {
        allowPrivateNetwork: rawBody.allowPrivateNetwork === true,
        overwrite: rawBody.overwrite === true,
        setDefault: rawBody.setDefault === true,
        onCommitted: (provider, persistedConfig) => {
          committedProvider = provider;
          committedConfig = persistedConfig;
        },
      });
      if (committedProvider && committedConfig) {
        adoptPersistedProviderIntoLiveConfig(config, result.name, committedProvider, committedConfig);
      }
      if (rawBody.setDefault === true) config.defaultProvider = result.name;
      clearPassiveKeyLimits(result.name);
      reconcileLiveStateStores();
      clearModelCache(result.name);
      const catalogRefresh = await convergeCodexCatalog();
      return jsonResponse({
        schemaVersion: result.schemaVersion,
        name: result.name,
        adapter: result.adapter,
        baseUrl: result.baseUrl,
        defaultModel: result.defaultModel,
        models: result.models,
        hasApiKey: result.hasApiKey,
        maskedApiKey: result.maskedApiKey,
        allowPrivateNetwork: result.allowPrivateNetwork,
        overwrote: result.overwrote,
        catalogRefresh,
      });
    } catch (error) {
      if (error instanceof DeepLinkImportError) {
        return jsonResponse({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }
  return null;
}
