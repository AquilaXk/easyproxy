import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboSelectionState,
  noteComboSuccess,
  pickComboTarget,
  reconcileComboRotationState,
} from "../../src/combos/resolve";
import { getCombo } from "../../src/combos/types";
import type { EpxConfig } from "../../src/types";

function leastUsedConfig(): EpxConfig {
  return {
    port: 0,
    defaultProvider: "p1",
    providers: {
      p1: { adapter: "openai-responses", baseUrl: "https://example.invalid/v1", apiKey: "k1", models: ["m1"] },
      p2: { adapter: "openai-responses", baseUrl: "https://example.invalid/v1", apiKey: "k2", models: ["m2"] },
    },
    combos: {
      "least-combo": {
        strategy: "least-used",
        targets: [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "m2" },
        ],
      },
    },
  };
}

describe("least-used combo preview isolation", () => {
  afterEach(() => {
    clearComboSelectionState();
  });

  test("preview picks do not create or mutate selectionState", () => {
    const config = leastUsedConfig();
    const firstPreview = pickComboTarget(config, "least-combo", { preview: true });
    expect(firstPreview?.target.provider).toBe("p1");

    // Reconciling against an empty combo set drops any tracked combo entry.
    // Because preview: true must not populate selectionState, removed stays 0.
    const removedAfterPreview = reconcileComboRotationState({
      generation: 1,
      comboIds: new Set(),
      comboTargets: new Set(),
    });
    expect(removedAfterPreview).toBe(0);

    // A non-preview pick followed by success DOES record state, and subsequent
    // preview picks observe that recorded balance without mutating it.
    const livePick = pickComboTarget(config, "least-combo");
    expect(livePick?.target.provider).toBe("p1");
    const combo = getCombo(config, "least-combo")!;
    noteComboSuccess("least-combo", combo, livePick!.target, 2);

    const previewAfterSuccess = pickComboTarget(config, "least-combo", { preview: true });
    expect(previewAfterSuccess?.target.provider).toBe("p2");

    const removedAfterLive = reconcileComboRotationState({
      generation: 2,
      comboIds: new Set(),
      comboTargets: new Set(),
    });
    expect(removedAfterLive).toBe(1);
  });
});
