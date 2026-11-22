import { formatClientRetryAfter } from "../../lib/client-retry-after";
import { CodexInstallationIdUnavailableError } from "../../codex/installation-id";
import { capturePoolQuotaWriter, forceRefreshCodexPoolToken, TokenRefreshError } from "../../codex/account-store";
import { formatErrorResponse } from "../../bridge";
import { resolveProviderApiKey } from "../../providers/key-store";
import { FORWARD_HEADERS } from "../../adapters/openai-responses";
import type { CodexAccountMode, EpxConfig, EpxProviderConfig } from "../../types";
import {
  applyCodexAuthContextToProvider,
  CodexMainProfileDrainingError,
  headersForCodexAuthContext,
  materializeCodexUpstreamAuthAsync,
  releaseCodexAuthContextProbeLease,
  resolveCodexAuthContext,
  stripCodexRuntimeProviderFields,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  forceRefreshMainAccountToken,
  mainAccountTokenQuotaWriter,
  type NativeMainRefreshDependencies,
} from "../../codex/main-account";
import { handOffThreadAffinityGeneration } from "../../codex/routing";
import { hasForwardableCodexBearer, type DataPlaneAdmission } from "../auth-cors";
import { codexAccountSelectionForTurn } from "../lifecycle";
import type { AdmissionLease } from "../../lib/admission";
import { CompactResponseTooLargeError, readCompactResponseBytes } from "./compact-response-body";
import { rebindPoolCreditPolicy } from "../../codex/pool-credit-policy";
import { clientCancelledResponse } from "./core-errors";
import { poolCredentialRefreshIncompleteResponse } from "./core";
import { mapCodexAuthContextErrorToResponse, nativeMainRefreshFailureResponse } from "./codex-auth-error";

export interface CompactContextRefreshOptions {
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
}

export function compactResponseTooLargeError(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "Compact response exceeded 32 MiB",
      type: "compact_response_too_large",
      code: "compact_response_too_large",
    },
  }), { status: 502, headers: { "Content-Type": "application/json" } });
}

export async function refreshNativeMainCompactContext(args: {
  req: Request;
  config: EpxConfig;
  modelId?: string;
  admission?: DataPlaneAdmission;
  authCtx: CodexAuthContext;
  provider: EpxProviderConfig;
  codexAccountMode?: CodexAccountMode;
  substituteMainCredential: boolean;
  options: CompactContextRefreshOptions;
}): Promise<
  | { ok: true; authCtx: CodexAuthContext; provider: EpxProviderConfig; headers: Headers }
  | { ok: false; response: Response }
> {
  const { req, config, authCtx, provider, codexAccountMode, substituteMainCredential, options } = args;
  if (authCtx.kind !== "main-pool") {
    return { ok: false, response: formatErrorResponse(401, "authentication_error", "No native main credential to refresh") };
  }
  try {
    const refreshed = await forceRefreshMainAccountToken(authCtx.accessToken, {
      signal: req.signal,
      ...(options.nativeMainRefreshDependencies ?? {}),
    });
    if (!refreshed) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", "Codex main account needs reauthentication") };
    }
    const refreshedAuthCtx: CodexAuthContext = {
      ...authCtx,
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
      mainQuotaWriter: mainAccountTokenQuotaWriter(refreshed) ?? authCtx.mainQuotaWriter,
    };
    const refreshedProvider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(provider),
      refreshedAuthCtx,
      codexAccountMode,
    );
    const headers = new Headers({ "content-type": "application/json" });
    const selected = await materializeCodexUpstreamAuthAsync(req.headers, refreshedAuthCtx, {
      admission: args.admission,
      config,
      modelId: args.modelId,
      substituteMainCredential,
      signal: req.signal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    for (const name of FORWARD_HEADERS) {
      const value = selected.get(name);
      if (value !== null) headers.set(name, value);
    }
    const override = (refreshedProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
    if (override) {
      headers.set("authorization", `Bearer ${override.accessToken}`);
      headers.set("chatgpt-account-id", override.chatgptAccountId);
    }
    return { ok: true, authCtx: refreshedAuthCtx, provider: refreshedProvider, headers };
  } catch (error) {
    if (req.signal.aborted) {
      return { ok: false, response: formatErrorResponse(499, "client_cancelled", "Client cancelled compact request") };
    }
    return {
      ok: false,
      response: mapCodexAuthContextErrorToResponse(error, {
        now: Date.now(),
      }) ?? nativeMainRefreshFailureResponse(error),
    };
  }
}

/** See the core counterpart: only a dead grant is terminal (#2887). */
function isTerminalCompactPoolRefreshFailure(error: unknown): boolean {
  return error instanceof TokenRefreshError && (error.reason === "revoked" || error.reason === "expired");
}

/**
 * Compact's forced refresh for an ordinary stored pool credential rejected with a
 * pre-stream 401. Mirrors {@link refreshNativeMainCompactContext} so the two 401
 * contracts on this endpoint cannot drift.
 */
export async function refreshPoolCompactContext(args: {
  req: Request;
  config: EpxConfig;
  modelId?: string;
  admission?: DataPlaneAdmission;
  authCtx: CodexAuthContext & { kind: "pool" };
  provider: EpxProviderConfig;
  codexAccountMode?: CodexAccountMode;
  /**
   * Public selector for the account this refresh is for, when the request carried one. The
   * caller has it and this function does not, because compact takes no `RouteResult` — which
   * is the whole reason the refusal here used to be less specific than the one core returns
   * for the identical failure.
   */
  codexAccountNamespace?: string;
  substituteMainCredential: boolean;
  options: CompactContextRefreshOptions;
}): Promise<
  | { ok: true; authCtx: CodexAuthContext; provider: EpxProviderConfig; headers: Headers }
  | { ok: false; response: Response; quarantine: boolean; quarantineGeneration?: number }
> {
  const { req, config, authCtx, provider, codexAccountMode, substituteMainCredential, options } = args;
  const reauthResponse = () => formatErrorResponse(
    401,
    "authentication_error",
    "Selected Codex account needs reauthentication",
  );
  try {
    const refreshed = await forceRefreshCodexPoolToken(authCtx.accountId, {
      rejectedGeneration: authCtx.generation,
      rejectedAccessToken: authCtx.accessToken,
      signal: req.signal,
    });
    // See the core counterpart: a successful response can rotate only the refresh grant,
    // so the credential may already sit at a later generation than the one we rejected.
    if (!refreshed.rotated) {
      return { ok: false, quarantine: true, quarantineGeneration: refreshed.generation, response: reauthResponse() };
    }
    if (refreshed.selfRefreshed) {
      handOffThreadAffinityGeneration(authCtx.accountId, authCtx.generation, refreshed.generation);
    }
    const refreshedAuthCtx: CodexAuthContext = {
      ...authCtx,
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
      generation: refreshed.generation,
      poolQuotaWriter: capturePoolQuotaWriter(authCtx.accountId, refreshed),
    };
    // See the core counterpart: the spread dropped the WeakMap-bound credit policy, so a hold
    // or opt-out landing during the refresh await would go unchecked on the copy.
    rebindPoolCreditPolicy(authCtx, refreshedAuthCtx);
    const refreshedProvider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(provider),
      refreshedAuthCtx,
      codexAccountMode,
    );
    const headers = new Headers({ "content-type": "application/json" });
    const selected = await materializeCodexUpstreamAuthAsync(req.headers, refreshedAuthCtx, {
      admission: args.admission,
      config,
      modelId: args.modelId,
      substituteMainCredential,
      signal: req.signal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    for (const name of FORWARD_HEADERS) {
      const value = selected.get(name);
      if (value !== null) headers.set(name, value);
    }
    const override = (refreshedProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
    if (override) {
      headers.set("authorization", `Bearer ${override.accessToken}`);
      headers.set("chatgpt-account-id", override.chatgptAccountId);
    }
    return { ok: true, authCtx: refreshedAuthCtx, provider: refreshedProvider, headers };
  } catch (error) {
    if (isTerminalCompactPoolRefreshFailure(error)) {
      return { ok: false, quarantine: true, response: reauthResponse() };
    }
    if (req.signal.aborted) {
      return { ok: false, quarantine: false, response: clientCancelledResponse() };
    }
    // See the core counterpart: a policy refusal raised after a successful refresh maps like
    // the admission path — a reset-bound 429, never a 503 mislabeled as a refresh failure.
    const policyResponse = mapCodexAuthContextErrorToResponse(error, {
      now: Date.now(),
      accountSelector: args.codexAccountNamespace,
    });
    if (policyResponse) return { ok: false, quarantine: false, response: policyResponse };
    return {
      ok: false,
      quarantine: false,
      response: poolCredentialRefreshIncompleteResponse({
        authCtx,
        config,
        accountSelector: args.codexAccountNamespace,
      }),
    };
  }
}

/**
 * Resolve one eligible pool account other than `excludeAccountId`, and build everything
 * the alternate send needs. Returns null when no alternate exists or construction fails,
 * in which case the caller keeps the first account's rejection intact.
 *
 * Mirrors the auth resolution the native compact branch already does for the first
 * account, so the alternate is built the same way rather than through a second,
 * divergent path.
 */
export async function resolveAlternateCompactContext(args: {
  req: Request;
  config: EpxConfig;
  route: { provider: EpxProviderConfig; codexAccountMode?: CodexAccountMode };
  selectedModelId: string | undefined;
  excludeAccountId: string | null;
  turnAdmissionLease?: AdmissionLease;
  admission?: DataPlaneAdmission;
}): Promise<{ authCtx: CodexAuthContext; provider: EpxProviderConfig; headers: Headers } | { failure: Response } | null> {
  const { req, config, route, selectedModelId, excludeAccountId, turnAdmissionLease } = args;
  if (!route.codexAccountMode || !excludeAccountId) return null;
  let authCtx: CodexAuthContext | undefined;
  try {
    authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
      admission: args.admission,
      ...(selectedModelId ? { modelId: selectedModelId } : {}),
      excludeAccountId,
      requestScopedMainCredential: hasForwardableCodexBearer(req.headers, config),
      beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
    });
    // Caller-owned main has no Pool account id. It is still a valid one-shot alternate after a
    // stored account fails; resolveCodexAuthContext already prevents returning it when main is the
    // excluded credential.
    if (authCtx.accountId === excludeAccountId) return null;
    const provider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
    const headers = new Headers({ "content-type": "application/json" });
    const selected = headersForCodexAuthContext(req.headers, authCtx, config, selectedModelId, args.admission);
    for (const name of FORWARD_HEADERS) {
      const value = selected.get(name);
      if (value !== null) headers.set(name, value);
    }
    const override = (provider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
    if (override) {
      headers.set("authorization", `Bearer ${override.accessToken}`);
      headers.set("chatgpt-account-id", override.chatgptAccountId);
    }
    if (provider.apiKey) headers.set("authorization", `Bearer ${resolveProviderApiKey(provider.apiKey)}`);
    return { authCtx, provider, headers };
  } catch (err) {
    releaseCodexAuthContextProbeLease(authCtx);
    if (err instanceof CodexInstallationIdUnavailableError) return { failure: formatErrorResponse(503, "server_busy", err.message) };
    if (err instanceof CodexMainProfileDrainingError) {
      // The native-main fence can start after account A has already rejected the
      // request. Treat the now-fenced main profile as no alternate and preserve A's
      // real rejection instead of replacing it with a synthetic drain response.
      return null;
    }
    // No eligible alternate (all cooled, affinity expired, reauth needed) — the caller
    // returns the first account's rejection unchanged, which is today's behavior.
    return null;
  }
}

/**
 * Headers a client needs to back off correctly after a pool rejection. The buffered
 * response is rebuilt from scratch, so anything not listed here is dropped — which is
 * what silently discarded `Retry-After` and the reset hints from a 429 before.
 * Deliberately narrow: no hop-by-hop headers, no content-length (the buffered body sets
 * its own), no cookies.
 */
const COMPACT_PASSTHROUGH_HEADERS = [
  "retry-after",
  "x-codex-primary-reset-at",
  "x-codex-secondary-reset-at",
  "x-codex-tertiary-reset-at",
  // A relayed 3xx keeps its Location so the client can follow it (#914).
  "location",
];

function compactResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
  for (const name of COMPACT_PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value === null) continue;
    if (name === "retry-after") {
      // Retry advice leaves as an integer this proxy formats, never the upstream bytes.
      const advice = formatClientRetryAfter(value);
      if (advice !== undefined) headers.set(name, advice);
    } else headers.set(name, value);
  }
  return headers;
}

export async function bufferCompactResponse(
  upstream: Response,
  signal: AbortSignal,
  stallTimeoutSec?: number,
  _localUpstream?: boolean,
): Promise<Response> {
  const headers = compactResponseHeaders(upstream);
  try {
    if (signal.aborted) {
      // No reader is attached yet. Cancellation must not wait for a broken source's cleanup.
      void upstream.body?.cancel(signal.reason).catch(() => undefined);
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (!upstream.body) return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
    const bytes = await readCompactResponseBytes(upstream, signal, stallTimeoutSec);
    if (signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (error) {
    if (signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    if (error instanceof CompactResponseTooLargeError) return compactResponseTooLargeError();
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return Response.json({ error: {
        message: "Compact response body stalled",
        type: "upstream_stall_timeout",
        code: "upstream_stall_timeout",
      } }, { status: 504 });
    }
    return formatErrorResponse(502, "upstream_error", "Failed to read compact response");
  }
}
