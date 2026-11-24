import type { EpxConfig, EpxApiKeyEntry } from "../types";
import { markProxyError } from "../lib/client-error-body";
import { normalizeMessagesProxyRefusal } from "../lib/messages-error-body";
import { anthropicErrorResponse } from "../claude/outbound";
import { resolveMatchedPrice, calculateCost } from "../usage/cost";
import { withCors } from "./auth-cors";
import { markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";

const DEFAULT_FALLBACK_OUTPUT_TOKENS = 64;
const MAX_HOLD_INPUT_TOKENS = 1_000_000;
const MAX_HOLD_OUTPUT_TOKENS = 128_000;
const UNPRICED_INFLIGHT_HOLD_USD = 0.0001;

export interface BudgetReservationEstimate {
  estimatedTokens: number;
  estimatedCostUsd: number;
}

export function estimateBudgetReservationForTurn(params: {
  providerName: string;
  modelId: string;
  decodedBytes?: number;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
}): BudgetReservationEstimate {
  const inputFromBytes = typeof params.decodedBytes === "number" && Number.isFinite(params.decodedBytes) && params.decodedBytes > 0
    ? Math.ceil(params.decodedBytes / 4)
    : 1;
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

export async function reservePreDispatchApiKeyHold(params: {
  req: Request;
  config: EpxConfig;
  logCtx?: RequestLogContext;
  providerName: string;
  modelId: string;
  decodedBytes?: number;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  anthropicSurface?: boolean;
}): Promise<Response | null> {
  const lease = params.logCtx?.apiKeyBudgetLease;
  const keyId = params.logCtx?.apiKeyId;
  if (!lease || !keyId) return null;
  const entry = params.config.apiKeys?.find((k) => k.id === keyId);
  if (!entry || !keyHasHoldSensitiveQuotas(entry)) return null;

  const decodedBytes = params.decodedBytes ?? params.logCtx?.requestBodyHolder?.facts?.decodedBytes;
  const estimate = estimateBudgetReservationForTurn({
    providerName: params.providerName,
    modelId: params.modelId,
    decodedBytes,
    estimatedInputTokens: params.estimatedInputTokens,
    maxOutputTokens: params.maxOutputTokens,
  });

  const decision = lease.reserveHold(entry, {
    tokens: estimate.estimatedTokens,
    costUsd: estimate.estimatedCostUsd,
  });
  if (decision.allowed) return null;

  if (params.logCtx) {
    markLocalRequestLogRefusal(params.logCtx, decision.reason);
    params.logCtx.errorCode = decision.reason;
  }
  const message =
    decision.reason === "tpm_limit_exceeded"
      ? "API key tokens-per-minute budget exceeded."
      : decision.reason === "in_flight_cost_limit_exceeded"
        ? "API key concurrent in-flight USD budget exceeded."
        : "API key request budget exceeded.";
  const raw = params.anthropicSurface
    ? anthropicErrorResponse(429, message, "rate_limit_error", decision.reason)
    : Response.json({
      error: {
        type: "rate_limit_error",
        code: decision.reason,
        message,
      },
    }, { status: 429 });
  raw.headers.set("Retry-After", String(decision.retryAfterSec));
  const refusal = markProxyError(raw);
  return withCors(await normalizeMessagesProxyRefusal(params.req, refusal), params.req, params.config);
}
