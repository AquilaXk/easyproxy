import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { handleGuardrailsCommand, GUARDRAILS_FILE_MAX_BYTES, GUARDRAILS_TEXT_MAX_CHARS } from "../../src/cli/guardrails";
import { handleObserveCommand } from "../../src/cli/observe";
import { findCommand } from "../../src/cli/registry";
import { handleWorkflowBudgetCommand } from "../../src/cli/workflow-budget";
import { dispatchCommand, resolveDispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import { parseCliHead } from "../../src/cli/root";
import { getDefaultConfig, saveConfig } from "../../src/config";
import type { LowQuotaEvent } from "../../src/codex/low-quota-events";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  resetWorkflowBudgetsForTest,
} from "../../src/lib/workflow-budget";
import { handleManagementAPI } from "../../src/server/management-api";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";
import {
  getOutboundHygieneStats,
  resetOutboundHygieneStatsForTests,
} from "../../src/server/outbound-payload-hygiene";
import type { EpxConfig } from "../../src/types";
import { managementHeaders, ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const cleanupDirs: string[] = [];

function makeTempHome(prefix = "epx-deferred-verbs-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function createPersistedHome(): { home: string; config: EpxConfig; restoreEnv: () => void } {
  const home = makeTempHome();
  const prevHome = process.env.EASYPROXY_HOME;
  process.env.EASYPROXY_HOME = home;
  const config = getDefaultConfig();
  config.port = 43123;
  saveConfig(config);
  return {
    home,
    config,
    restoreEnv: () => {
      if (prevHome === undefined) delete process.env.EASYPROXY_HOME;
      else process.env.EASYPROXY_HOME = prevHome;
    },
  };
}

function makeManagementBridge(
  config: EpxConfig,
  lowQuotaEvents: LowQuotaEvent[] = [],
  recorded: Array<{ method: string; path: string; body: unknown }> = [],
) {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let parsedBody: unknown = undefined;
    if (rawBody !== undefined) {
      try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
    }
    recorded.push({ method, path: `${url.pathname}${url.search}`, body: parsedBody });

    const headers = managementHeaders(init?.headers);
    const req = new ManagementRequest(url, { ...init, method, headers });
    const response = await handleManagementAPI(req, url, config, {
      listLowQuotaEvents: (limit = 20) => lowQuotaEvents.slice(0, limit),
    });
    if (!response) return new Response("Not Found", { status: 404 });
    return response;
  }) as typeof fetch;

  return {
    baseUrl: "http://127.0.0.1:43123",
    fetchImpl,
  };
}

function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((value?: unknown) => {
    out.push(String(value ?? ""));
  });
  const errSpy = spyOn(console, "error").mockImplementation((value?: unknown) => {
    err.push(String(value ?? ""));
  });
  return {
    out,
    err,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

afterEach(() => {
  resetWorkflowBudgetsForTest();
  resetOutboundHygieneStatsForTests();
  while (cleanupDirs.length > 0) {
    removeTreeWithRetry(cleanupDirs.pop()!);
  }
});

describe("Wave C deferred-verb promotion contracts", () => {
  test("un-exempts only the 8 targeted routes and leaves remaining deferred-verb routes exempt", () => {
    const promoted = [
      ["GET", "/api/codex-auth/low-quota-events"],
      ["GET", "/api/gateway-guardrails"],
      ["PUT", "/api/gateway-guardrails"],
      ["POST", "/api/gateway-guardrails/dry-run"],
      ["GET", "/api/workflow-budget"],
      ["POST", "/api/workflow-budget/clear"],
      ["GET", "/api/workflow-budget/settings"],
      ["PUT", "/api/workflow-budget/settings"],
    ] as const;

    for (const [method, path] of promoted) {
      const entry = MANAGEMENT_ROUTES.find(r => r.method === method && r.path === path);
      expect(entry, `${method} ${path}`).toBeDefined();
      expect(entry?.exempt, `${method} ${path}`).toBeUndefined();
    }

    const stillDeferred = [
      ["POST", "/api/lab/automation/run"],
      ["PUT", "/api/lab/automation"],
      ["POST", "/api/lab/public/community/import"],
      ["POST", "/api/lab/public/export"],
      ["POST", "/api/lab/public/preview"],
      ["POST", "/api/lab/public/verify"],
      ["POST", "/api/lab/automation/runs/{id}/cancel"],
      ["GET", "/api/codex/desktop-compatibility/certificate"],
      ["GET", "/api/codex/desktop-compatibility/runtime"],
      ["GET", "/api/codex/desktop-compatibility/settings"],
      ["GET", "/api/native-main-profiles/admission"],
      ["GET", "/api/quota-pool"],
      ["PUT", "/api/native-reasoning-retention"],
    ] as const;

    for (const [method, path] of stillDeferred) {
      const entry = MANAGEMENT_ROUTES.find(r => r.method === method && r.path === path);
      expect(entry, `${method} ${path}`).toBeDefined();
      expect(entry?.exempt?.reason, `${method} ${path}`).toBe("deferred-verb");
    }
    const nativeRetentionGet = MANAGEMENT_ROUTES.find(
      r => r.method === "GET" && r.path === "/api/native-reasoning-retention",
    );
    expect(nativeRetentionGet?.exempt?.reason).toBe("local-transport");
  });

  test("registers CLI commands and capability entries accurately", () => {
    expect(findCommand("workflow-budget")?.hidden).not.toBe(true);
    expect(findCommand("guardrails")?.hidden).not.toBe(true);
    expect(findCommand("observe")?.usage).toContain("low-quota-events");
    expect(findCommand("logs")?.usage).toContain("low-quota-events");

    const expectedCaps: Array<[string[], boolean, string, string]> = [
      [["workflow-budget", "status"], false, "GET", "/api/workflow-budget"],
      [["workflow-budget", "clear"], true, "POST", "/api/workflow-budget/clear"],
      [["workflow-budget", "settings", "show"], false, "GET", "/api/workflow-budget/settings"],
      [["workflow-budget", "settings", "set"], true, "PUT", "/api/workflow-budget/settings"],
      [["workflow-budget", "settings", "reset"], true, "PUT", "/api/workflow-budget/settings"],
      [["guardrails", "status"], false, "GET", "/api/gateway-guardrails"],
      [["guardrails", "set"], true, "PUT", "/api/gateway-guardrails"],
      [["guardrails", "dry-run"], false, "POST", "/api/gateway-guardrails/dry-run"],
      [["observe", "low-quota-events"], false, "GET", "/api/codex-auth/low-quota-events"],
      [["logs", "low-quota-events"], false, "GET", "/api/codex-auth/low-quota-events"],
    ];

    for (const [command, mutates, method, path] of expectedCaps) {
      const cap = CAPABILITIES.find(c => c.command.join(" ") === command.join(" "));
      expect(cap, command.join(" ")).toBeDefined();
      expect(cap?.mutates).toBe(mutates);
      expect(cap?.routes).toEqual([{ method, path }]);
      expect(cap?.flags?.some(f => f.name === "--json")).toBe(true);
    }
  });
});

describe("epx workflow-budget CLI", () => {
  test("round-trips status, root filtering, clear ({ root }), and settings show/set/reset", async () => {
    const env = createPersistedHome();
    const recorded: Array<{ method: string; path: string; body: unknown }> = [];
    const deps = makeManagementBridge(env.config, [], recorded);
    const consoleCap = captureConsole();

    try {
      const admitted = admitWorkflowTurn("root-alpha", "interactive");
      expect(admitted?.admitted).toBe(true);
      chargeWorkflowSends("root-alpha", 4);

      // Human status output
      expect(await handleWorkflowBudgetCommand([], deps)).toBe(0);
      expect(consoleCap.out.join("\n")).toContain("Tracked roots (1):");
      expect(consoleCap.out.join("\n")).toContain("root-alpha:");

      // Filtered --root --json status (tracked + untracked)
      consoleCap.out.length = 0;
      expect(await handleWorkflowBudgetCommand(["status", "--root", "root-alpha", "--limit", "5", "--json"], deps)).toBe(0);
      const filteredJson = JSON.parse(consoleCap.out.join("\n")) as {
        root: { rootId: string; sends: number } | null;
        events: unknown[];
      };
      expect(filteredJson.root?.rootId).toBe("root-alpha");
      expect(filteredJson.root?.sends).toBe(4);

      consoleCap.out.length = 0;
      expect(await handleWorkflowBudgetCommand(["--root", "untracked-root", "--json"], deps)).toBe(0);
      expect((JSON.parse(consoleCap.out.join("\n")) as { root: unknown }).root).toBeNull();

      // Clear via positional root-id -> sends { root }, never rootId
      consoleCap.out.length = 0;
      expect(await handleWorkflowBudgetCommand(["clear", "root-alpha", "--json"], deps)).toBe(0);
      const clearReq = recorded.find(r => r.path === "/api/workflow-budget/clear");
      expect(clearReq?.method).toBe("POST");
      expect(clearReq?.body).toEqual({ root: "root-alpha" });
      expect((JSON.parse(consoleCap.out.join("\n")) as { cleared: boolean; root: string }).cleared).toBe(true);

      // Clear via --root on unknown root -> 404 -> exit 4
      expect(await handleWorkflowBudgetCommand(["clear", "--root", "never-tracked"], deps)).toBe(4);

      // Settings show human displays read-only interactiveReserve
      consoleCap.out.length = 0;
      expect(await handleWorkflowBudgetCommand(["settings"], deps)).toBe(0);
      expect(consoleCap.out.join("\n")).toContain("interactiveReserve:");
      expect(consoleCap.out.join("\n")).toContain("(read-only)");

      // Settings set
      consoleCap.out.length = 0;
      expect(
        await handleWorkflowBudgetCommand(
          ["settings", "set", "--max-concurrent-children", "12", "--max-physical-sends", "500", "--max-distinct-children", "48", "--json"],
          deps,
        ),
      ).toBe(0);
      const updated = JSON.parse(consoleCap.out.join("\n")) as {
        maxConcurrentChildren: number;
        maxPhysicalSends: number;
        maxDistinctChildren: number;
      };
      expect(updated.maxConcurrentChildren).toBe(12);
      expect(updated.maxPhysicalSends).toBe(500);
      expect(updated.maxDistinctChildren).toBe(48);

      // Settings reset via --reset alias sends JSON null
      consoleCap.out.length = 0;
      expect(await handleWorkflowBudgetCommand(["settings", "--reset", "--json"], deps)).toBe(0);
      const resetReq = recorded.filter(r => r.path === "/api/workflow-budget/settings" && r.method === "PUT").at(-1);
      expect(resetReq?.body).toBeNull();
      const resetView = JSON.parse(consoleCap.out.join("\n")) as {
        maxConcurrentChildren: number;
        defaults: { maxConcurrentChildren: number };
      };
      expect(resetView.maxConcurrentChildren).toBe(resetView.defaults.maxConcurrentChildren);
    } finally {
      consoleCap.restore();
      env.restoreEnv();
    }
  });

  test("rejects invalid workflow-budget arguments with exit 2 without sending HTTP requests", async () => {
    const calls: string[] = [];
    const deps = {
      baseUrl: "http://127.0.0.1:43123",
      fetchImpl: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    };
    const consoleCap = captureConsole();

    try {
      const invalidCases: string[][] = [
        ["unknown"],
        ["status", "--root", ""],
        ["status", "--root", "   "],
        ["status", "--root", "x".repeat(201)],
        ["status", "--limit", "-1"],
        ["status", "--limit", "1.5"],
        ["clear"],
        ["clear", "a", "--root", "a"],
        ["clear", "   "],
        ["clear", "--root", "x".repeat(201)],
        ["clear", "a", "extra"],
        ["settings", "bogus"],
        ["settings", "show", "--reset"],
        ["settings", "show", "--max-concurrent-children", "4"],
        ["settings", "set"],
        ["settings", "set", "--reset"],
        ["settings", "--reset", "--max-concurrent-children", "4"],
        ["settings", "reset", "--max-physical-sends", "10"],
        ["settings", "set", "--interactive-reserve", "1"],
        ["settings", "set", "--max-concurrent-children", "1"],
        ["settings", "set", "--max-concurrent-children", "65"],
        ["settings", "set", "--max-physical-sends", "0"],
        ["settings", "set", "--max-physical-sends", "10001"],
        ["settings", "set", "--max-distinct-children", "0"],
        ["settings", "set", "--max-distinct-children", "1025"],
        ["settings", "set", "--max-concurrent-children", "4", "--max-concurrent-children", "8"],
      ];

      for (const argv of invalidCases) {
        expect(await handleWorkflowBudgetCommand(argv, deps), argv.join(" ")).toBe(2);
      }
      expect(calls).toEqual([]);

      // Also verify root dispatch resolves and invokes workflow-budget
      expect(resolveDispatchCommand("workflow-budget")).toBe("workflow-budget");
      const head = parseCliHead(["workflow-budget", "clear"]);
      expect(await dispatchCommand(head, {
        args: head.args,
        command: head.command,
        head,
        findLiveProxy: async () => null,
      } as unknown as CliDispatchDeps)).toBe(2);
    } finally {
      consoleCap.restore();
    }
  });
});

describe("epx guardrails CLI", () => {
  test("round-trips status, set, resets, and dry-run (--text and --file) without mutating live config or stats on dry-run", async () => {
    const env = createPersistedHome();
    const recorded: Array<{ method: string; path: string; body: unknown }> = [];
    const deps = makeManagementBridge(env.config, [], recorded);
    const consoleCap = captureConsole();

    try {
      const sampleFile = join(makeTempHome("epx-guardrails-file-"), "payload.txt");
      const ansiBody = Array.from({ length: 80 }, (_, i) => `\x1b[32mline-${i} ${"z".repeat(20)}\x1b[0m`).join("\n");
      writeFileSync(sampleFile, ansiBody, "utf8");

      // Initial status
      expect(await handleGuardrailsCommand(["--json"], deps)).toBe(0);
      const initial = JSON.parse(consoleCap.out.join("\n")) as {
        outboundSecretGuard: { mode: string };
        toolOutputCompression: { enabled: boolean; minChars: number };
      };
      expect(initial.outboundSecretGuard.mode).toBe("off");
      expect(initial.toolOutputCompression.enabled).toBe(false);

      // Update settings
      consoleCap.out.length = 0;
      expect(
        await handleGuardrailsCommand(
          [
            "set",
            "--secret-mode", "redact",
            "--compress", "on",
            "--min-chars", "1024",
            "--head-chars", "128",
            "--tail-chars", "256",
            "--strip-ansi", "off",
            "--json",
          ],
          deps,
        ),
      ).toBe(0);
      const updated = JSON.parse(consoleCap.out.join("\n")) as {
        outboundSecretGuard: { mode: string };
        toolOutputCompression: {
          enabled: boolean;
          minChars: number;
          headChars: number;
          tailChars: number;
          stripAnsi: boolean;
        };
      };
      expect(updated.outboundSecretGuard.mode).toBe("redact");
      expect(updated.toolOutputCompression).toEqual({
        enabled: true,
        minChars: 1024,
        headChars: 128,
        tailChars: 256,
        stripAnsi: false,
      });

      const statsBeforeDryRun = getOutboundHygieneStats();

      // Dry-run --text with --secret-mode block override
      consoleCap.out.length = 0;
      const syntheticAws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
      expect(
        await handleGuardrailsCommand(
          ["dry-run", "--text", `token=${syntheticAws}`, "--secret-mode", "block", "--json"],
          deps,
        ),
      ).toBe(0);
      const dryTextResult = JSON.parse(consoleCap.out.join("\n")) as {
        blocked: boolean;
        findings: string[];
        previewText: string;
      };
      expect(dryTextResult.blocked).toBe(true);
      expect(dryTextResult.findings).toContain("aws_access_key");
      expect(dryTextResult.previewText).toBe("");

      // Dry-run --file with compression + ANSI strip override
      consoleCap.out.length = 0;
      expect(
        await handleGuardrailsCommand(
          [
            "dry-run",
            "--file", sampleFile,
            "--secret-mode", "off",
            "--compress", "on",
            "--min-chars", "512",
            "--head-chars", "80",
            "--tail-chars", "80",
            "--strip-ansi", "on",
            "--json",
          ],
          deps,
        ),
      ).toBe(0);
      const dryFileResult = JSON.parse(consoleCap.out.join("\n")) as {
        blocked: boolean;
        compressedItems: number;
        savedChars: number;
        previewText: string;
      };
      expect(dryFileResult.blocked).toBe(false);
      expect(dryFileResult.compressedItems).toBe(1);
      expect(dryFileResult.savedChars).toBeGreaterThan(0);
      expect(dryFileResult.previewText).not.toContain("\x1b[");

      // Dry-run leaves persisted/live guardrails and hygieneStats untouched
      expect(env.config.outboundSecretGuard?.mode).toBe("redact");
      expect(env.config.toolOutputCompression?.stripAnsi).toBe(false);
      expect(getOutboundHygieneStats()).toEqual(statsBeforeDryRun);

      // Reset both sections individually
      consoleCap.out.length = 0;
      expect(await handleGuardrailsCommand(["set", "--reset-secret-guard", "--reset-compression", "--json"], deps)).toBe(0);
      const resetPut = recorded.filter(r => r.method === "PUT" && r.path === "/api/gateway-guardrails").at(-1);
      expect(resetPut?.body).toEqual({ outboundSecretGuard: null, toolOutputCompression: null });
      expect("outboundSecretGuard" in env.config).toBe(false);
      expect("toolOutputCompression" in env.config).toBe(false);
    } finally {
      consoleCap.restore();
      env.restoreEnv();
    }
  });

  test("fails closed with exit 2 on invalid bounds, unsafe files, and oversized inputs without sending HTTP requests", async () => {
    const dir = makeTempHome("epx-guardrails-bad-");
    const regularFile = join(dir, "ok.txt");
    writeFileSync(regularFile, "hello", "utf8");
    const symlinkFile = join(dir, "link.txt");
    symlinkSync(regularFile, symlinkFile);
    const subDir = join(dir, "subdir");
    mkdirSync(subDir);
    const oversizedFile = join(dir, "big.bin");
    writeFileSync(oversizedFile, Buffer.alloc(GUARDRAILS_FILE_MAX_BYTES + 1, 0x61));
    const badUtf8File = join(dir, "bad-utf8.bin");
    writeFileSync(badUtf8File, Buffer.from([0xff, 0xfe, 0xfd]));

    const calls: string[] = [];
    const deps = {
      baseUrl: "http://127.0.0.1:43123",
      fetchImpl: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    };
    const consoleCap = captureConsole();

    try {
      const invalidCases: string[][] = [
        ["unknown"],
        ["status", "--extra"],
        ["set"],
        ["set", "--secret-mode", "audit"],
        ["set", "--secret-mode", "redact", "--reset-secret-guard"],
        ["set", "--compress", "on", "--reset-compression"],
        ["set", "--min-chars", "512", "--reset-compression"],
        ["set", "--compress", "maybe"],
        ["set", "--strip-ansi", "invalid"],
        ["set", "--min-chars", "511"],
        ["set", "--min-chars", "500001"],
        ["set", "--head-chars", "-1"],
        ["set", "--head-chars", "100001"],
        ["set", "--tail-chars", "-1"],
        ["set", "--tail-chars", "100001"],
        ["dry-run"],
        ["dry-run", "--text", "a", "--file", regularFile],
        ["dry-run", "--text", "a".repeat(GUARDRAILS_TEXT_MAX_CHARS + 1)],
        ["dry-run", "--file", symlinkFile],
        ["dry-run", "--file", subDir],
        ["dry-run", "--file", oversizedFile],
        ["dry-run", "--file", badUtf8File],
        ["dry-run", "--file", join(dir, "missing.txt")],
        ["dry-run", "--text", "ok", "--reset-secret-guard"],
      ];

      for (const argv of invalidCases) {
        expect(await handleGuardrailsCommand(argv, deps), argv.join(" ")).toBe(2);
      }
      expect(calls).toEqual([]);

      // Also verify root dispatch resolves and invokes guardrails
      expect(resolveDispatchCommand("guardrails")).toBe("guardrails");
      const head = parseCliHead(["guardrails", "set"]);
      expect(await dispatchCommand(head, {
        args: head.args,
        command: head.command,
        head,
        findLiveProxy: async () => null,
      } as unknown as CliDispatchDeps)).toBe(2);
    } finally {
      consoleCap.restore();
    }
  });
});

describe("epx observe|logs low-quota-events CLI", () => {
  test("queries GET /api/codex-auth/low-quota-events via both observe and logs with --limit and --json", async () => {
    const env = createPersistedHome();
    const events: LowQuotaEvent[] = [
      {
        accountId: "acct-one",
        window: "short",
        percentUsed: 96,
        resetAt: 1_760_000_500_000,
        timestamp: 1_760_000_000_000,
        status: "delivered",
        delivery: "notice",
      },
      {
        accountId: "acct-two",
        window: "weekly",
        percentUsed: 98,
        resetAt: null,
        timestamp: 1_760_000_100_000,
        status: "succeeded",
        delivery: "pause-save",
      },
    ];
    const recorded: Array<{ method: string; path: string; body: unknown }> = [];
    const deps = makeManagementBridge(env.config, events, recorded);
    const consoleCap = captureConsole();

    try {
      expect(await handleObserveCommand(["low-quota-events", "--limit", "1", "--json"], deps)).toBe(0);
      expect(JSON.parse(consoleCap.out.join("\n"))).toEqual({ events: [events[0]] });

      consoleCap.out.length = 0;
      expect(await handleObserveCommand(["logs", "low-quota-events", "--limit", "100"], deps)).toBe(0);
      const human = consoleCap.out.join("\n");
      expect(human).toContain("Low-quota events (2):");
      expect(human).toContain("account=acct-one");
      expect(human).toContain("account=acct-two");

      expect(recorded.map(r => r.path)).toEqual([
        "/api/codex-auth/low-quota-events?limit=1",
        "/api/codex-auth/low-quota-events?limit=100",
      ]);

      // Invalid limits and extra flags fail closed with exit 2 before HTTP
      const before = recorded.length;
      expect(await handleObserveCommand(["low-quota-events", "--limit", "-1"], deps)).toBe(2);
      expect(await handleObserveCommand(["low-quota-events", "--limit", "101"], deps)).toBe(2);
      expect(await handleObserveCommand(["logs", "low-quota-events", "--bogus"], deps)).toBe(2);
      expect(await handleObserveCommand(["low-quota-events", "--limit", "5", "--limit", "6"], deps)).toBe(2);
      expect(recorded.length).toBe(before);
    } finally {
      consoleCap.restore();
      env.restoreEnv();
    }
  });
});
