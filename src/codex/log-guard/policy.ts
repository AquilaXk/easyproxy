import { loadConfig, saveConfigPreservingClaudeCode } from "../../config";
import type { EpxConfig } from "../../types";

export type CodexLogGuardMode = "off" | "compat" | "quiet";

type ConfigWithLogGuard = EpxConfig & {
  codexLogGuard?: {
    mode?: unknown;
    [key: string]: unknown;
  };
};

export interface CodexLogGuardPolicyDeps {
  load?: () => EpxConfig;
  save?: (config: EpxConfig) => void;
}

export function readCodexLogGuardMode(deps: CodexLogGuardPolicyDeps = {}): CodexLogGuardMode {
  const config = (deps.load ?? loadConfig)() as ConfigWithLogGuard;
  const mode = config.codexLogGuard?.mode;
  return mode === "compat" || mode === "quiet" ? mode : "off";
}

/**
 * Persist user intent separately from Codex's logs database.
 *
 * A Codex migration may rebuild the `logs` table and thereby remove our
 * trigger. Keeping intent in EasyProxy config makes that observable as drift
 * rather than silently treating protection as disabled. `off` is explicit so
 * a stale unknown value cannot reactivate protection later.
 */
export function writeCodexLogGuardMode(
  mode: CodexLogGuardMode,
  deps: CodexLogGuardPolicyDeps = {},
): void {
  const load = deps.load ?? loadConfig;
  const save = deps.save ?? saveConfigPreservingClaudeCode;
  const config = load() as ConfigWithLogGuard;
  const current = config.codexLogGuard && typeof config.codexLogGuard === "object"
    ? config.codexLogGuard
    : {};
  config.codexLogGuard = { ...current, mode };
  save(config);
}
