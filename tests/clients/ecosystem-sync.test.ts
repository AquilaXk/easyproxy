import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEcosystemSync,
  getEcosystemSyncStatus,
  previewEcosystemSync,
  resolveEcosystemPaths,
  restoreEcosystemSync,
  setEcosystemSyncTestHooks,
  type EcosystemSyncPathOptions,
} from "../../src/ecosystem/cli-sync";
import { sanitizeMcpUrlForDisplay } from "../../src/ecosystem/cli-sync-mcp";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleEcosystemSyncCommand } from "../../src/cli/ecosystem-sync";
import { ManagementRequest } from "../helpers/management-auth";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { getDefaultConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let sandboxRoot: string;
let syncHome: string;
let configDir: string;
let prevEnv: Record<string, string | undefined>;

function saveEnv(...keys: string[]): void {
  for (const key of keys) prevEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makePathOptions(): EcosystemSyncPathOptions {
  return {
    home: syncHome,
    configDir,
    env: {
      HOME: syncHome,
      EASYPROXY_HOME: configDir,
      EPX_CLI_SYNC_HOME: syncHome,
      CODEX_HOME: join(syncHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(syncHome, ".claude"),
      GEMINI_CLI_HOME: join(syncHome, ".gemini"),
      XDG_CONFIG_HOME: join(syncHome, ".config"),
    },
  };
}

function makeMgmtRequest(path: string, method: "GET" | "POST", body?: unknown): Request {
  return new ManagementRequest(`http://127.0.0.1:10100${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  prevEnv = {};
  saveEnv("EASYPROXY_HOME", "EPX_CLI_SYNC_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "XDG_CONFIG_HOME");
  sandboxRoot = mkdtempSync(join(tmpdir(), "epx-ecosystem-sync-"));
  syncHome = join(sandboxRoot, "sync-home");
  configDir = join(sandboxRoot, "epx-home");
  mkdirSync(syncHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.EASYPROXY_HOME = configDir;
  process.env.EPX_CLI_SYNC_HOME = syncHome;
  setEcosystemSyncTestHooks({ homeDir: syncHome });
});

afterEach(() => {
  resetSiblingStartForTests();
  setEcosystemSyncTestHooks(null);
  restoreEnv();
  removeTreeWithRetry(sandboxRoot);
});

describe("cross-CLI MCP and skills sync", () => {
  test("syncs stdio and remote MCP servers plus skills across all 4 CLIs while preserving foreign keys", async () => {
    const claudeDir = join(syncHome, ".claude");
    const codexDir = join(syncHome, ".codex");
    const geminiDir = join(syncHome, ".gemini");
    const opencodeDir = join(syncHome, ".config", "opencode");
    mkdirSync(join(claudeDir, "skills", "code-review"), { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(geminiDir, { recursive: true });
    mkdirSync(opencodeDir, { recursive: true });

    writeFileSync(join(claudeDir, "skills", "code-review", "SKILL.md"), "# Code Review\nCheck invariants.\n");
    writeFileSync(join(syncHome, ".claude.json"), JSON.stringify({
      numStartups: 9,
      mcpServers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: { CONTEXT7_TOKEN: "secret-ctx-token" },
        },
        remoteDocs: {
          type: "http",
          url: "https://mcp.example.com/v1?api_key=query-secret",
          headers: { Authorization: "Bearer super-secret-hdr" },
        },
        legacyBad: {
          weird: 42,
        },
      },
    }, null, 2));

    writeFileSync(join(codexDir, "config.toml"), 'model = "gpt-5.4"\n\n[projects."/work"]\ntrust_level = "trusted"\n');
    writeFileSync(join(geminiDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
    writeFileSync(join(opencodeDir, "opencode.json"), JSON.stringify({ model: "anthropic/claude-sonnet" }, null, 2));

    const opts = makePathOptions();
    const status = getEcosystemSyncStatus(opts);
    const statusJson = JSON.stringify(status);
    expect(statusJson).not.toContain("secret-ctx-token");
    expect(statusJson).not.toContain("super-secret-hdr");
    expect(statusJson).not.toContain("query-secret");
    expect(status.clis.claude.installed).toBe(true);
    expect(status.clis.claude.mcp.map(m => m.name)).toEqual(["context7", "remoteDocs"]);
    expect(status.clis.claude.mcp[0]?.envKeys).toEqual(["CONTEXT7_TOKEN"]);
    expect(status.clis.claude.mcp[1]?.headerKeys).toEqual(["Authorization"]);
    expect(status.clis.claude.unsupportedMcp).toEqual([
      expect.objectContaining({ name: "legacyBad" }),
    ]);
    expect(status.clis.claude.skills.map(s => s.slug)).toEqual(["code-review"]);

    const preview = previewEcosystemSync({
      source: "claude",
      targets: ["codex", "gemini", "opencode"],
      kinds: ["mcp", "skills"],
    }, opts);
    expect(JSON.stringify(preview)).not.toContain("secret-ctx-token");
    expect(JSON.stringify(preview)).not.toContain("super-secret-hdr");
    expect(preview.plans.codex?.mcp.filter(item => item.action === "create")).toHaveLength(2);
    expect(preview.plans.codex?.skills.filter(item => item.action === "create")).toHaveLength(1);

    const applied = await applyEcosystemSync({
      source: "claude",
      targets: ["codex", "gemini", "opencode"],
      kinds: ["mcp", "skills"],
    }, opts);
    expect(applied.batchId).toBeTruthy();

    // Verify foreign keys preserved & values written cleanly
    const codexToml = readFileSync(join(codexDir, "config.toml"), "utf8");
    expect(codexToml).toContain('model = "gpt-5.4"');
    expect(codexToml).toContain('mcp_servers');
    expect(codexToml).toContain("CONTEXT7_TOKEN");
    expect(readFileSync(join(codexDir, "skills", "code-review", "SKILL.md"), "utf8")).toContain("# Code Review");

    const geminiParsed = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf8"));
    expect(geminiParsed.theme).toBe("dark");
    expect(geminiParsed.mcpServers.context7.command).toBe("npx");
    expect(geminiParsed.mcpServers.remoteDocs.httpUrl).toBe("https://mcp.example.com/v1?api_key=query-secret");

    const opencodeParsed = JSON.parse(readFileSync(join(opencodeDir, "opencode.json"), "utf8"));
    expect(opencodeParsed.model).toBe("anthropic/claude-sonnet");
    expect(opencodeParsed.mcp.context7.type).toBe("local");
    expect(opencodeParsed.mcp.context7.command).toEqual(["npx", "-y", "@upstash/context7-mcp"]);
    expect(opencodeParsed.mcp.remoteDocs.type).toBe("remote");

    // Snapshot permissions check on POSIX
    if (process.platform !== "win32") {
      const journalMode = lstatSync(join(configDir, "ecosystem-sync", "journal.json")).mode & 0o777;
      expect(journalMode).toBe(0o600);
    }

    // Restore detects external modification conflict unless force: true
    writeFileSync(join(geminiDir, "settings.json"), JSON.stringify({ theme: "light" }, null, 2));
    await expect(restoreEcosystemSync({ batchId: applied.batchId }, opts)).rejects.toThrow(/conflict|modified/i);

    const restored = await restoreEcosystemSync({ batchId: applied.batchId, force: true }, opts);
    expect(restored.restoredBatchId).toBe(applied.batchId);
    expect(readFileSync(join(geminiDir, "settings.json"), "utf8")).toContain('"dark"');
    expect(existsSync(join(codexDir, "skills", "code-review", "SKILL.md"))).toBe(false);
    expect(existsSync(join(codexDir, "skills", "code-review"))).toBe(false);
  });

  test("rejects symlinks, invalid slugs, oversized SKILL.md, >128 skills/servers, and real home writes", async () => {
    const claudeDir = join(syncHome, ".claude");
    mkdirSync(join(claudeDir, "skills", "bad-link"), { recursive: true });
    writeFileSync(join(syncHome, "outside.txt"), "secret-outside");
    symlinkSync(join(syncHome, "outside.txt"), join(claudeDir, "skills", "bad-link", "SKILL.md"));

    const opts = makePathOptions();
    expect(() => previewEcosystemSync({
      source: "claude",
      targets: ["codex"],
      kinds: ["skills"],
    }, opts)).toThrow(/symlink/i);

    // Replace symlink with oversized >256KiB file
    removeTreeWithRetry(join(claudeDir, "skills"));
    mkdirSync(join(claudeDir, "skills", "huge"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "huge", "SKILL.md"), "a".repeat(256 * 1024 + 1));
    expect(() => previewEcosystemSync({
      source: "claude",
      targets: ["codex"],
      kinds: ["skills"],
    }, opts)).toThrow(/262144|large|limit|size/i);

    // Invalid slug with ..
    removeTreeWithRetry(join(claudeDir, "skills"));
    mkdirSync(join(claudeDir, "skills", "bad..slug"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "bad..slug", "SKILL.md"), "# Bad");
    expect(() => previewEcosystemSync({
      source: "claude",
      targets: ["codex"],
      kinds: ["skills"],
    }, opts)).toThrow(/slug/i);

    // >128 skills
    removeTreeWithRetry(join(claudeDir, "skills"));
    for (let i = 0; i < 129; i++) {
      mkdirSync(join(claudeDir, "skills", `skill-${i}`), { recursive: true });
      writeFileSync(join(claudeDir, "skills", `skill-${i}`, "SKILL.md"), `# Skill ${i}`);
    }
    expect(() => previewEcosystemSync({
      source: "claude",
      targets: ["codex"],
      kinds: ["skills"],
    }, opts)).toThrow(/128|limit/i);

    // Real home write guard under test mode
    const realHome = process.env.EPX_REAL_HOME?.trim() || homedir();
    await expect(applyEcosystemSync({
      source: "claude",
      targets: ["codex"],
      kinds: ["mcp"],
    }, { home: realHome, configDir })).rejects.toThrow(/refusing to write/i);
  });

  test("management routes enforce sibling guard and drive status/preview/apply/restore", async () => {
    mkdirSync(join(syncHome, ".claude", "skills", "triage"), { recursive: true });
    mkdirSync(join(syncHome, ".codex"), { recursive: true });
    writeFileSync(join(syncHome, ".claude", "skills", "triage", "SKILL.md"), "# Triage\n");

    const config = getDefaultConfig();
    config.adminApiToken = "test-admin-token";
    const deps = {
      saveConfig: () => {},
      onQuit: () => {},
      convergeCodexCatalog: async () => ({ status: "ok" as const, modelCount: 0 }),
    } as never;

    const callMgmt = (req: Request) => handleManagementAPI(req, new URL(req.url), config, deps);

    const statusRes = await callMgmt(makeMgmtRequest("/api/ecosystem/sync", "GET"));
    expect(statusRes?.status).toBe(200);
    const statusJson = await statusRes!.json() as { clis: { claude: { skills: Array<{ slug: string }> } } };
    expect(statusJson.clis.claude.skills[0]?.slug).toBe("triage");

    const previewRes = await callMgmt(makeMgmtRequest("/api/ecosystem/sync/preview", "POST", {
      source: "claude",
      targets: ["codex"],
      kinds: ["skills"],
    }));
    expect(previewRes?.status).toBe(200);

    const applyRes = await callMgmt(makeMgmtRequest("/api/ecosystem/sync/apply", "POST", {
      source: "claude",
      targets: ["codex"],
      kinds: ["skills"],
    }));
    expect(applyRes?.status).toBe(200);
    const applyJson = await applyRes!.json() as { batchId: string };
    expect(existsSync(join(syncHome, ".codex", "skills", "triage", "SKILL.md"))).toBe(true);

    // Sibling guard refuses mutating requests when running as sibling
    markSiblingStart(10100);
    const siblingRes = await callMgmt(makeMgmtRequest("/api/ecosystem/sync/apply", "POST", {
      source: "claude",
      targets: ["codex"],
    }));
    expect(siblingRes?.status).toBe(409);
    resetSiblingStartForTests();

    const restoreRes = await callMgmt(makeMgmtRequest("/api/ecosystem/sync/restore", "POST", {
      batchId: applyJson.batchId,
    }));
    expect(restoreRes?.status).toBe(200);
    expect(existsSync(join(syncHome, ".codex", "skills", "triage", "SKILL.md"))).toBe(false);
  });

  test("CLI integration sync status/preview/apply/restore handles --yes and JSON output", async () => {
    mkdirSync(join(syncHome, ".claude", "skills", "audit"), { recursive: true });
    mkdirSync(join(syncHome, ".gemini"), { recursive: true });
    writeFileSync(join(syncHome, ".claude", "skills", "audit", "SKILL.md"), "# Audit\n");

    const deps = { findLiveProxy: async () => null };
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    try {
      const noYesCode = await handleEcosystemSyncCommand(
        ["apply", "--source", "claude", "--targets", "gemini", "--json"],
        deps,
      );
      expect(noYesCode).toBe(2);

      const statusCode = await handleEcosystemSyncCommand(["status", "--json"], deps);
      expect(statusCode).toBe(0);
      expect(JSON.parse(logs.at(-1)!).clis.claude.skills[0].slug).toBe("audit");

      const applyCode = await handleEcosystemSyncCommand(
        ["apply", "--source", "claude", "--targets", "gemini", "--yes", "--json"],
        deps,
      );
      expect(applyCode).toBe(0);
      const batchId = JSON.parse(logs.at(-1)!).batchId as string;
      expect(existsSync(join(syncHome, ".gemini", "skills", "audit", "SKILL.md"))).toBe(true);

      const restoreCode = await handleEcosystemSyncCommand(
        ["restore", "--batch", batchId, "--yes", "--json"],
        deps,
      );
      expect(restoreCode).toBe(0);
      expect(existsSync(join(syncHome, ".gemini", "skills", "audit", "SKILL.md"))).toBe(false);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("resolveEcosystemPaths honors EPX_CLI_SYNC_HOME passed through options.env", () => {
    setEcosystemSyncTestHooks(null);
    const customSyncHome = join(sandboxRoot, "env-sync-home");
    const paths = resolveEcosystemPaths({
      configDir,
      env: {
        HOME: join(sandboxRoot, "unrelated-home"),
        EPX_CLI_SYNC_HOME: customSyncHome,
        CLAUDE_CONFIG_DIR: join(sandboxRoot, "ambient-claude"),
        CODEX_HOME: join(sandboxRoot, "ambient-codex"),
        GEMINI_CLI_HOME: join(sandboxRoot, "ambient-gemini"),
        XDG_CONFIG_HOME: join(sandboxRoot, "ambient-xdg"),
      },
    });
    expect(paths.syncHome).toBe(customSyncHome);
    expect(paths.clis.claude.configDir).toBe(join(customSyncHome, ".claude"));
    expect(paths.clis.claude.mcpPath).toBe(join(customSyncHome, ".claude.json"));
    expect(paths.clis.codex.configDir).toBe(join(customSyncHome, ".codex"));
    expect(paths.clis.gemini.configDir).toBe(join(customSyncHome, ".gemini"));
    expect(paths.clis.opencode.configDir).toBe(join(customSyncHome, ".config", "opencode"));
  });

  test("applyEcosystemSync compensates previously written files in reverse order when mid-batch write fails", async () => {
    const claudeDir = join(syncHome, ".claude");
    const codexDir = join(syncHome, ".codex");
    const geminiDir = join(syncHome, ".gemini");
    mkdirSync(join(claudeDir, "skills", "new-skill"), { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(geminiDir, { recursive: true });

    writeFileSync(join(claudeDir, "skills", "new-skill", "SKILL.md"), "# New Skill\n");
    writeFileSync(join(syncHome, ".claude.json"), JSON.stringify({
      mcpServers: {
        context7: { command: "npx", args: ["-y", "ctx7"] },
      },
    }));
    const originalCodexToml = 'model = "gpt-5.4"\n';
    writeFileSync(join(codexDir, "config.toml"), originalCodexToml);
    writeFileSync(join(geminiDir, "settings.json"), JSON.stringify({ theme: "dark" }));

    setEcosystemSyncTestHooks({
      homeDir: syncHome,
      onBeforeWriteTarget: target => {
        if (target === "gemini") {
          throw new Error("simulated mid-batch disk failure");
        }
      },
    });

    await expect(applyEcosystemSync({
      source: "claude",
      targets: ["codex", "gemini"],
      kinds: ["mcp", "skills"],
    }, makePathOptions())).rejects.toThrow("simulated mid-batch disk failure");

    // Target 1 changes must be completely rolled back (existing restored, newly created removed).
    expect(readFileSync(join(codexDir, "config.toml"), "utf8")).toBe(originalCodexToml);
    expect(existsSync(join(codexDir, "skills", "new-skill", "SKILL.md"))).toBe(false);
    expect(existsSync(join(codexDir, "skills", "new-skill"))).toBe(false);
    expect(existsSync(join(configDir, "ecosystem-sync", "journal.json"))).toBe(false);
  });

  test("sanitizeMcpUrlForDisplay strips URL fragments and masks credentials in templated URLs", () => {
    const withFrag = sanitizeMcpUrlForDisplay("https://user:pass@mcp.example.test/sse?token=secret#access_token=frag-secret");
    expect(withFrag).not.toContain("pass");
    expect(withFrag).not.toContain("secret");
    expect(withFrag).not.toContain("frag-secret");
    expect(withFrag).not.toContain("#");

    const templatedParsed = sanitizeMcpUrlForDisplay("https://user:secret@${MCP_HOST}/sse?k=v#frag");
    expect(templatedParsed).not.toContain("user");
    expect(templatedParsed).not.toContain("secret");
    expect(templatedParsed).not.toContain("v");
    expect(templatedParsed).not.toContain("frag");

    const templatedFallback = sanitizeMcpUrlForDisplay("https://user:secret@${MCP_HOST:8443}/sse?k=v#frag");
    expect(templatedFallback).toBe("https://***@${MCP_HOST:8443}/sse");
    expect(templatedFallback).not.toContain("user");
    expect(templatedFallback).not.toContain("secret");
    expect(templatedFallback).not.toContain("k=v");
    expect(templatedFallback).not.toContain("frag");
  });
});
