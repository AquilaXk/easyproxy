// Ported from Portkey-AI/gateway and can1357/oh-my-pi (MIT License) following EasyProxy's
// data-plane security, SSRF, key-scope, budget, hygiene, and bounded audio-stream contracts.

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
import { markProxyError } from "../lib/client-error-body";
import { providerDestinationConfigError, providerDestinationResolvedError } from "../lib/destination-policy";
import { clientFacingModelLabel } from "../lib/error-destination";
import { isTransientUpstreamStatus } from "../lib/upstream-retry";
import type { EpxProviderTransport } from "../providers/xai-transport";
import { NoEligiblePolicyCandidateError, routeConcreteModel, routeModel, type RouteResult } from "../router";
import type { EpxConfig, EpxProviderConfig, EpxUsage } from "../types";
import { AdmissionModelDeniedError, assertRouteAllowedByScope, resolveAdmissionModelScope } from "./admission-model-scope";
import { reservePreDispatchApiKeyHold } from "./api-key-budget-estimate";
import type { DataPlaneAdmission } from "./auth-cors";
import {
  adapterSupportsAuxiliaryEndpoint,
  resolveAuxiliaryUpstreamHeaders,
  sendAuxiliaryUpstreamRequest,
} from "./auxiliary-upstream";
import { applyOutboundPayloadHygiene, OUTBOUND_SECRET_BLOCKED_MESSAGE } from "./outbound-payload-hygiene";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";

const MAX_SPEECH_INPUT_CHARS = 16_384;
const MAX_SPEECH_INSTRUCTIONS_CHARS = 4_096;
const MAX_SPEECH_RESPONSE_BYTES = 32 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 120_000;

const SPEECH_FORMAT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

type ValidatedAudioSpeechRequest = {
  model: string;
  input: string;
  voice: string;
  responseFormat: string;
  speed?: number;
  instructions?: string;
  estimatedTokens: number;
};

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateAudioSpeechBody(raw: unknown): { ok: true; body: ValidatedAudioSpeechRequest } | { ok: false; message: string } {
  if (!isRec(raw)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 256) {
    return { ok: false, message: "model must be a non-empty string (<= 256 chars)" };
  }
  const model = raw.model.trim();
  if (typeof raw.input !== "string" || raw.input.trim().length === 0) {
    return { ok: false, message: "input must be a non-empty string" };
  }
  if (raw.input.length > MAX_SPEECH_INPUT_CHARS) {
    return { ok: false, message: `input exceeds ${MAX_SPEECH_INPUT_CHARS} characters` };
  }
  if (typeof raw.voice !== "string" || !raw.voice.trim() || raw.voice.length > 64) {
    return { ok: false, message: "voice must be a non-empty string (<= 64 chars)" };
  }
  const voice = raw.voice.trim();

  let responseFormat = "mp3";
  if (raw.response_format !== undefined) {
    if (typeof raw.response_format !== "string" || !Object.hasOwn(SPEECH_FORMAT_CONTENT_TYPES, raw.response_format)) {
      return { ok: false, message: `response_format must be one of: ${Object.keys(SPEECH_FORMAT_CONTENT_TYPES).join(", ")}` };
    }
    responseFormat = raw.response_format;
  }

  let speed: number | undefined;
  if (raw.speed !== undefined) {
    if (typeof raw.speed !== "number" || !Number.isFinite(raw.speed) || raw.speed < 0.25 || raw.speed > 4.0) {
      return { ok: false, message: "speed must be a finite number between 0.25 and 4.0" };
    }
    speed = raw.speed;
  }

  let instructions: string | undefined;
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions !== "string" || raw.instructions.length > MAX_SPEECH_INSTRUCTIONS_CHARS) {
      return { ok: false, message: `instructions must be a string (<= ${MAX_SPEECH_INSTRUCTIONS_CHARS} chars)` };
    }
    instructions = raw.instructions;
  }

  const totalChars = raw.input.length + (instructions?.length ?? 0);
  return {
    ok: true,
    body: {
      model,
      input: raw.input,
      voice,
      responseFormat,
      ...(speed !== undefined ? { speed } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      estimatedTokens: Math.max(1, Math.ceil(totalChars / 4)),
    },
  };
}

export function resolveAudioSpeechUrl(provider: Pick<EpxProviderConfig, "baseUrl">): string {
  const trimmed = provider.baseUrl.trim();
  const rewritePath = (path: string): string => {
    let p = path;
    while (p.endsWith("/")) p = p.slice(0, -1);
    if (!p.endsWith("/audio/speech")) {
      if (p.endsWith("/audio/transcriptions")) p = p.slice(0, -"/audio/transcriptions".length);
      else if (p.endsWith("/embeddings")) p = p.slice(0, -"/embeddings".length);
      else if (p.endsWith("/responses")) p = p.slice(0, -"/responses".length);
      else if (p.endsWith("/chat/completions")) p = p.slice(0, -"/chat/completions".length);
      while (p.endsWith("/")) p = p.slice(0, -1);
      p = /\/v\d+(?:alpha|beta)?$/i.test(p) ? `${p}/audio/speech` : `${p}/v1/audio/speech`;
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

function adapterSupportsSpeech(provider: Pick<EpxProviderConfig, "adapter" | "authMode" | "baseUrl">): boolean {
  return adapterSupportsAuxiliaryEndpoint(provider);
}

interface ResolvedSpeechCandidate {
  providerName: string;
  modelId: string;
  provider: EpxProviderConfig;
  comboTarget?: NormalizedComboTarget;
}

function resolveSpeechCandidates(route: RouteResult, config: EpxConfig): ResolvedSpeechCandidate[] {
  const candidates: ResolvedSpeechCandidate[] = [
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
              return resolved.provider.disabled !== true && adapterSupportsSpeech(resolved.provider);
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

function releaseSpeechLeaseOnRefusal(logCtx: RequestLogContext, upstreamAttempted: boolean): void {
  if (upstreamAttempted) logCtx.apiKeyBudgetLease?.releaseHoldOnly();
  else logCtx.apiKeyBudgetLease?.releaseUnused();
}

function safeAudioResponseContentType(upstreamHeader: string | null, format: string): string | null {
  const fallback = SPEECH_FORMAT_CONTENT_TYPES[format] ?? "audio/mpeg";
  if (!upstreamHeader) return fallback;
  const mediaType = upstreamHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mediaType || mediaType === "application/octet-stream") return fallback;
  if (mediaType.startsWith("audio/") || mediaType === "application/ogg") {
    return mediaType;
  }
  return null;
}

export async function handleAudioSpeech(
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
    releaseSpeechLeaseOnRefusal(logCtx, false);
    markLocalRequestLogRefusal(logCtx, code);
    logCtx.errorCode = code;
    addFinalRequestLog(options.requestId, options.start, logCtx, status, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(status, status === 413 ? "request_too_large" : "invalid_request_error", error instanceof Error ? error.message : "invalid request body"));
  }

  const validated = validateAudioSpeechBody(rawBody);
  if (!validated.ok) {
    releaseSpeechLeaseOnRefusal(logCtx, false);
    markLocalRequestLogRefusal(logCtx, "invalid_speech_request");
    logCtx.errorCode = "invalid_speech_request";
    addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(400, "invalid_request_error", validated.message));
  }

  const parsed = validated.body;
  const hygienePayload: { input: string; instructions?: string } = {
    input: parsed.input,
    ...(parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}),
  };
  const hygiene = applyOutboundPayloadHygiene(hygienePayload, config, logCtx);
  if (hygiene.blocked) {
    releaseSpeechLeaseOnRefusal(logCtx, false);
    addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
    return markProxyError(formatErrorResponse(400, "invalid_request_error", OUTBOUND_SECRET_BLOCKED_MESSAGE));
  }
  const sanitized = hygiene.body as typeof hygienePayload;
  parsed.input = sanitized.input;
  if (sanitized.instructions !== undefined) parsed.instructions = sanitized.instructions;
  logCtx.requestedModel = parsed.model;

  let route: RouteResult;
  try {
    route = routeModel(config, parsed.model);
  } catch (error) {
    releaseSpeechLeaseOnRefusal(logCtx, false);
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

  const candidates = resolveSpeechCandidates(route, config);
  const admissionScope = resolveAdmissionModelScope(config, options.admission);
  const comboConfig = route.combo ? getCombo(config, route.combo.comboId) : undefined;
  const isEwmaCombo = comboConfig?.strategy === "ewma-latency";
  const recordComboFailure = (candidate: ResolvedSpeechCandidate): void => {
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
  let lastErrorMessage = "upstream audio speech request failed";
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
        releaseSpeechLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, "api_key_scope_denied");
        logCtx.errorCode = "api_key_scope_denied";
        addFinalRequestLog(options.requestId, options.start, logCtx, 403, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(403, "permission_error", error.message));
      }
      throw error;
    }

    if (!adapterSupportsSpeech(candidate.provider)) {
      if (hasMore) continue;
      releaseSpeechLeaseOnRefusal(logCtx, upstreamAttempted);
      logCtx.errorCode = "speech_unsupported_provider";
      markLocalRequestLogRefusal(logCtx, "speech_unsupported_provider");
      addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(
        400,
        "invalid_request_error",
        `provider ${candidate.providerName} (${candidate.provider.adapter}) does not support /v1/audio/speech`,
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
      releaseSpeechLeaseOnRefusal(logCtx, upstreamAttempted);
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
        releaseSpeechLeaseOnRefusal(logCtx, upstreamAttempted);
        markLocalRequestLogRefusal(logCtx, "destination_rejected");
        logCtx.errorCode = "destination_rejected";
        addFinalRequestLog(options.requestId, options.start, logCtx, 400, { closeReason: "non_stream" });
        return markProxyError(formatErrorResponse(400, "invalid_request_error", dnsErr));
      }
    }

    const url = resolveAudioSpeechUrl(candidate.provider);
    const headerResolution = await resolveAuxiliaryUpstreamHeaders(req, config, candidate, logCtx);
    if ("error" in headerResolution) {
      const authErr = headerResolution.error;
      if (authErr.shouldFailover) recordComboFailure(candidate);
      lastErrorStatus = authErr.status;
      lastErrorMessage = authErr.message;
      lastErrorCode = authErr.code;
      if (authErr.shouldFailover && hasMore) continue;
      releaseSpeechLeaseOnRefusal(logCtx, upstreamAttempted);
      markLocalRequestLogRefusal(logCtx, lastErrorCode);
      logCtx.errorCode = lastErrorCode;
      addFinalRequestLog(options.requestId, options.start, logCtx, authErr.status, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(authErr.status, authErr.errorType, lastErrorMessage));
    }
    const { headers } = headerResolution;

    const upstreamPayload: Record<string, unknown> = {
      model: candidate.modelId,
      input: parsed.input,
      voice: parsed.voice,
      response_format: parsed.responseFormat,
      ...(parsed.speed !== undefined ? { speed: parsed.speed } : {}),
      ...(parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}),
    };

    const fetchImpl = candidateTransport.fetch ?? globalThis.fetch;
    const attemptStartMs = Date.now();
    const outcome = await sendAuxiliaryUpstreamRequest({
      url,
      headers,
      payload: upstreamPayload,
      reqSignal: req.signal,
      fetchImpl,
      config,
      provider: candidate.provider,
      maxResponseBytes: MAX_SPEECH_RESPONSE_BYTES,
      defaultBodyTimeoutMs: SPEECH_TIMEOUT_MS,
      onAttemptStart: () => {
        upstreamAttempted = true;
      },
    });
    if (outcome.kind === "client_cancel") {
      logCtx.errorCode = "client_cancel";
      addFinalRequestLog(options.requestId, options.start, logCtx, 499, { closeReason: "client_cancel" });
      return formatErrorResponse(499, "client_closed_request", "request cancelled by client");
    }
    if (outcome.kind === "fetch_error") {
      lastErrorStatus = 502;
      lastErrorMessage = outcome.message;
      lastErrorCode = "upstream_fetch_failed";
      recordComboFailure(candidate);
      if (hasMore) continue;
      logCtx.errorCode = lastErrorCode;
      addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
      return formatErrorResponse(502, "upstream_error", lastErrorMessage);
    }
    if (outcome.kind === "redirect") {
      recordComboFailure(candidate);
      lastErrorStatus = 502;
      lastErrorMessage = `upstream redirected with HTTP ${outcome.status}`;
      lastErrorCode = "upstream_redirect_rejected";
      if (hasMore) continue;
      logCtx.errorCode = lastErrorCode;
      addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(502, "upstream_error", lastErrorMessage));
    }
    if (outcome.kind === "oversized") {
      recordComboFailure(candidate);
      lastErrorStatus = 502;
      lastErrorMessage = `upstream audio speech response exceeded ${MAX_SPEECH_RESPONSE_BYTES} bytes`;
      lastErrorCode = "upstream_response_too_large";
      if (hasMore) continue;
      logCtx.errorCode = lastErrorCode;
      addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
      return markProxyError(formatErrorResponse(502, "upstream_error", lastErrorMessage));
    }
    const { upstreamRes, bytes } = outcome;
    if (!upstreamRes.ok) {
      const text = new TextDecoder().decode(bytes);
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

    const contentType = safeAudioResponseContentType(upstreamRes.headers.get("content-type"), parsed.responseFormat);
    if (!contentType || bytes.byteLength === 0) {
      recordComboFailure(candidate);
      lastErrorStatus = 502;
      lastErrorMessage = "upstream returned invalid or empty audio payload";
      lastErrorCode = "invalid_upstream_audio";
      if (hasMore) continue;
      logCtx.errorCode = lastErrorCode;
      addFinalRequestLog(options.requestId, options.start, logCtx, 502, { closeReason: "non_stream" });
      return formatErrorResponse(502, "upstream_error", lastErrorMessage);
    }

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

    const usage: EpxUsage = {
      inputTokens: parsed.estimatedTokens,
      outputTokens: 0,
      totalTokens: parsed.estimatedTokens,
      estimated: true,
    };
    logCtx.usage = usage;
    addFinalRequestLog(options.requestId, options.start, logCtx, 200, { closeReason: "non_stream" });
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  }

  logCtx.errorCode = lastErrorCode;
  addFinalRequestLog(options.requestId, options.start, logCtx, lastErrorStatus, { closeReason: "non_stream" });
  return formatErrorResponse(lastErrorStatus, "upstream_error", lastErrorMessage);
}
