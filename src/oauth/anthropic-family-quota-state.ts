/** Per-instance passive family quota observation state with zero cache dependencies. */
import { credentialGeneration, getAccountCredential } from "./store";
import type { ProviderQuota, ProviderQuotaWindow } from "../providers/quota-types";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { GenerationContext } from "../lib/state-store-sweeper";
import { anthropicModelFamily } from "./anthropic-model-family";

export { anthropicModelFamily, type AnthropicModelFamily } from "./anthropic-model-family";

export const ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS = 30 * 60_000;

export function anthropicModelPercents(quota: ProviderQuota | null, model?: string): number[] {
  const family = anthropicModelFamily(model);
  return [quota?.fiveHourPercent, quota?.weeklyPercent, ...(!model ? [quota?.monthlyPercent] : []),
    ...(quota?.customWindows ?? []).filter(window => !model || window.scope !== "model" || (family && window.label === family)).map(window => window.percent)]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

interface FamilyObservation { generation: string; seenAt: number; resetAt?: number; busy: boolean; }
const keyFor = (id: string, family: string) => `${id}\0${family}`;

function createAnthropicFamilyQuotaState(instance: AnthropicInstanceId) {
  let spentFamilies: Map<string, FamilyObservation> | undefined;
  let familyGenerations: Map<string, number> | undefined;
  let nextFamilyGeneration = 1;
  let emptyGeneration = 0;
  function bump(id: string): void { (familyGenerations ??= new Map()).set(id, nextFamilyGeneration++); }
  function anthropicFamilyQuotaGeneration(id: string): number { return familyGenerations?.get(id) ?? emptyGeneration; }
  /** Reserving an asynchronous probe is a write; ordinary generation reads stay allocation-free. */
  function captureAnthropicFamilyQuotaGeneration(id: string): number {
    if (!familyGenerations?.has(id)) bump(id);
    return anthropicFamilyQuotaGeneration(id);
  }
  function ownedObservation(id: string, family: string): FamilyObservation | undefined {
    const key = keyFor(id, family);
    const entry = spentFamilies?.get(key);
    if (!entry) return undefined;
    const credential = getAccountCredential(instance, id);
    if (!credential || credentialGeneration(credential) !== entry.generation) { spentFamilies!.delete(key); bump(id); return undefined; }
    return entry;
  }
  function observeAnthropicFamilyQuota(id: string, windows: ProviderQuotaWindow[], now: number, authoritative = false): void {
    const credential = getAccountCredential(instance, id);
    if (!credential) return;
    if (!authoritative && !windows.some(window => window.scope === "model")) return;
    bump(id);
    const observations = spentFamilies ??= new Map();
    if (authoritative) for (const key of observations.keys()) if (key.startsWith(`${id}\0`)) observations.delete(key);
    for (const window of windows) {
      if (window.scope !== "model") continue;
      const key = keyFor(id, window.label);
      if (!window.rejected) { observations.delete(key); continue; }
      observations.set(key, { generation: credentialGeneration(credential), seenAt: now, resetAt: window.resetAt, busy: false });
    }
  }
  function anthropicFamilyRejected(id: string, model?: string, now = Date.now()): boolean {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    if (!entry) return false;
    if (entry.resetAt !== undefined && entry.resetAt <= now) return entry.busy;
    return entry.busy || now - entry.seenAt < ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS;
  }
  /** Only stale passive family exclusions require a request-driven single-flight physical send. */
  function claimAnthropicFamilyRevalidation(id: string, model?: string, now = Date.now()): (() => void) | null {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    if (!entry) return () => {};
    if (anthropicFamilyRejected(id, model, now)) return null;
    entry.busy = true;
    return () => { if (spentFamilies?.get(keyFor(id, family!)) === entry) entry.busy = false; };
  }
  /** An owned successful send proves admission for its requested family even without headers. */
  function clearAnthropicRequestedFamilyQuota(id: string, model?: string): void {
    const family = anthropicModelFamily(model);
    if (family && spentFamilies?.delete(keyFor(id, family))) bump(id);
  }
  function clearAnthropicFamilyQuota(): void {
    // A prior zero-generation claim must stay stale even after an identical account is re-added.
    emptyGeneration = nextFamilyGeneration++;
    spentFamilies = undefined;
    familyGenerations = undefined;
  }
  function reconcileAnthropicFamilyQuota(context: GenerationContext): number {
    let removed = 0;
    const retired = new Set<string>();
    for (const [key] of spentFamilies ?? []) {
      const id = key.slice(0, key.indexOf("\0"));
      if (context.oauthAccountKeys.has(`${instance}\0${id}`)) continue;
      spentFamilies!.delete(key); retired.add(id); removed++;
    }
    for (const id of familyGenerations?.keys() ?? []) {
      if (!context.oauthAccountKeys.has(`${instance}\0${id}`)) retired.add(id);
    }
    for (const id of retired) bump(id);
    return removed;
  }
  function anthropicFamilyRetryAt(id: string, model?: string, now = Date.now()): number | undefined {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    if (!entry || !anthropicFamilyRejected(id, model, now)) return undefined;
    return entry.busy ? now + 1000 : Math.min(entry.resetAt ?? Infinity, entry.seenAt + ANTHROPIC_PASSIVE_FAMILY_MAX_AGE_MS);
  }
  /**
   * The requested family's exclusion as a usage-limit fact: whether a revalidation send is in flight
   * (its answer may reopen the family within the second) and the upstream window reset, when known.
   * The admission deadline `anthropicFamilyRetryAt` is not that reset: passive evidence also expires
   * after thirty minutes.
   */
  function anthropicFamilyHoldState(id: string, model?: string): { revalidating: boolean; resetAt?: number } | undefined {
    const family = anthropicModelFamily(model);
    const entry = family && ownedObservation(id, family);
    return entry ? { revalidating: entry.busy, ...(entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {}) } : undefined;
  }
  return Object.freeze({
    instance,
    anthropicFamilyQuotaGeneration,
    captureAnthropicFamilyQuotaGeneration,
    observeAnthropicFamilyQuota,
    anthropicFamilyRejected,
    claimAnthropicFamilyRevalidation,
    clearAnthropicRequestedFamilyQuota,
    clearAnthropicFamilyQuota,
    anthropicFamilyRetryAt,
    anthropicFamilyHoldState,
    reconcileAnthropicFamilyQuota,
  });
}

export type AnthropicFamilyQuotaState = ReturnType<typeof createAnthropicFamilyQuotaState>;
const instances = new Map<AnthropicInstanceId, AnthropicFamilyQuotaState>();

export function anthropicFamilyQuotaStateFor(instance: AnthropicInstanceId): AnthropicFamilyQuotaState {
  let state = instances.get(instance);
  if (!state) { state = createAnthropicFamilyQuotaState(instance); instances.set(instance, state); }
  return state;
}

export function reconcileAllAnthropicFamilyQuota(context: GenerationContext): number {
  let removed = 0;
  for (const state of instances.values()) removed += state.reconcileAnthropicFamilyQuota(context);
  return removed;
}

export function clearAllAnthropicFamilyQuota(): void {
  for (const state of instances.values()) state.clearAnthropicFamilyQuota();
}
