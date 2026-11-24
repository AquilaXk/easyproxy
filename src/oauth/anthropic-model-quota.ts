/** Model-scoped passive quota evidence. Reimplemented from documented behavior, not ported code. */
import { getCachedProviderAccountQuota } from "../providers/quota/account-cache";
import type { ProviderQuota, ProviderQuotaWindow } from "../providers/quota-types";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { GenerationContext } from "../lib/state-store-sweeper";
import { familyWeeklyEquivalentPercent } from "../providers/quota/anthropic-usage-windows";
import {
  ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS,
  anthropicFamilyQuotaStateFor,
  anthropicModelFamily,
  anthropicModelPercents,
  clearAllAnthropicFamilyQuota,
  reconcileAllAnthropicFamilyQuota,
} from "./anthropic-family-quota-state";

export {
  ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS,
  anthropicModelFamily,
  anthropicModelPercents,
  clearAllAnthropicFamilyQuota,
  reconcileAllAnthropicFamilyQuota,
  type AnthropicModelFamily,
} from "./anthropic-family-quota-state";

function createAnthropicModelQuota(instance: AnthropicInstanceId) {
  const state = anthropicFamilyQuotaStateFor(instance);
  function anthropicModelExhausted(accountId: string, model?: string): boolean {
    return anthropicModelPercents(getCachedProviderAccountQuota(instance, accountId), model).some(percent => percent >= 100);
  }
  return Object.freeze({
    ...state,
    anthropicModelExhausted,
  });
}

export type AnthropicModelQuota = ReturnType<typeof createAnthropicModelQuota>;
const instances = new Map<AnthropicInstanceId, AnthropicModelQuota>();
export function anthropicModelQuotaFor(instance: AnthropicInstanceId): AnthropicModelQuota {
  let facade = instances.get(instance);
  if (!facade) { facade = createAnthropicModelQuota(instance); instances.set(instance, facade); }
  return facade;
}
export function anthropicModelExhausted(accountId: string, model?: string): boolean {
  return anthropicModelQuotaFor("anthropic").anthropicModelExhausted(accountId, model);
}
export function anthropicFamilyQuotaGeneration(id: string): number {
  return anthropicModelQuotaFor("anthropic").anthropicFamilyQuotaGeneration(id);
}
export function observeAnthropicFamilyQuota(id: string, windows: ProviderQuotaWindow[], now: number, authoritative = false): void {
  anthropicModelQuotaFor("anthropic").observeAnthropicFamilyQuota(id, windows, now, authoritative);
}
export function anthropicFamilyRejected(id: string, model?: string, now = Date.now()): boolean {
  return anthropicModelQuotaFor("anthropic").anthropicFamilyRejected(id, model, now);
}
export function claimAnthropicFamilyRevalidation(id: string, model?: string, now = Date.now()): (() => void) | null {
  return anthropicModelQuotaFor("anthropic").claimAnthropicFamilyRevalidation(id, model, now);
}
export function clearAnthropicRequestedFamilyQuota(id: string, model?: string): void {
  anthropicModelQuotaFor("anthropic").clearAnthropicRequestedFamilyQuota(id, model);
}
export function clearAnthropicFamilyQuota(): void { anthropicModelQuotaFor("anthropic").clearAnthropicFamilyQuota(); }
export function anthropicFamilyRetryAt(id: string, model?: string, now = Date.now()): number | undefined {
  return anthropicModelQuotaFor("anthropic").anthropicFamilyRetryAt(id, model, now);
}
export function reconcileAnthropicFamilyQuota(context: GenerationContext): number {
  return anthropicModelQuotaFor("anthropic").reconcileAnthropicFamilyQuota(context);
}

export function anthropicModelWeeklyPercent(quota: ProviderQuota | null, model?: string): number | undefined {
  const family = anthropicModelFamily(model);
  return family ? quota?.customWindows?.find(window => window.scope === "model" && window.label === family)?.percent : undefined;
}

/**
 * The requested family's usage for comparing accounts, restated on the shared weekly scale when
 * upstream reported its allowance. Thresholds keep `anthropicModelWeeklyPercent`: a fresh Fable
 * seat reads 50 here, which ranks correctly but is not usage an operator's threshold means.
 */
export function anthropicModelRankPercent(quota: ProviderQuota | null, model?: string): number | undefined {
  const family = anthropicModelFamily(model);
  const window = family ? quota?.customWindows?.find(window => window.scope === "model" && window.label === family) : undefined;
  return window ? familyWeeklyEquivalentPercent(window) : undefined;
}
