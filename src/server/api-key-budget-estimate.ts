import type { EpxConfig, EpxApiKeyEntry } from "../types";
import { carryProxyError, markProxyError } from "../lib/client-error-body";
import { normalizeMessagesProxyRefusal } from "../lib/messages-error-body";
import { anthropicErrorResponse } from "../claude/outbound";
import { resolveMatchedPrice, calculateCost } from "../usage/cost";
import { isApiKeyExpired, withCors } from "./auth-cors";
import { markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";

const DEFAULT_FALLBACK_OUTPUT_TOKENS = 64;
const MAX_HOLD_INPUT_TOKENS = 1_000_000;
const MAX_HOLD_OUTPUT_TOKENS = 128_000;
const UNPRICED_INFLIGHT_HOLD_USD = 0.0001;
const DENSE_ASCII_FALLBACK_MIN_BYTES = 256;
const DENSE_ASCII_FALLBACK_SHARE = 0.85;
const DENSE_ASCII_BYTES_PER_TOKEN = 2;

export interface BudgetReservationEstimate {
  estimatedTokens: number;
  estimatedCostUsd: number;
}

export function estimateBudgetReservationForTurn(params: {
  providerName: string;
  modelId: string;
  decodedBytes?: number;
  nonWhitespaceAsciiBytes?: number;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
}): BudgetReservationEstimate {
  const decodedBytes = typeof params.decodedBytes === "number" && Number.isFinite(params.decodedBytes) && params.decodedBytes > 0
    ? Math.trunc(params.decodedBytes)
    : 0;
  let inputFromBytes = decodedBytes > 0 ? Math.ceil(decodedBytes / 4) : 1;
  if (
    decodedBytes >= DENSE_ASCII_FALLBACK_MIN_BYTES
    && typeof params.nonWhitespaceAsciiBytes === "number"
    && Number.isFinite(params.nonWhitespaceAsciiBytes)
    && params.nonWhitespaceAsciiBytes > 0
  ) {
    const denseAsciiBytes = Math.min(decodedBytes, Math.trunc(params.nonWhitespaceAsciiBytes));
    if (denseAsciiBytes >= decodedBytes * DENSE_ASCII_FALLBACK_SHARE) {
      inputFromBytes = Math.max(inputFromBytes, Math.ceil(denseAsciiBytes / DENSE_ASCII_BYTES_PER_TOKEN));
    }
  }
  const rawInput = typeof params.estimatedInputTokens === "number" && Number.isFinite(params.estimatedInputTokens) && params.estimatedInputTokens > 0
    ? Math.trunc(params.estimatedInputTokens)
    : inputFromBytes;
  const inputTokens = Math.min(MAX_HOLD_INPUT_TOKENS, Math.max(1, rawInput));
  const rawOut = typeof params.maxOutputTokens === "number" && Number.isFinite(params.maxOutputTokens) && params.maxOutputTokens > 0
    ? Math.trunc(params.maxOutputTokens)
    : DEFAULT_FALLBACK_OUTPUT_TOKENS;
  const outputTokens = Math.min(MAX_HOLD_OUTPUT_TOKENS, rawOut);
  const estimatedTokens = inputTokens + outputTokens;

  let estimatedCostUsd = UNPRICED_INFLIGHT_HOLD_USD;
  try {
    const price = resolveMatchedPrice(params.providerName, params.modelId);
    if (price) {
      const breakdown = calculateCost(
        { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 },
        price.cost4,
      );
      if (Number.isFinite(breakdown.total) && breakdown.total > 0) {
        estimatedCostUsd = Math.max(0.000001, Math.round(breakdown.total * 1_000_000) / 1_000_000);
      }
    }
  } catch {
    // Keep conservative minimum hold when pricing lookup fails.
  }
  return { estimatedTokens, estimatedCostUsd };
}

function keyHasHoldSensitiveQuotas(entry: EpxApiKeyEntry): boolean {
  return entry.tpmLimit !== undefined
    || entry.dailyTokenLimit !== undefined
    || entry.dailyCostLimitUsd !== undefined
    || entry.maxInFlightCostUsd !== undefined;
}

async function buildPreDispatchRefusal(
  req: Request,
  config: EpxConfig,
  lease: NonNullable<RequestLogContext["apiKeyBudgetLease"]>,
  logCtx: RequestLogContext | undefined,
  upstreamAttempted: boolean | undefined,
  anthropicSurface: boolean | undefined,
  status: number,
  errorType: "authentication_error" | "rate_limit_error",
  code: string,
  message: string,
  retryAfterSec?: number,
): Promise<Response> {
  if (upstreamAttempted || (logCtx?.attempts?.length ?? 0) > 0) {
    lease.releaseHoldOnly();
  } else {
    lease.releaseUnused();
  }
  if (logCtx) {
    markLocalRequestLogRefusal(logCtx, code);
    logCtx.errorCode = code;
  }
  const raw = anthropicSurface
    ? anthropicErrorResponse(status, message, errorType, code)
    : Response.json({
      error: {
        type: errorType,
        code,
        message,
      },
    }, { status });
  if (retryAfterSec !== undefined) raw.headers.set("Retry-After", String(retryAfterSec));
  const refusal = markProxyError(raw);
  return carryProxyError(
    refusal,
    withCors(await normalizeMessagesProxyRefusal(req, refusal), req, config),
  );
}

export async function reservePreDispatchApiKeyHold(params: {
  req: Request;
  config: EpxConfig;
  logCtx?: RequestLogContext;
  providerName: string;
  modelId: string;
  decodedBytes?: number;
  nonWhitespaceAsciiBytes?: number;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  anthropicSurface?: boolean;
  upstreamAttempted?: boolean;
}): Promise<Response | null> {
  const lease = params.logCtx?.apiKeyBudgetLease;
  const keyId = params.logCtx?.apiKeyId;
  if (!lease || !keyId) return null;
  const entry = params.config.apiKeys?.find((k) => k.id === keyId);
  if (!entry || isApiKeyExpired(entry)) {
    return buildPreDispatchRefusal(
      params.req,
      params.config,
      lease,
      params.logCtx,
      params.upstreamAttempted,
      params.anthropicSurface,
      401,
      "authentication_error",
      "invalid_api_key",
      "easyproxy API key is invalid, expired, or revoked",
    );
  }
  if (!keyHasHoldSensitiveQuotas(entry)) return null;

  const decodedBytes = params.decodedBytes ?? params.logCtx?.requestBodyHolder?.facts?.decodedBytes;
  const nonWhitespaceAsciiBytes = params.nonWhitespaceAsciiBytes
    ?? (params.decodedBytes === undefined ? params.logCtx?.requestBodyHolder?.nonWhitespaceAsciiBytes : undefined);
  const estimate = estimateBudgetReservationForTurn({
    providerName: params.providerName,
    modelId: params.modelId,
    decodedBytes,
    nonWhitespaceAsciiBytes,
    estimatedInputTokens: params.estimatedInputTokens,
    maxOutputTokens: params.maxOutputTokens,
  });

  const decision = lease.reserveHold(entry, {
    tokens: estimate.estimatedTokens,
    costUsd: estimate.estimatedCostUsd,
  });
  if (decision.allowed) return null;

  const message =
    decision.reason === "tpm_limit_exceeded"
      ? "API key tokens-per-minute budget exceeded."
      : decision.reason === "in_flight_cost_limit_exceeded"
        ? "API key concurrent in-flight USD budget exceeded."
        : "API key request budget exceeded.";
  return buildPreDispatchRefusal(
    params.req,
    params.config,
    lease,
    params.logCtx,
    params.upstreamAttempted,
    params.anthropicSurface,
    429,
    "rate_limit_error",
    decision.reason,
    message,
    decision.retryAfterSec,
  );
}
