import { describe, expect, test } from "bun:test";
import { estimateQuotaPace, inferWindowDurationMs } from "../src/quota-pace";

const HOUR_MS = 3_600_000;

describe("quota-pace", () => {
  test("infers standard quota window durations and rejects unknown labels", () => {
    expect(inferWindowDurationMs("5h")).toBe(5 * HOUR_MS);
    expect(inferWindowDurationMs("five-hour")).toBe(5 * HOUR_MS);
    expect(inferWindowDurationMs("daily")).toBe(24 * HOUR_MS);
    expect(inferWindowDurationMs("weekly")).toBe(7 * 24 * HOUR_MS);
    expect(inferWindowDurationMs("monthly")).toBe(30 * 24 * HOUR_MS);
    expect(inferWindowDurationMs("custom-opaque")).toBeNull();
  });

  test("predicts exhaustion before reset when burn rate exceeds remaining window", () => {
    const now = 1_700_000_000_000;
    // 5h window: 2h elapsed, 3h left; 60% used => 30%/h => 40% remaining in ~1.33h < 3h
    const estimate = estimateQuotaPace({
      percentUsed: 60,
      resetAtMs: now + 3 * HOUR_MS,
      windowDurationMs: 5 * HOUR_MS,
      nowMs: now,
    });
    expect(estimate).not.toBeNull();
    expect(estimate!.burnRatePctPerHour).toBeCloseTo(30, 5);
    expect(estimate!.etaToExhaustionMs).toBeCloseTo((40 / 30) * HOUR_MS, 0);
    expect(estimate!.willExhaustBeforeReset).toBe(true);
  });

  test("marks healthy pace when exhaustion occurs after window reset", () => {
    const now = 1_700_000_000_000;
    // 5h window: 4h elapsed, 1h left; 20% used => 5%/h => 80% remaining in 16h > 1h
    const estimate = estimateQuotaPace({
      percentUsed: 20,
      resetAtMs: now + 1 * HOUR_MS,
      windowDurationMs: 5 * HOUR_MS,
      nowMs: now,
    });
    expect(estimate).not.toBeNull();
    expect(estimate!.willExhaustBeforeReset).toBe(false);
  });

  test("returns null under cold-start elapsed time or invalid boundary inputs", () => {
    const now = 1_700_000_000_000;
    // Only 2 minutes elapsed inside 5h window
    expect(estimateQuotaPace({
      percentUsed: 15,
      resetAtMs: now + 5 * HOUR_MS - 120_000,
      windowDurationMs: 5 * HOUR_MS,
      nowMs: now,
    })).toBeNull();
    expect(estimateQuotaPace({ percentUsed: 0, resetAtMs: now + HOUR_MS, windowDurationMs: 5 * HOUR_MS, nowMs: now })).toBeNull();
    expect(estimateQuotaPace({ percentUsed: 100, resetAtMs: now + HOUR_MS, windowDurationMs: 5 * HOUR_MS, nowMs: now })).toBeNull();
    expect(estimateQuotaPace({ percentUsed: 50, resetAtMs: now - 1000, windowDurationMs: 5 * HOUR_MS, nowMs: now })).toBeNull();
    expect(estimateQuotaPace({ percentUsed: 50, resetAtMs: now + HOUR_MS, windowDurationMs: null, nowMs: now })).toBeNull();
  });
});
