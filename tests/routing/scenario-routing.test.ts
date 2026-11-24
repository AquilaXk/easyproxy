import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server";
import type { ManagementAuthState } from "../../src/server/management-auth";
import { handleAgentCommand } from "../../src/cli/agent";
import { getConfigDir, getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { scenarioRoutingConfigError, scenarioRoutingSchema } from "../../src/config/schema/scenario-routing";
import { previewRouteModel, routeModel } from "../../src/router";
import { classifyRequestScenario, SCENARIO_KINDS } from "../../src/routing/scenario";
import type { EpxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

function baseConfig(overrides: Partial<EpxConfig> = {}): EpxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "main",
    providers: {
      main: { adapter: "openai-responses", baseUrl: "https://main.invalid/v1", apiKey: "sk-main", models: ["gpt-default"] },
      longctx: { adapter: "openai-responses", baseUrl: "https://long.invalid/v1", apiKey: "sk-long", models: ["gemini-2.5-pro"] },
      thinker: { adapter: "anthropic", baseUrl: "https://think.invalid/v1", apiKey: "sk-think", models: ["claude-opus-4-6"] },
      bg: { adapter: "openai-chat", baseUrl: "https://bg.invalid/v1", apiKey: "sk-bg", models: ["gpt-mini"] },
      searcher: { adapter: "openai-responses", baseUrl: "https://search.invalid/v1", apiKey: "sk-search", models: ["gpt-search"] },
      disabledprov: { adapter: "openai-chat", baseUrl: "https://disabled.invalid/v1", apiKey: "sk-dis", models: ["m"], disabled: true },
    },
    ...overrides,
  };
}

describe("heuristic scenario classifier & routing", () => {
  const activeServers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  const tempHomes: TempHome[] = [];
  const extraServers: Array<ReturnType<typeof Bun.serve>> = [];

  afterEach(async () => {
    for (const s of activeServers.splice(0)) await s.stop(true);
    for (const s of extraServers.splice(0)) await s.stop(true);
    for (const h of tempHomes.splice(0)) h.remove();
  });

  test("exits in O(1) without classifying when disabled or routes are empty", () => {
    const hugeArray = new Array(1000).fill({ type: "message", role: "user", content: "x".repeat(500) });
    const disabled = classifyRequestScenario({
      body: { input: hugeArray, thinking: { type: "enabled" }, tools: [{ type: "web_search" }], background: true },
      config: { enabled: false, routes: { think: "thinker/claude-opus-4-6" } },
    });
    expect(disabled).toEqual({
      matched: null,
      matchedScenarios: [],
      estimatedTokens: 0,
      signals: { longContext: false, think: false, background: false, webSearch: false },
      truncated: false,
    });

    const emptyRoutes = classifyRequestScenario({
      body: { thinking: { type: "enabled" } },
      config: { enabled: true, routes: {} },
    });
    expect(emptyRoutes.matched).toBeNull();
  });

  test("detects longContext, think, background, and webSearch without false positives on base64 media", () => {
    const cfg = {
      enabled: true,
      longContextThresholdTokens: 1_500,
      thinkBudgetThreshold: 4_000,
      routes: {
        longContext: "longctx/gemini-2.5-pro",
        think: "thinker/claude-opus-4-6",
        background: "bg/gpt-mini",
        webSearch: "searcher/gpt-search",
      },
    };

    // Think via Anthropic budget threshold, Chat reasoning_effort, Responses reasoning.effort, and output_config
    expect(classifyRequestScenario({
      body: { thinking: { type: "enabled", budget_tokens: 8000 } },
      config: cfg,
    }).matched).toBe("think");
    expect(classifyRequestScenario({
      body: { thinking: { type: "enabled", budget_tokens: 1024 } },
      config: cfg,
    }).matched).toBeNull();
    expect(classifyRequestScenario({
      body: { reasoning: { effort: "high" } },
      config: cfg,
    }).matched).toBe("think");
    expect(classifyRequestScenario({
      body: { reasoning: { effort: "low" } },
      config: cfg,
    }).matched).toBeNull();
    expect(classifyRequestScenario({
      body: { output_config: { effort: "xhigh" } },
      config: cfg,
    }).matched).toBe("think");

    // WebSearch across wire formats
    expect(classifyRequestScenario({
      body: { tools: [{ type: "web_search_20250305", name: "web_search" }] },
      config: cfg,
    }).matched).toBe("webSearch");
    expect(classifyRequestScenario({
      body: { tools: [{ google_search: {} }] },
      config: cfg,
    }).matched).toBe("webSearch");

    // Background via header, metadata, compaction, and tool-free prompt markers
    expect(classifyRequestScenario({
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { "X-EPX-Priority": "background" },
      config: cfg,
    }).matched).toBe("background");
    expect(classifyRequestScenario({
      body: { metadata: { priority: "background" }, messages: [] },
      config: cfg,
    }).matched).toBe("background");
    expect(classifyRequestScenario({
      body: { input: [] },
      isCompaction: true,
      config: cfg,
    }).matched).toBe("background");
    expect(classifyRequestScenario({
      body: {
        system: "Generate a concise title for the following conversation.",
        messages: [{ role: "user", content: "hello" }],
      },
      config: cfg,
    }).matched).toBe("background");
    // Prompt marker does NOT trigger background when tools are declared (interactive coding turn).
    expect(classifyRequestScenario({
      body: {
        system: "Generate a concise title if needed, use read_file first.",
        tools: [{ type: "function", name: "read_file" }],
        messages: [{ role: "user", content: "hello" }],
      },
      config: cfg,
    }).signals.background).toBe(false);

    // Base64 media must NOT trigger longContext via raw base64 byte count
    const largeImageBlob = `data:image/png;base64,${"A".repeat(40_000)}`;
    const imageRes = classifyRequestScenario({
      body: {
        input: [{ role: "user", content: [{ type: "input_image", image_url: largeImageBlob }] }],
      },
      config: cfg,
    });
    expect(imageRes.signals.longContext).toBe(false);
    expect(imageRes.estimatedTokens).toBe(1000);

    // Genuine text exceeding threshold triggers longContext cleanly
    const longRes = classifyRequestScenario({
      body: {
        input: [{ role: "user", content: "word ".repeat(1_600) }],
      },
      config: cfg,
    });
    expect(longRes.matched).toBe("longContext");
    expect(longRes.estimatedTokens).toBeGreaterThanOrEqual(1_500);
  });

  test("enforces bounded scan cap on hostile payloads and honors precedence & active-route filtering", () => {
    const hostileItems = new Array(700).fill({ type: "message", role: "user", content: "hi" });
    const bounded = classifyRequestScenario({
      body: { input: hostileItems },
      config: {
        enabled: true,
        longContextThresholdTokens: 50_000,
        routes: { longContext: "longctx/gemini-2.5-pro" },
      },
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.signals.longContext).toBe(false);

    // Custom partial precedence prioritizes webSearch before think, and unconfigured background yields to next match
    const result = classifyRequestScenario({
      body: {
        background: true,
        reasoning: { effort: "high" },
        tools: [{ type: "web_search" }],
      },
      config: {
        enabled: true,
        precedence: ["webSearch"],
        routes: {
          webSearch: "searcher/gpt-search",
          think: "thinker/claude-opus-4-6",
        },
      },
    });
    expect(result.matched).toBe("webSearch");
    expect(result.matchedScenarios).toEqual(["webSearch", "think"]);
  });

  test("routeModel preserves combo/policy unless overrideExplicitRoutes and stamps trace + credential rewrite", () => {
    const config = baseConfig({
      combos: {
        mycombo: { strategy: "failover", targets: [{ provider: "main", model: "gpt-default" }] },
      },
      scenarioRouting: {
        enabled: true,
        routes: {
          think: "thinker/claude-opus-4-6",
          webSearch: "combo/mycombo",
        },
      },
    });

    const rewritten = routeModel(config, "gpt-default", undefined, {
      body: { model: "gpt-default", reasoning: { effort: "high" } },
    });
    expect(rewritten.providerName).toBe("thinker");
    expect(rewritten.modelId).toBe("claude-opus-4-6");
    expect(rewritten.routeReason).toBe("scenario:think");
    expect(rewritten.credentialDomainRewrite).toBe(true);
    expect(rewritten.routeDecision?.scenario).toEqual({
      matched: "think",
      target: "thinker/claude-opus-4-6",
      estimatedTokens: 0,
    });

    // Scenario route pointing into a combo selects combo target cleanly
    const intoCombo = routeModel(config, "gpt-default", undefined, {
      body: { model: "gpt-default", tools: [{ type: "web_search" }] },
    });
    expect(intoCombo.routeKind).toBe("combo");
    expect(intoCombo.combo?.comboId).toBe("mycombo");
    expect(intoCombo.scenarioMatch?.scenario).toBe("webSearch");

    // Explicit combo/* stays preserved when overrideExplicitRoutes is false
    const explicitCombo = routeModel(config, "combo/mycombo", undefined, {
      body: { model: "combo/mycombo", reasoning: { effort: "high" } },
    });
    expect(explicitCombo.providerName).toBe("main");
    expect(explicitCombo.scenarioMatch).toBeUndefined();
  });

  test("validates schema fail-closed and degrades malformed hand edits cleanly on load", () => {
    expect(scenarioRoutingConfigError({ enabled: true, routes: {} })).toContain("at least one configured route target");
    expect(scenarioRoutingConfigError({ enabled: true, precedence: ["think", "think"], routes: { think: "a/b" } })).toContain("repeat");
    expect(scenarioRoutingConfigError({ enabled: true, longContextThresholdTokens: 100, routes: { think: "a/b" } })).not.toBeNull();
    expect(scenarioRoutingSchema.safeParse({ enabled: true, routes: { think: "thinker/claude-opus-4-6" } }).success).toBe(true);

    const h = createTempHome("epx-scenario-load-");
    tempHomes.push(h);
    const bad = {
      ...baseConfig(),
      scenarioRouting: { enabled: true, routes: {} },
    };
    writeFileSync(getConfigPath(), JSON.stringify(bad, null, 2));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadConfig();
      expect(loaded.scenarioRouting).toBeUndefined();
      expect(warn.mock.calls.flat().join("\n")).toContain("scenarioRouting is invalid");
    } finally {
      warn.mockRestore();
    }
  });

  test("live HTTP server routes /v1/responses, /v1/chat/completions, and /v1/messages via scenario rules + CLI & management API", async () => {
    const h = createTempHome("epx-scenario-e2e-");
    tempHomes.push(h);
    const received: Array<{ path: string; model: string }> = [];

    const stubUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.json() as Record<string, unknown>;
        received.push({ path: url.pathname, model: String(body.model ?? "") });
        if (url.pathname.endsWith("/messages")) {
          return Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "ok-anthropic" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        return Response.json({
          id: "resp_1",
          object: "response",
          status: "completed",
          model: body.model,
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok-responses" }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      },
    });
    extraServers.push(stubUpstream);

    const cfg = baseConfig({
      port: 10100,
      providers: {
        main: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${stubUpstream.port}/main/v1`, apiKey: "k1", models: ["gpt-main"], allowPrivateNetwork: true },
        thinker: { adapter: "anthropic", baseUrl: `http://127.0.0.1:${stubUpstream.port}/think`, apiKey: "k2", models: ["claude-opus-4-6"], allowPrivateNetwork: true },
        bg: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${stubUpstream.port}/bg/v1`, apiKey: "k3", models: ["gpt-mini"], allowPrivateNetwork: true },
        longctx: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${stubUpstream.port}/long/v1`, apiKey: "k4", models: ["gemini-2.5-pro"], allowPrivateNetwork: true },
        disabledprov: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${stubUpstream.port}/dis/v1`, apiKey: "k5", models: ["m"], disabled: true, allowPrivateNetwork: true },
      },
    });
    saveConfig(cfg);
    const adminToken = "epx_admin_scenario_test_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const managementAuthState: ManagementAuthState = {
      available: true,
      token: adminToken,
      source: "environment",
      sessions: new Map(),
      pairingGrants: new Map(),
    };
    const server = startServer(0, { managementAuthState });
    activeServers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    // Management PUT fails closed on disabled target (and refuses unauthenticated calls)
    const unauthPut = await fetch(`${base}/api/routing/scenario`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, routes: { think: "disabledprov/m" } }),
    });
    expect(unauthPut.status).toBe(401);

    const badPut = await fetch(`${base}/api/routing/scenario`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({ enabled: true, routes: { think: "disabledprov/m" } }),
    });
    expect(badPut.status).toBe(400);

    // Configure via CLI `epx agent scenario-routing set` against live management API
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await handleAgentCommand([
        "scenario-routing",
        "set",
        "--think", "thinker/claude-opus-4-6",
        "--background", "bg/gpt-mini",
        "--long-context", "longctx/gemini-2.5-pro",
        "--long-context-threshold", "1000",
        "--json",
      ], {
        baseUrl: base,
        fetchImpl: ((input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${adminToken}`);
          return fetch(input, { ...init, headers });
        }) as typeof fetch,
      });
      expect(code).toBe(0);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // Verify classify dry-run route
    const classifyRes = await fetch(`${base}/api/routing/scenario/classify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        selector: "gpt-main",
        body: { model: "gpt-main", reasoning: { effort: "high" } },
      }),
    });
    expect(classifyRes.status).toBe(200);
    const classifyJson = await classifyRes.json() as { matched: string; resolvedTarget: { provider: string; model: string } };
    expect(classifyJson.matched).toBe("think");
    expect(classifyJson.resolvedTarget).toMatchObject({ provider: "thinker", model: "claude-opus-4-6" });

    // 1) /v1/responses think -> thinker/claude-opus-4-6
    const respThink = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-main",
        reasoning: { effort: "high" },
        input: [{ role: "user", content: [{ type: "input_text", text: "Think deeply." }] }],
      }),
    });
    expect(respThink.status).toBe(200);
    expect(received.at(-1)).toEqual({ path: "/think/v1/messages", model: "claude-opus-4-6" });

    // 2) /v1/chat/completions background header -> bg/gpt-mini
    const respBg = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-epx-priority": "background" },
      body: JSON.stringify({
        model: "gpt-main",
        messages: [{ role: "user", content: "Classify this" }],
      }),
    });
    expect(respBg.status).toBe(200);
    expect(received.at(-1)).toEqual({ path: "/bg/v1/responses", model: "gpt-mini" });

    // 3) /v1/messages longContext -> longctx/gemini-2.5-pro
    const respLong = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "token ".repeat(900) }],
      }),
    });
    expect(respLong.status).toBe(200);
    expect(received.at(-1)).toEqual({ path: "/long/v1/responses", model: "gemini-2.5-pro" });

    // 4) DELETE /api/routing/scenario clears it cleanly
    const delRes = await fetch(`${base}/api/routing/scenario`, { method: "DELETE", headers: adminHeaders });
    expect(delRes.status).toBe(200);
    const saved = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(saved.scenarioRouting).toBeUndefined();
    expect(SCENARIO_KINDS).toHaveLength(4);
  });
});
