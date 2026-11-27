// Ported from farion1231/cc-switch (src-tauri/src/proxy/thinking_budget_rectifier.rs, MIT License).
// Pre-rectifies and recoverably clamps Anthropic `thinking.budget_tokens` and `max_tokens`
// invariants while never modifying adaptive, disabled, or between_tools thinking requests.

import { claudeFamilyVersion, usesAdaptiveThinking } from "../anthropic-model-contract";
import { ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS } from "../../providers/registry/model-seeds";
import { modelRecordValue } from "../../reasoning-effort";
import type { EpxProviderConfig } from "../../types";

export const MIN_ANTHROPIC_THINKING_BUDGET = 1024;
export const MAX_ANTHROPIC_THINKING_BUDGET = 32_000;
export const DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS = 64_000;
export const MIN_ANTHROPIC_MAX_TOKENS_FOR_MAX_BUDGET = MAX_ANTHROPIC_THINKING_BUDGET + 1;
export const DEFAULT_ANTHROPIC_BUDGET_OUTPUT_HEADROOM = 8_192;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface RectifyAnthropicThinkingBudgetOptions {
  /** Target Claude model ID used for family/adaptive checks and output-cap resolution. */
  modelId?: string;
  /** Optional model output ceiling; rectified max_tokens never exceeds this value when positive. */
  modelMaxOutputTokens?: number;
  /** Repair max_tokens <= budget_tokens when enabled (default true in standalone helper). */
  rectifyMaxTokensMismatch?: boolean;
  /** Visible-output headroom added above budget_tokens when max_tokens must grow. */
  outputHeadroom?: number;
}

export interface RectifyAnthropicThinkingBudgetResult<T extends Rec = Rec> {
  body: T;
  applied: boolean;
}

/**
 * Matches Anthropic upstream HTTP 400 errors triggered by `thinking.budget_tokens`
 * constraints (`>= 1024` minimum or `max_tokens > thinking.budget_tokens`).
 */
export function shouldRectifyAnthropicThinkingBudgetError(errorText?: string | null): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  const hasBudgetRef = lower.includes("budget_tokens") || lower.includes("budget tokens");
  const hasThinkingRef = lower.includes("thinking");
  if (!hasBudgetRef || !hasThinkingRef) return false;
  return lower.includes("greater than or equal to 1024")
    || lower.includes(">= 1024")
    || (lower.includes("1024") && lower.includes("input should be"))
    || lower.includes("max_tokens must be greater than")
    || lower.includes("must be less than max_tokens");
}

function validModelCeiling(raw?: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > MIN_ANTHROPIC_THINKING_BUDGET + 1) {
    return Math.trunc(raw);
  }
  return DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS;
}

function normalizeClaudeModelSlug(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const match = /(?:^|\/)(claude-[^/@\s\[]+)/i.exec(trimmed);
  return match ? match[1]! : trimmed;
}

function resolveEffectiveModelId(body: Rec, modelId?: string | null): string | undefined {
  if (typeof modelId === "string" && modelId.trim().length > 0) return modelId;
  return typeof body.model === "string" && body.model.trim().length > 0 ? body.model : undefined;
}

function isPositiveCeiling(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > MIN_ANTHROPIC_THINKING_BUDGET + 1;
}

/** Resolves the safe max_tokens ceiling for a Claude model during thinking rectification. */
export function resolveAnthropicThinkingModelMaxOutputTokens(
  modelId?: string | null,
  provider?: Pick<EpxProviderConfig, "defaultMaxOutputTokens" | "modelMaxOutputTokens">,
): number {
  const trimmedId = typeof modelId === "string" ? modelId.trim() : undefined;
  const normalizedSlug = trimmedId ? normalizeClaudeModelSlug(trimmedId) : undefined;

  if (provider?.modelMaxOutputTokens && trimmedId) {
    const perModel = modelRecordValue(provider.modelMaxOutputTokens, trimmedId)
      ?? (normalizedSlug ? modelRecordValue(provider.modelMaxOutputTokens, normalizedSlug) : undefined);
    if (isPositiveCeiling(perModel)) {
      return Math.trunc(perModel);
    }
  }

  const defaultCap = isPositiveCeiling(provider?.defaultMaxOutputTokens)
    ? Math.trunc(provider!.defaultMaxOutputTokens!)
    : undefined;

  if (normalizedSlug) {
    const parsed = claudeFamilyVersion(normalizedSlug);
    if (parsed?.family === "opus" && parsed.major === 4 && parsed.minor <= 1) {
      return defaultCap !== undefined ? Math.min(32_000, defaultCap) : 32_000;
    }
    if (/^claude-3[.-]5-(?:sonnet|haiku)(?:[-@]|$)/.test(normalizedSlug)) {
      return defaultCap !== undefined ? Math.min(8_192, defaultCap) : 8_192;
    }
    if (/^claude-3-(?:opus|sonnet|haiku)(?:[-@]|$)/.test(normalizedSlug)) {
      return defaultCap !== undefined ? Math.min(4_096, defaultCap) : 4_096;
    }
    if (/^claude-3[.-]7-sonnet(?:[-@]|$)/.test(normalizedSlug)) {
      return defaultCap !== undefined ? Math.min(64_000, defaultCap) : 64_000;
    }
  }

  if (defaultCap !== undefined) {
    return defaultCap;
  }

  if (normalizedSlug) {
    const seeded = ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[normalizedSlug];
    if (isPositiveCeiling(seeded)) {
      return seeded;
    }
  }

  return DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS;
}

function shouldSkipThinkingRectification(body: Rec, modelId?: string): boolean {
  if (modelId && usesAdaptiveThinking(modelId)) {
    return true;
  }
  if (isRec(body.thinking)) {
    const t = body.thinking.type;
    if (t === "adaptive" || t === "disabled" || t === "between_tools") {
      return true;
    }
  }
  return false;
}

/**
 * Pre-request sanitizer for Anthropic `thinking.budget_tokens`:
 * - Skips adaptive-thinking Claude families (`opus-4-7+`, `sonnet-5+`, `haiku-5-5+`, `fable`),
 *   requests without `thinking`, or `thinking.type` === `"adaptive"` | `"disabled"` | `"between_tools"`.
 * - For `thinking.type === "enabled"`: repairs missing, non-integer, or `< 1024` `budget_tokens`
 *   to at least `MIN_ANTHROPIC_THINKING_BUDGET` (`1024`), and (when `rectifyMaxTokensMismatch !== false`)
 *   ensures `max_tokens > budget_tokens` within the model's ceiling.
 */
export function rectifyAnthropicThinkingBudgetPreRequest<T extends Rec>(
  body: T,
  options: RectifyAnthropicThinkingBudgetOptions = {},
): RectifyAnthropicThinkingBudgetResult<T> {
  if (!isRec(body) || !isRec(body.thinking)) {
    return { body, applied: false };
  }
  const effectiveModel = resolveEffectiveModelId(body, options.modelId);
  if (shouldSkipThinkingRectification(body, effectiveModel)) {
    return { body, applied: false };
  }
  if (body.thinking.type !== "enabled") {
    return { body, applied: false };
  }

  const ceiling = options.modelMaxOutputTokens !== undefined
    ? validModelCeiling(options.modelMaxOutputTokens)
    : resolveAnthropicThinkingModelMaxOutputTokens(effectiveModel);
  const rawBudget = body.thinking.budget_tokens;
  const rawValidBudget = typeof rawBudget === "number" && Number.isFinite(rawBudget)
    ? Math.trunc(rawBudget)
    : undefined;

  let nextBudget = rawValidBudget === undefined || rawValidBudget < MIN_ANTHROPIC_THINKING_BUDGET
    ? MIN_ANTHROPIC_THINKING_BUDGET
    : rawValidBudget;

  const rawMaxTokens = body.max_tokens;
  const rawValidMax = typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
    ? Math.trunc(rawMaxTokens)
    : undefined;

  let nextMaxTokens = rawValidMax;
  const fixMaxOrder = options.rectifyMaxTokensMismatch !== false;
  if (fixMaxOrder && (nextMaxTokens === undefined || nextMaxTokens <= nextBudget)) {
    const headroom = Math.max(1, Math.trunc(options.outputHeadroom ?? DEFAULT_ANTHROPIC_BUDGET_OUTPUT_HEADROOM));
    const targetMax = Math.max(nextBudget + headroom, MIN_ANTHROPIC_MAX_TOKENS_FOR_MAX_BUDGET);
    nextMaxTokens = Math.min(ceiling, targetMax);
    if (nextMaxTokens <= nextBudget) {
      nextBudget = Math.max(MIN_ANTHROPIC_THINKING_BUDGET, nextMaxTokens - 1);
      if (nextMaxTokens <= nextBudget) nextMaxTokens = nextBudget + 1;
    }
  }

  const budgetChanged = nextBudget !== rawBudget;
  const maxChanged = fixMaxOrder && nextMaxTokens !== rawMaxTokens;
  if (!budgetChanged && !maxChanged) {
    return { body, applied: false };
  }

  const nextBody: Rec = {
    ...body,
    thinking: {
      ...body.thinking,
      type: "enabled",
      budget_tokens: nextBudget,
    },
    ...(maxChanged && nextMaxTokens !== undefined ? { max_tokens: nextMaxTokens } : {}),
  };
  return { body: nextBody as T, applied: true };
}

/**
 * Error-recovery rectifier aligned with farion1231/cc-switch:
 * - Skips adaptive-thinking models and `adaptive` / `disabled` / `between_tools` thinking types.
 * - Normalizes `thinking` to `{ type: "enabled", budget_tokens: 32000 }` (clamped below model ceiling).
 * - Ensures `max_tokens >= 64000` (or model ceiling) when absent or `< 32001`.
 */
export function rectifyAnthropicThinkingBudgetOnError<T extends Rec>(
  body: T,
  options: Pick<RectifyAnthropicThinkingBudgetOptions, "modelId" | "modelMaxOutputTokens"> = {},
): RectifyAnthropicThinkingBudgetResult<T> {
  if (!isRec(body)) return { body, applied: false };
  const effectiveModel = resolveEffectiveModelId(body, options.modelId);
  if (shouldSkipThinkingRectification(body, effectiveModel)) {
    return { body, applied: false };
  }

  const explicitCeiling = options.modelMaxOutputTokens !== undefined;
  const ceiling = explicitCeiling
    ? validModelCeiling(options.modelMaxOutputTokens)
    : resolveAnthropicThinkingModelMaxOutputTokens(effectiveModel);
  const rawMax = body.max_tokens;
  const existingMax = typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
    ? Math.trunc(rawMax)
    : undefined;
  const shouldClampExisting = explicitCeiling || ceiling !== DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS;
  const clampedExisting = existingMax !== undefined && shouldClampExisting
    ? Math.min(ceiling, existingMax)
    : existingMax;

  const targetMax = clampedExisting === undefined || clampedExisting < Math.min(ceiling, MIN_ANTHROPIC_MAX_TOKENS_FOR_MAX_BUDGET)
    ? ceiling
    : clampedExisting;
  const targetBudget = Math.min(MAX_ANTHROPIC_THINKING_BUDGET, Math.max(MIN_ANTHROPIC_THINKING_BUDGET, targetMax - 1));
  const finalMax = targetMax <= targetBudget ? targetBudget + 1 : targetMax;

  const currentThinking = isRec(body.thinking) ? body.thinking : {};
  const thinkingChanged = currentThinking.type !== "enabled" || currentThinking.budget_tokens !== targetBudget;
  const maxChanged = rawMax !== finalMax;
  if (!thinkingChanged && !maxChanged) {
    return { body, applied: false };
  }

  const nextBody: Rec = {
    ...body,
    thinking: {
      ...currentThinking,
      type: "enabled",
      budget_tokens: targetBudget,
    },
    max_tokens: finalMax,
  };
  return { body: nextBody as T, applied: true };
}
