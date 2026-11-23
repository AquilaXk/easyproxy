import { fetchCursorUsableModels, hasCursorUsableModelsFetcherForTests } from "../../adapters/cursor/live-models";
import { hasFreshCachedCatalog } from "../../adapters/devin/cloud-direct";
import { fetchDevinUsableModels } from "../../adapters/devin/live-models";
import { probeJevDecisionProvider } from "../../combos/jev";
import { hasOwnProvider, isValidProviderName } from "../../config";
import {
  ProviderOutboundPolicyError,
  providerOutboundGet,
  providerOutboundPost,
  providerRedirectError,
  verifyBespokeDestination,
} from "../../lib/provider-outbound";
import { isPinnedHttp1 } from "../../lib/upstream-http-version";
import { resolveDevinApiBaseUrl } from "../../oauth/devin/api-base";
import { captureModelsOAuthTarget, mayResolveModelsOAuth, modelsOAuthTargetMatches } from "../../oauth/model-discovery-auth";
import { parseAntigravityAvailableModels } from "../../providers/antigravity-models";
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
import {
  extractModelEnvelopeRows,
  extractProviderModelItems,
  isRegistryModelDiscoveryUrl,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
} from "../../providers/model-discovery";
import { invalidModelDiscoveryHint } from "../../providers/model-discovery-diagnostic";
import { effectiveGoogleMode, getProviderRegistryEntry, providerMatchesRegistryTransport } from "../../providers/registry";
import { isXaiGrokOAuth, readXaiLegacyPrivacyError, XAI_LEGACY_PRIVACY_MESSAGE } from "../../providers/xai-privacy-mode";
import type { EpxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/**
 * Lightweight connectivity probe (`POST /api/providers/test`): perform the provider's live /models
 * fetch directly and report only real upstream evidence. The catalog aggregate (fetchAllModels)
 * deliberately hides fetch failures behind stale/static fallbacks, so a catalog-presence check would
 * let a static-catalog provider with a fake key "pass" — this endpoint never uses it.
 */
export async function handleProviderTestRoute(ctx: ManagementContext): Promise<Response> {
  const { req, url, config, convergeCodexCatalog } = ctx;

  const name = url.searchParams.get("name")?.trim();
  if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
    return jsonResponse({ error: "unknown provider" }, 404);
  }
  const prov = { ...config.providers[name]! };
  const authorizedTarget = captureModelsOAuthTarget(name, prov);
  if (prov.disabled) {
    return jsonResponse({ ok: false, error: "Provider is disabled", latencyMs: 0 });
  }
  if (prov.authMode === "forward") {
    return jsonResponse({
      ok: true,
      latencyMs: 0,
      message: "Passthrough provider is configured (forwards your Codex login; no upstream /models).",
    });
  }
  // Decision services answer through the bounded JEV client. A retargeted `jev` row is neither
  // TypeSafe nor a self-hosted service, so it is not probed at all: its key stays unsent.
  if (prov.adapter === "jev-decision") {
    if (name === "jev" && !providerMatchesRegistryTransport(name, prov)) {
      return jsonResponse({ applicable: false, reason: "retargeted_decision_service", latencyMs: 0 });
    }
    return jsonResponse(await probeJevDecisionProvider(config, name, { signal: req.signal }));
  }
  if (prov.liveModels === false) {
    // No live discovery endpoint. Only Vertex ADC still has a credential to verify; every other
    // static catalog must stay before credential resolution/network access (e.g. Antigravity).
    const { staticCatalogConnectionTest } = await import("./static-catalog-probe");
    return jsonResponse(await staticCatalogConnectionTest(name, prov, req.signal));
  }
  const { buildModelsRequest, getModelsOAuthAccessSnapshot, resolveModelsAuthToken } = await import("../../oauth");
  const antigravity = effectiveGoogleMode(name, prov) === "cloud-code-assist";
  const snapshot = prov.authMode === "oauth" && mayResolveModelsOAuth(name, config.providers[name])
    ? await getModelsOAuthAccessSnapshot(name, prov).catch(() => undefined)
    : undefined;
  const vertexDeadline = effectiveGoogleMode(name, prov) === "vertex" ? vertexDiscoveryDeadline(req.signal) : undefined;
  let vertexAuth: VertexDiscoveryAuth | undefined;
  const apiKey = prov.authMode === "oauth"
    ? snapshot?.accessToken
    : vertexDeadline
      ? (vertexAuth = await resolveVertexDiscoveryAuth(prov, vertexDeadline))?.token
      : await resolveModelsAuthToken(name, prov);
  if ((prov.authMode === "oauth" || effectiveGoogleMode(name, prov) === "vertex") && !apiKey) {
    return jsonResponse({ ok: false, latencyMs: 0, error: "static catalog only — upstream not verified (not logged in)" });
  }
  if (prov.adapter === "m365-copilot") return (await import("./m365-copilot-provider-probe")).probeM365CopilotProvider(name, prov, snapshot, req.signal);
  if (prov.adapter === "zed") return (await import("./zed-provider-probe")).probeZedProvider(prov, apiKey, snapshot?.providerUserId);
  if (prov.adapter === "cursor") {
    const started = Date.now();
    const canonicalCursorBase = (name === "cursor"
      ? getProviderRegistryEntry(name)?.baseUrl ?? prov.baseUrl
      : prov.baseUrl) || "https://api2.cursor.sh";
    const cursorTarget = canonicalCursorBase.replace(/\/+$/, "");
    const rawCursorBase = typeof prov.baseUrl === "string" ? prov.baseUrl.trim() : "";
    if (rawCursorBase && rawCursorBase.replace(/\/+$/, "") !== cursorTarget) {
      const rawCheck = await verifyBespokeDestination(name, prov, rawCursorBase, {
        skipDns: true,
        isCanonicalUrl: isRegistryModelDiscoveryUrl,
      });
      if (!rawCheck.ok) {
        return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: rawCheck.error });
      }
    }
    const cursorFetch = (prov as EpxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch;
    const useCallerHttp1Fetch = isPinnedHttp1(prov.upstreamHttpVersion) && typeof cursorFetch === "function";
    const skipDns = hasCursorUsableModelsFetcherForTests() || useCallerHttp1Fetch;
    const verified = await verifyBespokeDestination(name, prov, cursorTarget, {
      skipDns,
      isCanonicalUrl: isRegistryModelDiscoveryUrl,
    });
    if (!verified.ok) {
      return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: verified.error });
    }
    const live = await fetchCursorUsableModels({
      apiKey: apiKey ?? "",
      baseUrl: canonicalCursorBase,
      upstreamHttpVersion: prov.upstreamHttpVersion,
      pinnedAddress: verified.pinnedAddress,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8_000)]),
      ...(useCallerHttp1Fetch ? { fetch: cursorFetch } : {}),
    });
    const latencyMs = Date.now() - started;
    if (!live.ok) {
      return jsonResponse({
        ok: false,
        latencyMs,
        error: `cursor discovery ${live.error}${live.detail ? `: ${live.detail}` : ""}`,
      });
    }
    return jsonResponse({
      ok: true,
      latencyMs,
      models: live.models.length,
      message: `Connected. ${live.models.length} models.`,
    });
  }
  if (prov.adapter === "devin") {
    const started = Date.now();
    const configuredBase = name === "devin" ? getProviderRegistryEntry(name)?.baseUrl ?? prov.baseUrl : prov.baseUrl;
    const rawConfiguredBase = typeof prov.baseUrl === "string" ? prov.baseUrl.trim() : "";
    if (rawConfiguredBase && rawConfiguredBase !== (configuredBase ?? "").trim()) {
      const rawCheck = await verifyBespokeDestination(name, prov, rawConfiguredBase, {
        skipDns: true,
        isCanonicalUrl: isRegistryModelDiscoveryUrl,
      });
      if (!rawCheck.ok) {
        return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: rawCheck.error });
      }
    }
    const rawBase = snapshot?.apiBaseUrl ?? configuredBase;
    const destination = resolveDevinApiBaseUrl(rawBase);
    const targetToCheck = rawBase && rawBase.trim().length > 0 ? rawBase.trim() : destination;
    if (targetToCheck !== destination) {
      const targetCheck = await verifyBespokeDestination(name, prov, targetToCheck, {
        skipDns: name === "devin",
        isCanonicalUrl: isRegistryModelDiscoveryUrl,
      });
      if (!targetCheck.ok) {
        return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: targetCheck.error });
      }
    }
    const destVerified = await verifyBespokeDestination(name, prov, destination, {
      skipDns: hasFreshCachedCatalog(apiKey ?? "", destination),
      isCanonicalUrl: isRegistryModelDiscoveryUrl,
    });
    if (!destVerified.ok) {
      return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: destVerified.error });
    }
    const liveResult = await fetchDevinUsableModels({
      apiKey: apiKey ?? "",
      baseUrl: destination,
      pinnedAddress: destVerified.pinnedAddress,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8_000)]),
    });
    const latencyMs = Date.now() - started;
    if (!liveResult.ok) {
      return jsonResponse({
        ok: false,
        latencyMs,
        error: `devin discovery ${liveResult.error}${liveResult.detail ? `: ${liveResult.detail}` : ""}`,
      });
    }
    return jsonResponse({
      ok: true,
      latencyMs,
      models: liveResult.models.length,
      message: `Connected. ${liveResult.models.length} models.`,
    });
  }
  if (prov.adapter === "qoder") {
    // A late success re-syncs the catalog through the same convergence every mutation uses.
    return (await import("./qoder-provider-probe")).probeQoderProvider(name, prov, apiKey, convergeCodexCatalog);
  }
  const project = prov.project ?? snapshot?.projectId;
  if (antigravity && !project) {
    return jsonResponse({ ok: false, latencyMs: 0, error: "Antigravity project unavailable — re-run `epx login google-antigravity`" });
  }
  const { method, url: modelsUrl, headers } = buildVertexProviderModelsRequest(name, prov, apiKey)
    ?? buildModelsRequest(prov, apiKey, name, { oauthApiBaseUrl: snapshot?.apiBaseUrl, workbuddy: snapshot?.workbuddy });
  const discovery = resolveProviderModelDiscovery(name, prov);
  const started = Date.now();
  try {
    // Same canonical-URL TUN transparency as catalog discovery: the registry's
    // own fixed discovery URL survives purely-benchmark (Clash/Surge/Mihomo
    // fake-IP) DNS without proxy env.
    const outboundDependencies = (requestUrl: string) => ({ isCanonicalUrl: isRegistryModelDiscoveryUrl,
      beforeSend: () => (!vertexAuth || vertexDiscoveryAuthIsCurrent(prov, vertexAuth, headers, requestUrl))
        && (prov.authMode !== "oauth" || (mayResolveModelsOAuth(name, config.providers[name])
        && modelsOAuthTargetMatches(name, config.providers[name], authorizedTarget)
        && (name !== "anthropic2" || new URL(requestUrl).href === authorizedTarget))) });
    const res = method === "POST"
      ? await providerOutboundPost(name, prov, modelsUrl, {
        headers,
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(8000),
      }, outboundDependencies(modelsUrl))
      : await providerOutboundGet(name, prov, modelsUrl, {
        headers,
        signal: vertexDeadline ?? AbortSignal.timeout(8000),
      }, outboundDependencies(modelsUrl));
    const latencyMs = Date.now() - started;
    const redirectError = await providerRedirectError(res, modelsUrl);
    if (redirectError) {
      return jsonResponse({
        ok: false,
        latencyMs,
        error: redirectError,
      });
    }
    if (!res.ok) {
      if (isXaiGrokOAuth(name, prov) && await readXaiLegacyPrivacyError(res)) {
        return jsonResponse({ ok: false, latencyMs, error: XAI_LEGACY_PRIVACY_MESSAGE });
      }
      try {
        void res.body?.cancel().catch(() => undefined);
      } catch {
        // Best-effort release for non-conforming response streams.
      }
      return jsonResponse({ ok: false, latencyMs, error: `upstream model discovery returned ${res.status}` });
    }
    const vertexFirstPage = vertexDeadline ? countDiscoveryResponseBytes(res) : undefined;
    const bounded = await readBoundedDiscoveryJson(vertexFirstPage?.response ?? res, discovery.maxResponseBytes);
    if (!bounded.ok) {
      return jsonResponse({
        ok: false,
        latencyMs,
        error: bounded.reason === "response_too_large"
            ? `upstream model discovery exceeded the ${discovery.maxResponseBytes}-byte response limit`
            : "upstream model discovery returned invalid JSON",
      });
    }
    const ccaModels = antigravity ? parseAntigravityAvailableModels(bounded.value, discovery.maxModels) : undefined;
    if (antigravity && !ccaModels) {
      return jsonResponse({ ok: false, latencyMs, error: "upstream CCA model discovery returned an unexpected shape" });
    }
    const listing = !ccaModels && vertexDeadline
      ? await collectVertexPublisherModelPages(modelsUrl, bounded.value,
        { ...discovery, firstPageBytes: vertexFirstPage?.bytes(), signal: vertexDeadline },
        (pageUrl, signal) => providerOutboundGet(name, prov, pageUrl, { headers, signal }, outboundDependencies(pageUrl)))
      : { ok: true as const, value: bounded.value };
    if (!listing.ok) return jsonResponse({ ok: false, latencyMs, error: `upstream Vertex model listing is incomplete: ${listing.diagnostic}` });
    // OpenAI-style lists (and Together top-level arrays) use the same validation/dedupe/filter
    // as catalog discovery. Google AI Studio parses the native `models[]` envelope and filters to
    // `generateContent`, while other providers fall back to generic envelope rows if they return `models[]`.
    const record = listing.value !== null && typeof listing.value === "object" && !Array.isArray(listing.value)
      ? listing.value as Record<string, unknown>
      : undefined;
    const googleNative = !ccaModels
      ? extractGoogleNativeModelItems(name, prov, listing.value, discovery.maxModels)
      : undefined;
    const extracted = ccaModels
      ? undefined
      : googleNative
      ?? (Array.isArray(listing.value) || Array.isArray(record?.data)
        ? extractProviderModelItems(listing.value, discovery)
        : extractModelEnvelopeRows(listing.value, discovery.maxModels, ["models"]));
    if (extracted && !extracted.ok) {
      return jsonResponse({
        ok: false,
        latencyMs,
        error: extracted.reason === "too_many_models"
          ? `upstream /models exceeded the ${discovery.maxModels}-row model limit`
          : `upstream /models returned an unexpected shape${invalidModelDiscoveryHint("diagnostic" in extracted && typeof extracted.diagnostic === "string" ? extracted.diagnostic : undefined, discovery.skipInvalidRows === true)}`,
      });
    }
    const models = ccaModels?.length ?? ("items" in extracted! ? extracted!.items.length : extracted!.rows.length);
    return jsonResponse({
      ok: true,
      latencyMs,
      models,
      message: `Connected — ${models} model${models === 1 ? "" : "s"} available${extracted && "skippedInvalidRows" in extracted && extracted.skippedInvalidRows ? ` (${extracted.skippedInvalidRows} invalid row${extracted.skippedInvalidRows === 1 ? "" : "s"} skipped)` : ""}.`,
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof ProviderOutboundPolicyError
        ? `upstream /models blocked by destination policy: ${err.message}`
        : err instanceof Error ? err.message : "Connection test failed",
    });
  }
}
