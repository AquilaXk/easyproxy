import type { EpxConfig } from "../types";

export const LIVE_TOPOLOGY_KEYS = new Set([
  "hostname", "port", "runtimeRole", "hub", "client", "unauthenticatedLoopbackListener", "codexAuthMethod",
]);
const baselines = new WeakMap<EpxConfig, Record<string, unknown>>();

function snapshot(config: EpxConfig): Record<string, unknown> {
  const record = config as unknown as Record<string, unknown>;
  return Object.fromEntries([...LIVE_TOPOLOGY_KEYS].filter(key => Object.hasOwn(record, key))
    .map(key => [key, structuredClone(record[key])]));
}

/** Track actual active values independently of the desired config last persisted. */
export function captureLiveTopologyBaseline(config: EpxConfig): void {
  baselines.set(config, snapshot(config));
}

/** Merge desired next-start settings without mutating active values. */
export function projectLiveTopology(
  config: EpxConfig, persisted: EpxConfig,
  mergeRecord: (live: Record<string, unknown>, baseline: Record<string, unknown>, disk: Record<string, unknown>, skipped: ReadonlySet<string>) => void,
): EpxConfig {
  const projected = { ...config, ...snapshot(config) } as unknown as Record<string, unknown>;
  const baseline = baselines.get(config) ?? snapshot(config);
  const disk = persisted as unknown as Record<string, unknown>;
  const skipped = new Set([...Object.keys(projected), ...Object.keys(baseline), ...Object.keys(disk)]
    .filter(key => !LIVE_TOPOLOGY_KEYS.has(key)));
  mergeRecord(projected, baseline, disk, skipped);
  return projected as unknown as EpxConfig;
}
