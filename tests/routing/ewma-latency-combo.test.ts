import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleComboCommand } from "../../src/cli/combo";
import {
  advanceComboAfterFailure,
  clearComboEwmaState,
  clearComboSelectionState,
  noteComboSuccess,
  pickComboTarget,
  pickEwmaLatencyIndex,
  recordComboEwmaFailure,
  recordComboEwmaSuccess,
  snapshotComboEwmaStats,
} from "../../src/combos";
import { reconcileComboRotationState } from "../../src/combos/resolve";
import { getCombo, comboConfigIssues } from "../../src/combos/types";
import { getConfigPath, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { ManagementAuthState } from "../../src/server/management-auth";
import type { EpxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

function ewmaConfig(overrides: Partial<NonNullable<EpxConfig["combos"]>["fast"]> = {}): EpxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "p1",
    providers: {
      p1: { adapter: "openai-responses", baseUrl: "https://p1.invalid/v1", apiKey: "k1", models: ["m1"] },
      p2: { adapter: "openai-responses", baseUrl: "https://p2.invalid/v1", apiKey: "k2", models: ["m2"] },
      p3: { adapter: "openai-responses", baseUrl: "https://p3.invalid/v1", apiKey: "k3", models: ["m3"] },
    },
    combos: {
      fast: {
        strategy: "ewma-latency",
        targets: [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "m2" },
          { provider: "p3", model: "m3" },
        ],
        ...overrides,
      },
    },
  };
}

describe("EWMA latency combo load balancing", () => {
  const servers: Array<Awaited<ReturnType<typeof startServer>> | ReturnType<typeof Bun.serve>> = [];
  const tempHomes: TempHome[] = [];

  afterEach(async () => {
    clearComboSelectionState();
    clearComboEwmaState();
    for (const s of servers.splice(0)) await s.stop(true);
    for (const h of tempHomes.splice(0)) h.remove();
  });

  test("explores cold-start targets round-robin without mutating cursor in preview mode", () => {
    const config = ewmaConfig({ ewmaLatency: { minSamples: 2 } });

    const preview1 = pickComboTarget(config, "fast", { preview: true });
    const preview2 = pickComboTarget(config, "fast", { preview: true });
    expect(preview1?.target.provider).toBe("p1");
    expect(preview2?.target.provider).toBe("p1");

    // Non-preview distributes across unmeasured targets cleanly
    const p1 = pickComboTarget(config, "fast");
    const p2 = pickComboTarget(config, "fast");
    const p3 = pickComboTarget(config, "fast");
    const p4 = pickComboTarget(config, "fast");
    expect([p1?.target.provider, p2?.target.provider, p3?.target.provider, p4?.target.provider]).toEqual([
      "p1", "p2", "p3", "p1",
    ]);
  });

  test("routes to lowest EWMA latency target and adapts when latency shifts", () => {
    const config = ewmaConfig({ ewmaLatency: { alpha: 0.5, minSamples: 1 } });
    const combo = getCombo(config, "fast")!;
    const now = 1_000_000;

    // Seed initial latencies: p1=400ms, p2=60ms, p3=220ms
    noteComboSuccess("fast", combo, combo.targets[0]!, 0, { latencyMs: 400, now });
    noteComboSuccess("fast", combo, combo.targets[1]!, 0, { latencyMs: 60, now });
    noteComboSuccess("fast", combo, combo.targets[2]!, 0, { latencyMs: 220, now });

    expect(pickComboTarget(config, "fast", { now: now + 100 })?.target.provider).toBe("p2");

    // Now p2 spikes to 1200ms while p3 improves to 50ms
    noteComboSuccess("fast", combo, combo.targets[1]!, 0, { latencyMs: 1200, now: now + 200 });
    noteComboSuccess("fast", combo, combo.targets[2]!, 0, { latencyMs: 50, now: now + 200 });

    expect(pickComboTarget(config, "fast", { now: now + 300 })?.target.provider).toBe("p3");
    const stats = snapshotComboEwmaStats("fast");
    expect(stats["p2/m2"]!.ewmaMs).toBeCloseTo(630, 5);
    expect(stats["p3/m3"]!.ewmaMs).toBeCloseTo(135, 5);
  });

  test("honors weights and failure penalties, and recovers stale penalized targets over time", () => {
    const t0 = 1_000_000;
    const targets = [
      { provider: "p1", model: "m1", weight: 4 },
      { provider: "p2", model: "m2", weight: 1 },
    ];
    recordComboEwmaSuccess("weighted", "p1/m1", { alpha: 0.5, minSamples: 1 }, 200, t0); // score 200/4 = 50
    recordComboEwmaSuccess("weighted", "p2/m2", { alpha: 0.5, minSamples: 1 }, 80, t0);  // score 80/1 = 80
    expect(pickEwmaLatencyIndex("weighted", targets, () => true, t => `${t.provider}/${t.model}`, { alpha: 0.5, minSamples: 1 }, t0 + 100)).toBe(0);

    // Penalty inflates failing target
    recordComboEwmaFailure("weighted", "p1/m1", { errorPenaltyMs: 10_000, minSamples: 1 }, t0 + 200);
    expect(pickEwmaLatencyIndex("weighted", targets, () => true, t => `${t.provider}/${t.model}`, { minSamples: 1 }, t0 + 300)).toBe(1);

    // After prolonged staleness while p2 gets fresh traffic, stale p1 blends toward fresh median so it can recover
    recordComboEwmaSuccess("weighted", "p2/m2", { halfLifeMs: 5_000, minSamples: 1 }, 100, t0 + 120_000);
    expect(pickEwmaLatencyIndex("weighted", targets, () => true, t => `${t.provider}/${t.model}`, { halfLifeMs: 5_000, minSamples: 1 }, t0 + 120_000)).toBe(0);
  });

  test("rejects invalid ewmaLatency config fields and reconciles on combo removal", () => {
    const config = ewmaConfig();
    expect(comboConfigIssues("fast", {
      strategy: "failover",
      targets: [{ provider: "p1", model: "m1" }],
      ewmaLatency: { alpha: 0.3 },
    }, config.providers).some(i => i.path[0] === "ewmaLatency")).toBe(true);

    expect(comboConfigIssues("fast", {
      strategy: "ewma-latency",
      targets: [{ provider: "p1", model: "m1" }],
      ewmaLatency: { alpha: 2 },
    }, config.providers).some(i => i.path.join(".") === "ewmaLatency.alpha")).toBe(true);

    const pick = pickComboTarget(config, "fast")!;
    advanceComboAfterFailure(config, pick, { status: 502, now: 2000 });
    expect(snapshotComboEwmaStats("fast")[`${pick.target.provider}/${pick.target.model}`]?.consecutiveFailures).toBe(1);

    recordComboEwmaSuccess("fast", "p1/m1", undefined, 50, 1000);
    expect(Object.keys(snapshotComboEwmaStats("fast"))).toContain("p1/m1");
    const removed = reconcileComboRotationState({ generation: 1, comboIds: new Set(), comboTargets: new Set() });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(snapshotComboEwmaStats("fast")).toEqual({});
  });

  test("validates CLI set + management API round-trip and live fast-target convergence", async () => {
    const h = createTempHome("epx-ewma-live-");
    tempHomes.push(h);

    const calls: string[] = [];
    const slowUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        calls.push("slow");
        await new Promise(r => setTimeout(r, 120));
        return Response.json({
          id: "resp_slow",
          object: "response",
          status: "completed",
          model: "m-slow",
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "slow" }] }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        });
      },
    });
    const fastUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        calls.push("fast");
        return Response.json({
          id: "resp_fast",
          object: "response",
          status: "completed",
          model: "m-fast",
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fast" }] }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        });
      },
    });
    servers.push(slowUpstream, fastUpstream);

    saveConfig({
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "slow",
      providers: {
        slow: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${slowUpstream.port}/v1`, apiKey: "k1", models: ["m-slow"], allowPrivateNetwork: true },
        fast: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${fastUpstream.port}/v1`, apiKey: "k2", models: ["m-fast"], allowPrivateNetwork: true },
      },
    });

    const adminToken = "epx_admin_ewma_test_ABCDEFGHIJKLMNOPQRSTUVWXYZ123";
    const managementAuthState: ManagementAuthState = {
      available: true,
      token: adminToken,
      source: "environment",
      sessions: new Map(),
      pairingGrants: new Map(),
    };
    const server = startServer(0, {
      managementAuthState,
      managementApi: { createManagementConvergeCodex: catalogConvergenceFactory() },
    });
    servers.push(server);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await handleComboCommand([
        "set", "latency-pool",
        "--targets", "slow/m-slow,fast/m-fast",
        "--strategy", "ewma-latency",
        "--ewma-alpha", "0.5",
        "--ewma-min-samples", "1",
        "--ewma-error-penalty-ms", "15000",
        "--json",
      ], {
        baseUrl: `http://127.0.0.1:${server.port}`,
        fetchImpl: ((input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${adminToken}`);
          return fetch(input, { ...init, headers });
        }) as typeof fetch,
      });
      expect(errSpy.mock.calls.flat()).toEqual([]);
      expect(code).toBe(0);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    const saved = JSON.parse(readFileSync(getConfigPath(), "utf8")) as EpxConfig;
    expect(saved.combos?.["latency-pool"]?.strategy).toBe("ewma-latency");
    expect(saved.combos?.["latency-pool"]?.ewmaLatency).toEqual({
      alpha: 0.5,
      minSamples: 1,
      errorPenaltyMs: 15_000,
    });

    // Request 1 & 2 explore cold-start (slow then fast); requests 3 & 4 lock onto fast!
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/latency-pool",
          input: [{ role: "user", content: [{ type: "input_text", text: `turn ${i}` }] }],
        }),
      });
      expect(res.status).toBe(200);
    }
    expect(calls).toEqual(["slow", "fast", "fast", "fast"]);
  });
});
