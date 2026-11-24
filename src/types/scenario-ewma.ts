export type EpxScenarioKind = "longContext" | "think" | "background" | "webSearch";

export interface EpxScenarioRoutingConfig {
  enabled: boolean;
  /** Optional priority order when multiple scenarios match. Default: ["background", "longContext", "webSearch", "think"]. */
  precedence?: EpxScenarioKind[];
  /** Estimated token threshold triggering `longContext`. Default 60000; range 1000..10000000. */
  longContextThresholdTokens?: number;
  /** Minimum Anthropic `thinking.budget_tokens` triggering `think` when specified. Default 1; range 1..1000000. */
  thinkBudgetThreshold?: number;
  /** Model selectors (`provider/model`, combo/policy alias, or native model) per scenario. */
  routes: Partial<Record<EpxScenarioKind, string>>;
  /** Optional inbound selector allowlist (exact match or trailing `*` prefix). */
  matchModels?: string[];
  /** Allow scenario routing even when the caller requested an explicit `combo/*` or `policy/*` selector. Default false. */
  overrideExplicitRoutes?: boolean;
}

export interface EpxComboEwmaLatencyConfig {
  /** Smoothing factor in (0, 1]. Default 0.3. */
  alpha?: number;
  /** Optional time-decay half-life in ms (1000..3600000). */
  halfLifeMs?: number;
  /** Minimum recorded observations per target before EWMA exploits measured winners over cold-start exploration. Default 1; range 1..20. */
  minSamples?: number;
  /** Synthetic latency penalty in ms recorded on upstream failure. Default 30000; range 100..600000. */
  errorPenaltyMs?: number;
}
