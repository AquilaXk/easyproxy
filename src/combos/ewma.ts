import type { EpxComboEwmaLatencyConfig, EpxComboTarget } from "../types";

export const EWMA_DEFAULT_ALPHA = 0.3;
export const EWMA_MIN_ALPHA = 0.01;
export const EWMA_MAX_ALPHA = 1;
export const EWMA_MIN_HALF_LIFE_MS = 1_000;
export const EWMA_MAX_HALF_LIFE_MS = 3_600_000;
export const EWMA_DEFAULT_MIN_SAMPLES = 1;
export const EWMA_MIN_SAMPLES = 1;
export const EWMA_MAX_SAMPLES = 20;
export const EWMA_DEFAULT_ERROR_PENALTY_MS = 30_000;
export const EWMA_MIN_ERROR_PENALTY_MS = 100;
export const EWMA_MAX_ERROR_PENALTY_MS = 600_000;
export const EWMA_MAX_SAMPLE_MS = 600_000;
export const EWMA_DEFAULT_STALE_WINDOW_MS = 300_000;
const MAX_EWMA_ENTRIES = 4096;

export interface NormalizedEwmaLatencyConfig {
  alpha: number;
  halfLifeMs?: number;
  minSamples: number;
  errorPenaltyMs: number;
}

export interface EwmaLatencyIssue {
  path: Array<string | number>;
  message: string;
}

export interface EwmaTargetStats {
  ewmaMs: number;
  samples: number;
  consecutiveFailures: number;
  lastUpdatedAt: number;
  lastSampleMs: number;
}

const KNOWN_EWMA_KEYS = new Set(["alpha", "halfLifeMs", "minSamples", "errorPenaltyMs"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function ewmaLatencyConfigIssues(raw: unknown): EwmaLatencyIssue[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) {
    return [{ path: ["ewmaLatency"], message: "ewmaLatency must be an object" }];
  }
  const issues: EwmaLatencyIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_EWMA_KEYS.has(key)) {
      issues.push({ path: ["ewmaLatency", key], message: `unsupported ewmaLatency field "${key}"` });
    }
  }
  if (raw.alpha !== undefined) {
    if (typeof raw.alpha !== "number" || !Number.isFinite(raw.alpha) || raw.alpha < EWMA_MIN_ALPHA || raw.alpha > EWMA_MAX_ALPHA) {
      issues.push({
        path: ["ewmaLatency", "alpha"],
        message: `ewmaLatency.alpha must be a finite number from ${EWMA_MIN_ALPHA} to ${EWMA_MAX_ALPHA}`,
      });
    }
  }
  if (raw.halfLifeMs !== undefined) {
    if (typeof raw.halfLifeMs !== "number"
      || !Number.isSafeInteger(raw.halfLifeMs)
      || raw.halfLifeMs < EWMA_MIN_HALF_LIFE_MS
      || raw.halfLifeMs > EWMA_MAX_HALF_LIFE_MS) {
      issues.push({
        path: ["ewmaLatency", "halfLifeMs"],
        message: `ewmaLatency.halfLifeMs must be an integer from ${EWMA_MIN_HALF_LIFE_MS} to ${EWMA_MAX_HALF_LIFE_MS}`,
      });
    }
  }
  if (raw.minSamples !== undefined) {
    if (typeof raw.minSamples !== "number"
      || !Number.isSafeInteger(raw.minSamples)
      || raw.minSamples < EWMA_MIN_SAMPLES
      || raw.minSamples > EWMA_MAX_SAMPLES) {
      issues.push({
        path: ["ewmaLatency", "minSamples"],
        message: `ewmaLatency.minSamples must be an integer from ${EWMA_MIN_SAMPLES} to ${EWMA_MAX_SAMPLES}`,
      });
    }
  }
  if (raw.errorPenaltyMs !== undefined) {
    if (typeof raw.errorPenaltyMs !== "number"
      || !Number.isSafeInteger(raw.errorPenaltyMs)
      || raw.errorPenaltyMs < EWMA_MIN_ERROR_PENALTY_MS
      || raw.errorPenaltyMs > EWMA_MAX_ERROR_PENALTY_MS) {
      issues.push({
        path: ["ewmaLatency", "errorPenaltyMs"],
        message: `ewmaLatency.errorPenaltyMs must be an integer from ${EWMA_MIN_ERROR_PENALTY_MS} to ${EWMA_MAX_ERROR_PENALTY_MS}`,
      });
    }
  }
  return issues;
}

export function normalizeEwmaLatencyConfig(raw?: EpxComboEwmaLatencyConfig): NormalizedEwmaLatencyConfig {
  const alpha = typeof raw?.alpha === "number" && Number.isFinite(raw.alpha)
    ? Math.min(EWMA_MAX_ALPHA, Math.max(EWMA_MIN_ALPHA, raw.alpha))
    : EWMA_DEFAULT_ALPHA;
  const halfLifeMs = typeof raw?.halfLifeMs === "number" && Number.isFinite(raw.halfLifeMs) && raw.halfLifeMs >= EWMA_MIN_HALF_LIFE_MS
    ? Math.min(EWMA_MAX_HALF_LIFE_MS, Math.trunc(raw.halfLifeMs))
    : undefined;
  const minSamples = typeof raw?.minSamples === "number" && Number.isFinite(raw.minSamples)
    ? Math.min(EWMA_MAX_SAMPLES, Math.max(EWMA_MIN_SAMPLES, Math.trunc(raw.minSamples)))
    : EWMA_DEFAULT_MIN_SAMPLES;
  const errorPenaltyMs = typeof raw?.errorPenaltyMs === "number" && Number.isFinite(raw.errorPenaltyMs)
    ? Math.min(EWMA_MAX_ERROR_PENALTY_MS, Math.max(EWMA_MIN_ERROR_PENALTY_MS, Math.trunc(raw.errorPenaltyMs)))
    : EWMA_DEFAULT_ERROR_PENALTY_MS;
  return { alpha, ...(halfLifeMs !== undefined ? { halfLifeMs } : {}), minSamples, errorPenaltyMs };
}

const ewmaEntries = new Map<string, EwmaTargetStats>();
const ewmaExploreCursors = new Map<string, number>();

function ewmaOwnerKey(comboId: string, targetKey: string): string {
  return `${comboId}\0${targetKey}`;
}

function setBoundedEntry(ownerKey: string, entry: EwmaTargetStats): void {
  if (ewmaEntries.has(ownerKey)) {
    ewmaEntries.delete(ownerKey);
  } else if (ewmaEntries.size >= MAX_EWMA_ENTRIES) {
    const oldestKey = ewmaEntries.keys().next().value;
    if (oldestKey !== undefined) ewmaEntries.delete(oldestKey);
  }
  ewmaEntries.set(ownerKey, entry);
}

function clampLatencySample(sampleMs: number): number {
  if (!Number.isFinite(sampleMs)) return 1;
  return Math.min(EWMA_MAX_SAMPLE_MS, Math.max(1, sampleMs));
}

function effectiveAlpha(config: NormalizedEwmaLatencyConfig, elapsedMs: number): number {
  if (config.halfLifeMs === undefined) return config.alpha;
  const dt = Math.max(0, elapsedMs);
  const timeWeight = 1 - Math.exp((-Math.LN2 * dt) / config.halfLifeMs);
  return Math.min(0.95, Math.max(config.alpha, timeWeight));
}

/** Record one successful upstream completion latency sample in O(1). */
export function recordComboEwmaSuccess(
  comboId: string,
  targetKey: string,
  rawConfig: EpxComboEwmaLatencyConfig | undefined,
  latencyMs: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const cfg = normalizeEwmaLatencyConfig(rawConfig);
  const sample = clampLatencySample(latencyMs);
  const ownerKey = ewmaOwnerKey(comboId, targetKey);
  const existing = ewmaEntries.get(ownerKey);
  if (!existing || existing.samples === 0) {
    setBoundedEntry(ownerKey, {
      ewmaMs: sample,
      samples: 1,
      consecutiveFailures: 0,
      lastUpdatedAt: now,
      lastSampleMs: sample,
    });
    return;
  }
  const a = effectiveAlpha(cfg, now - existing.lastUpdatedAt);
  setBoundedEntry(ownerKey, {
    ewmaMs: a * sample + (1 - a) * existing.ewmaMs,
    samples: existing.samples + 1,
    consecutiveFailures: 0,
    lastUpdatedAt: now,
    lastSampleMs: sample,
  });
}

/** Apply a bounded failure penalty to a target's EWMA latency so failing lanes yield cleanly. */
export function recordComboEwmaFailure(
  comboId: string,
  targetKey: string,
  rawConfig: EpxComboEwmaLatencyConfig | undefined,
  now = Date.now(),
): void {
  const cfg = normalizeEwmaLatencyConfig(rawConfig);
  const ownerKey = ewmaOwnerKey(comboId, targetKey);
  const existing = ewmaEntries.get(ownerKey);
  const nextFailures = Math.min(8, (existing?.consecutiveFailures ?? 0) + 1);
  const penalty = clampLatencySample(cfg.errorPenaltyMs * nextFailures);
  if (!existing || existing.samples === 0) {
    setBoundedEntry(ownerKey, {
      ewmaMs: penalty,
      samples: 1,
      consecutiveFailures: nextFailures,
      lastUpdatedAt: now,
      lastSampleMs: penalty,
    });
    return;
  }
  const a = Math.max(0.5, effectiveAlpha(cfg, now - existing.lastUpdatedAt));
  setBoundedEntry(ownerKey, {
    ewmaMs: a * penalty + (1 - a) * existing.ewmaMs,
    samples: existing.samples + 1,
    consecutiveFailures: nextFailures,
    lastUpdatedAt: now,
    lastSampleMs: penalty,
  });
}

/** Select the eligible target index with lowest weighted/decayed EWMA latency (with cold-start round-robin). */
export function pickEwmaLatencyIndex<T extends Pick<EpxComboTarget, "provider" | "model" | "weight">>(
  comboId: string,
  targets: readonly T[],
  eligible: (target: T) => boolean,
  targetKeyOf: (target: T) => string,
  rawConfig: EpxComboEwmaLatencyConfig | undefined,
  now = Date.now(),
  options: { preview?: boolean } = {},
): number {
  const cfg = normalizeEwmaLatencyConfig(rawConfig);
  const eligibleIndices: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (eligible(targets[i]!)) eligibleIndices.push(i);
  }
  if (eligibleIndices.length === 0) return -1;
  if (eligibleIndices.length === 1) return eligibleIndices[0]!;

  // Cold-start exploration: distribute traffic across unmeasured or under-sampled targets before exploiting.
  const coldStart: Array<{ index: number; samples: number }> = [];
  let minColdSamples = Number.POSITIVE_INFINITY;
  for (const index of eligibleIndices) {
    const key = targetKeyOf(targets[index]!);
    const entry = ewmaEntries.get(ewmaOwnerKey(comboId, key));
    const samples = entry?.samples ?? 0;
    if (samples < cfg.minSamples) {
      coldStart.push({ index, samples });
      if (samples < minColdSamples) minColdSamples = samples;
    }
  }
  if (coldStart.length > 0) {
    const leastSampled = coldStart.filter(item => item.samples === minColdSamples);
    const cursor = ewmaExploreCursors.get(comboId) ?? 0;
    const chosen = leastSampled[cursor % leastSampled.length]!.index;
    if (!options.preview) {
      ewmaExploreCursors.set(comboId, (cursor + 1) % Number.MAX_SAFE_INTEGER);
    }
    return chosen;
  }

  // Compute stale-recovery reference (median non-stale EWMA) once per call without sorting huge arrays.
  const staleWindow = cfg.halfLifeMs !== undefined ? cfg.halfLifeMs * 4 : EWMA_DEFAULT_STALE_WINDOW_MS;
  const freshValues: number[] = [];
  for (const index of eligibleIndices) {
    const key = targetKeyOf(targets[index]!);
    const entry = ewmaEntries.get(ewmaOwnerKey(comboId, key));
    if (entry && now - entry.lastUpdatedAt <= staleWindow) {
      freshValues.push(entry.ewmaMs);
    }
  }
  freshValues.sort((a, b) => a - b);
  const medianFresh = freshValues.length > 0
    ? freshValues[Math.floor(freshValues.length / 2)]!
    : undefined;

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestRawEwma = Number.POSITIVE_INFINITY;
  let bestFailures = Number.POSITIVE_INFINITY;

  for (const index of eligibleIndices) {
    const target = targets[index]!;
    const key = targetKeyOf(target);
    const entry = ewmaEntries.get(ewmaOwnerKey(comboId, key));
    const rawEwma = entry?.ewmaMs ?? EWMA_DEFAULT_ERROR_PENALTY_MS;
    const ageMs = entry ? Math.max(0, now - entry.lastUpdatedAt) : 0;
    let adjustedEwma = rawEwma;
    if (entry && medianFresh !== undefined && ageMs > staleWindow) {
      const keepWeight = Math.exp(-(ageMs - staleWindow) / staleWindow);
      adjustedEwma = keepWeight * rawEwma + (1 - keepWeight) * medianFresh;
    }
    const weight = typeof target.weight === "number" && Number.isFinite(target.weight) && target.weight > 0
      ? target.weight
      : 1;
    const score = adjustedEwma / weight;
    const failures = entry?.consecutiveFailures ?? 0;
    if (
      bestIndex < 0
      || score < bestScore - 1e-6
      || (Math.abs(score - bestScore) <= 1e-6 && (
        adjustedEwma < bestRawEwma - 1e-6
        || (Math.abs(adjustedEwma - bestRawEwma) <= 1e-6 && failures < bestFailures)
      ))
    ) {
      bestIndex = index;
      bestScore = score;
      bestRawEwma = adjustedEwma;
      bestFailures = failures;
    }
  }
  return bestIndex;
}

export function snapshotComboEwmaStats(comboId: string): Record<string, EwmaTargetStats> {
  const prefix = `${comboId}\0`;
  const result: Record<string, EwmaTargetStats> = {};
  for (const [ownerKey, stats] of ewmaEntries) {
    if (!ownerKey.startsWith(prefix)) continue;
    result[ownerKey.slice(prefix.length)] = { ...stats };
  }
  return result;
}

export function reconcileComboEwmaState(comboIds: ReadonlySet<string>, comboTargets: ReadonlySet<string>): number {
  let removed = 0;
  for (const ownerKey of [...ewmaEntries.keys()]) {
    const splitAt = ownerKey.indexOf("\0");
    if (splitAt <= 0 || !comboTargets.has(ownerKey)) {
      ewmaEntries.delete(ownerKey);
      removed += 1;
    }
  }
  for (const comboId of [...ewmaExploreCursors.keys()]) {
    if (!comboIds.has(comboId)) {
      ewmaExploreCursors.delete(comboId);
      removed += 1;
    }
  }
  return removed;
}

export function clearComboEwmaState(comboId?: string): void {
  if (comboId === undefined) {
    ewmaEntries.clear();
    ewmaExploreCursors.clear();
    return;
  }
  const prefix = `${comboId}\0`;
  for (const ownerKey of [...ewmaEntries.keys()]) {
    if (ownerKey.startsWith(prefix)) ewmaEntries.delete(ownerKey);
  }
  ewmaExploreCursors.delete(comboId);
}
