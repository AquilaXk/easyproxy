// Ported from router-for-me/CLIProxyAPI (internal/auth/power_darwin.go, MIT License).
// Used solely by periodic background refresh/probe loops so macOS DarkWake ticks defer
// without adding latency to live inbound proxy requests.

import { execFile } from "node:child_process";

const PMSET_PATH = "/usr/bin/pmset";
const PMSET_ARGS = ["-g", "systemstate"] as const;
const PMSET_TIMEOUT_MS = 2_000;
const PMSET_MAX_BUFFER_BYTES = 16 * 1024;
const DEFAULT_CACHE_TTL_MS = 2_000;
const CAPABILITIES_PREFIX = "Current System Capabilities are:";

export type MacOSPowerReadinessReason =
  | "non_darwin"
  | "interactive_ready"
  | "dark_wake_missing_capabilities"
  | "capabilities_line_missing"
  | "probe_failed";

export interface MacOSPowerReadiness {
  ready: boolean;
  reason: MacOSPowerReadinessReason;
  cached?: boolean;
}

export interface MacOSPowerStateOptions {
  platform?: NodeJS.Platform;
  readState?: () => Promise<string>;
  now?: number;
  cacheTtlMs?: number;
  skipCache?: boolean;
}

export function parseMacOSSystemCapabilitiesReady(output: string): MacOSPowerReadiness {
  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith(CAPABILITIES_PREFIX)) continue;
    const remainder = trimmed.slice(CAPABILITIES_PREFIX.length);
    const tokens = remainder.split(/\s+/).filter(Boolean);
    let hasGraphics = false;
    let hasNetwork = false;
    for (const token of tokens) {
      if (token === "Graphics") hasGraphics = true;
      else if (token === "Network") hasNetwork = true;
    }
    return hasGraphics && hasNetwork
      ? { ready: true, reason: "interactive_ready" }
      : { ready: false, reason: "dark_wake_missing_capabilities" };
  }
  return { ready: false, reason: "capabilities_line_missing" };
}

function defaultReadMacOSSystemState(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PMSET_PATH,
      [...PMSET_ARGS],
      {
        encoding: "utf8",
        timeout: PMSET_TIMEOUT_MS,
        maxBuffer: PMSET_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function createMacOSPowerReadyChecker(
  defaultReadState: () => Promise<string> = defaultReadMacOSSystemState,
  defaultCacheTtlMs = DEFAULT_CACHE_TTL_MS,
) {
  let cached: { checkedAt: number; platform: NodeJS.Platform; result: MacOSPowerReadiness } | null = null;
  let inFlight: Promise<MacOSPowerReadiness> | null = null;

  return {
    reset() {
      cached = null;
      inFlight = null;
    },
    async check(options?: MacOSPowerStateOptions): Promise<MacOSPowerReadiness> {
      const platform = options?.platform ?? process.platform;
      if (platform !== "darwin") {
        return { ready: true, reason: "non_darwin" };
      }

      const useCache = options?.skipCache !== true && options?.readState === undefined;
      const now = options?.now ?? Date.now();
      const cacheTtlMs = options?.cacheTtlMs ?? defaultCacheTtlMs;

      if (useCache && cached && cached.platform === platform && now - cached.checkedAt >= 0 && now - cached.checkedAt < cacheTtlMs) {
        return { ...cached.result, cached: true };
      }

      if (useCache && inFlight) {
        return inFlight;
      }

      const reader = options?.readState ?? defaultReadState;
      const run = (async (): Promise<MacOSPowerReadiness> => {
        let result: MacOSPowerReadiness;
        try {
          const output = await reader();
          result = typeof output === "string"
            ? parseMacOSSystemCapabilitiesReady(output)
            : { ready: false, reason: "probe_failed" };
        } catch {
          result = { ready: false, reason: "probe_failed" };
        }
        if (useCache) {
          cached = { checkedAt: options?.now ?? Date.now(), platform, result };
        }
        return result;
      })();

      if (!useCache) {
        return run;
      }

      inFlight = run;
      try {
        return await run;
      } finally {
        if (inFlight === run) {
          inFlight = null;
        }
      }
    },
  };
}

const defaultChecker = createMacOSPowerReadyChecker();

export async function checkMacOSRefreshReadiness(options?: MacOSPowerStateOptions): Promise<MacOSPowerReadiness> {
  return defaultChecker.check(options);
}

export async function isInteractiveMacOSPowerReady(options?: MacOSPowerStateOptions): Promise<boolean> {
  return (await defaultChecker.check(options)).ready;
}

export function resetMacOSPowerStateCacheForTests(): void {
  defaultChecker.reset();
}
