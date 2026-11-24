import { boundDecisionWindows, publishAnthropicDecisionQuota } from "../quota-decision-publication";
import { decisionQuotaSinkActive, publishDecisionAccountQuota } from "../../lib/decision-quota-sink";
import { mergeAnthropicFamilyWindows, hasAnthropicFamilyEnumeration } from "./anthropic-family-headers";
import { getCachedProviderAccountQuota, captureProviderAccountQuotaEpoch, type AccountQuotaCacheEntry } from "./account-cache";
import { anthropicFamilyQuotaStateFor } from "../../oauth/anthropic-family-quota-state";
import {
  anthropicCooldownStateFor,
  clearAllAnthropicCooldownGenerations,
  reconcileAllAnthropicCooldownGenerations,
} from "../../oauth/anthropic-cooldown-state";
export {
  clearAllAnthropicCooldownGenerations,
  reconcileAllAnthropicCooldownGenerations,
};
import type { AnthropicInstanceId } from "../anthropic-instance-id";
import type { GenerationContext } from "../../lib/state-store-sweeper";
import { anthropicCredentialEvidenceKey, credentialGeneration, getAccountCredentialWithStatus, getAccountSet } from "../../oauth/store";
import type { ProviderQuota } from "../quota-types";
import type { AnthropicUsageProbe } from "../claude-cli-usage";

export class AnthropicQuotaProbeOwnershipError extends Error {}

export type AnthropicCooldownRecoveryProbe = Readonly<{
  instance: AnthropicInstanceId;
  generation: string;
  credentialKey: string;
  requiresFreshDispatch: boolean;
  isCurrentCredential(): boolean;
  isCurrentFamily(): boolean;
  isCurrent(): boolean;
  settle(quota: ProviderQuota): "cleared" | "retained" | "superseded";
}>;

export type AnthropicQuotaRecoveryResult = Readonly<{
  instance: AnthropicInstanceId;
  credentialKey: string;
  /** Null only when the response retires the monthly fallback without supplying meters. */
  quota: ProviderQuota | null;
  /** Account cache diagnostics for a retirement-only response. */
  failureFields?: Pick<AccountQuotaCacheEntry, "unavailable" | "quotaFailure" | "quotaFailureIsCurrent">;
  dispatch?: number;
  /** Publishes secret-free advisory evidence for the primary pool only; a no-op for Pool 2. */
  publishDecisionQuota(): void;
  /** Must be checked synchronously at each publication boundary. */
  isCurrent(): boolean;
}>;

export type DispatchedAnthropicUsageProbe = AnthropicUsageProbe & {
  dispatch: number;
  isQuotaDispatchCurrent(accountId: string): boolean;
};

/** Create the cooldown-recovery probe owner for one Anthropic instance; its results are credential- and generation-bound before they may publish. */
function createAnthropicCooldownRecovery(instance: AnthropicInstanceId) {
  const familyGeneration = (accountId: string) => anthropicFamilyQuotaStateFor(instance).anthropicFamilyQuotaGeneration(accountId);

  /** Check live pause and bearer ownership at the last synchronous step before usage dispatch. */
  function assertAnthropicQuotaSendAllowed(accountId: string, token: string): void {
    const row = getAccountCredentialWithStatus(instance, accountId);
    if (!row || row.paused || row.needsReauth || row.credential.access !== token) {
      throw new AnthropicQuotaProbeOwnershipError(`${instance} quota account is no longer eligible`);
    }
  }

  const {
    anthropicCooldownGeneration,
    reserveCooldownGeneration,
    noteAnthropicCooldownMutation,
    anthropicAccountIncarnation,
    reserveAnthropicAccountIncarnation,
    clearAnthropicCooldownGenerations,
    reconcileAnthropicCooldownGenerations,
  } = anthropicCooldownStateFor(instance);
  let afterSettlementForTests: (() => void) | undefined;

  function setAnthropicQuotaAfterSettlementForTests(hook: (() => void) | undefined): void {
    afterSettlementForTests = hook;
  }

  /** Keep same-state quota calls joinable while moving post-429 calls to a fresh flight. */
  function anthropicCooldownFlightKey(baseKey: string, accountId: string): string {
    // Flight reservation establishes an incarnation even without prior refusal evidence.
    const generation = reserveCooldownGeneration(accountId);
    return `${baseKey}\0${instance}-cooldown:${generation}`;
  }

  /** Active usage readers bind this key after token refresh; renewal keeps the legacy flight valid. */
  function anthropicCredentialQuotaFlightKey(baseKey: string, accountId: string): string {
    const row = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
    return `${anthropicCooldownFlightKey(baseKey, accountId)}\0${row ? anthropicCredentialEvidenceKey(row) : "missing"}`;
  }

  /**
   * Bind a quota probe to both the credential and cooldown generations it observed before
   * dispatch. A successful response may otherwise arrive after either credential replacement
   * or a newer 429 and incorrectly make unrelated state eligible.
   */
  async function captureAnthropicCooldownRecoveryProbe(
    accountId: string,
    accessToken: string,
  ): Promise<AnthropicCooldownRecoveryProbe | null> {
    const initialRow = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
    if (!initialRow || initialRow.paused || initialRow.needsReauth || initialRow.credential.access !== accessToken) return null;
    const generation = credentialGeneration(initialRow.credential);
    const credentialKey = anthropicCredentialEvidenceKey(initialRow);
    const incarnation = reserveAnthropicAccountIncarnation(accountId);
    const quotaEpoch = captureProviderAccountQuotaEpoch(instance);
    const isCurrentCredential = () => {
      const current = getAccountSet(instance)?.accounts.find(row => row.id === accountId);
      return quotaEpoch === captureProviderAccountQuotaEpoch(instance)
        && anthropicAccountIncarnation(accountId) === incarnation
        && !!current && anthropicCredentialEvidenceKey(current) === credentialKey;
    };
    // Lazy because anthropic-routing reads the quota cache on normal request routing.
    const { anthropicRoutingFor } = await import("../../oauth/anthropic-routing");
    const routing = anthropicRoutingFor(instance);
    if (!isCurrentCredential()) return null;
    const cooldownGeneration = reserveCooldownGeneration(accountId);
    const capturedFamilyGeneration = anthropicFamilyQuotaStateFor(instance).captureAnthropicFamilyQuotaGeneration(accountId);
    const claim = routing.captureAnthropicCooldownRecovery(accountId);
    return {
      instance,
      generation,
      credentialKey,
      requiresFreshDispatch: claim !== null,
      isCurrentCredential,
      isCurrentFamily: () => familyGeneration(accountId) === capturedFamilyGeneration,
      isCurrent: () => isCurrentCredential()
        && anthropicCooldownGeneration(accountId) === cooldownGeneration,
      settle: quota => !isCurrentCredential() || anthropicCooldownGeneration(accountId) !== cooldownGeneration ? "superseded"
        : claim === null ? "retained" : routing.settleAnthropicCooldownRecovery(claim, quota),
    };
  }

  /** Run one authoritative usage read and publish its recovery effect only while still owned. */
  async function probeAnthropicQuotaWithRecovery(
    accountId: string,
    accessToken: string,
    read: (requireFreshDispatch: boolean) => Promise<DispatchedAnthropicUsageProbe | ProviderQuota | null>,
    mayPublish: () => boolean,
  ): Promise<AnthropicQuotaRecoveryResult | null> {
    const probe = await captureAnthropicCooldownRecoveryProbe(accountId, accessToken);
    if (!probe) throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe lost credential ownership`);
    if (!probe.isCurrent() || !mayPublish()) throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe lost dispatch ownership`);
    let readResult: DispatchedAnthropicUsageProbe | ProviderQuota | null;
    try { readResult = await read(probe.requiresFreshDispatch); }
    catch (error) {
      if (!probe.isCurrent() || !mayPublish()) throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe failure is stale`);
      throw error;
    }
    const observation = readResult && "quota" in readResult ? readResult : undefined;
    let quota = readResult && "quota" in readResult ? readResult.quota : readResult;
    const monthlyFallback = quota?.monthlyPercent !== undefined;
    const observationCurrent = () => mayPublish() && observation?.isQuotaDispatchCurrent(accountId) !== false;
    if (!probe.isCurrent() || !observationCurrent()) {
      throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe result is stale`);
    }
    if (!quota) {
      if (!observation?.retireMonthlyFallback) return null;
      const isCurrent = () => probe.isCurrent() && observationCurrent();
      return {
        instance, credentialKey: probe.credentialKey, quota: null, dispatch: observation.dispatch, isCurrent,
        failureFields: {
          unavailable: true,
          ...(observation.failure ? { quotaFailure: observation.failure, quotaFailureIsCurrent: isCurrent } : {}),
        },
        publishDecisionQuota: () => {
          if (instance === "anthropic" && decisionQuotaSinkActive() && isCurrent()) {
            publishAnthropicDecisionQuota(accountId, probe.generation, null, true);
          }
        },
      };
    }
    const settlement = probe.settle(quota);
    if (settlement === "superseded") {
      throw new AnthropicQuotaProbeOwnershipError(`${instance} quota probe lost cooldown ownership`);
    }
    // Clearing the claimed cooldown intentionally advances the fence. Adopt that exact new
    // generation; any later observation/429 then invalidates publication before a cache write.
    const rawQuota = quota;
    const ownsFamily = probe.isCurrentFamily();
    const authoritative = ownsFamily && hasAnthropicFamilyEnumeration(quota);
    if (ownsFamily) anthropicFamilyQuotaStateFor(instance).observeAnthropicFamilyQuota(accountId, quota.customWindows ?? [], quota.updatedAt, authoritative);
    if (!authoritative && !monthlyFallback) {
      const cached = getCachedProviderAccountQuota(instance, accountId)?.customWindows;
      const windows = ownsFamily ? mergeAnthropicFamilyWindows(cached, quota.customWindows)
        : cached ?? [];
      // A superseded family enumeration has no authority, including over absent families.
      if (!ownsFamily || windows.length) quota = { ...quota, customWindows: windows };
    }
    const publicationGeneration = anthropicCooldownGeneration(accountId);
    const publicationFamilyGeneration = familyGeneration(accountId);
    /** True while the probed credential, cooldown generation and family generation are unchanged and publication is still permitted. */
    const isCurrent = () => probe.isCurrentCredential()
      && anthropicCooldownGeneration(accountId) === publicationGeneration
      && familyGeneration(accountId) === publicationFamilyGeneration
      && observationCurrent();
    afterSettlementForTests?.();
    return {
      instance,
      credentialKey: probe.credentialKey,
      quota,
      dispatch: observation?.dispatch,
      isCurrent,
      publishDecisionQuota: () => {
        // Activation first: ownership validation reads the auth store and must not run for signals-off installs.
        if (instance !== "anthropic" || !decisionQuotaSinkActive() || !isCurrent()) return;
        // An unbound probe result was parsed while inactive: unknown, never display fallback.
        const windows = boundDecisionWindows(rawQuota);
        if (windows) publishDecisionAccountQuota("anthropic", accountId, probe.generation,
          windows.filter(row => ownsFamily || ["5h", "weekly", "monthly"].includes(row.window)), !authoritative);
      },
    };
  }

  return Object.freeze({ instance, assertAnthropicQuotaSendAllowed, setAnthropicQuotaAfterSettlementForTests,
    anthropicCooldownGeneration, anthropicCooldownFlightKey, anthropicCredentialQuotaFlightKey, noteAnthropicCooldownMutation,
    anthropicAccountIncarnation, reserveAnthropicAccountIncarnation,
    clearAnthropicCooldownGenerations, captureAnthropicCooldownRecoveryProbe,
    probeAnthropicQuotaWithRecovery, reconcileAnthropicCooldownGenerations });
}
export type AnthropicCooldownRecovery = ReturnType<typeof createAnthropicCooldownRecovery>;
const instances = new Map<AnthropicInstanceId, AnthropicCooldownRecovery>();
export function anthropicCooldownRecoveryFor(instance: AnthropicInstanceId): AnthropicCooldownRecovery {
  let facade = instances.get(instance);
  if (!facade) { facade = createAnthropicCooldownRecovery(instance); instances.set(instance, facade); }
  return facade;
}
export function assertAnthropicQuotaSendAllowed(accountId: string, token: string): void {
  anthropicCooldownRecoveryFor("anthropic").assertAnthropicQuotaSendAllowed(accountId, token);
}
export function setAnthropicQuotaAfterSettlementForTests(hook: (() => void) | undefined): void {
  anthropicCooldownRecoveryFor("anthropic").setAnthropicQuotaAfterSettlementForTests(hook);
}
export function anthropicCooldownGeneration(accountId: string): number {
  return anthropicCooldownRecoveryFor("anthropic").anthropicCooldownGeneration(accountId);
}
export function anthropicCooldownFlightKey(baseKey: string, accountId: string): string {
  return anthropicCooldownRecoveryFor("anthropic").anthropicCooldownFlightKey(baseKey, accountId);
}
export function noteAnthropicCooldownMutation(accountId: string): number {
  return anthropicCooldownRecoveryFor("anthropic").noteAnthropicCooldownMutation(accountId);
}
export function clearAnthropicCooldownGenerations(): void {
  anthropicCooldownRecoveryFor("anthropic").clearAnthropicCooldownGenerations();
}
export function captureAnthropicCooldownRecoveryProbe(accountId: string, accessToken: string): Promise<AnthropicCooldownRecoveryProbe | null> {
  return anthropicCooldownRecoveryFor("anthropic").captureAnthropicCooldownRecoveryProbe(accountId, accessToken);
}
export function probeAnthropicQuotaWithRecovery(
  accountId: string, accessToken: string,
  read: (requireFreshDispatch: boolean) => Promise<ProviderQuota | null>, mayPublish: () => boolean,
): Promise<AnthropicQuotaRecoveryResult | null> {
  return anthropicCooldownRecoveryFor("anthropic").probeAnthropicQuotaWithRecovery(accountId, accessToken, read, mayPublish);
}
