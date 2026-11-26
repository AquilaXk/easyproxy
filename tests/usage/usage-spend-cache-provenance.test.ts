import { describe, expect, test } from "bun:test";
import {
  classifyCacheTelemetryProvenance,
  normalizeRequestSpend,
  normalizeUsageEntryForTest,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { cacheObservationFromUsage, summarizeUsage } from "../../src/usage/summary";
import { calculateNetCacheSavingsUsd, estimateRequestCost } from "../../src/usage/cost";
import { EXPECTED_PRICE_OVERLAYS } from "../../src/usage/expected-prices";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function entry(overrides: Partial<PersistedUsageEntry> & { requestId: string }): PersistedUsageEntry {
  return {
    timestamp: NOW - 1000,
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    ...overrides,
  };
}

describe("cache telemetry provenance", () => {
  test("a zero is observed when reported raw and synthesized when read off a wire", () => {
    const zeroDetail = { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0 };
    expect(classifyCacheTelemetryProvenance(zeroDetail)).toBe("observed");
    expect(classifyCacheTelemetryProvenance(zeroDetail, { wireParsed: true })).toBe("synthesized");
    // A positive reading is a measurement whatever carried it.
    expect(classifyCacheTelemetryProvenance({ ...zeroDetail, cacheReadInputTokens: 5 }, { wireParsed: true }))
      .toBe("observed");
    // No detail at all is not a zero.
    expect(classifyCacheTelemetryProvenance({ inputTokens: 1000, outputTokens: 10 })).toBe("unknown");
    expect(classifyCacheTelemetryProvenance(undefined)).toBe("unknown");
  });

  test("a row written before the field existed keeps its previous reading", () => {
    expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0 }, undefined).provenance)
      .toBe("observed");
    expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1 }, undefined).provenance).toBe("unknown");
    expect(cacheObservationFromUsage(undefined, undefined).provenance).toBe("unknown");
    // A stored label cannot invent a denominator the row has no fields for.
    expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1 }, "observed").provenance).toBe("unknown");
  });
});

describe("persisted spend record", () => {
  test("counts must be whole, non-negative and internally consistent", () => {
    expect(normalizeRequestSpend({ sends: 4, settled: 3, unresolved: 1, reserved: 4 }))
      .toEqual({ sends: 4, settled: 3, unresolved: 1, reserved: 4 });
    // More settled spend than was ever sent understates the unexplained remainder.
    expect(normalizeRequestSpend({ sends: 2, settled: 3, unresolved: 0 })).toBeUndefined();
    expect(normalizeRequestSpend({ sends: 2.5, settled: 1, unresolved: 1 })).toBeUndefined();
    expect(normalizeRequestSpend({ sends: 2, settled: 1, unresolved: -1 })).toBeUndefined();
    expect(normalizeRequestSpend({ sends: 1, settled: 1, unresolved: 0, moveReasons: ["quota_refusal", "nonsense"] }))
      .toEqual({ sends: 1, settled: 1, unresolved: 0, moveReasons: ["quota_refusal"] });
  });

  test("the ledger keeps spend, provenance and a well-formed logical request id", () => {
    const normalized = normalizeUsageEntryForTest(entry({
      requestId: "epx-1",
      logicalRequestId: "lr-abc-1",
      usage: { inputTokens: 100, outputTokens: 5 },
      spend: { sends: 4, settled: 4, unresolved: 0, reserved: 4, policyVersion: "guarded-v1" },
      cacheProvenance: "synthesized",
    }));
    expect(normalized.logicalRequestId).toBe("lr-abc-1");
    expect(normalized.spend?.sends).toBe(4);
    expect(normalized.spend?.policyVersion).toBe("guarded-v1");
    expect(normalized.cacheProvenance).toBe("synthesized");

    const rejected = normalizeUsageEntryForTest(entry({
      requestId: "epx-2",
      logicalRequestId: "lr abc\nnewline",
      spend: { sends: 1, settled: 2, unresolved: 0 },
      cacheProvenance: "made-up" as PersistedUsageEntry["cacheProvenance"],
    }));
    expect(rejected).not.toHaveProperty("logicalRequestId");
    expect(rejected).not.toHaveProperty("spend");
    expect(rejected).not.toHaveProperty("cacheProvenance");
  });
});

describe("usage summary spend and cache provenance", () => {
  test("sends are totalled per logical request, with unresolved spend kept apart from settled", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "epx-a",
        logicalRequestId: "lr-a",
        usage: { inputTokens: 100, outputTokens: 5 },
        spend: { sends: 4, settled: 3, unresolved: 1, reserved: 4 },
      }),
      entry({
        requestId: "epx-b",
        logicalRequestId: "lr-b",
        usage: { inputTokens: 100, outputTokens: 5 },
        spend: { sends: 2, settled: 2, unresolved: 0, reserved: 2 },
      }),
      // A row from before the record existed contributes no sends rather than a zero.
      entry({ requestId: "epx-c", usage: { inputTokens: 100, outputTokens: 5 } }),
    ], "30d", NOW);

    expect(summary.summary.requests).toBe(3);
    expect(summary.summary.sends).toBe(6);
    expect(summary.summary.settledSends).toBe(5);
    expect(summary.summary.unresolvedSends).toBe(1);
    expect(summary.summary.spendRequests).toBe(2);
    // Two logical requests reached upstream six times; the attempt count alone would say three.
    expect(summary.summary.attemptCount).toBe(3);
  });

  test("an unknown or synthesized cache detail is never averaged as an observed zero", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "epx-observed",
        usage: { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 400, cacheCreationInputTokens: 0 },
        cacheProvenance: "observed",
      }),
      entry({
        requestId: "epx-unknown",
        usage: { inputTokens: 1000, outputTokens: 10 },
        cacheProvenance: "unknown",
      }),
      entry({
        requestId: "epx-synth",
        usage: { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0 },
        cacheProvenance: "synthesized",
      }),
    ], "30d", NOW);

    const model = summary.models.find(row => row.model === "claude-sonnet-5");
    expect(model?.inputTokens).toBe(3000);
    expect(model?.cacheReadInputTokens).toBe(400);
    // 400 of the 1000 tokens that were actually measured, not 400 of all 3000.
    expect(model?.cacheObservedInputTokens).toBe(1000);
    expect(model?.cacheHitRate).toBeCloseTo(0.4);

    const provider = summary.providers.find(row => row.provider === "anthropic");
    expect(provider?.cacheHitRate).toBeCloseTo(0.4);
    const day = summary.days.find(row => row.models.some(m => m.model === "claude-sonnet-5"));
    expect(day?.models[0]?.cacheHitRate).toBeCloseTo(0.4);

    expect(summary.summary.cacheObservedRequests).toBe(1);
    expect(summary.summary.cacheUnknownRequests).toBe(1);
    expect(summary.summary.cacheSynthesizedRequests).toBe(1);
    expect(summary.summary.cacheObservedInputTokens).toBe(1000);
  });

  test("a window with no observed cache detail reports no rate rather than a zero one", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "epx-only-synth",
        usage: { inputTokens: 500, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0 },
        cacheProvenance: "synthesized",
      }),
    ], "30d", NOW);
    expect(summary.models[0]?.cacheHitRate).toBeNull();
    expect(summary.models[0]?.cacheObservedInputTokens).toBe(0);
  });

  test("a combo child without its own cache detail does not inherit a sibling's observation", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "epx-combo",
        provider: "combo",
        model: "combo/pair",
        usage: { inputTokens: 2000, outputTokens: 20 },
        cacheProvenance: "observed",
        attempts: [
          {
            ordinal: 1, provider: "anthropic", model: "claude-sonnet-5", adapter: "anthropic",
            status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
            usage: { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 500 },
            cacheProvenance: "observed",
          },
          {
            ordinal: 2, provider: "anthropic", model: "claude-opus-5", adapter: "anthropic",
            status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
            usage: { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0 },
            cacheProvenance: "synthesized",
          },
        ],
      }),
    ], "30d", NOW);

    const sonnet = summary.models.find(row => row.model === "claude-sonnet-5");
    const opus = summary.models.find(row => row.model === "claude-opus-5");
    expect(sonnet?.cacheHitRate).toBeCloseTo(0.5);
    expect(opus?.cacheHitRate).toBeNull();
    expect(opus?.cacheObservedInputTokens).toBe(0);
    expect(summary.summary.cacheObservedInputTokens).toBe(1000);
    expect(summary.summary.cacheHitRate).toBeCloseTo(0.5);
  });

  test("summary surfaces overall cacheHitRate and positive estimatedCacheSavingsUsd while omitting write-only surcharges and credit billing", () => {
    // Direct unit check on calculateNetCacheSavingsUsd with 5m and 1h writes
    const rate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const netHit = calculateNetCacheSavingsUsd(
      { input: 20_000, output: 1_000, cacheRead: 100_000, cacheWrite: 10_000 },
      rate,
      { input: 0.06, output: 0.015, cacheRead: 0.03, cacheWrite: 0.0375, total: 0.1425 },
    );
    // Savings on 100k read = (3 - 0.3) * 0.1 = $0.27; surcharge on 10k 5m write = (3.75 - 3) * 0.01 = $0.0075 -> net $0.2625
    expect(netHit).toBeCloseTo(0.2625, 8);

    const net1hWriteOnly = calculateNetCacheSavingsUsd(
      { input: 10_000, output: 500, cacheRead: 0, cacheWrite: 20_000, cacheWrite1h: 20_000 },
      rate,
      { input: 0.03, output: 0.0075, cacheRead: 0, cacheWrite: 0.12, total: 0.1575 },
    );
    // 1h write costs 2x input ($6/M vs $3/M -> -$0.06 net)
    expect(net1hWriteOnly).toBeCloseTo(-0.06, 8);

    // Summary aggregation: positive net savings surfaced alongside overall cacheHitRate
    const positiveSummary = summarizeUsage([
      entry({
        requestId: "epx-cache-save-1",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          inputTokens: 120_000,
          outputTokens: 2_000,
          cachedInputTokens: 100_000,
          cacheReadInputTokens: 100_000,
          cacheCreationInputTokens: 0,
        },
        cacheProvenance: "observed",
      }),
    ], "7d", NOW);
    expect(positiveSummary.summary.cacheHitRate).toBeCloseTo(100_000 / 120_000, 6);
    expect(positiveSummary.summary.estimatedCacheSavingsUsd).toBeGreaterThan(0.2);

    // Write-only window has negative net cache delta -> estimatedCacheSavingsUsd stays undefined
    const writeOnlySummary = summarizeUsage([
      entry({
        requestId: "epx-cache-write-only",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          inputTokens: 50_000,
          outputTokens: 1_000,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 40_000,
        },
        cacheProvenance: "observed",
      }),
    ], "7d", NOW);
    expect(writeOnlySummary.summary.cacheHitRate).toBe(0);
    expect(writeOnlySummary.summary.estimatedCacheSavingsUsd).toBeUndefined();

    // Credit-billed provider must never synthesize token cache USD savings
    const creditEstimate = estimateRequestCost(
      entry({
        requestId: "epx-credit-1",
        provider: "creditprov",
        model: "custom-m",
        usage: {
          inputTokens: 100_000,
          outputTokens: 1_000,
          cachedInputTokens: 80_000,
          cacheReadInputTokens: 80_000,
          providerCredits: 5,
        },
      }),
      EXPECTED_PRICE_OVERLAYS,
      [
        {
          provider: "creditprov",
          modelId: "custom-m",
          cost4: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          status: "verified",
        },
      ],
      new Map([["creditprov", 0.01]]),
    );
    expect(creditEstimate).not.toBeNull();
    expect(creditEstimate!.billing?.source).toBe("provider-credits");
    expect(creditEstimate!.netCacheSavingsUsd).toBeUndefined();

    // Per-model and per-provider breakdowns surface positive net cache savings and omit non-positive rows
    const breakdownSummary = summarizeUsage([
      entry({
        requestId: "epx-prov-save-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        cacheProvenance: "observed",
        usage: {
          inputTokens: 100_000,
          outputTokens: 1_000,
          cachedInputTokens: 90_000,
          cacheReadInputTokens: 90_000,
          cacheCreationInputTokens: 5_000,
        },
      }),
      entry({
        requestId: "epx-prov-nosave-1",
        provider: "openai",
        model: "gpt-5.4",
        cacheProvenance: "observed",
        usage: {
          inputTokens: 10_000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      }),
    ], "7d", NOW);
    const sonnetRow = breakdownSummary.models.find(m => m.model === "claude-sonnet-4-6");
    const gptRow = breakdownSummary.models.find(m => m.model === "gpt-5.4");
    const anthropicProv = breakdownSummary.providers.find(p => p.provider === "anthropic");
    const openaiProv = breakdownSummary.providers.find(p => p.provider === "openai");
    expect(sonnetRow?.estimatedCacheSavingsUsd).toBeGreaterThan(0.2);
    expect(anthropicProv?.estimatedCacheSavingsUsd).toBeCloseTo(sonnetRow!.estimatedCacheSavingsUsd!, 6);
    expect(gptRow?.estimatedCacheSavingsUsd).toBeUndefined();
    expect(openaiProv?.estimatedCacheSavingsUsd).toBeUndefined();
  });
});
