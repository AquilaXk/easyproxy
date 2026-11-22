import { describe, expect, test } from "bun:test";

import { readCodexLogGuardMode, writeCodexLogGuardMode } from "../../src/codex/log-guard/policy";
import type { EpxConfig } from "../../src/types";

describe("Codex Log Guard desired-state policy", () => {
  test("defaults missing or invalid modes to off", () => {
    const base = { port: 0, defaultProvider: "openai", providers: {} } as EpxConfig;
    expect(readCodexLogGuardMode({ load: () => base })).toBe("off");
    expect(readCodexLogGuardMode({
      load: () => ({ ...base, codexLogGuard: { mode: "maximum" } }) as EpxConfig,
    })).toBe("off");
  });

  test("persists mode while preserving sibling Log Guard settings", () => {
    const base = {
      port: 0,
      defaultProvider: "openai",
      providers: {},
      codexLogGuard: { mode: "off", futureSetting: 7 },
    } as unknown as EpxConfig;
    let saved: EpxConfig | null = null;
    writeCodexLogGuardMode("quiet", {
      load: () => structuredClone(base),
      save: config => { saved = config; },
    });
    expect(saved).not.toBeNull();
    expect((saved as unknown as { codexLogGuard: Record<string, unknown> }).codexLogGuard).toEqual({
      mode: "quiet",
      futureSetting: 7,
    });
  });
});
