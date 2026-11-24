import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ADAPTER_REGISTRY } from "../adapters/registry";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import { readConfigDiagnostics, validateConfigCandidate } from "../config/diagnostics";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { mutatePersistedConfig } from "../config/persisted-mutation";
import { hasOwnProvider, isValidProviderName } from "../config/provider-name";
import { providerBaseUrlConfigError } from "../config/provider-validation";
import {
  assessUrlDestination,
  providerDestinationConfigError,
} from "../lib/destination-policy";
import { assertJsonNestingDepth, JsonNestingDepthExceededError } from "../lib/json-depth-guard";
import { providerManagementConfigError } from "../server/auth-cors";
import type { EpxConfig, EpxProviderConfig } from "../types";

export const MAX_EPX_DEEP_LINK_BYTES = 8192;
export const MAX_DECODED_PAYLOAD_BYTES = 16384;
export const MAX_IMPORTED_MODELS = 64;
export const MAX_DEEP_LINK_JSON_DEPTH = 8;

export const SUPPORTED_ADAPTERS: ReadonlySet<string> = new Set(Object.keys(ADAPTER_REGISTRY));

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

export class DeepLinkImportError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "invalid_deep_link",
  ) {
    super(message);
    this.name = "DeepLinkImportError";
  }
}

export interface DeepLinkImportOptions {
  allowPrivateNetwork?: boolean;
  overwrite?: boolean;
  setDefault?: boolean;
  existingProviders?: Record<string, EpxProviderConfig>;
  lookupDns?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  onCommitted?: (provider: EpxProviderConfig, persistedConfig: EpxConfig) => void;
}

export interface ParsedDeepLinkProvider {
  schemeHost: "provider" | "import";
  name: string;
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  models?: string[];
  authMode?: "key" | "forward" | "local";
  note?: string;
  apiKeyTransport?: "x-api-key" | "bearer";
  googleMode?: "ai-studio" | "vertex";
  urlRequestedPrivateNetwork: boolean;
}

export interface ProviderDeepLinkPreviewResult {
  schemaVersion: 1;
  schemeHost: "provider" | "import";
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel: string | null;
  models: string[];
  authMode: string | null;
  note: string | null;
  apiKeyTransport: string | null;
  hasApiKey: boolean;
  maskedApiKey: string | null;
  urlRequestedPrivateNetwork: boolean;
  requiresPrivateNetworkOptIn: boolean;
  privateNetworkOptInGranted: boolean;
  conflict: boolean;
  canImport: boolean;
  blockedReason: string | null;
  warnings: string[];
}

export interface ProviderDeepLinkApplyResult {
  schemaVersion: 1;
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel: string | null;
  models: string[];
  hasApiKey: boolean;
  maskedApiKey: string | null;
  allowPrivateNetwork: boolean;
  overwrote: boolean;
}

export function maskDeepLinkApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return "••••••••";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function assertNoControlChars(value: string, label: string): string {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new DeepLinkImportError(`${label} contains disallowed control characters`, 400, "invalid_deep_link_characters");
  }
  return value;
}

function validateStringField(value: unknown, label: string, maxLength = 2048): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new DeepLinkImportError(`${label} must be a string`, 400, "invalid_deep_link_field");
  }
  assertNoControlChars(value, label);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new DeepLinkImportError(`${label} exceeds maximum length (${maxLength})`, 400, "invalid_deep_link_field");
  }
  return trimmed;
}

function parseBooleanish(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") return false;
  }
  throw new DeepLinkImportError(`${label} must be a boolean`, 400, "invalid_deep_link_field");
}

function parseModelsList(raw: unknown): string[] {
  let items: string[] = [];
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    assertNoControlChars(raw, "models");
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new DeepLinkImportError("models JSON array is malformed", 400, "invalid_deep_link_models");
      }
      if (!Array.isArray(parsed)) {
        throw new DeepLinkImportError("models must be an array of strings", 400, "invalid_deep_link_models");
      }
      items = parsed.map((entry, idx) => {
        if (typeof entry !== "string") {
          throw new DeepLinkImportError(`models[${idx}] must be a string`, 400, "invalid_deep_link_models");
        }
        return assertNoControlChars(entry, `models[${idx}]`).trim();
      });
    } else {
      items = trimmed.split(",").map(s => assertNoControlChars(s, "models").trim());
    }
  } else if (Array.isArray(raw)) {
    items = raw.map((entry, idx) => {
      if (typeof entry !== "string") {
        throw new DeepLinkImportError(`models[${idx}] must be a string`, 400, "invalid_deep_link_models");
      }
      return assertNoControlChars(entry, `models[${idx}]`).trim();
    });
  } else {
    throw new DeepLinkImportError("models must be a comma-separated string or array", 400, "invalid_deep_link_models");
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of items) {
    if (!id) continue;
    if (id.length > 256) {
      throw new DeepLinkImportError(`model id exceeds maximum length: ${id.slice(0, 32)}`, 400, "invalid_deep_link_models");
    }
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  if (deduped.length > MAX_IMPORTED_MODELS) {
    throw new DeepLinkImportError(
      `models count (${deduped.length}) exceeds limit of ${MAX_IMPORTED_MODELS}`,
      400,
      "invalid_deep_link_models",
    );
  }
  return deduped;
}

function decodeBase64UrlPayload(encoded: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+=*$/.test(encoded)) {
    throw new DeepLinkImportError("payload parameter is not valid base64url", 400, "invalid_deep_link_payload");
  }
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.byteLength === 0) {
    throw new DeepLinkImportError("payload parameter decoded empty", 400, "invalid_deep_link_payload");
  }
  if (decoded.byteLength > MAX_DECODED_PAYLOAD_BYTES) {
    throw new DeepLinkImportError(
      `decoded payload exceeds limit of ${MAX_DECODED_PAYLOAD_BYTES} bytes`,
      400,
      "deep_link_too_large",
    );
  }
  try {
    assertJsonNestingDepth(decoded, MAX_DEEP_LINK_JSON_DEPTH);
  } catch (error) {
    if (error instanceof JsonNestingDepthExceededError) {
      throw new DeepLinkImportError(error.message, 400, "deep_link_depth_exceeded");
    }
    throw error;
  }
  const text = decoded.toString("utf8");
  assertNoControlChars(text, "payload");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeepLinkImportError("decoded payload is not valid JSON", 400, "invalid_deep_link_payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeepLinkImportError("decoded payload must be a JSON object", 400, "invalid_deep_link_payload");
  }
  return parsed as Record<string, unknown>;
}

export function parseProviderDeepLink(rawUrl: string): ParsedDeepLinkProvider {
  if (typeof rawUrl !== "string") {
    throw new DeepLinkImportError("Deep link URL must be a string", 400, "invalid_deep_link");
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new DeepLinkImportError("Deep link URL is required", 400, "invalid_deep_link");
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_EPX_DEEP_LINK_BYTES) {
    throw new DeepLinkImportError(
      `Deep link URL exceeds limit of ${MAX_EPX_DEEP_LINK_BYTES} bytes`,
      400,
      "deep_link_too_large",
    );
  }
  assertNoControlChars(trimmed, "URL");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new DeepLinkImportError("Invalid epx:// deep link URL", 400, "invalid_deep_link");
  }
  if (parsedUrl.protocol !== "epx:") {
    throw new DeepLinkImportError("Deep link must use the epx:// scheme", 400, "invalid_deep_link_scheme");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
    throw new DeepLinkImportError("Deep link URL must not contain userinfo or fragments", 400, "invalid_deep_link");
  }
  const schemeHost = parsedUrl.hostname.toLowerCase();
  if (schemeHost !== "provider" && schemeHost !== "import") {
    throw new DeepLinkImportError(`Unsupported epx:// target "${parsedUrl.hostname}"; expected provider or import`, 400, "invalid_deep_link_host");
  }
  if (parsedUrl.pathname && parsedUrl.pathname !== "/" && parsedUrl.pathname !== "") {
    throw new DeepLinkImportError("Unexpected path on epx:// deep link", 400, "invalid_deep_link");
  }

  let data: Record<string, unknown> = {};
  const payloadParam = parsedUrl.searchParams.get("payload");
  if (payloadParam !== null) {
    data = decodeBase64UrlPayload(payloadParam);
  }

  for (const [k, v] of parsedUrl.searchParams.entries()) {
    if (k === "payload") continue;
    assertNoControlChars(k, "query key");
    assertNoControlChars(v, `query param ${k}`);
    if (data[k] === undefined) {
      data[k] = v;
    }
  }

  const name = validateStringField(data.name ?? data.id, "name", 64);
  if (!name || !isValidProviderName(name)) {
    throw new DeepLinkImportError(
      "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved key",
      400,
      "invalid_provider_name",
    );
  }

  const adapter = validateStringField(data.adapter, "adapter", 64);
  if (!adapter) {
    throw new DeepLinkImportError("adapter is required in deep link", 400, "missing_adapter");
  }

  // Enforce CLI_CONSENT.md ToS / OAuth boundary before network or endpoint checks.
  const rawAuthMode = validateStringField(data.authMode ?? data.auth_mode, "authMode", 32);
  const rawGoogleMode = validateStringField(data.googleMode ?? data.google_mode, "googleMode", 32);
  if (
    name.toLowerCase() === "antigravity"
    || name.toLowerCase() === "google-antigravity"
    || adapter === "agy-acp"
    || rawGoogleMode === "cloud-code-assist"
    || rawAuthMode === "oauth"
  ) {
    throw new DeepLinkImportError(
      "Refused ToS-gated OAuth / Antigravity deep link import; interactive user consent is required.",
      400,
      "antigravity_import_refused",
    );
  }

  if (!SUPPORTED_ADAPTERS.has(adapter)) {
    throw new DeepLinkImportError(`Unsupported adapter: ${adapter}`, 400, "unsupported_adapter");
  }

  const baseUrl = validateStringField(data.baseUrl ?? data.base_url ?? data.endpoint, "baseUrl", 2048);
  if (!baseUrl) {
    throw new DeepLinkImportError("baseUrl is required in deep link", 400, "missing_base_url");
  }

  const baseErr = providerBaseUrlConfigError(baseUrl);
  if (baseErr) {
    throw new DeepLinkImportError(baseErr, 400, "invalid_base_url");
  }

  let authMode: "key" | "forward" | "local" | undefined;
  if (rawAuthMode !== undefined) {
    if (rawAuthMode !== "key" && rawAuthMode !== "forward" && rawAuthMode !== "local") {
      throw new DeepLinkImportError(`Unsupported authMode: ${rawAuthMode}`, 400, "invalid_auth_mode");
    }
    authMode = rawAuthMode;
  }

  let apiKeyTransport: "x-api-key" | "bearer" | undefined;
  const rawTransport = validateStringField(data.apiKeyTransport ?? data.api_key_transport, "apiKeyTransport", 32);
  if (rawTransport !== undefined) {
    if (rawTransport !== "x-api-key" && rawTransport !== "bearer") {
      throw new DeepLinkImportError(`Unsupported apiKeyTransport: ${rawTransport}`, 400, "invalid_transport");
    }
    apiKeyTransport = rawTransport;
  }

  let googleMode: "ai-studio" | "vertex" | undefined;
  if (rawGoogleMode !== undefined) {
    if (rawGoogleMode !== "ai-studio" && rawGoogleMode !== "vertex") {
      throw new DeepLinkImportError(`Unsupported googleMode: ${rawGoogleMode}`, 400, "invalid_google_mode");
    }
    googleMode = rawGoogleMode;
  }

  const apiKey = validateStringField(data.apiKey ?? data.api_key, "apiKey", 1024);
  const defaultModel = validateStringField(data.defaultModel ?? data.default_model ?? data.model, "defaultModel", 256);
  const note = validateStringField(data.note, "note", 512);
  const models = parseModelsList(data.models);
  const urlRequestedPrivateNetwork = parseBooleanish(
    data.allowPrivateNetwork ?? data.allow_private_network,
    "allowPrivateNetwork",
  );

  return {
    schemeHost,
    name,
    adapter,
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(authMode !== undefined ? { authMode } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(apiKeyTransport !== undefined ? { apiKeyTransport } : {}),
    ...(googleMode !== undefined ? { googleMode } : {}),
    urlRequestedPrivateNetwork,
  };
}

async function evaluateDestinationPolicy(
  parsed: ParsedDeepLinkProvider,
  callerAllowsPrivate: boolean,
  lookupDns?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<{
  requiresPrivateNetworkOptIn: boolean;
  privateNetworkOptInGranted: boolean;
  blockedReason: string | null;
}> {
  const literal = assessUrlDestination(parsed.baseUrl);
  if (!literal) {
    throw new DeepLinkImportError("Invalid baseUrl", 400, "invalid_base_url");
  }
  if (literal.kind === "metadata" || literal.kind === "link-local" || literal.kind === "unspecified") {
    throw new DeepLinkImportError(
      `baseUrl targets a blocked ${literal.detail} and is unconditionally forbidden`,
      400,
      "blocked_destination",
    );
  }

  const literalPrivate = literal.kind === "localhost" || literal.kind === "loopback" || literal.kind === "private";
  let dnsPrivate = false;

  let hostname = "";
  try {
    hostname = new URL(parsed.baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    hostname = "";
  }

  if (hostname && isIP(hostname) === 0 && hostname !== "localhost" && !hostname.endsWith(".localhost")) {
    const resolver = lookupDns ?? (host => dnsLookup(host, { all: true, verbatim: true }));
    let resolvedList: Array<{ address: string; family: number }> = [];
    try {
      const resolved = await resolver(hostname);
      resolvedList = Array.isArray(resolved) ? resolved : [];
    } catch {
      resolvedList = [];
    }
    for (const entry of resolvedList) {
      const address = entry?.address;
      if (typeof address !== "string") continue;
      const probe = assessUrlDestination(isIP(address) === 6 ? `https://[${address}]/` : `https://${address}/`);
      if (!probe || probe.kind === "public") continue;
      if (probe.kind === "metadata" || probe.kind === "link-local" || probe.kind === "unspecified") {
        throw new DeepLinkImportError(
          `baseUrl hostname resolves to blocked ${probe.detail} (${address})`,
          400,
          "blocked_destination",
        );
      }
      dnsPrivate = true;
    }
  }

  // Synchronous literal/scheme check when no test resolver is injected (single DNS pass above already inspected A/AAAA).
  if (!lookupDns) {
    const syncDestErr = providerDestinationConfigError(parsed.name, {
      baseUrl: parsed.baseUrl,
      allowPrivateNetwork: callerAllowsPrivate,
    });
    if (syncDestErr && !literalPrivate) {
      throw new DeepLinkImportError(syncDestErr, 400, "blocked_destination");
    }
  }

  const requiresPrivateNetworkOptIn = parsed.urlRequestedPrivateNetwork || literalPrivate || dnsPrivate;
  const privateNetworkOptInGranted = !requiresPrivateNetworkOptIn || callerAllowsPrivate;
  const blockedReason = requiresPrivateNetworkOptIn && !callerAllowsPrivate
    ? "Target points to a private/loopback address or requests private-network access; explicit allowPrivateNetwork opt-in is required."
    : null;

  return {
    requiresPrivateNetworkOptIn,
    privateNetworkOptInGranted,
    blockedReason,
  };
}

function buildProviderCandidate(parsed: ParsedDeepLinkProvider, allowPrivateNetwork: boolean): EpxProviderConfig {
  return {
    adapter: parsed.adapter,
    baseUrl: parsed.baseUrl,
    ...(parsed.apiKey !== undefined ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.defaultModel !== undefined ? { defaultModel: parsed.defaultModel } : {}),
    ...(parsed.models && parsed.models.length > 0 ? { models: [...parsed.models] } : {}),
    ...(parsed.authMode !== undefined ? { authMode: parsed.authMode } : {}),
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    ...(parsed.apiKeyTransport !== undefined ? { apiKeyTransport: parsed.apiKeyTransport } : {}),
    ...(parsed.googleMode !== undefined ? { googleMode: parsed.googleMode } : {}),
    ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  };
}

export async function previewProviderDeepLink(
  rawUrl: string,
  options: DeepLinkImportOptions = {},
): Promise<ProviderDeepLinkPreviewResult> {
  const parsed = parseProviderDeepLink(rawUrl);
  const callerAllowsPrivate = options.allowPrivateNetwork === true;
  const policy = await evaluateDestinationPolicy(parsed, callerAllowsPrivate, options.lookupDns);

  const existingProviders = options.existingProviders ?? readConfigDiagnostics({ passive: true }).config.providers;
  const conflict = hasOwnProvider(existingProviders, parsed.name);

  const candidate = buildProviderCandidate(parsed, policy.requiresPrivateNetworkOptIn && callerAllowsPrivate);
  const candidateErr = policy.privateNetworkOptInGranted
    ? providerManagementConfigError(parsed.name, candidate)
    : null;
  if (candidateErr) {
    throw new DeepLinkImportError(candidateErr, 400, "invalid_provider_config");
  }

  const warnings: string[] = [];
  if (parsed.urlRequestedPrivateNetwork && !callerAllowsPrivate) {
    warnings.push("URL requested allowPrivateNetwork=true, which is ignored until you explicitly opt in.");
  }
  if (conflict && !options.overwrite) {
    warnings.push(`Provider "${parsed.name}" already exists; enable overwrite to replace it.`);
  }

  let blockedReason = policy.blockedReason;
  if (!blockedReason && conflict && !options.overwrite) {
    blockedReason = `Provider "${parsed.name}" already exists.`;
  }

  return {
    schemaVersion: 1,
    schemeHost: parsed.schemeHost,
    name: parsed.name,
    adapter: parsed.adapter,
    baseUrl: parsed.baseUrl,
    defaultModel: parsed.defaultModel ?? null,
    models: parsed.models ?? [],
    authMode: parsed.authMode ?? null,
    note: parsed.note ?? null,
    apiKeyTransport: parsed.apiKeyTransport ?? null,
    hasApiKey: parsed.apiKey !== undefined,
    maskedApiKey: parsed.apiKey ? maskDeepLinkApiKey(parsed.apiKey) : null,
    urlRequestedPrivateNetwork: parsed.urlRequestedPrivateNetwork,
    requiresPrivateNetworkOptIn: policy.requiresPrivateNetworkOptIn,
    privateNetworkOptInGranted: policy.privateNetworkOptInGranted,
    conflict,
    canImport: policy.privateNetworkOptInGranted && (!conflict || options.overwrite === true),
    blockedReason,
    warnings,
  };
}

export async function applyProviderDeepLink(
  rawUrl: string,
  options: DeepLinkImportOptions = {},
): Promise<ProviderDeepLinkApplyResult> {
  const parsed = parseProviderDeepLink(rawUrl);
  const callerAllowsPrivate = options.allowPrivateNetwork === true;
  const policy = await evaluateDestinationPolicy(parsed, callerAllowsPrivate, options.lookupDns);

  if (policy.requiresPrivateNetworkOptIn && !callerAllowsPrivate) {
    throw new DeepLinkImportError(
      "Private-network destination requires explicit caller allowPrivateNetwork: true opt-in.",
      400,
      "private_network_opt_in_required",
    );
  }

  const candidate = buildProviderCandidate(parsed, policy.requiresPrivateNetworkOptIn && callerAllowsPrivate);
  const mgmtErr = providerManagementConfigError(parsed.name, candidate);
  if (mgmtErr) {
    throw new DeepLinkImportError(mgmtErr, 400, "invalid_provider_config");
  }

  let overwrote = false;
  let persistedConfigSnapshot: EpxConfig | undefined;

  const outcome = await withConfigDirHardeningSettled(getConfigDir(), () => mutatePersistedConfig(config => {
    const exists = hasOwnProvider(config.providers, parsed.name);
    if (exists && options.overwrite !== true) {
      throw new DeepLinkImportError(`Provider "${parsed.name}" already exists`, 409, "provider_exists");
    }
    const nsErr = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, parsed.name);
    if (nsErr) {
      throw new DeepLinkImportError(nsErr, 409, "codex_namespace_collision");
    }
    overwrote = exists;
    config.providers[parsed.name] = structuredClone(candidate);
    if (options.setDefault === true) {
      config.defaultProvider = parsed.name;
    }
    const validation = validateConfigCandidate(config);
    if (!validation.ok) {
      throw new DeepLinkImportError(validation.error, 400, "invalid_provider_config");
    }
    persistedConfigSnapshot = structuredClone(config);
    return { changed: true, value: undefined };
  }));

  if (outcome.status === "unavailable" || !persistedConfigSnapshot) {
    throw new DeepLinkImportError("Configuration is unavailable for provider import", 503, "config_unavailable");
  }

  options.onCommitted?.(structuredClone(candidate), persistedConfigSnapshot);

  return {
    schemaVersion: 1,
    name: parsed.name,
    adapter: parsed.adapter,
    baseUrl: parsed.baseUrl,
    defaultModel: parsed.defaultModel ?? null,
    models: parsed.models ?? [],
    hasApiKey: parsed.apiKey !== undefined,
    maskedApiKey: parsed.apiKey ? maskDeepLinkApiKey(parsed.apiKey) : null,
    allowPrivateNetwork: Boolean(candidate.allowPrivateNetwork),
    overwrote,
  };
}

export function buildProviderShareDeepLink(
  name: string,
  provider: Pick<
    EpxProviderConfig,
    "adapter" | "baseUrl" | "defaultModel" | "models" | "authMode" | "note" | "apiKeyTransport"
  > & {
    apiKey?: unknown;
    apiKeyPool?: unknown;
    headers?: unknown;
  },
): string {
  if (!isValidProviderName(name)) {
    throw new DeepLinkImportError(`Invalid provider name: ${name}`, 400, "invalid_provider_name");
  }
  if (!provider.adapter || !SUPPORTED_ADAPTERS.has(provider.adapter)) {
    throw new DeepLinkImportError(`Unsupported adapter: ${String(provider.adapter)}`, 400, "unsupported_adapter");
  }
  const baseErr = providerBaseUrlConfigError(provider.baseUrl);
  if (baseErr) {
    throw new DeepLinkImportError(baseErr, 400, "invalid_base_url");
  }

  const params = new URLSearchParams();
  params.set("name", name);
  params.set("adapter", provider.adapter);
  params.set("baseUrl", provider.baseUrl);
  if (typeof provider.defaultModel === "string" && provider.defaultModel.trim()) {
    params.set("defaultModel", provider.defaultModel.trim());
  }
  if (Array.isArray(provider.models) && provider.models.length > 0) {
    const safeModels = provider.models
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .slice(0, MAX_IMPORTED_MODELS);
    if (safeModels.length > 0) {
      params.set("models", safeModels.join(","));
    }
  }
  if (provider.authMode === "key" || provider.authMode === "forward" || provider.authMode === "local") {
    params.set("authMode", provider.authMode);
  }
  if (provider.apiKeyTransport === "x-api-key" || provider.apiKeyTransport === "bearer") {
    params.set("apiKeyTransport", provider.apiKeyTransport);
  }
  if (typeof provider.note === "string" && provider.note.trim() && !CONTROL_CHAR_PATTERN.test(provider.note)) {
    params.set("note", provider.note.trim().slice(0, 512));
  }

  const deepLink = `epx://provider?${params.toString()}`;
  if (Buffer.byteLength(deepLink, "utf8") > MAX_EPX_DEEP_LINK_BYTES) {
    throw new DeepLinkImportError("Generated share URL exceeds 8192 bytes", 400, "deep_link_too_large");
  }
  return deepLink;
}
