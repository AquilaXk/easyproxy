import { getValidAccessToken } from "../oauth/index";
import { isProviderApiKeyPaused, ProviderApiKeyPausedError } from "../providers/api-key-pause";
import { resolveCurrentProviderApiKeyTransport } from "../providers/api-key-selection";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-forward-destination";
import { signalWithTimeout } from "../lib/abort";
import { authorizationCredential } from "../lib/authorization-scheme";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { isLocalUpstream } from "../lib/local-upstream";
import { redactSecretString } from "../lib/redact";
import { providerConnectTimeoutMs, providerStallTimeoutSec, resolveConnectTimeoutMs, resolveStallTimeoutMs } from "../stall-timeout";
import type { EpxConfig, EpxProviderConfig } from "../types";
import { isProxyAdmissionSecret, validateForwardAdmissionCredential } from "./auth-cors";
import { fetchWithHeaderTimeout } from "./responses/fetch-helpers";
import type { RequestLogContext } from "./request-log";

export const SUPPORTED_AUXILIARY_ADAPTERS = new Set(["openai-responses", "openai-chat"]);

export function adapterSupportsAuxiliaryEndpoint(
  provider: Pick<EpxProviderConfig, "adapter" | "authMode" | "baseUrl">,
): boolean {
  if (!SUPPORTED_AUXILIARY_ADAPTERS.has(provider.adapter)) return false;
  if (isCanonicalOpenAiForwardProvider(provider as EpxProviderConfig)) return false;
  return Boolean(provider.baseUrl && provider.baseUrl.trim().length > 0);
}

export interface AuxiliaryUpstreamAuthError {
  status: number;
  errorType: "authentication_error" | "permission_error";
  message: string;
  code: string;
  shouldFailover: boolean;
}

export async function resolveAuxiliaryUpstreamHeaders(
  req: Request,
  config: EpxConfig,
  candidate: { providerName: string; provider: EpxProviderConfig },
  logCtx: RequestLogContext,
): Promise<{ headers: Headers } | { error: AuxiliaryUpstreamAuthError }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (candidate.provider.headers) {
    for (const [k, v] of Object.entries(candidate.provider.headers)) {
      headers.set(k, v);
    }
  }

  if (candidate.provider.authMode === "oauth") {
    let token: string | null = null;
    try {
      token = await getValidAccessToken(candidate.providerName);
    } catch {
      token = null;
    }
    if (!token) {
      return {
        error: {
          status: 401,
          errorType: "authentication_error",
          message: `OAuth access token unavailable for provider ${candidate.providerName}`,
          code: "oauth_token_unavailable",
          shouldFailover: true,
        },
      };
    }
    headers.set("authorization", `Bearer ${token}`);
  } else if (candidate.provider.authMode === "forward") {
    const callerBearer = authorizationCredential(req.headers);
    if (callerBearer) {
      if (isProxyAdmissionSecret(callerBearer, config)) {
        return {
          error: {
            status: 401,
            errorType: "authentication_error",
            message: "EasyProxy admission credentials cannot be forwarded upstream",
            code: "forward_credential_rejected",
            shouldFailover: false,
          },
        };
      }
      headers.set("authorization", `Bearer ${callerBearer}`);
    } else if (headers.has("authorization")) {
      try {
        validateForwardAdmissionCredential(headers, config);
      } catch {
        return {
          error: {
            status: 401,
            errorType: "authentication_error",
            message: "EasyProxy admission credentials cannot be forwarded upstream",
            code: "forward_credential_rejected",
            shouldFailover: false,
          },
        };
      }
    } else if (!candidate.provider.keyOptional) {
      return {
        error: {
          status: 401,
          errorType: "authentication_error",
          message: `Caller bearer credential required for forward-auth provider ${candidate.providerName}`,
          code: "forward_authorization_required",
          shouldFailover: true,
        },
      };
    }
  } else {
    if (isProviderApiKeyPaused(candidate.provider)) {
      return {
        error: {
          status: 403,
          errorType: "permission_error",
          message: new ProviderApiKeyPausedError().message,
          code: "provider_key_paused",
          shouldFailover: true,
        },
      };
    }
    const transport = resolveCurrentProviderApiKeyTransport(config, candidate.providerName, candidate.provider);
    if (!transport) {
      if (candidate.provider.keyOptional) {
        if (candidate.provider.apiKey) headers.set("authorization", `Bearer ${candidate.provider.apiKey}`);
      } else {
        return {
          error: {
            status: 403,
            errorType: "permission_error",
            message: `no active API key available for provider ${candidate.providerName}`,
            code: "provider_key_unavailable",
            shouldFailover: true,
          },
        };
      }
    } else if (transport.apiKey) {
      headers.set("authorization", `Bearer ${transport.apiKey}`);
    }
  }

  if (logCtx.otlpSpan?.traceparent && !headers.has("traceparent")) {
    headers.set("traceparent", logCtx.otlpSpan.traceparent);
  }
  return { headers };
}

export type AuxiliaryUpstreamFetchOutcome =
  | { kind: "response"; upstreamRes: Response; bytes: Uint8Array }
  | { kind: "oversized" }
  | { kind: "redirect"; status: number }
  | { kind: "client_cancel" }
  | { kind: "fetch_error"; message: string };

/**
 * Dispatches an auxiliary POST request with independent Phase 1 header-arrival
 * (`connectTimeoutMs`) and Phase 2 response-body deadlines so a tight connect
 * timeout never prematurely aborts a streaming or slow-to-buffer response body.
 */
export async function sendAuxiliaryUpstreamRequest(params: {
  url: string;
  headers: Headers;
  payload: Record<string, unknown>;
  reqSignal: AbortSignal;
  fetchImpl: typeof globalThis.fetch;
  config: EpxConfig;
  provider: EpxProviderConfig;
  maxResponseBytes: number;
  defaultBodyTimeoutMs: number;
  onAttemptStart?: () => void;
}): Promise<AuxiliaryUpstreamFetchOutcome> {
  const {
    url,
    headers,
    payload,
    reqSignal,
    fetchImpl,
    config,
    provider,
    maxResponseBytes,
    defaultBodyTimeoutMs,
    onAttemptStart,
  } = params;

  const localUpstream = isLocalUpstream(url);
  const configuredConnect = providerConnectTimeoutMs(config, provider);
  const headerTimeoutMs = configuredConnect !== undefined
    ? resolveConnectTimeoutMs(configuredConnect, { localUpstream })
    : localUpstream
      ? defaultBodyTimeoutMs
      : Math.min(resolveConnectTimeoutMs(undefined, { localUpstream: false }), defaultBodyTimeoutMs);

  const configuredStallMs = resolveStallTimeoutMs(providerStallTimeoutSec(config, provider), { localUpstream });
  const effectiveBodyTimeoutMs = configuredStallMs > 0 ? configuredStallMs : defaultBodyTimeoutMs;

  let bodyDeadline: ReturnType<typeof signalWithTimeout> | undefined;
  let upstreamRes: Response | undefined;
  try {
    onAttemptStart?.();
    upstreamRes = await fetchWithHeaderTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
      reqSignal,
      headerTimeoutMs,
      false,
      fetchImpl,
    );

    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      if (upstreamRes.body && !upstreamRes.body.locked) {
        void upstreamRes.body.cancel().catch(() => undefined);
      }
      return { kind: "redirect", status: upstreamRes.status };
    }

    bodyDeadline = signalWithTimeout(effectiveBodyTimeoutMs, reqSignal);
    const bytesResult = await readBoundedResponseBytes(upstreamRes, {
      maxBytes: maxResponseBytes,
      signal: bodyDeadline.signal,
    });
    if (bytesResult.oversized) {
      return { kind: "oversized" };
    }
    return { kind: "response", upstreamRes, bytes: bytesResult.bytes };
  } catch (error) {
    if (reqSignal.aborted) {
      return { kind: "client_cancel" };
    }
    return {
      kind: "fetch_error",
      message: redactSecretString(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    bodyDeadline?.cleanup();
  }
}
