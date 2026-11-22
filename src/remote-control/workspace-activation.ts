import type { EpxConfig } from "../types";

/** Side-effect-free opt-in; never creates a store, probes a runtime, or opens a listener. */
export function remoteWorkspaceEnabled(
  config: Pick<EpxConfig, "runtimeRole">,
  enabled = process.env.EPX_REMOTE_WORKSPACE_ENABLED,
): boolean {
  return config.runtimeRole === "hub" && enabled === "1";
}
