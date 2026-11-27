/**
 * Anthropic OAuth account-pool settings. One shape, two locations:
 * `config.anthropicAccountPool` for the `anthropic` instance and
 * `config.providers.anthropic2.anthropicAccountPool` for `anthropic2`. Neither inherits from the other.
 *
 * Leaf module: `config.ts` and `provider.ts` import these types, never the reverse.
 */
export type EpxAccountPoolRotationStrategy = "quota" | "round-robin" | "fill-first" | "reset-near-weighted";

export type EpxAccountPoolQuotaWindow = "five-hour" | "weekly" | "max-utilization";

export interface AnthropicModelRoute {
  name: string;
  match: string;
  accounts: string[];
  fallback?: boolean;
}

export interface AnthropicAccountPoolConfig {
  enabled?: boolean;
  /** Preserve native Claude Messages while the pool is enabled. Default true; false selects legacy translation. */
  nativeMessages?: boolean;
  /** Usage % threshold for new-session auto-pick. Default 80. 0 = disabled (affinity/active only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota (today's behaviour). */
  strategy?: EpxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Usage window for quota-based scoring. Default "five-hour" (today's behaviour). */
  quotaWindow?: EpxAccountPoolQuotaWindow;
  /** Ordered model allowlists; inactive while the pool is disabled. Stored account IDs only. */
  routes?: AnthropicModelRoute[];
  /**
   * Opt-in fallback to Anthropic slow lane (`anthropic-usage-limit: slow`) when every eligible
   * OAuth account in the pool has exhausted its 5-hour quota while weekly capacity remains.
   */
  slowFallback?: boolean;
}
