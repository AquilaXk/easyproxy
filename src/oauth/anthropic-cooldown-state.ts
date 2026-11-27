/** Per-instance Anthropic cooldown health and generation fences with zero routing/cache cycles. */
import type { GenerationContext } from "../lib/state-store-sweeper";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";

/**
 * Where a cooldown's length came from. Same vocabulary as `CodexCooldownSource`:
 * `retry-after` is upstream answering THIS refusal, `reset-derived` is upstream stating
 * when the spent window reopens, and `default` is our own fallback.
 */
export type AnthropicCooldownSource = "retry-after" | "reset-derived" | "default";
export type AnthropicQuotaWindow = "five-hour" | "weekly";

export interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: AnthropicCooldownSource;
  /** Windows whose rejected status established a reset-derived cooldown. */
  rejectedQuotaWindows?: AnthropicQuotaWindow[];
  /** Monotonic fence so an older quota probe cannot erase a newer refusal. */
  cooldownGeneration: number;
  /** When the refusal was recorded; a reset settled earlier must not lift it. */
  recordedAt: number;
  /** 429 (shared quota) or 403/402/400 (entitlement/billing); only a quota refusal can be lifted by a reset grant. */
  refusalStatus: 429 | 403 | 402 | 400;
  /** Windows a 429 reported as rejected, whatever set the deadline; empty when it named none. */
  refusedQuotaWindows: AnthropicQuotaWindow[];
  /**
   * When the rejected windows reopen according to upstream's reset headers, kept even when
   * Retry-After set the deadline.
   */
  quotaResetAt?: number;
}

/** No health/affinity bucket is allocated by a read or an event for a dormant instance. */
export class RoutingMap<K, V> implements Iterable<[K, V]> {
  private rows?: Map<K, V>;
  get size(): number { return this.rows?.size ?? 0; }
  get(key: K): V | undefined { return this.rows?.get(key); }
  set(key: K, value: V): void { (this.rows ??= new Map()).set(key, value); }
  delete(key: K): boolean { return this.rows?.delete(key) ?? false; }
  clear(): void { this.rows = undefined; }
  *entries(): IterableIterator<[K, V]> { if (this.rows) yield* this.rows; }
  [Symbol.iterator](): IterableIterator<[K, V]> { return this.entries(); }
}

function createAnthropicCooldownState(instance: AnthropicInstanceId) {
  const upstreamHealth = new RoutingMap<string, AccountHealth>();
  let cooldownGenerationByAccount: Map<string, number> | undefined;
  let emptyGeneration = 0;
  let nextCooldownGeneration = 1;
  // Account lifetime is distinct from refusal/probe mutations; a valid refusal must not revoke itself.
  let accountIncarnations: Map<string, number> | undefined;
  let emptyAccountIncarnation = 0;
  let nextAccountIncarnation = 1;

  /** Monotonic per-account fence shared by routing mutations and quota publication. */
  function anthropicCooldownGeneration(accountId: string): number {
    return cooldownGenerationByAccount?.get(accountId) ?? emptyGeneration;
  }

  function noteAnthropicCooldownMutation(accountId: string): number {
    const generation = nextCooldownGeneration++;
    (cooldownGenerationByAccount ??= new Map()).set(accountId, generation);
    return generation;
  }

  function reserveCooldownGeneration(accountId: string): number {
    return cooldownGenerationByAccount?.get(accountId) ?? noteAnthropicCooldownMutation(accountId);
  }

  function anthropicAccountIncarnation(accountId: string): number {
    return accountIncarnations?.get(accountId) ?? emptyAccountIncarnation;
  }

  function reserveAnthropicAccountIncarnation(accountId: string): number {
    const existing = accountIncarnations?.get(accountId);
    if (existing !== undefined) return existing;
    const incarnation = nextAccountIncarnation++;
    (accountIncarnations ??= new Map()).set(accountId, incarnation);
    return incarnation;
  }

  function clearAnthropicCooldownGenerations(): void {
    emptyGeneration = nextCooldownGeneration++;
    cooldownGenerationByAccount = undefined;
    emptyAccountIncarnation = nextAccountIncarnation++;
    accountIncarnations = undefined;
  }

  function getAnthropicAccountHealthSnapshot(
    accountId: string,
    now = Date.now(),
  ): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
    const entry = upstreamHealth.get(accountId);
    if (!entry) return null;
    if (entry.cooldownUntil <= now) {
      upstreamHealth.delete(accountId);
      noteAnthropicCooldownMutation(accountId);
      return null;
    }
    return { cooldownUntil: entry.cooldownUntil, cooldownSource: entry.cooldownSource };
  }

  function reconcileAnthropicCooldownGenerations(context: GenerationContext): number {
    // Probe reservations include accounts with no cooldown, so every claim retires here.
    for (const id of cooldownGenerationByAccount?.keys() ?? []) {
      if (!context.oauthAccountKeys.has(`${instance}\0${id}`)) noteAnthropicCooldownMutation(id);
    }
    for (const id of accountIncarnations?.keys() ?? []) {
      if (!context.oauthAccountKeys.has(`${instance}\0${id}`)) accountIncarnations!.set(id, nextAccountIncarnation++);
    }
    return 0; // Tombstones are retained, never reclaimed into an older generation.
  }

  return Object.freeze({
    instance,
    upstreamHealth,
    anthropicCooldownGeneration,
    reserveCooldownGeneration,
    noteAnthropicCooldownMutation,
    anthropicAccountIncarnation,
    reserveAnthropicAccountIncarnation,
    clearAnthropicCooldownGenerations,
    getAnthropicAccountHealthSnapshot,
    reconcileAnthropicCooldownGenerations,
  });
}

export type AnthropicCooldownState = ReturnType<typeof createAnthropicCooldownState>;
const instances = new Map<AnthropicInstanceId, AnthropicCooldownState>();

export function anthropicCooldownStateFor(instance: AnthropicInstanceId): AnthropicCooldownState {
  let state = instances.get(instance);
  if (!state) { state = createAnthropicCooldownState(instance); instances.set(instance, state); }
  return state;
}

export function reconcileAllAnthropicCooldownGenerations(context: GenerationContext): number {
  for (const state of instances.values()) state.reconcileAnthropicCooldownGenerations(context);
  return 0;
}

export function clearAllAnthropicCooldownGenerations(): void {
  for (const state of instances.values()) state.clearAnthropicCooldownGenerations();
}
