/** Routing-profile configuration types (`routingProfiles` in config.json). */

export type EpxRoutingUnknownEvidenceMode = "allow" | "penalize" | "exclude";

export interface EpxRoutingProfileCandidate {
  provider: string;
  model: string;
}

export interface EpxRoutingProfileRequirements {
  /** Minimum model context window in tokens. */
  minContextWindow?: number;
  /** Minimum remaining quota headroom fraction (0..1). */
  minQuotaHeadroom?: number;
  tools?: boolean;
  imageInput?: boolean;
  structuredOutput?: boolean;
  reasoningEffort?: string;
  serviceTier?: string;
  localOnly?: boolean;
  remoteAllowed?: boolean;
  /** Special encrypted Codex task readability (ChatGPT forward pool). */
  encryptedCodexTasks?: boolean;
}

export interface EpxRoutingProfileOptimize {
  latency?: number;
  health?: number;
  cost?: number;
  quota?: number;
}

/**
 * Policy for the hard cost ceiling when a candidate has no finite cost
 * estimate. `"allow"` (default) preserves the documented dry-run contract:
 * the cap only excludes evidence known to exceed it, and the candidate's
 * `cost.capOutcome` is `"unknown-allowed"`. `"exclude"` makes the ceiling
 * fail-closed (`cost-limit-unknown` + `capOutcome: "unknown-excluded"`).
 */
export type EpxRoutingUnknownCostCapMode = "allow" | "exclude";

export interface EpxRoutingProfileLimits {
  /** Hard per-request estimated-cost ceiling in USD. */
  maxEstimatedCostUsd?: number;
  /**
   * How `maxEstimatedCostUsd` behaves when the estimate is unknown.
   * Defaults to `"allow"` (eligible + `cost.capOutcome: "unknown-allowed"`);
   * opt in to `"exclude"` for a true hard ceiling.
   */
  onUnknownCost?: EpxRoutingUnknownCostCapMode;
}

export interface EpxRoutingProfileUnknownEvidence {
  capability?: EpxRoutingUnknownEvidenceMode;
  health?: EpxRoutingUnknownEvidenceMode;
  quota?: EpxRoutingUnknownEvidenceMode;
  cost?: EpxRoutingUnknownEvidenceMode;
}

export interface EpxRoutingProfileCompatibilitySuite {
  suiteId: string;
  evidenceLayer: "protocol_conformance" | "live_route_compatibility";
}

export interface EpxRoutingProfileCompatibility {
  requiredSuites?: EpxRoutingProfileCompatibilitySuite[];
  minStatus?: "PROBED" | "VERIFIED";
  maxEvidenceAgeMs?: number;
  unknownEvidence?: EpxRoutingUnknownEvidenceMode;
  degradedEvidence?: EpxRoutingUnknownEvidenceMode;
}

export interface EpxRoutingProfileConfig {
  /**
   * Explicit candidate allowlist (`provider/model` refs). No implicit
   * expansion in v1.
   */
  candidates: EpxRoutingProfileCandidate[];
  /** Optional public model name replacing the default `policy/<id>` slug. */
  alias?: string;
  /** Hard requirements evaluated before scoring. */
  require?: EpxRoutingProfileRequirements;
  /** Optimization weights; normalized deterministically. */
  optimize?: EpxRoutingProfileOptimize;
  limits?: EpxRoutingProfileLimits;
  /** How unknown evidence is handled per dimension. */
  unknownEvidence?: EpxRoutingProfileUnknownEvidence;
  /** Optional Compatibility Lab policy (CL-06). */
  compatibility?: EpxRoutingProfileCompatibility;
}
