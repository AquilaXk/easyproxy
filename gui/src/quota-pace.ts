const HOUR_MS = 3_600_000;
const MIN_ELAPSED_MS = 5 * 60_000;

export interface QuotaPaceEstimate {
  burnRatePctPerHour: number;
  etaToExhaustionMs: number;
  willExhaustBeforeReset: boolean;
}

export function inferWindowDurationMs(windowId: string): number | null {
  const id = windowId.trim().toLowerCase();
  if (!id) return null;
  if (id === "5h" || id.includes("five-hour") || id.includes("5-hour") || id.includes("five_hour")) {
    return 5 * HOUR_MS;
  }
  if (id === "daily" || id === "24h" || id === "1d" || id.includes("daily")) {
    return 24 * HOUR_MS;
  }
  if (id === "weekly" || id === "7d" || id.includes("weekly")) {
    return 7 * 24 * HOUR_MS;
  }
  if (id === "monthly" || id === "30d" || id.includes("monthly")) {
    return 30 * 24 * HOUR_MS;
  }
  return null;
}

export function estimateQuotaPace(input: {
  percentUsed?: number | null;
  resetAtMs?: number | null;
  windowDurationMs: number | null;
  nowMs?: number;
}): QuotaPaceEstimate | null {
  const { percentUsed, resetAtMs, windowDurationMs, nowMs = Date.now() } = input;
  if (
    windowDurationMs === null
    || !Number.isFinite(windowDurationMs)
    || windowDurationMs <= 0
    || percentUsed === undefined
    || percentUsed === null
    || !Number.isFinite(percentUsed)
    || percentUsed <= 0
    || percentUsed >= 100
    || resetAtMs === undefined
    || resetAtMs === null
    || !Number.isFinite(resetAtMs)
    || resetAtMs <= nowMs
  ) {
    return null;
  }

  const remainingMs = resetAtMs - nowMs;
  const elapsedMs = windowDurationMs - remainingMs;
  if (elapsedMs < MIN_ELAPSED_MS) return null;

  const elapsedHours = elapsedMs / HOUR_MS;
  const burnRatePctPerHour = percentUsed / elapsedHours;
  if (!Number.isFinite(burnRatePctPerHour) || burnRatePctPerHour <= 0) return null;

  const remainingPct = 100 - percentUsed;
  const etaToExhaustionMs = (remainingPct / burnRatePctPerHour) * HOUR_MS;
  if (!Number.isFinite(etaToExhaustionMs) || etaToExhaustionMs < 0) return null;

  return {
    burnRatePctPerHour,
    etaToExhaustionMs,
    willExhaustBeforeReset: etaToExhaustionMs < remainingMs,
  };
}
