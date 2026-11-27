// Ported from can1357/oh-my-pi and Portkey-AI/gateway (MIT License) following EasyProxy's
// embeddings data-plane security, SSRF, key-scope, budget, hygiene, and combo-failover contracts.

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
import { clientFacingModelLabel } from "../lib/error-destination";
import { redactSecretString } from "../lib/redact";
import { isTransientUpstreamStatus } from "../lib/upstream-retry";
import { getValidAccessToken } from "../oauth/index";
import { isProviderApiKeyPaused, ProviderApiKeyPausedError } from "../providers/api-key-pause";
import { resolveCurrentProviderApiKeyTransport } from "../providers/api-key-selection";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-forward-destination";
import type { EpxProviderTransport } from "../providers/xai-transport";
import { NoEligiblePolicyCandidateError, routeConcreteModel, routeModel, type RouteResult } from "../router";
import type { EpxConfig, EpxProviderConfig, EpxUsage } from "../types";
import { AdmissionModelDeniedError, assertRouteAllowedByScope, resolveAdmissionModelScope } from "./admission-model-scope";
import { reservePreDispatchApiKeyHold } from "./api-key-budget-estimate";
import type { DataPlaneAdmission } from "./auth-cors";
import { applyOutboundPayloadHygiene, OUTBOUND_SECRET_BLOCKED_MESSAGE } from "./outbound-payload-hygiene";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";

const MAX_RERANK_DOCUMENTS = 1_000;
const MAX_RERANK_QUERY_CHARS = 128_000;
const MAX_RERANK_TOTAL_DOC_CHARS = 2_000_000;
const MAX_RERANK_RESPONSE_BYTES = 16 * 1024 * 1024;
const RERANK_TIMEOUT_MS = 120_000;

const SUPPORTED_RERANK_ADAPTERS = new Set(["openai-responses", "openai-chat", "openai-compatible"]);

type RerankDocumentInput = string | Record<string, unknown>;

type ValidatedRerankRequest = {
  model: string;
  query: string;
  documents: RerankDocumentInput[];
  topN?: number;
  returnDocuments?: boolean;
  maxChunksPerDoc?: number;
  rawScores?: boolean;
  rankFields?: string[];
  estimatedTokens: number;
};

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateRerankBody(raw: unknown): { ok: true; body: ValidatedRerankRequest } | { ok: false; message: string } {
  if (!isRec(raw)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 256) {
    return { ok: false, message: "model must be a non-empty string (<= 256 chars)" };
  }
  const model = raw.model.trim();
  if (typeof raw.query !== "string" || raw.query.trim().length === 0) {
    return { ok: false, message: "query must be a non-empty string" };
  }
  if (raw.query.length > MAX_RERANK_QUERY_CHARS) {
    return { ok: false, message: `query exceeds ${MAX_RERANK_QUERY_CHARS} characters` };
  }
  if (!Array.isArray(raw.documents) || raw.documents.length === 0) {
    return { ok: false, message: "documents must be a non-empty array" };
  }
  if (raw.documents.length > MAX_RERANK_DOCUMENTS) {
    return { ok: false, message: `documents exceeds ${MAX_RERANK_DOCUMENTS} items` };
  }

  let totalChars = raw.query.length;
  for (const doc of raw.documents) {
    if (typeof doc === "string") {
      totalChars += doc.length;
    } else if (isRec(doc)) {
      totalChars += JSON.stringify(doc).length;
    } else {
      return { ok: false, message: "documents items must be strings or objects" };
    }
    if (totalChars > MAX_RERANK_TOTAL_DOC_CHARS) {
      return { ok: false, message: `rerank payload exceeds ${MAX_RERANK_TOTAL_DOC_CHARS} total characters` };
    }
  }

  let topN: number | undefined;
  if (raw.top_n !== undefined) {
    if (typeof raw.top_n !== "number" || !Number.isSafeInteger(raw.top_n) || raw.top_n < 1 || raw.top_n > MAX_RERANK_DOCUMENTS) {
      return { ok: false, message: `top_n must be an integer between 1 and ${MAX_RERANK_DOCUMENTS}` };
    }
    topN = raw.top_n;
  }

  let returnDocuments: boolean | undefined;
  if (raw.return_documents !== undefined) {
    if (typeof raw.return_documents !== "boolean") {
      return { ok: false, message: "return_documents must be a boolean" };
    }
    returnDocuments = raw.return_documents;
  }

  let maxChunksPerDoc: number | undefined;
  if (raw.max_chunks_per_doc !== undefined) {
    if (typeof raw.max_chunks_per_doc !== "number" || !Number.isSafeInteger(raw.max_chunks_per_doc) || raw.max_chunks_per_doc < 1 || raw.max_chunks_per_doc > 10_000) {
      return { ok: false, message: "max_chunks_per_doc must be a positive integer" };
    }
    maxChunksPerDoc = raw.max_chunks_per_doc;
  }

  let rawScores: boolean | undefined;
  if (raw.raw_scores !== undefined) {
    if (typeof raw.raw_scores !== "boolean") {
      return { ok: false, message: "raw_scores must be a boolean" };
    }
    rawScores = raw.raw_scores;
  }

  let rankFields: string[] | undefined;
  if (raw.rank_fields !== undefined) {
    if (!Array.isArray(raw.rank_fields) || raw.rank_fields.length > 64 || !raw.rank_fields.every(f => typeof f === "string" && f.length > 0 && f.length <= 128)) {
      return { ok: false, message: "rank_fields must be a bounded array of non-empty strings" };
    }
    rankFields = raw.rank_fields;
  }

  return {
    ok: true,
    body: {
      model,
      query: raw.query,
      documents: raw.documents as RerankDocumentInput[],
      ...(topN !== undefined ? { topN } : {}),
      ...(returnDocuments !== undefined ? { returnDocuments } : {}),
      ...(maxChunksPerDoc !== undefined ? { maxChunksPerDoc } : {}),
      ...(rawScores !== undefined ? { rawScores } : {}),
      ...(rankFields !== undefined ? { rankFields } : {}),
      estimatedTokens: Math.max(1, Math.ceil(totalChars / 4)),
    },
  };
}

export function resolveRerankUrl(provider: Pick<EpxProviderConfig, "baseUrl">): string {
  const trimmed = provider.baseUrl.trim();
  const rewritePath = (path: string): string => {
    let p = path;
    while (p.endsWith("/")) p = p.slice(0, -1);
    if (!p.endsWith("/rerank")) {
      if (p.endsWith("/embeddings")) p = p.slice(0, -"/embeddings".length);
      else if (p.endsWith("/responses")) p = p.slice(0, -"/responses".length);
      else if (p.endsWith("/chat/completions")) p = p.slice(0, -"/chat/completions".length);
      while (p.endsWith("/")) p = p.slice(0, -1);
      p = /\/v\d+(?:alpha|beta)?$/i.test(p) ? `${p}/rerank` : `${p}/v1/rerank`;
    }
    return p;
  };
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = rewritePath(parsed.pathname);
    return parsed.toString();
  } catch {
    return rewritePath(trimmed);
  }
}

function adapterSupportsRerank(provider: Pick<EpxProviderConfig, "adapter" | "authMode" | "baseUrl">): boolean {
  if (!SUPPORTED_RERANK_ADAPTERS.has(provider.adapter)) return false;
  if (isCanonicalOpenAiForwardProvider(provider as EpxProviderConfig)) return false;
  return Boolean(provider.baseUrl && provider.baseUrl.trim().length > 0);
}

interface ResolvedRerankCandidate {
  providerName: string;
  modelId: string;
  provider: EpxProviderConfig;
  comboTarget?: NormalizedComboTarget;
}

function resolveRerankCandidates(route: RouteResult, config: EpxConfig): ResolvedRerankCandidate[] {
  const candidates: ResolvedRerankCandidate[] = [
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
          eligible: target => {
            try {
              const resolved = routeConcreteModel(config, `${target.provider}/${target.model}`);
              return resolved.provider.disabled !== true && adapterSupportsRerank(resolved.provider);
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

function releaseRerankLeaseOnRefusal(logCtx: RequestLogContext, upstreamAttempted: boolean): void {
  if (upstreamAttempted) logCtx.apiKeyBudgetLease?.releaseHoldOnly();
  else logCtx.apiKeyBudgetLease?.releaseUnused();
}

function parseRerankUsage(payload: unknown, fallbackTokens: number): { usage: EpxUsage; totalTokens: number } {
  if (isRec(payload)) {
    const metaTokens = isRec(payload.meta) && isRec(payload.meta.tokens) ? payload.meta.tokens : undefined;
    const rawUsage = isRec(payload.usage) ? payload.usage : undefined;
    const inputRaw = metaTokens?.input_tokens ?? rawUsage?.prompt_tokens ?? rawUsage?.total_tokens;
    const totalRaw = rawUsage?.total_tokens ?? metaTokens?.input_tokens;
    const input = typeof inputRaw === "number" && Number.isFinite(inputRaw) && inputRaw >= 0
      ? Math.trunc(inputRaw) : undefined;
    const total = typeof totalRaw === "number" && Number.isFinite(totalRaw) && totalRaw >= 0
      ? Math.trunc(totalRaw) : undefined;
    if (input !== undefined || total !== undefined) {
      const resolvedInput = input ?? total ?? fallbackTokens;
      const resolvedTotal = total ?? resolvedInput;
      return {
        usage: {
          inputTokens: resolvedInput,
          outputTokens: 0,
          totalTokens: resolvedTotal,
          upstreamReported: true as const,
        },
        totalTokens: resolvedTotal,
      };
    }
  }
  return {
    usage: { inputTokens: fallbackTokens, outputTokens: 0, totalTokens: fallbackTokens, estimated: true },
    totalTokens: fallbackTokens,
  };
}

export async function handleRerank(
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
    releaseRerankLeaseOnRefusal(logCtx, false);
    markLocalRequestLogRefusal(logCtx, code);
    logCtx.errorCode = code;
    addFinalRequestLog(options.requestId, options.start, logCtx, status, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(status, status === 413 ? "request_too_large" : "invalid_request_error", error instanceof Error ? error.message : "invalid request body"));
  }

  const validated = validateRerankBody(rawBody);
  if (!validated.ok) {
    releaseRerankLeaseOnRefusal(logCtx, false);
    markLocalRequestLogRefusal(logCtx, "invalid_rerank_request");
    logCtx.errorCode = "invalid_rerank_request";
    addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(400, "invalid_request_error", validated.message));
  }

  const parsed = validated.body;
  const hygienePayload: { query: string; documents: RerankDocumentInput[] } = {
    query: parsed.query,
    documents: parsed.documents,
  };
  const hygiene = applyOutboundPayloadHygiene(hygienePayload, config, logCtx);
  if (hygiene.blocked) {
    releaseRerankLeaseOnRefusal(logCtx, false);
    addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(400, "invalid_request_error", OUTBOUND_SECRET_BLOCKED_MESSAGE));
  }
  const sanitized = hygiene.body as typeof hygienePayload;
  parsed.query = sanitized.query;
  parsed.documents = sanitized.documents;
  logCtx.requestedModel = parsed.model;

  let route: RouteResult;
  try {
    route = routeModel(config, parsed.model);
  } catch (error) {
    releaseRerankLeaseOnRefusal(logCtx, false);
    if (error instanceof NoEligiblePolicyCandidateError) logCtx.routeDecision = error.trace;
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

  const candidates = resolveRerankCandidates(route, config);
  const admissionScope = resolveAdmissionModelScope(config, options.admission);
  const comboConfig = route.combo ? getCombo(config, route.combo.comboId) : undefined;
  const isEwmaCombo = comboConfig?.strategy === "ewma-latency";
  const recordComboFailure = (candidate: ResolvedRerankCandidate): void => {
    if (!route.combo) return;
    noteComboFailure(
      route.combo.comboId,
      candidate.comboTarget ?? { provider: candidate.providerName, model: candidate.modelId },
      route.combo.writerGeneration,
      { recordEwma: isEwmaCombo, ewmaLatency: comboConfig?.ewmaLatency },
    );
  };

  let upstreamAttempted = false;
  let lastErrorStatus = 502;
  let lastErrorMessage = "upstream rerank request failed";
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
        releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, "api_key_scope_denied");
        logCtx.errorCode = "api_key_scope_denied";
        addFinalRequestLog(options.requestId, options.start, logCtx, 403, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(403, "permission_error", error.message));
      }
      throw error;
    }

    if (!adapterSupportsRerank(candidate.provider)) {
      if (hasMore) continue;
      releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
      logCtx.errorCode = "rerank_unsupported_provider";
      markLocalRequestLogRefusal(logCtx, "rerank_unsupported_provider");
      addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(
        400,
        "invalid_request_error",
        `provider ${candidate.providerName} (${candidate.provider.adapter}) does not support /v1/rerank`,
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
      addFinalRequestLog(options.requestId, options.start, logCtx, holdRefusal.status, { closeReason: "non_stream" });
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
      releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
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
        releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, "destination_rejected");
        logCtx.errorCode = "destination_rejected";
        addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(400, "invalid_request_error", dnsErr));
      }
    }

    const url = resolveRerankUrl(candidate.provider);
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
        releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
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
        releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
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
          releaseRerankLeaseOnRefusal(logCtx, upstreamAttempted);
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
      query: parsed.query,
      documents: parsed.documents,
      ...(parsed.topN !== undefined ? { top_n: parsed.topN } : {}),
      ...(parsed.returnDocuments !== undefined ? { return_documents: parsed.returnDocuments } : {}),
      ...(parsed.maxChunksPerDoc !== undefined ? { max_chunks_per_doc: parsed.maxChunksPerDoc } : {}),
      ...(parsed.rawScores !== undefined ? { raw_scores: parsed.rawScores } : {}),
      ...(parsed.rankFields !== undefined ? { rank_fields: parsed.rankFields } : {}),
    };

    const fetchImpl = candidateTransport.fetch ?? globalThis.fetch;
    const timeoutMs = typeof candidate.provider.connectTimeoutMs === "number" && candidate.provider.connectTimeoutMs > 0
      ? Math.max(1_000, Math.min(candidate.provider.connectTimeoutMs, RERANK_TIMEOUT_MS))
      : RERANK_TIMEOUT_MS;
    const deadline = signalWithTimeout(timeoutMs, req.signal);
    const attemptStartMs = Date.now();
    try {
      upstreamAttempted = true;
      const upstreamRes = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamPayload),
        redirect: "error",
        signal: deadline.signal,
      });
      const bytesResult = await readBoundedResponseBytes(upstreamRes, {
        maxBytes: MAX_RERANK_RESPONSE_BYTES,
        signal: deadline.signal,
      });
      if (bytesResult.oversized) {
        recordComboFailure(candidate);
        lastErrorStatus = 502;
        lastErrorMessage = `upstream rerank response exceeded ${MAX_RERANK_RESPONSE_BYTES} bytes`;
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
        lastErrorMessage = "upstream returned invalid JSON for rerank";
        lastErrorCode = "invalid_upstream_json";
        if (hasMore) continue;
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
        return formatErrorResponse(502, "upstream_error", lastErrorMessage);
      }

      if (!isRec(json) || !Array.isArray(json.results)) {
        recordComboFailure(candidate);
        lastErrorStatus = 502;
        lastErrorMessage = "upstream returned a malformed rerank payload";
        lastErrorCode = "invalid_upstream_payload";
        if (hasMore) continue;
        logCtx.errorCode = lastErrorCode;
        addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
        return formatErrorResponse(502, "upstream_error", lastErrorMessage);
      }

      const { usage } = parseRerankUsage(json, parsed.estimatedTokens);
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
      addFinalRequestLog(options.requestId, options.start, logCtx, 200, { closeReason: "non_stream" });
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json", "cache-control": "no-store" },
      });
    } catch (error) {
      if (req.signal.aborted) {
        logCtx.errorCode = "client_cancel";
        addFinalRequestLog(options.requestId, options.start, logCtx, 499, { closeReason: "client_cancel" });
        return formatErrorResponse(499, "client_closed_request", "request cancelled by client");
      }
      lastErrorStatus = 502;
      lastErrorMessage = redactSecretString(error instanceof Error ? error.message : String(error));
      lastErrorCode = "upstream_fetch_failed";
      recordComboFailure(candidate);
      if (hasMore) continue;
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
