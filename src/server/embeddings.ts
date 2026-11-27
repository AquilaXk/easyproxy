import {
  getCombo,
  NoAvailableComboTargetsError,
  noteComboFailure,
  noteComboSuccess,
  pickComboTarget,
  settleComboReprobeSuccess,
  targetKey,
} from "../combos";
import type { NormalizedComboTarget } from "../combos/types";
import { sanitizeUpstreamErrorText } from "../adapters/upstream-http-error";
import { formatErrorResponse } from "../bridge";
import { signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { markProxyError } from "../lib/client-error-body";
import { providerDestinationConfigError, providerDestinationResolvedError } from "../lib/destination-policy";
import { isTransientUpstreamStatus } from "../lib/upstream-retry";
import { getValidAccessToken } from "../oauth/index";
import { isProviderApiKeyPaused, ProviderApiKeyPausedError } from "../providers/api-key-pause";
import { resolveCurrentProviderApiKeyTransport } from "../providers/api-key-selection";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-forward-destination";
import type { EpxProviderTransport } from "../providers/xai-transport";
import { NoEligiblePolicyCandidateError, routeConcreteModel, routeModel, type RouteResult } from "../router";
import type { EpxConfig, EpxProviderConfig, EpxUsage } from "../types";
import { clientFacingModelLabel } from "../lib/error-destination";
import { AdmissionModelDeniedError, assertRouteAllowedByScope, resolveAdmissionModelScope } from "./admission-model-scope";
import { reservePreDispatchApiKeyHold } from "./api-key-budget-estimate";
import type { DataPlaneAdmission } from "./auth-cors";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";
import { applyOutboundPayloadHygiene, OUTBOUND_SECRET_BLOCKED_MESSAGE } from "./outbound-payload-hygiene";

const MAX_EMBEDDING_INPUT_ITEMS = 2_048;
const MAX_EMBEDDING_TOTAL_CHARS = 2_000_000;
const MAX_EMBEDDING_TOKEN_IDS_PER_ITEM = 32_768;
const MAX_EMBEDDINGS_RESPONSE_BYTES = 32 * 1024 * 1024;
const EMBEDDINGS_TIMEOUT_MS = 120_000;
const MAX_DIMENSIONS = 65_536;

const SUPPORTED_EMBEDDING_ADAPTERS = new Set(["openai-responses", "openai-chat", "openai-compatible"]);

type ValidatedEmbeddingsRequest = {
  model: string;
  input: string | string[] | number[] | number[][];
  encodingFormat?: "float" | "base64";
  dimensions?: number;
  user?: string;
  estimatedTokens: number;
};

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateEmbeddingsBody(raw: unknown): { ok: true; body: ValidatedEmbeddingsRequest } | { ok: false; message: string } {
  if (!isRec(raw)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 256) {
    return { ok: false, message: "model must be a non-empty string (<= 256 chars)" };
  }
  const model = raw.model.trim();
  const input = raw.input;
  let totalChars = 0;
  let estimatedTokens = 0;

  if (typeof input === "string") {
    if (input.length === 0) return { ok: false, message: "input string must not be empty" };
    if (input.length > MAX_EMBEDDING_TOTAL_CHARS) {
      return { ok: false, message: `input exceeds ${MAX_EMBEDDING_TOTAL_CHARS} characters` };
    }
    totalChars = input.length;
    estimatedTokens = Math.max(1, Math.ceil(totalChars / 4));
  } else if (Array.isArray(input)) {
    if (input.length === 0) return { ok: false, message: "input array must not be empty" };
    if (input.length > MAX_EMBEDDING_INPUT_ITEMS) {
      return { ok: false, message: `input array exceeds ${MAX_EMBEDDING_INPUT_ITEMS} items` };
    }
    const allStrings = input.every((item) => typeof item === "string");
    if (allStrings) {
      for (const item of input as string[]) {
        totalChars += item.length;
        if (totalChars > MAX_EMBEDDING_TOTAL_CHARS) {
          return { ok: false, message: `input exceeds ${MAX_EMBEDDING_TOTAL_CHARS} total characters` };
        }
      }
      estimatedTokens = Math.max(input.length, Math.ceil(totalChars / 4));
    } else if (input.every((item) => typeof item === "number")) {
      if (input.length > MAX_EMBEDDING_TOKEN_IDS_PER_ITEM) {
        return { ok: false, message: `token array items must have 1..${MAX_EMBEDDING_TOKEN_IDS_PER_ITEM} tokens` };
      }
      for (const tok of input as unknown[]) {
        if (typeof tok !== "number" || !Number.isSafeInteger(tok) || tok < 0) {
          return { ok: false, message: "token array items must contain non-negative integers" };
        }
      }
      estimatedTokens = input.length;
    } else if (input.every((item) => Array.isArray(item))) {
      for (const seq of input as unknown[][]) {
        if (seq.length === 0 || seq.length > MAX_EMBEDDING_TOKEN_IDS_PER_ITEM) {
          return { ok: false, message: `token array items must have 1..${MAX_EMBEDDING_TOKEN_IDS_PER_ITEM} tokens` };
        }
        for (const tok of seq) {
          if (typeof tok !== "number" || !Number.isSafeInteger(tok) || tok < 0) {
            return { ok: false, message: "token array items must contain non-negative integers" };
          }
        }
        estimatedTokens += seq.length;
      }
    } else {
      return { ok: false, message: "input array must contain either strings or non-empty integer token arrays" };
    }
  } else {
    return { ok: false, message: "input must be a non-empty string or array of strings/token arrays" };
  }

  let encodingFormat: "float" | "base64" | undefined;
  if (raw.encoding_format !== undefined) {
    if (raw.encoding_format !== "float" && raw.encoding_format !== "base64") {
      return { ok: false, message: "encoding_format must be \"float\" or \"base64\"" };
    }
    encodingFormat = raw.encoding_format;
  }

  let dimensions: number | undefined;
  if (raw.dimensions !== undefined) {
    if (typeof raw.dimensions !== "number" || !Number.isSafeInteger(raw.dimensions) || raw.dimensions < 1 || raw.dimensions > MAX_DIMENSIONS) {
      return { ok: false, message: `dimensions must be an integer between 1 and ${MAX_DIMENSIONS}` };
    }
    dimensions = raw.dimensions;
  }

  let user: string | undefined;
  if (raw.user !== undefined) {
    if (typeof raw.user !== "string" || raw.user.length > 256) {
      return { ok: false, message: "user must be a string <= 256 chars" };
    }
    user = raw.user;
  }

  return {
    ok: true,
    body: {
      model,
      input: input as ValidatedEmbeddingsRequest["input"],
      ...(encodingFormat ? { encodingFormat } : {}),
      ...(dimensions !== undefined ? { dimensions } : {}),
      ...(user !== undefined ? { user } : {}),
      estimatedTokens: Math.max(1, estimatedTokens),
    },
  };
}

export function resolveEmbeddingsUrl(provider: Pick<EpxProviderConfig, "baseUrl">): string {
  const trimmed = provider.baseUrl.trim();
  try {
    const parsed = new URL(trimmed);
    let path = parsed.pathname;
    while (path.endsWith("/")) path = path.slice(0, -1);
    if (!path.endsWith("/embeddings")) {
      if (path.endsWith("/responses")) path = path.slice(0, -"/responses".length);
      else if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length);
      while (path.endsWith("/")) path = path.slice(0, -1);
      path = /\/v\d+(?:alpha|beta)?$/i.test(path) ? `${path}/embeddings` : `${path}/v1/embeddings`;
    }
    parsed.pathname = path;
    return parsed.toString();
  } catch {
    let base = trimmed;
    while (base.endsWith("/")) base = base.slice(0, -1);
    if (base.endsWith("/embeddings")) return base;
    if (base.endsWith("/responses")) base = base.slice(0, -"/responses".length);
    else if (base.endsWith("/chat/completions")) base = base.slice(0, -"/chat/completions".length);
    while (base.endsWith("/")) base = base.slice(0, -1);
    if (/\/v\d+(?:alpha|beta)?$/i.test(base)) {
      return `${base}/embeddings`;
    }
    return `${base}/v1/embeddings`;
  }
}

function adapterSupportsEmbeddings(provider: Pick<EpxProviderConfig, "adapter" | "authMode" | "baseUrl">): boolean {
  if (!SUPPORTED_EMBEDDING_ADAPTERS.has(provider.adapter)) return false;
  if (isCanonicalOpenAiForwardProvider(provider as EpxProviderConfig)) return false;
  return Boolean(provider.baseUrl && provider.baseUrl.trim().length > 0);
}

interface ResolvedEmbeddingCandidate {
  providerName: string;
  modelId: string;
  provider: EpxProviderConfig;
  comboTarget?: NormalizedComboTarget;
}

function resolveEmbeddingCandidates(route: RouteResult, config: EpxConfig): ResolvedEmbeddingCandidate[] {
  const candidates: ResolvedEmbeddingCandidate[] = [
    {
      providerName: route.providerName,
      modelId: route.modelId,
      provider: route.provider,
      ...(route.combo ? { comboTarget: route.combo.target } : {}),
    },
  ];
  if (route.combo) {
    const combo = getCombo(config, route.combo.comboId);
    if (combo?.targets?.length) {
      const excluded = new Set<string>([targetKey(route.combo.target)]);
      const reprobeEntries = route.combo.cooldownReprobeTargets
        ? Object.entries(route.combo.cooldownReprobeTargets)
        : undefined;
      for (let step = 0; step < combo.targets.length; step += 1) {
        const nextPick = pickComboTarget(config, route.combo.comboId, {
          exclude: excluded,
          allowCooldownReprobe: false,
          cooldownReprobeTargets: reprobeEntries,
          preview: true,
          eligible: (target) => {
            try {
              const resolved = routeConcreteModel(config, `${target.provider}/${target.model}`);
              return resolved.provider.disabled !== true && adapterSupportsEmbeddings(resolved.provider);
            } catch {
              return false;
            }
          },
        });
        if (!nextPick) break;
        const key = targetKey(nextPick.target);
        if (excluded.has(key)) break;
        excluded.add(key);
        try {
          const resolved = routeConcreteModel(config, key);
          if (!resolved.provider.disabled) {
            candidates.push({
              providerName: resolved.providerName,
              modelId: resolved.modelId,
              provider: resolved.provider,
              comboTarget: nextPick.target,
            });
          }
        } catch {
          // Skip targets whose resolved route fails during candidate expansion.
        }
      }
    }
  }
  return candidates;
}

function releaseEmbeddingLeaseOnRefusal(logCtx: RequestLogContext, upstreamAttempted: boolean): void {
  if (upstreamAttempted) logCtx.apiKeyBudgetLease?.releaseHoldOnly();
  else logCtx.apiKeyBudgetLease?.releaseUnused();
}

function parseEmbeddingsUsage(payload: unknown, fallbackTokens: number): { usage: EpxUsage; totalTokens: number } {
  const rawUsage = isRec(payload) && isRec(payload.usage) ? payload.usage : undefined;
  const prompt = typeof rawUsage?.prompt_tokens === "number" && Number.isFinite(rawUsage.prompt_tokens) && rawUsage.prompt_tokens >= 0
    ? Math.trunc(rawUsage.prompt_tokens)
    : undefined;
  const total = typeof rawUsage?.total_tokens === "number" && Number.isFinite(rawUsage.total_tokens) && rawUsage.total_tokens >= 0
    ? Math.trunc(rawUsage.total_tokens)
    : undefined;
  const inputTokens = prompt ?? total ?? fallbackTokens;
  const totalTokens = total ?? inputTokens;
  return {
    usage: {
      inputTokens,
      outputTokens: 0,
      totalTokens,
      ...(prompt !== undefined || total !== undefined ? { upstreamReported: true as const } : { estimated: true }),
    },
    totalTokens,
  };
}

export async function handleEmbeddings(
  req: Request,
  config: EpxConfig,
  logCtx: RequestLogContext,
  options: {
    requestId: string;
    start: number;
    admission?: DataPlaneAdmission;
    onRequestBodyRead?: () => void;
  },
): Promise<Response> {
  const maxBodyBytes = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  let rawBody: unknown;
  try {
    rawBody = await readJsonRequestBody(req, undefined, maxBodyBytes);
    options.onRequestBodyRead?.();
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 400;
    const code = (error as { code?: string })?.code ?? "invalid_json";
    releaseEmbeddingLeaseOnRefusal(logCtx, false);
    markLocalRequestLogRefusal(logCtx, code);
    logCtx.errorCode = code;
    addFinalRequestLog(options.requestId, options.start, logCtx, status, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(status, status === 413 ? "request_too_large" : "invalid_request_error", error instanceof Error ? error.message : "invalid request body"));
  }

  const validated = validateEmbeddingsBody(rawBody);
  if (!validated.ok) {
    releaseEmbeddingLeaseOnRefusal(logCtx, false);
    markLocalRequestLogRefusal(logCtx, "invalid_embeddings_request");
    logCtx.errorCode = "invalid_embeddings_request";
    addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(400, "invalid_request_error", validated.message));
  }

  const parsed = validated.body;
  const hygienePayload: { input: ValidatedEmbeddingsRequest["input"]; user?: string } = {
    input: parsed.input,
    ...(parsed.user !== undefined ? { user: parsed.user } : {}),
  };
  const hygiene = applyOutboundPayloadHygiene(hygienePayload, config, logCtx);
  if (hygiene.blocked) {
    releaseEmbeddingLeaseOnRefusal(logCtx, false);
    addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(400, "invalid_request_error", OUTBOUND_SECRET_BLOCKED_MESSAGE));
  }
  const sanitized = hygiene.body as typeof hygienePayload;
  parsed.input = sanitized.input;
  if (sanitized.user !== undefined) parsed.user = sanitized.user;
  logCtx.requestedModel = parsed.model;
  let route: RouteResult;
  try {
    route = routeModel(config, parsed.model);
  } catch (error) {
    releaseEmbeddingLeaseOnRefusal(logCtx, false);
    if (error instanceof NoEligiblePolicyCandidateError) {
      logCtx.routeDecision = error.trace;
    }
    const msg = error instanceof Error ? error.message : `unknown model ${parsed.model}`;
    const isDestinationBlocked = msg.includes("baseUrl targets a blocked metadata endpoint")
      || msg.includes("baseUrl points to a ")
      || msg.includes("baseUrl must use https:");
    const isUnavailableCombo = error instanceof NoAvailableComboTargetsError;
    const status = isDestinationBlocked ? 400 : isUnavailableCombo ? 503 : 404;
    const code = isDestinationBlocked ? "destination_rejected" : isUnavailableCombo ? "combo_unavailable" : "model_not_found";
    markLocalRequestLogRefusal(logCtx, code);
    logCtx.errorCode = code;
    addFinalRequestLog(options.requestId, options.start, logCtx, status, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(status, isUnavailableCombo ? "upstream_error" : "invalid_request_error", msg));
  }

  const candidates = resolveEmbeddingCandidates(route, config);
  const admissionScope = resolveAdmissionModelScope(config, options.admission);
  const comboConfig = route.combo ? getCombo(config, route.combo.comboId) : undefined;
  const isEwmaCombo = comboConfig?.strategy === "ewma-latency";
  const recordComboFailure = (candidate: ResolvedEmbeddingCandidate): void => {
    if (!route.combo) return;
    noteComboFailure(
      route.combo.comboId,
      candidate.comboTarget ?? { provider: candidate.providerName, model: candidate.modelId },
      route.combo.writerGeneration,
      {
        recordEwma: isEwmaCombo,
        ewmaLatency: comboConfig?.ewmaLatency,
      },
    );
  };

  let upstreamAttempted = false;
  let lastErrorStatus = 502;
  let lastErrorMessage = "upstream embeddings request failed";
  let lastErrorCode = "upstream_error";

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    const hasMore = i < candidates.length - 1;
    logCtx.provider = candidate.providerName;
    logCtx.model = candidate.modelId;

    try {
      assertRouteAllowedByScope(admissionScope, clientFacingModelLabel(parsed.model, "requested"), {
        providerName: candidate.providerName,
        modelId: candidate.modelId,
      });
    } catch (error) {
      if (error instanceof AdmissionModelDeniedError) {
        releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, "api_key_scope_denied");
        logCtx.errorCode = "api_key_scope_denied";
        addFinalRequestLog(options.requestId, options.start, logCtx, 403, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(403, "permission_error", error.message));
      }
      throw error;
    }

    if (!adapterSupportsEmbeddings(candidate.provider)) {
      if (hasMore) continue;
      releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
      logCtx.errorCode = "embeddings_unsupported_provider";
      markLocalRequestLogRefusal(logCtx, "embeddings_unsupported_provider");
      addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(
        400,
        "invalid_request_error",
        `provider ${candidate.providerName} (${candidate.provider.adapter}) does not support /v1/embeddings`,
      ));
    }

    const holdRefusal = await reservePreDispatchApiKeyHold({
      req,
      config,
      logCtx,
      providerName: candidate.providerName,
      modelId: candidate.modelId,
      estimatedInputTokens: parsed.estimatedTokens,
      maxOutputTokens: 0,
      upstreamAttempted,
    });
    if (holdRefusal) {
      addFinalRequestLog(options.requestId, options.start, logCtx, 429, { closeReason: "non_stream" });
      return holdRefusal;
    }

    const syncDestErr = providerDestinationConfigError(candidate.providerName, candidate.provider);
    if (syncDestErr) {
      if (hasMore) {
        recordComboFailure(candidate);
        lastErrorStatus = 400;
        lastErrorMessage = syncDestErr;
        lastErrorCode = "destination_rejected";
        continue;
      }
      releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
      markLocalRequestLogRefusal(logCtx, "destination_rejected");
      logCtx.errorCode = "destination_rejected";
      addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(400, "invalid_request_error", syncDestErr));
    }
    const candidateTransport = candidate.provider as EpxProviderTransport;
    if (typeof candidateTransport.fetch !== "function") {
      const dnsErr = await providerDestinationResolvedError(candidate.providerName, candidate.provider);
      if (dnsErr) {
        if (hasMore) {
          recordComboFailure(candidate);
          lastErrorStatus = 400;
          lastErrorMessage = dnsErr;
          lastErrorCode = "destination_rejected";
          continue;
        }
        releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, "destination_rejected");
        logCtx.errorCode = "destination_rejected";
        addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(400, "invalid_request_error", dnsErr));
      }
    }

    const url = resolveEmbeddingsUrl(candidate.provider);
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
        recordComboFailure(candidate);
        lastErrorStatus = 401;
        lastErrorMessage = `OAuth access token unavailable for provider ${candidate.providerName}`;
        lastErrorCode = "oauth_token_unavailable";
        if (hasMore) continue;
        releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, lastErrorCode);
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 401, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(401, "authentication_error", lastErrorMessage));
      }
      headers.set("authorization", `Bearer ${token}`);
    } else if (candidate.provider.authMode !== "forward") {
      if (isProviderApiKeyPaused(candidate.provider)) {
        recordComboFailure(candidate);
        lastErrorStatus = 403;
        lastErrorMessage = new ProviderApiKeyPausedError().message;
        lastErrorCode = "provider_key_paused";
        if (hasMore) continue;
        releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, lastErrorCode);
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 403, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(403, "permission_error", lastErrorMessage));
      }
      const transport = resolveCurrentProviderApiKeyTransport(config, candidate.providerName, candidate.provider);
      if (!transport) {
        if (candidate.provider.keyOptional) {
          if (candidate.provider.apiKey) headers.set("authorization", `Bearer ${candidate.provider.apiKey}`);
        } else {
          recordComboFailure(candidate);
          lastErrorStatus = 403;
          lastErrorMessage = `no active API key available for provider ${candidate.providerName}`;
          lastErrorCode = "provider_key_unavailable";
          if (hasMore) continue;
          releaseEmbeddingLeaseOnRefusal(logCtx, upstreamAttempted);
          markLocalRequestLogRefusal(logCtx, lastErrorCode);
          logCtx.errorCode = lastErrorCode;
          addFinalRequestLog(options.requestId, options.start, logCtx, 403, { closeReason: "non_stream" });
          return markProxyError(formatErrorResponse(403, "permission_error", lastErrorMessage));
        }
      } else if (transport.apiKey) {
        headers.set("authorization", `Bearer ${transport.apiKey}`);
      }
    }
    if (logCtx.otlpSpan?.traceparent && !headers.has("traceparent")) {
      headers.set("traceparent", logCtx.otlpSpan.traceparent);
    }

    const upstreamPayload: Record<string, unknown> = {
      model: candidate.modelId,
      input: parsed.input,
      ...(parsed.encodingFormat ? { encoding_format: parsed.encodingFormat } : {}),
      ...(parsed.dimensions !== undefined ? { dimensions: parsed.dimensions } : {}),
      ...(parsed.user !== undefined ? { user: parsed.user } : {}),
    };

    const fetchImpl = candidateTransport.fetch ?? globalThis.fetch;
    const timeoutMs = typeof candidate.provider.connectTimeoutMs === "number" && candidate.provider.connectTimeoutMs > 0
      ? Math.max(1_000, Math.min(candidate.provider.connectTimeoutMs, EMBEDDINGS_TIMEOUT_MS))
      : EMBEDDINGS_TIMEOUT_MS;
    const deadline = signalWithTimeout(timeoutMs, req.signal);
    const attemptStartMs = Date.now();
    let upstreamRes: Response;
    try {
      upstreamAttempted = true;
      upstreamRes = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamPayload),
        redirect: "error",
        signal: deadline.signal,
      });
      const bytesResult = await readBoundedResponseBytes(upstreamRes, {
        maxBytes: MAX_EMBEDDINGS_RESPONSE_BYTES,
        signal: deadline.signal,
      });
      if (bytesResult.oversized) {
        recordComboFailure(candidate);
        lastErrorStatus = 502;
        lastErrorMessage = `upstream embeddings response exceeded ${MAX_EMBEDDINGS_RESPONSE_BYTES} bytes`;
        lastErrorCode = "upstream_response_too_large";
        if (hasMore) continue;
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(502, "upstream_error", lastErrorMessage));
      }
      const text = new TextDecoder().decode(bytesResult.bytes);
      if (!upstreamRes.ok) {
        lastErrorStatus = upstreamRes.status;
        lastErrorMessage = sanitizeUpstreamErrorText(text) || `upstream returned HTTP ${upstreamRes.status}`;
        lastErrorCode = `upstream_${upstreamRes.status}`;
        const shouldFailoverOrPenalize =
          isTransientUpstreamStatus(upstreamRes.status)
          || upstreamRes.status >= 500
          || upstreamRes.status === 429
          || upstreamRes.status === 401
          || upstreamRes.status === 403
          || upstreamRes.status === 408
          || upstreamRes.status === 402;
        if (shouldFailoverOrPenalize) {
          recordComboFailure(candidate);
          if (hasMore) continue;
        }
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, upstreamRes.status, { closeReason: "non_stream" });
        return formatErrorResponse(upstreamRes.status, upstreamRes.status === 429 ? "rate_limit_error" : "upstream_error", lastErrorMessage);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        recordComboFailure(candidate);
        lastErrorStatus = 502;
        lastErrorMessage = "upstream returned invalid JSON for embeddings";
        lastErrorCode = "invalid_upstream_json";
        if (hasMore) continue;
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
        return formatErrorResponse(502, "upstream_error", lastErrorMessage);
      }

      if (!isRec(json)) {
        recordComboFailure(candidate);
        lastErrorStatus = 502;
        lastErrorMessage = "upstream returned a non-object embeddings payload";
        lastErrorCode = "invalid_upstream_payload";
        if (hasMore) continue;
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
        return formatErrorResponse(502, "upstream_error", lastErrorMessage);
      }

      const { usage } = parseEmbeddingsUsage(json, parsed.estimatedTokens);
      if (route.combo && comboConfig && candidate.comboTarget) {
        noteComboSuccess(
          route.combo.comboId,
          comboConfig,
          candidate.comboTarget,
          route.combo.writerGeneration,
          { latencyMs: Math.max(1, Date.now() - attemptStartMs) },
        );
        if (targetKey(candidate.comboTarget) === targetKey(route.combo.target)) {
          settleComboReprobeSuccess(route.combo);
        }
      }
      logCtx.usage = usage;
      logCtx.usageWireParsed = !usage.estimated;
      addFinalRequestLog(options.requestId, options.start, logCtx, 200, {
        closeReason: "non_stream",
      });
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (req.signal.aborted) {
        logCtx.errorCode = "client_cancel";
        addFinalRequestLog(options.requestId, options.start, logCtx, 499, { closeReason: "client_cancel" });
        return formatErrorResponse(499, "client_closed_request", "request cancelled by client");
      }
      lastErrorStatus = 502;
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      lastErrorCode = "upstream_fetch_failed";
      recordComboFailure(candidate);
      if (hasMore) {
        continue;
      }
      logCtx.errorCode = lastErrorCode;
      addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
      return formatErrorResponse(502, "upstream_error", lastErrorMessage);
    } finally {
      deadline.cleanup();
    }
  }

  logCtx.errorCode = lastErrorCode;
  addFinalRequestLog(options.requestId, options.start, logCtx, lastErrorStatus, { closeReason: "non_stream" });
  return formatErrorResponse(lastErrorStatus, "upstream_error", lastErrorMessage);
}
