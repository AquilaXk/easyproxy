/**
 * Anthropic fast mode (`speed: "fast"`): wire constants and refusal recognition.
 *
 * Fast mode is a separately entitled, separately rate-limited lane on the same Opus models
 * (https://platform.claude.com/docs/en/build-with-claude/fast-mode). The Messages API never
 * falls back on its own: an account without usage credits gets a 429, an organization that has
 * not enabled the feature gets a 400, and a model outside the lane gets a 400 naming the
 * `speed` parameter. Claude Code retries such a request at standard speed; the adapter
 * dispatch loop does the same, once per request.
 *
 * Recognition is deliberately narrow. A generic 429 or 529 on a fast request may be an ordinary
 * account rate limit and must keep flowing into the existing wait/rotation handling, so only an
 * error message that names fast mode or the speed parameter, a fast-pool header reporting
 * zero remaining, or `anthropic-ratelimit-unified-overage-disabled-reason` counts.
 * Overage-disabled reason classification adapted from `tribgames/mixdog` (`fast_mode.rs`,
 * Apache-2.0). Live probe strings (2026-09-23,
 * devlog/_fin/260923_anthropic_fast_speed/020_probe-evidence.md):
 *   429 "Usage credits are required for fast mode."
 *   400 "Fast mode is not enabled for your organization. ..."
 *   400 "'<model>' does not support the `speed` parameter. ..."
 */

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
export const ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER = "anthropic-ratelimit-unified-overage-disabled-reason";

export type AnthropicFastRefusalClass = "transient" | "disabled" | "unsupported";

const MAX_FAST_REFUSAL_BODY_BYTES = 8_192;
const FAST_REFUSAL_MESSAGE = /\bfast mode\b|\bspeed\b\W{0,2} parameter/i;
const FAST_UNSUPPORTED_MESSAGE = /does not support\b[\s\S]*\bspeed\b|\bspeed\b\W{0,2} parameter/i;
const FAST_POOL_REMAINING_HEADER = /^anthropic-fast-(?:input|output)-tokens-remaining$/i;
const TRANSIENT_OVERAGE_REASONS = new Set(["org_level_disabled_until", "out_of_credits"]);
const DISABLED_OVERAGE_REASONS = new Set(["overage_not_provisioned", "org_level_disabled"]);
const STANDARD_QUOTA_STATUS_HEADERS = [
  "anthropic-ratelimit-unified-5h-status",
  "anthropic-ratelimit-unified-7d-status",
  "anthropic-ratelimit-unified-7d_oi-status",
] as const;
const STANDARD_REPRESENTATIVE_CLAIM_RE = /^(?:five_hour|seven_day(?:_oauth_apps|_opus|_sonnet|_overage_included)?)$/i;

function anthropicErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText.slice(0, MAX_FAST_REFUSAL_BODY_BYTES));
    if (!parsed || typeof parsed !== "object") return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object") return undefined;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function fastPoolExhausted(headers: Headers): boolean {
  let exhausted = false;
  headers.forEach((value, name) => {
    if (FAST_POOL_REMAINING_HEADER.test(name) && value.trim() === "0") exhausted = true;
  });
  return exhausted;
}

function hasStandardQuotaRejectionHeader(headers: Headers): boolean {
  for (const name of STANDARD_QUOTA_STATUS_HEADERS) {
    if (headers.get(name)?.trim().toLowerCase() === "rejected") return true;
  }
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim")?.trim().toLowerCase();
  if (claim !== undefined && STANDARD_REPRESENTATIVE_CLAIM_RE.test(claim)) return true;
  const unifiedStatus = headers.get("anthropic-ratelimit-unified-status")?.trim().toLowerCase();
  if (unifiedStatus !== "rejected") return false;
  const overageStatus = headers.get("anthropic-ratelimit-unified-overage-status")?.trim().toLowerCase();
  const hasAllowedStandardWindow = ["anthropic-ratelimit-unified-5h-status", "anthropic-ratelimit-unified-7d-status"]
    .some(name => {
      const value = headers.get(name)?.trim().toLowerCase();
      return value === "allowed" || value === "allowed_warning";
    });
  return overageStatus !== "rejected"
    && claim !== "overage"
    && claim !== "slow"
    && !hasAllowedStandardWindow;
}

/**
 * Classify a fast-lane refusal (`speed: "fast"`) into transient credit/window exhaustion vs
 * org/feature disablement vs unsupported model/parameter, or `null` when it is an ordinary
 * account limit / unrelated error.
 */
export function classifyAnthropicFastRefusal(
  status: number,
  headers: Headers,
  bodyText: string | undefined,
): AnthropicFastRefusalClass | null {
  if (status === 400) {
    const message = bodyText === undefined ? undefined : anthropicErrorMessage(bodyText);
    if (!message || !FAST_REFUSAL_MESSAGE.test(message)) return null;
    if (FAST_UNSUPPORTED_MESSAGE.test(message)) return "unsupported";
    return "disabled";
  }
  if (status !== 429) return null;
  const fastExhausted = fastPoolExhausted(headers);
  const message = bodyText === undefined ? undefined : anthropicErrorMessage(bodyText);
  const messageNamesFast = message !== undefined && FAST_REFUSAL_MESSAGE.test(message);
  const overageReason = headers.get(ANTHROPIC_OVERAGE_DISABLED_REASON_HEADER)?.trim().toLowerCase();
  if (overageReason) {
    if (hasStandardQuotaRejectionHeader(headers) && !fastExhausted && !messageNamesFast) {
      return null;
    }
    if (TRANSIENT_OVERAGE_REASONS.has(overageReason)) return "transient";
    if (DISABLED_OVERAGE_REASONS.has(overageReason)) return "disabled";
  }
  if (fastExhausted) return "transient";
  return messageNamesFast ? "transient" : null;
}

/**
 * Whether a response to a request that actually sent `speed: "fast"` is a fast-lane refusal a
 * standard-speed resend can recover. Pure; the caller supplies a bounded body read.
 */
export function isAnthropicFastRefusal(
  status: number,
  headers: Headers,
  bodyText: string | undefined,
): boolean {
  return classifyAnthropicFastRefusal(status, headers, bodyText) !== null;
}

/**
 * Merge beta tokens into the single `anthropic-beta` header, case-insensitively. Header
 * overrides may spell the name in any case; two spellings in one plain object would reach the
 * wire as two headers (Headers comma-joins them), so every spelling collapses into one
 * lowercase key with deduplicated tokens in first-seen order.
 */
export function mergeAnthropicBetaHeader(
  headers: Record<string, string>,
  extraBetas: readonly string[] = [],
): void {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    for (const part of raw.split(",")) {
      const token = part.trim();
      if (!token || seen.has(token.toLowerCase())) continue;
      seen.add(token.toLowerCase());
      tokens.push(token);
    }
  };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== "anthropic-beta") continue;
    add(headers[name] ?? "");
    delete headers[name];
  }
  for (const beta of extraBetas) add(beta);
  if (tokens.length > 0) headers["anthropic-beta"] = tokens.join(",");
}
