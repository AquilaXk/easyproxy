import { describe, expect, test } from "bun:test";
import {
  JEV_API_URL,
  parseJevDecision,
  resolveJevDecision,
  selectMinRiskJevChoice,
  type JevCandidate,
} from "../../src/combos";
import { comboConfigIssues, normalizeComboConfig } from "../../src/combos/types";
import type { EpxConfig } from "../../src/types";
import {
  createJevStatsAccumulator,
  normalizePersistedJevDecision,
} from "../../src/usage/jev-stats";

const CANDIDATES: JevCandidate[] = [
  { key: "openai/gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna", reasoningEfforts: ["low", "medium", "high"] },
  { key: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoningEfforts: ["high", "xhigh"] },
];

const SINGLE_TARGET: JevCandidate[] = [
  { key: "openai/gpt-5.6-sol", provider: "openai", model: "gpt-5.6-sol", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
];

const BASE_CONFIG = {
  providers: {
    jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, apiKey: "jev-test" },
    openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
  },
} as unknown as EpxConfig;

describe("JEV 2-stage asymmetric min-risk selection policy", () => {
  test("Stage 1 picks target with highest marginal mass and Stage 2 picks asymmetric min-risk effort", () => {
    // Argmax would pick astra:high (0.35), while luna marginal mass is 0.60 > 0.40!
    // Conditional on luna: [0.30/0.60=0.50, 0.25/0.60=0.4167, 0.05/0.60=0.0833]
    // R(low=0) = 3*(0.4167*1 + 0.0833*2) = 1.75
    // R(medium=1) = 1*(0.50*1) + 3*(0.0833*1) = 0.75 (MIN)
    // R(high=2) = 1*(0.50*2 + 0.4167*1) = 1.4167
    const distribution = new Map<string, number>([
      ["openai/gpt-5.6-luna:low", 0.30],
      ["openai/gpt-5.6-luna:medium", 0.25],
      ["openai/gpt-5.6-luna:high", 0.05],
      ["openai/gpt-6-astra:high", 0.35],
      ["openai/gpt-6-astra:xhigh", 0.05],
    ]);

    const result = selectMinRiskJevChoice({
      candidates: CANDIDATES,
      distribution,
      fallbackChoice: { targetKey: "openai/gpt-6-astra", effort: "high" },
    });

    expect(result.targetKey).toBe("openai/gpt-5.6-luna");
    expect(result.effort).toBe("medium");
    expect(result.delta).toEqual({ differs: true, targetChanged: true, effortStepDelta: -1 });
  });

  test("asymmetric loss breaks exact ties toward the middle effort tier", () => {
    // Uniform [0.25, 0.25, 0.25, 0.25]:
    // R(0)=4.5, R(1)=2.5, R(2)=1.5, R(3)=1.5 -> tie between high(2) and xhigh(3) -> middle (2=high) wins!
    const uniform = new Map<string, number>([
      ["openai/gpt-5.6-sol:low", 0.25],
      ["openai/gpt-5.6-sol:medium", 0.25],
      ["openai/gpt-5.6-sol:high", 0.25],
      ["openai/gpt-5.6-sol:xhigh", 0.25],
    ]);
    const resUniform = selectMinRiskJevChoice({
      candidates: SINGLE_TARGET,
      distribution: uniform,
      fallbackChoice: { targetKey: "openai/gpt-5.6-sol", effort: "xhigh" },
    });
    expect(resUniform.effort).toBe("high");
    expect(resUniform.delta).toEqual({ differs: true, targetChanged: false, effortStepDelta: -1 });

    // [0.50, 0.25, 0.25] across [low, medium, high]:
    // R(0)=2.25, R(1)=1.25, R(2)=1.25 -> tie between medium(1) and high(2) -> middle (1=medium) wins!
    const threeTier: JevCandidate[] = [
      { key: "openai/gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna", reasoningEfforts: ["low", "medium", "high"] },
    ];
    const dist3 = new Map<string, number>([
      ["openai/gpt-5.6-luna:low", 0.50],
      ["openai/gpt-5.6-luna:medium", 0.25],
      ["openai/gpt-5.6-luna:high", 0.25],
    ]);
    const res3 = selectMinRiskJevChoice({
      candidates: threeTier,
      distribution: dist3,
      fallbackChoice: { targetKey: "openai/gpt-5.6-luna", effort: "low" },
    });
    expect(res3.effort).toBe("medium");
  });

  test("confident easy turn keeps low effort without upward drift", () => {
    const easy = new Map<string, number>([
      ["openai/gpt-5.6-sol:low", 0.85],
      ["openai/gpt-5.6-sol:medium", 0.10],
      ["openai/gpt-5.6-sol:high", 0.05],
      ["openai/gpt-5.6-sol:xhigh", 0.00],
    ]);
    const res = selectMinRiskJevChoice({
      candidates: SINGLE_TARGET,
      distribution: easy,
      fallbackChoice: { targetKey: "openai/gpt-5.6-sol", effort: "low" },
    });
    expect(res.effort).toBe("low");
    expect(res.delta).toEqual({ differs: false, targetChanged: false, effortStepDelta: 0 });
  });

  test("fails closed on empty/non-finite/out-of-range distributions", () => {
    const fallback = { targetKey: "openai/gpt-5.6-sol", effort: "high" as const };
    expect(selectMinRiskJevChoice({ candidates: [], distribution: new Map(), fallbackChoice: fallback }))
      .toEqual({ ...fallback, delta: { differs: false, targetChanged: false, effortStepDelta: 0 } });
    expect(selectMinRiskJevChoice({
      candidates: SINGLE_TARGET,
      distribution: new Map([["openai/gpt-5.6-sol:high", Number.NaN]]),
      fallbackChoice: fallback,
    })).toEqual({ ...fallback, delta: { differs: false, targetChanged: false, effortStepDelta: 0 } });
  });
});

describe("JEV decision resolution & stats across selection policies", () => {
  const payload = {
    answers: {
      route: {
        choice: "openai/gpt-6-astra:high",
        confidence: 0.45,
        probabilities: {
          "openai/gpt-5.6-luna:low": 0.30,
          "openai/gpt-5.6-luna:medium": 0.25,
          "openai/gpt-5.6-luna:high": 0.05,
          "openai/gpt-6-astra:high": 0.35,
          "openai/gpt-6-astra:xhigh": 0.05,
        },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };

  test("parseJevDecision retains exact output shape and distribution integrity checks", () => {
    expect(parseJevDecision(payload, CANDIDATES)).toEqual({
      targetKey: "openai/gpt-6-astra",
      effort: "high",
      confidence: 0.45,
      chosenProbability: 0.35,
      usage: { input_tokens: 100, output_tokens: 10 },
    });
  });

  test("min-risk changes decision while observe keeps argmax routing and emits content-free policyDelta", async () => {
    const post = (async () => Response.json(payload)) as unknown as NonNullable<Parameters<typeof resolveJevDecision>[0]["post"]>;

    const argmaxDec = await resolveJevDecision({
      body: { input: "Check tiny typo" },
      candidates: CANDIDATES,
      fallback: { targetKey: CANDIDATES[0]!.key, effort: "low" },
      config: BASE_CONFIG,
      jevSelectionPolicy: "argmax",
      post,
    });
    expect(argmaxDec.targetKey).toBe("openai/gpt-6-astra");
    expect(argmaxDec.effort).toBe("high");
    expect(argmaxDec.policy).toBeUndefined();
    expect(argmaxDec.policyDelta).toBeUndefined();

    const minRiskDec = await resolveJevDecision({
      body: { input: "Check tiny typo" },
      candidates: CANDIDATES,
      fallback: { targetKey: CANDIDATES[0]!.key, effort: "low" },
      config: BASE_CONFIG,
      jevSelectionPolicy: "min-risk",
      post,
    });
    expect(minRiskDec.targetKey).toBe("openai/gpt-5.6-luna");
    expect(minRiskDec.effort).toBe("medium");
    expect(minRiskDec.chosenProbability).toBe(0.25);
    expect(minRiskDec.policy).toBe("min-risk");
    expect(minRiskDec.policyDelta).toEqual({ differs: true, targetChanged: true, effortStepDelta: -1 });

    const observeDec = await resolveJevDecision({
      body: { input: "Check tiny typo" },
      candidates: CANDIDATES,
      fallback: { targetKey: CANDIDATES[0]!.key, effort: "low" },
      config: BASE_CONFIG,
      jevSelectionPolicy: "observe",
      post,
    });
    expect(observeDec.targetKey).toBe("openai/gpt-6-astra");
    expect(observeDec.effort).toBe("high");
    expect(observeDec.chosenProbability).toBe(0.35);
    expect(observeDec.policy).toBe("observe");
    expect(observeDec.policyDelta).toEqual({ differs: true, targetChanged: true, effortStepDelta: -1 });
  });

  test("combo validation keeps default sparse and rejects non-jev or unknown policies", () => {
    const targets = [{ provider: "openai", model: "gpt-5.6-sol" }];
    expect(comboConfigIssues("c", { strategy: "jev", targets, jevSelectionPolicy: "min-risk" }, BASE_CONFIG.providers)).toEqual([]);
    expect(comboConfigIssues("c", { strategy: "jev", targets, jevSelectionPolicy: "observe" }, BASE_CONFIG.providers)).toEqual([]);
    expect(comboConfigIssues("c", { strategy: "failover", targets, jevSelectionPolicy: "observe" }, BASE_CONFIG.providers).length).toBeGreaterThan(0);
    expect(comboConfigIssues("c", { strategy: "jev", targets, jevSelectionPolicy: "bogus" as any }, BASE_CONFIG.providers).length).toBeGreaterThan(0);

    expect(normalizeComboConfig({ strategy: "jev", targets, jevSelectionPolicy: "argmax" })).not.toHaveProperty("jevSelectionPolicy");
    expect(normalizeComboConfig({ strategy: "jev", targets, jevSelectionPolicy: "min-risk" }).jevSelectionPolicy).toBe("min-risk");
  });

  test("jev-stats aggregates content-free policy deltas cleanly and rejects out-of-range effortStepDelta", () => {
    const valid = normalizePersistedJevDecision({
      version: 1,
      comboId: "auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
      gate: "apply",
      latencyMs: 12,
      policy: "observe",
      policyDelta: { differs: true, targetChanged: true, effortStepDelta: -1 },
    });
    expect(valid?.policy).toBe("observe");
    expect(valid?.policyDelta).toEqual({ differs: true, targetChanged: true, effortStepDelta: -1 });

    // Out-of-bounds effortStepDelta is dropped cleanly without corrupting entry.
    const badDelta = normalizePersistedJevDecision({
      version: 1,
      comboId: "auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
      gate: "apply",
      latencyMs: 12,
      policy: "min-risk",
      policyDelta: { differs: true, targetChanged: false, effortStepDelta: 99 },
    });
    expect(badDelta?.policyDelta).toBeUndefined();

    const acc = createJevStatsAccumulator();
    acc.add({
      requestId: "r1",
      timestamp: 1000,
      provider: "openai",
      model: "gpt-6-astra",
      status: 200,
      durationMs: 20,
      usageStatus: "reported",
      jevDecision: valid,
    });
    const summary = acc.clone().summarize("7d", 2000);
    expect(summary.selectionPolicy).toEqual({
      compared: 1,
      differed: 1,
      targetChanged: 1,
      effortDecreased: 1,
      effortIncreased: 0,
      byPolicy: { argmax: 0, minRisk: 0, observe: 1 },
    });
  });
});
