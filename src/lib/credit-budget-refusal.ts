/*
 * Adapted from can1357/oh-my-pi (packages/ai/src/error/rate-limit.ts),
 * licensed under the MIT License.
 */
import { readBoundedResponseBody } from "./bounded-body";

const MAX_SCAN_CHARS = 8_192;
const MAX_REFUSAL_RESPONSE_BYTES = 8 * 1024;
const REFUSAL_READ_DEADLINE_MS = 250;

// Anthropic subscription entitlement wall: "Usage credits are required for this model" (`credits_required`).
// Bounded away from bare "usage credits" diagnostics (e.g. "Failed to fetch usage credits from billing service").
const ANTHROPIC_CREDITS_REQUIRED_TEXT_RE = /\busage credits are required\b/i;

// Prepaid balance exhaustion: Cursor `usage_pricing_required` or depleted prepaid balance.
// Trailing \b keeps `USAGE_PRICING_REQUIRED_CHANGEABLE` excluded.
const PREPAID_BALANCE_TEXT_RE =
  /\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b/i;

// Spend limits / caps ("monthly spend limit", "monthly spending cap"); trailing \b after cap excludes "spending capacity".
const SPEND_LIMIT_TEXT_RE = /\bspend(?:ing)?[\s_-]+(?:limit|cap)\b/i;

// Virtual key / proxy budget exhaustion (e.g. LiteLLM HTTP 422 "Budget Exceeded" / "Budget has been exceeded!").
const BUDGET_EXCEEDED_TEXT_RE = /\bbudget(?:[\s_-]+has[\s_-]+been)?[\s_-]+exceeded\b/i;

// Generic credit depletion wording (OpenRouter "exceed your available credits", "insufficient credits", etc.).
const CREDITS_EXHAUSTED_TEXT_RE =
  /\b(?:exceed(?:ed)?|insufficient|not enough|out of|run out of)\b[^\n]{0,40}\bcredits\b|\bcredits\b[^\n]{0,40}\b(?:exhausted|depleted)\b/i;

// Throttle phrasing that mentions spending capacity rather than a billing cap.
const SPENDING_CAPACITY_THROTTLE_RE = /\bspending capacity\b/i;

export const MULTI_PROVIDER_BILLING_CODES: ReadonlySet<string> = new Set([
  "credits_required",
  "usage_pricing_required",
  "budget_exceeded",
  "spend_limit_reached",
  "spending_limit_reached",
  "spending_cap_exceeded",
  "credit_balance_too_low",
  "insufficient_balance",
  "payment_required",
  "billing_hard_limit_reached",
]);

function normalizeToken(value: string | number | null | undefined): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function boundedText(message: string | null | undefined): string {
  if (typeof message !== "string" || message.length === 0) return "";
  return message.length > MAX_SCAN_CHARS ? message.slice(0, MAX_SCAN_CHARS) : message;
}

export function isMultiProviderBillingCode(code: string | number | null | undefined): boolean {
  const token = normalizeToken(code);
  return token.length > 0 && MULTI_PROVIDER_BILLING_CODES.has(token);
}

/**
 * Matches spending-capacity throttles (transient rate limit, NOT a permanent billing cap).
 * Distinct from `spending cap` / `spend limit`.
 */
export function isSpendingCapacityThrottleText(message: string | null | undefined): boolean {
  const text = boundedText(message);
  return text.length > 0 && SPENDING_CAPACITY_THROTTLE_RE.test(text);
}

export interface CreditOrBudgetRefusalInput {
  status?: number;
  message?: string | null;
  code?: string | number | null;
  rootCode?: string | number | null;
  type?: string | null;
}

/**
 * Classifies account-attributed credit, prepaid balance, spending cap, and budget exhaustion
 * errors across providers (Anthropic `credits_required`, Cursor `usage_pricing_required`,
 * HTTP 422 `budget_exceeded`, `"spending cap"`, OpenRouter/prepaid balance).
 *
 * Deliberately rejects plain validation prose on HTTP 400 unless accompanied by an authoritative
 * refusal code/exact wording, and excludes `"spending capacity"` throttles.
 */
export function isCreditOrBudgetExhaustedRefusal(input: CreditOrBudgetRefusalInput): boolean {
  const { status } = input;
  const text = boundedText(input.message);
  if (SPENDING_CAPACITY_THROTTLE_RE.test(text)) {
    return false;
  }
  const codes = [input.code, input.rootCode, input.type].map(normalizeToken).filter(Boolean);
  if (codes.some(code => MULTI_PROVIDER_BILLING_CODES.has(code))) {
    return true;
  }
  if (!text) return false;
  if (ANTHROPIC_CREDITS_REQUIRED_TEXT_RE.test(text)) return true;
  // On HTTP 400 without a billing code, only exact documented prepaid/credit sentences apply;
  // on 402/403/422/429 (or 5xx wrappers), recognize budget_exceeded / spending cap / prepaid exhaustion.
  if (status === 400) {
    return false;
  }
  if (BUDGET_EXCEEDED_TEXT_RE.test(text) || /\bbudget_exceeded\b/i.test(text)) return true;
  if (/\busage_pricing_required\b/i.test(text) || PREPAID_BALANCE_TEXT_RE.test(text)) return true;
  if (SPEND_LIMIT_TEXT_RE.test(text)) return true;
  if (CREDITS_EXHAUSTED_TEXT_RE.test(text)) return true;
  return false;
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function readCreditOrBudgetExhaustedResponse(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (response.status !== 400 && response.status !== 402 && response.status !== 403 && response.status !== 422) {
    return false;
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(contentType)) return false;
  try {
    const deadline = AbortSignal.timeout(REFUSAL_READ_DEADLINE_MS);
    const body = await readBoundedResponseBody(response.clone(), {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      maxBytes: MAX_REFUSAL_RESPONSE_BYTES,
      fatalUtf8: true,
      totalTimeoutMs: REFUSAL_READ_DEADLINE_MS,
    });
    if (signal?.aborted || !body.displaySafe || body.truncated || body.timedOut || body.oversized) return false;
    const payload = asObj(JSON.parse(body.text));
    if (!payload) return false;
    const nested = asObj(payload.error);
    const code = nested?.code ?? payload.code;
    const rootCode = payload.code;
    const type = nested?.type ?? payload.type;
    const message = typeof nested?.message === "string"
      ? nested.message
      : typeof payload.message === "string"
        ? payload.message
        : typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    return isCreditOrBudgetExhaustedRefusal({
      status: response.status,
      code: typeof code === "string" || typeof code === "number" ? code : null,
      rootCode: typeof rootCode === "string" || typeof rootCode === "number" ? rootCode : null,
      type: typeof type === "string" ? type : null,
      message,
    });
  } catch {
    return false;
  }
}
