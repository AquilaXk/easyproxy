export interface WaterfallAttempt {
  ordinal: number;
  provider: string;
  model: string;
  status: number;
  durationMs: number;
  firstOutputMs?: number | null;
}

export interface WaterfallSegmentMetrics {
  offsetPct: number;
  widthPct: number;
  ttftPct: number;
  decodePct: number;
  hasTtftSplit: boolean;
  tone: "ok" | "warn" | "err";
}

function clampNonNeg(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function computeWaterfallLayout(
  attempts: readonly WaterfallAttempt[],
  totalDurationMs: number,
): { scaleMs: number; rows: Array<{ attempt: WaterfallAttempt; metrics: WaterfallSegmentMetrics }> } {
  const ordered = attempts.toSorted((a, b) => a.ordinal - b.ordinal);
  let sumMs = 0;
  let maxAttemptMs = 0;
  for (const item of ordered) {
    const dur = clampNonNeg(item.durationMs);
    sumMs += dur;
    if (dur > maxAttemptMs) maxAttemptMs = dur;
  }
  const scaleMs = Math.max(1, clampNonNeg(totalDurationMs), sumMs, maxAttemptMs);
  const sequential = ordered.length > 1 && sumMs <= scaleMs * 1.05;

  let cursorMs = 0;
  const rows = ordered.map((attempt) => {
    const dur = clampNonNeg(attempt.durationMs);
    const offsetMs = sequential ? cursorMs : 0;
    cursorMs += dur;
    const offsetPct = Math.min(98, (offsetMs / scaleMs) * 100);
    const rawWidthPct = dur > 0 ? Math.max(2, (dur / scaleMs) * 100) : 0;
    const widthPct = Math.min(100 - offsetPct, rawWidthPct);

    const rawTtft = attempt.firstOutputMs;
    const hasTtftSplit = typeof rawTtft === "number" && Number.isFinite(rawTtft) && rawTtft >= 0 && dur > 0;
    let ttftPct = 0;
    let decodePct = 100;
    if (hasTtftSplit) {
      const waitMs = Math.min(dur, rawTtft);
      ttftPct = Math.round((waitMs / dur) * 1000) / 10;
      decodePct = Math.max(0, Math.round((100 - ttftPct) * 10) / 10);
    }

    const tone: "ok" | "warn" | "err" = attempt.status === 429
      ? "warn"
      : attempt.status >= 400 || attempt.status === 0
        ? "err"
        : "ok";

    return {
      attempt,
      metrics: { offsetPct, widthPct, ttftPct, decodePct, hasTtftSplit, tone },
    };
  });

  return { scaleMs, rows };
}
