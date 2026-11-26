/**
 * Two-stage asymmetric minimum-risk JEV route & effort selection policy.
 *
 * Stage 1 aggregates option probabilities into a marginal distribution over candidate targets
 * and selects the target with highest marginal mass.
 * Stage 2 chooses among that target's allowed effort levels {0, ..., K - 1} by minimizing
 * expected asymmetric L1 loss: underestimation (i < j) carries weight 3.0, overestimation
 * (i > j) carries weight 1.0, scaled by |i - j|, with exact ties broken toward the middle
 * effort level (and lower effort on equidistant symmetry).
 */
import type { EpxComboDefaultEffort, EpxComboJevSelectionPolicy } from "../types";

export const JEV_SELECTION_POLICIES: readonly EpxComboJevSelectionPolicy[] = Object.freeze([
  "argmax",
  "min-risk",
  "observe",
]);

export const JEV_EFFORT_ORDER: readonly EpxComboDefaultEffort[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const JEV_RISK_UNDERESTIMATE_WEIGHT = 3.0;
export const JEV_RISK_OVERESTIMATE_WEIGHT = 1.0;

const MAX_RISK_CANDIDATES = 64;
const MAX_DISTRIBUTION_ENTRIES = 512;
const MARGINAL_TIE_EPS = 1e-12;
const RISK_TIE_EPS = 1e-9;

export interface JevRiskCandidate {
  key: string;
  reasoningEfforts: readonly EpxComboDefaultEffort[];
}

export interface JevSelectionChoice {
  targetKey: string;
  effort: EpxComboDefaultEffort | null;
}

export interface JevSelectionPolicyDelta {
  differs: boolean;
  targetChanged: boolean;
  effortStepDelta: number;
}

const VALID_EFFORTS = new Set<EpxComboDefaultEffort>(JEV_EFFORT_ORDER);

function orderedCandidateEfforts(efforts: readonly EpxComboDefaultEffort[]): EpxComboDefaultEffort[] {
  const present = new Set<EpxComboDefaultEffort>();
  for (const effort of efforts) {
    if (VALID_EFFORTS.has(effort)) present.add(effort);
  }
  return JEV_EFFORT_ORDER.filter(effort => present.has(effort));
}

export function selectMinRiskJevChoice(options: {
  candidates: readonly JevRiskCandidate[];
  distribution: ReadonlyMap<string, number>;
  fallbackChoice: JevSelectionChoice;
}): JevSelectionChoice & { delta: JevSelectionPolicyDelta } {
  const { candidates, distribution, fallbackChoice } = options;
  const zeroDelta = (): JevSelectionPolicyDelta => ({
    differs: false,
    targetChanged: false,
    effortStepDelta: 0,
  });

  if (
    candidates.length === 0
    || candidates.length > MAX_RISK_CANDIDATES
    || distribution.size === 0
    || distribution.size > MAX_DISTRIBUTION_ENTRIES
  ) {
    return { ...fallbackChoice, delta: zeroDelta() };
  }

  for (const value of distribution.values()) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { ...fallbackChoice, delta: zeroDelta() };
    }
  }

  // Stage 1: Marginal probability per target across all allowlisted options for that target.
  const targetMasses: Array<{ candidate: JevRiskCandidate; efforts: EpxComboDefaultEffort[]; mass: number }> = [];
  let maxMass = -1;
  let chosenTarget = candidates[0]!;
  let chosenMass = -1;
  let totalMass = 0;

  for (const candidate of candidates) {
    const efforts = orderedCandidateEfforts(candidate.reasoningEfforts);
    const keys: Array<EpxComboDefaultEffort | null> = efforts.length > 0 ? efforts : [null];
    let mass = 0;
    for (const effort of keys) {
      const p = distribution.get(`${candidate.key}:${effort ?? "none"}`) ?? 0;
      mass += p;
    }
    totalMass += mass;
    targetMasses.push({ candidate, efforts, mass });
    if (mass > maxMass + MARGINAL_TIE_EPS) {
      maxMass = mass;
      chosenTarget = candidate;
      chosenMass = mass;
    }
  }

  if (!(totalMass > 0)) {
    return { ...fallbackChoice, delta: zeroDelta() };
  }

  // Preserve argmax target on an exact marginal probability tie.
  const fallbackEntry = targetMasses.find(entry => entry.candidate.key === fallbackChoice.targetKey);
  if (fallbackEntry && Math.abs(fallbackEntry.mass - maxMass) <= MARGINAL_TIE_EPS) {
    chosenTarget = fallbackEntry.candidate;
    chosenMass = fallbackEntry.mass;
  }

  const chosenEntry = targetMasses.find(entry => entry.candidate.key === chosenTarget.key)!;
  const efforts = chosenEntry.efforts;

  let chosenEffort: EpxComboDefaultEffort | null;
  if (efforts.length === 0) {
    chosenEffort = null;
  } else if (efforts.length === 1) {
    chosenEffort = efforts[0]!;
  } else if (!(chosenMass > 0)) {
    chosenEffort = chosenTarget.key === fallbackChoice.targetKey && fallbackChoice.effort && efforts.includes(fallbackChoice.effort)
      ? fallbackChoice.effort
      : efforts[Math.floor((efforts.length - 1) / 2)]!;
  } else {
    // Stage 2: Normalize conditional distribution over efforts and minimize asymmetric expected loss.
    const K = efforts.length;
    const q = efforts.map(effort => (distribution.get(`${chosenTarget.key}:${effort}`) ?? 0) / chosenMass);
    const mid = (K - 1) / 2;
    let bestIdx = 0;
    let bestRisk = Number.POSITIVE_INFINITY;

    for (let i = 0; i < K; i += 1) {
      let risk = 0;
      for (let j = 0; j < K; j += 1) {
        if (i === j) continue;
        const distance = Math.abs(i - j);
        const weight = i < j ? JEV_RISK_UNDERESTIMATE_WEIGHT : JEV_RISK_OVERESTIMATE_WEIGHT;
        risk += q[j]! * weight * distance;
      }
      if (risk < bestRisk - RISK_TIE_EPS) {
        bestRisk = risk;
        bestIdx = i;
      } else if (Math.abs(risk - bestRisk) <= RISK_TIE_EPS) {
        const currentDist = Math.abs(i - mid);
        const bestDist = Math.abs(bestIdx - mid);
        if (currentDist < bestDist - RISK_TIE_EPS || (Math.abs(currentDist - bestDist) <= RISK_TIE_EPS && i < bestIdx)) {
          bestRisk = Math.min(bestRisk, risk);
          bestIdx = i;
        }
      }
    }
    chosenEffort = efforts[bestIdx]!;
  }

  const targetChanged = chosenTarget.key !== fallbackChoice.targetKey;
  const differs = targetChanged || chosenEffort !== fallbackChoice.effort;
  const fromIdx = fallbackChoice.effort ? JEV_EFFORT_ORDER.indexOf(fallbackChoice.effort) : -1;
  const toIdx = chosenEffort ? JEV_EFFORT_ORDER.indexOf(chosenEffort) : -1;
  const effortStepDelta = fromIdx >= 0 && toIdx >= 0 ? toIdx - fromIdx : 0;

  return {
    targetKey: chosenTarget.key,
    effort: chosenEffort,
    delta: {
      differs,
      targetChanged,
      effortStepDelta,
    },
  };
}
