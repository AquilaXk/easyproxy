import { afterEach, describe, expect, test } from "bun:test";
import {
  CACHE_BREAKEVEN_MIN_EXPECTED_SAVINGS_USD,
  CACHE_WRITE_1H_MULTIPLIER,
  evaluatePromptCacheBreakeven,
  inferContextWindowTokens,
  inspectPromptContextJson,
} from "../../src/lib/context-inspector";
import {
  checkMacOSRefreshReadiness,
  createMacOSPowerReadyChecker,
  isInteractiveMacOSPowerReady,
  parseMacOSSystemCapabilitiesReady,
  resetMacOSPowerStateCacheForTests,
} from "../../src/lib/macos-power-state";
import {
  compressResponsesToolOutputsInPlace,
  foldRepetitiveLogLines,
} from "../../src/lib/tool-output-compression";
import { registerAnthropicCooldownRecoveryProbeWorker } from "../../src/providers/quota/anthropic-cooldown-recovery-worker";
import { registerCodexQuotaAutoRefreshWorker } from "../../src/codex/quota-auto-refresh";
import { getDefaultConfig } from "../../src/config";

describe("P1-C macOS DarkWake readiness guard", () => {
  afterEach(() => {
    resetMacOSPowerStateCacheForTests();
  });

  test("short-circuits true on non-darwin platforms without invoking probe", async () => {
    let probeCalls = 0;
    const ready = await isInteractiveMacOSPowerReady({
      platform: "linux",
      readState: async () => {
        probeCalls += 1;
        return "";
      },
    });
    expect(ready).toBe(true);
    expect(probeCalls).toBe(0);
  });

  test("distinguishes Display Sleep/headless hosts from true DarkWake and falls back ready on probe failures", () => {
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n",
    )).toEqual({ ready: true, reason: "interactive_ready" });

    // Display Sleep or headless Mac: Power State 4 with Network (without Graphics) is active and ready.
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Network \nCurrent Power State: 4\n",
    )).toEqual({ ready: true, reason: "interactive_ready" });

    // Display Sleep / active host with Audio + Network (without Power State line) is active and ready.
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Audio Network \n",
    )).toEqual({ ready: true, reason: "interactive_ready" });

    // Power Nap / DarkWake: Network or CPU present at lower power state without Graphics/Audio.
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Network \nCurrent Power State: 2\n",
    )).toEqual({ ready: false, reason: "dark_wake_missing_capabilities" });

    // Offline wake: Graphics present without Network.
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Graphics \nCurrent Power State: 4\n",
    )).toEqual({ ready: false, reason: "dark_wake_missing_capabilities" });

    // Malformed / missing capabilities output fails open so background OAuth workers never starve.
    expect(parseMacOSSystemCapabilitiesReady("Current Power State: 4\n")).toEqual({
      ready: true,
      reason: "capabilities_line_missing",
    });
    expect(parseMacOSSystemCapabilitiesReady("")).toEqual({
      ready: true,
      reason: "capabilities_line_missing",
    });

    // Empty "Current Power State:" must not coerce Number("") === 0 and override Audio+Network active wake.
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Audio Network \nCurrent Power State:\n",
    )).toEqual({ ready: true, reason: "interactive_ready" });
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Audio Network \nCurrent Power State:   \n",
    )).toEqual({ ready: true, reason: "interactive_ready" });
    expect(parseMacOSSystemCapabilitiesReady(
      "Current System Capabilities are: CPU Network \nCurrent Power State:\n",
    )).toEqual({ ready: false, reason: "dark_wake_missing_capabilities" });
  });

  test("falls back to ready: true when pmset reader throws or returns non-capabilities output, and caches within TTL", async () => {
    const failed = await checkMacOSRefreshReadiness({
      platform: "darwin",
      readState: async () => {
        throw new Error("pmset timed out");
      },
    });
    expect(failed).toEqual({ ready: true, reason: "probe_failed" });

    let reads = 0;
    let clock = 1_000;
    const checker = createMacOSPowerReadyChecker(async () => {
      reads += 1;
      return "Current System Capabilities are: CPU Graphics Audio Network \n";
    }, 2_000);

    const originalNow = Date.now;
    Date.now = () => clock;
    try {
      const a = await checker.check({ platform: "darwin" });
      const b = await checker.check({ platform: "darwin" });
      clock += 2_500;
      const c = await checker.check({ platform: "darwin" });
      expect(a).toEqual({ ready: true, reason: "interactive_ready" });
      expect(b).toEqual({ ready: true, reason: "interactive_ready", cached: true });
      expect(c).toEqual({ ready: true, reason: "interactive_ready" });
      expect(reads).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test("background worker registration defers during DarkWake cleanly and cleans up on dispose", async () => {
    const config = getDefaultConfig();
    let powerCalls = 0;
    const disposeAnthropic = registerAnthropicCooldownRecoveryProbeWorker(config, {
      isPowerReady: async () => {
        powerCalls += 1;
        return false;
      },
    });
    const disposeCodex = registerCodexQuotaAutoRefreshWorker(config, {
      isPowerReady: async () => {
        powerCalls += 1;
        return false;
      },
    });
    expect(typeof disposeAnthropic).toBe("function");
    expect(typeof disposeCodex).toBe("function");
    disposeAnthropic();
    disposeCodex();
    expect(powerCalls).toBe(0);
  });
});

describe("P1-D(a) command-aware lossless folding of consecutive passing test logs", () => {
  test("folds Bun, Jest/Vitest, Cargo, Pytest, and Go passing runs while keeping first, last, and failures verbatim", () => {
    const bunLog = [
      "bun test v1.4.4",
      ...Array.from({ length: 12 }, (_, idx) => `✓ tests/server/suite_${idx}.test.ts > case_${idx} handles auth cleanly [${idx + 1}.05ms]`),
      "✗ tests/server/fail.test.ts > asserts token mismatch",
      "Expected: 200, Received: 401",
      "    at Object.<anonymous> (/repo/tests/server/fail.test.ts:44:12)",
      " 12 pass",
      " 1 fail",
    ].join("\n");

    const foldedBun = foldRepetitiveLogLines(bunLog);
    expect(foldedBun.folded).toBe(true);
    expect(foldedBun.text).toContain("✓ tests/server/suite_0.test.ts");
    expect(foldedBun.text).toContain("[... 10 intermediate passing tests folded]");
    expect(foldedBun.text).toContain("✓ tests/server/suite_11.test.ts");
    expect(foldedBun.text).toContain("✗ tests/server/fail.test.ts > asserts token mismatch");
    expect(foldedBun.text).toContain("at Object.<anonymous> (/repo/tests/server/fail.test.ts:44:12)");

    const cargoLog = [
      "running 8 tests",
      ...Array.from({ length: 8 }, (_, idx) => `test integration::worker_case_${idx}::rejects_invalid_payload ... ok`),
      "test result: ok. 8 passed; 0 failed; 0 ignored",
    ].join("\n");
    const foldedCargo = foldRepetitiveLogLines(cargoLog);
    expect(foldedCargo.folded).toBe(true);
    expect(foldedCargo.text).toContain("test integration::worker_case_0::rejects_invalid_payload ... ok");
    expect(foldedCargo.text).toContain("[... 6 intermediate passing tests folded]");
    expect(foldedCargo.text).toContain("test integration::worker_case_7::rejects_invalid_payload ... ok");
    expect(foldedCargo.text).toContain("test result: ok. 8 passed; 0 failed; 0 ignored");

    const goLog = [
      ...Array.from({ length: 6 }, (_, idx) => `=== RUN   TestRouterAuthCase${idx}\n--- PASS: TestRouterAuthCase${idx} (0.0${idx}s)`),
      "=== RUN   TestRouterBroken",
      "--- FAIL: TestRouterBroken (0.01s)",
      "PASS_CHECK_ERROR: mismatch",
    ].join("\n");
    const foldedGo = foldRepetitiveLogLines(goLog);
    expect(foldedGo.folded).toBe(true);
    expect(foldedGo.text).toContain("=== RUN   TestRouterAuthCase0");
    expect(foldedGo.text).toContain("[... 4 intermediate passing tests folded]");
    expect(foldedGo.text).toContain("--- PASS: TestRouterAuthCase5 (0.05s)");
    expect(foldedGo.text).toContain("=== RUN   TestRouterBroken\n--- FAIL: TestRouterBroken (0.01s)");

    const pytestLog = [
      ...Array.from({ length: 7 }, (_, idx) => `tests/unit/test_routing_${idx}.py::test_route_handles_error_cleanly PASSED [ ${Math.round(((idx + 1) / 7) * 100)}%]`),
      "=== 7 passed in 0.42s ===",
    ].join("\n");
    const foldedPytest = foldRepetitiveLogLines(pytestLog);
    expect(foldedPytest.folded).toBe(true);
    expect(foldedPytest.text).toContain("[... 5 intermediate passing tests folded]");
    expect(foldedPytest.text).toContain("=== 7 passed in 0.42s ===");

    const jestLog = [
      ...Array.from({ length: 6 }, (_, idx) => `PASS src/components/__tests__/panel_${idx}.test.tsx (123 ms)`),
      "Test Suites: 6 passed, 6 total",
    ].join("\n");
    const foldedJest = foldRepetitiveLogLines(jestLog);
    expect(foldedJest.folded).toBe(true);
    expect(foldedJest.text).toContain("[... 4 intermediate passing tests folded]");
    expect(foldedJest.text).toContain("Test Suites: 6 passed, 6 total");
  });

  test("preserves small < 4 test runs, mixed pass/skip runs, and Responses tool payloads without corruption", () => {
    const small = [
      "✓ tests/a.test.ts > case 1 [1.00ms]",
      "✓ tests/a.test.ts > case 2 [1.00ms]",
      "✓ tests/a.test.ts > case 3 [1.00ms]",
      "--- trailing warning line that pads the payload over 160 chars ---",
    ].join("\n");
    expect(foldRepetitiveLogLines(small)).toEqual({ text: small, folded: false });

    const payload = {
      input: [
        {
          type: "function_call_output",
          call_id: "call_test_run",
          output: Array.from({ length: 10 }, (_, idx) => `✓ tests/unit/case_${idx}.test.ts > passes cleanly [1.2ms]`).join("\n"),
        },
      ],
    };
    const res = compressResponsesToolOutputsInPlace(payload, {
      enabled: true,
      minChars: 50_000,
      foldRepetitiveLines: true,
    });
    expect(res.foldedLogItems).toBe(1);
    expect(payload.input[0]!.output).toContain("[... 8 intermediate passing tests folded]");
  });
});

describe("P2(c) manual prompt-cache breakeven diagnostic calculation", () => {
  test("computes exact 5m and 1h write amortization hit counts and warm/miss savings without network I/O", () => {
    // Claude Sonnet 4.6 pricing: input $3, output $15, cacheRead $0.30, cacheWrite $3.75 per MTok
    const sonnetRates = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
    const diag5m = evaluatePromptCacheBreakeven({ prefixTokens: 100_000, rates: sonnetRates, writeTtl: "5m" });
    expect(diag5m.economicsAvailable).toBe(true);
    expect(diag5m.writePremiumUsd).toBeCloseTo(0.075, 6);
    expect(diag5m.perHitSavingsUsd).toBeCloseTo(0.27, 6);
    expect(diag5m.breakevenFollowUpHits).toBeCloseTo(0.75 / 2.7, 6);
    expect(diag5m.breakevenHitCount).toBe(1);
    expect(diag5m.activeExpectedSavingsUsd).toBeCloseTo(0.375 - 0.03 - (0.03 + 0.000015), 6);
    expect(diag5m.worthwhileActive).toBe(true);
    expect(diag5m.worthwhileIdle).toBe(diag5m.idleExpectedSavingsUsd >= CACHE_BREAKEVEN_MIN_EXPECTED_SAVINGS_USD);

    // 1h TTL increases write price by 2 / 1.25 = 1.6x -> $6.00/MTok ($3/MTok premium -> 2 follow-up hits break even)
    const diag1h = evaluatePromptCacheBreakeven({ prefixTokens: 100_000, rates: sonnetRates, writeTtl: "1h" });
    expect(diag1h.writePremiumUsd).toBeCloseTo((100_000 * (3.75 * CACHE_WRITE_1H_MULTIPLIER - 3)) / 1_000_000, 6);
    expect(diag1h.breakevenFollowUpHits).toBeCloseTo(3 / 2.7, 6);
    expect(diag1h.breakevenHitCount).toBe(2);

    // Zero tokens / zero pricing fail gracefully with economicsAvailable: false
    expect(evaluatePromptCacheBreakeven({ prefixTokens: 0, rates: sonnetRates })).toMatchObject({
      economicsAvailable: false,
      breakevenHitCount: null,
      worthwhileActive: false,
    });
    expect(evaluatePromptCacheBreakeven({
      prefixTokens: 10_000,
      rates: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    })).toMatchObject({ economicsAvailable: false, breakevenHitCount: null });

    // Free cache writes (OpenAI / Gemini style): breakevenHitCount is 0 when cacheRead < input
    const openAiRates = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 0 };
    expect(evaluatePromptCacheBreakeven({ prefixTokens: 50_000, rates: openAiRates })).toMatchObject({
      economicsAvailable: true,
      writePremiumUsd: 0,
      breakevenHitCount: 0,
    });

    // Context inspection attaches breakeven diagnostics when pricing rates are supplied
    const report = inspectPromptContextJson(JSON.stringify({
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "A".repeat(8_000), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "hi" }],
    }), { rates: sonnetRates });
    expect(report.ok).toBe(true);
    expect(report.cache.breakeven?.writeTtl).toBe("1h");
    expect(report.cache.breakeven?.breakevenHitCount).toBe(2);

    // Top-level automatic cache_control: { ttl: "1h" } also infers 1h write pricing
    const topLevel1h = inspectPromptContextJson(JSON.stringify({
      model: "claude-sonnet-4-6",
      cache_control: { type: "ephemeral", ttl: "1h" },
      system: "A".repeat(8_000),
      messages: [{ role: "user", content: "hi" }],
    }), { rates: sonnetRates });
    expect(topLevel1h.ok).toBe(true);
    expect(topLevel1h.cache.breakeven?.writeTtl).toBe("1h");
    expect(topLevel1h.cache.breakeven?.breakevenHitCount).toBe(2);
  });

  test("maps gemini-3* to 1M context window, detects timestamps past 256 chars in array system/developer blocks, and supports autoResolveRates", () => {
    expect(inferContextWindowTokens("gemini-3-pro")).toBe(1_000_000);
    expect(inferContextWindowTokens("gemini-3.0-flash")).toBe(1_000_000);

    const lateTimestamp = `${"Static architectural rules. ".repeat(20)}\nGenerated: 2026-11-27T12:00:00Z`;
    const chatDevArray = inspectPromptContextJson(JSON.stringify({
      model: "gpt-5.4",
      messages: [
        { role: "developer", content: [{ type: "input_text", text: lateTimestamp }] },
        { role: "user", content: "hi" },
      ],
    }));
    expect(chatDevArray.ok).toBe(true);
    expect(chatDevArray.cache.warnings).toContain("volatile_iso_timestamp_in_system");

    const responsesSysArray = inspectPromptContextJson(JSON.stringify({
      model: "gpt-5.4",
      input: [
        { role: "system", content: [{ type: "input_text", text: lateTimestamp }] },
        { role: "user", content: "hi" },
      ],
    }));
    expect(responsesSysArray.ok).toBe(true);
    expect(responsesSysArray.cache.warnings).toContain("volatile_iso_timestamp_in_system");

    const autoRated = inspectPromptContextJson(JSON.stringify({
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "A".repeat(8_000), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "hi" }],
    }), { autoResolveRates: true });
    expect(autoRated.ok).toBe(true);
    expect(autoRated.cache.breakeven).toMatchObject({
      writeTtl: "1h",
      economicsAvailable: true,
      breakevenHitCount: 2,
    });
  });
});
