import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { EXPORT_CLIENT_IDS } from "../../src/clients/config-export";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const binPath = join(repoRoot, "bin", "epx.mjs");

// Every case below spawns the real CLI. A hung child without a spawnSync timeout can
// pin the whole shard for the full 15-minute CI budget (observed on Linux test 3/4
// after an unrelated Bun epoll_ctl load fault). Keep the child deadline under the
// test budget so a stuck help/status process fails fast instead of cancelling CI.
setDefaultTimeout(SPAWN_BUDGET_MS);
const SPAWN_TIMEOUT_MS = SPAWN_BUDGET_MS - 5_000;

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

function expectSpawnFinished(result: ReturnType<typeof spawnSync>, label: string) {
  expect(result.error, `${label} should not hang: ${result.error?.message ?? "unknown spawn error"}`).toBeUndefined();
  expect(result.signal, `${label} should not be killed by signal ${result.signal}`).toBeNull();
}

describe("CLI subcommand help", () => {
  test("version commands print a single script-friendly line", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runCli(args);
      expectSpawnFinished(result, `epx ${args.join(" ")}`);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toMatch(/^easyproxy \d+\.\d+\.\d+/);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }

    const binResult = spawnSync(process.execPath, [binPath, "--version"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    expectSpawnFinished(binResult, "bin/epx.mjs --version");
    expect(binResult.status).toBe(0);
    expect(binResult.stdout.trim()).toMatch(/^easyproxy \d+\.\d+\.\d+/);
    expect(binResult.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("help command routes to subcommand help", () => {
    const result = runCli(["help", "start"]);
    expectSpawnFinished(result, "epx help start");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: epx start [--port <port>] [--socks5 [host:port] | --socks5-off]");
    expect(result.stdout).toContain("Start the proxy server and sync models to Codex.");
  });

  test("full help counts every export client and export help names them", () => {
    const full = runCli(["help", "--all"]);
    expectSpawnFinished(full, "epx help --all");
    expect(full.status).toBe(0);
    // Derived, not frozen: a hard-coded literal here agreed with a stale
    // literal in help.ts, so the pair stayed self-consistent and wrong
    // while the registry grew. help.ts keeps its literal on purpose —
    // importing the export registry there would load node:os/node:path
    // machinery on the `epx --help` path — so this assertion is what
    // holds the two in lockstep.
    expect(full.stdout).toContain(`(${EXPORT_CLIENT_IDS.length} clients)`);

    const exportHelp = runCli(["help", "export"]);
    expectSpawnFinished(exportHelp, "epx help export");
    expect(exportHelp.status).toBe(0);
    expect(exportHelp.stdout).toContain("opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh");
    expect(exportHelp.stdout).toContain("DeepSeek Harness");
  });

  test("top-level help forms exit before Codex shim auto-restore can mutate launchers", () => {
    const easyproxyHome = mkdtempSync(join(tmpdir(), "epx-help-shim-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "epx-help-shim-bin-"));
    try {
      const wrapper = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      const backup = join(binDir, process.platform === "win32" ? "codex.easyproxy-real.cmd" : "codex.easyproxy-real");
      const statePath = join(easyproxyHome, "codex-shim.json");
      const replacement = "replacement that help must not promote\n";
      writeFileSync(wrapper, replacement, "utf8");
      writeFileSync(backup, "known-good prior launcher\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
      writeFileSync(statePath, `${JSON.stringify({
        platform: process.platform,
        wrapperPath: wrapper,
        originalPath: wrapper,
        backupPath: backup,
      }, null, 2)}\n`, "utf8");
      const stateBefore = readFileSync(statePath);
      const backupBefore = readFileSync(backup);
      Bun.sleepSync(120);

      for (const args of [[], ["help"], ["--help"], ["-h"]]) {
        const result = runCli(args, { EASYPROXY_HOME: easyproxyHome, PATH: binDir });
        expectSpawnFinished(result, `epx ${args.join(" ") || "(no args)"}`);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("easyproxy (epx)");
        expect(readFileSync(wrapper, "utf8")).toBe(replacement);
        expect(readFileSync(backup)).toEqual(backupBefore);
        expect(readFileSync(statePath)).toEqual(stateBefore);
      }
    } finally {
      removeTreeWithRetry(easyproxyHome);
      removeTreeWithRetry(binDir);
    }
  });

  test("tray help documents the install-only no-start flag", () => {
    const result = runCli(["help", "tray"]);
    expectSpawnFinished(result, "epx help tray");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--no-start");
  });

  test("GUI help documents explicit-origin pairing without making a live request", () => {
    const result = runCli(["help", "gui"]);
    expectSpawnFinished(result, "epx help gui");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: epx gui [pair [--desktop] --origin <browser-origin> [--json]]");
    expect(result.stdout).toContain("single-use");
    expect(result.stdout).toContain("must not be persisted");
  });

  test("connect help exposes stdin-only credentials and offline disconnect", () => {
    const connect = runCli(["help", "connect"]);
    expectSpawnFinished(connect, "epx help connect");
    expect(connect.status).toBe(0);
    expect(connect.stdout).toContain("--pairing-code-stdin");
    expect(connect.stdout).toContain("--admin-token-stdin");
    expect(connect.stdout).not.toContain("--admin-token <");

    const disconnect = runCli(["help", "disconnect"]);
    expectSpawnFinished(disconnect, "epx help disconnect");
    expect(disconnect.status).toBe(0);
    expect(disconnect.stdout).toContain("--keep-catalog");
  });

  test("unknown command with help flag remains an error", () => {
    const result = runCli(["foobar", "--help"]);
    expectSpawnFinished(result, "epx foobar --help");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: foobar");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("epx help --all");
    expect(result.stderr.trim().split("\n").length).toBeLessThan(10);
  });

  test("status prints diagnostics without starting the proxy", () => {
    const easyproxyHome = mkdtempSync(join(tmpdir(), "epx-status-"));
    try {
      const configPath = join(easyproxyHome, "config.json");
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status"], {
        cwd: repoRoot,
        env: { ...process.env, EASYPROXY_HOME: easyproxyHome },
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });

      expectSpawnFinished(result, "epx status");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Proxy:");
      expect(result.stdout).toContain("Health: http://127.0.0.1:9/healthz");
      expect(result.stdout).toContain("Dashboard: http://localhost:9/");
      expect(result.stdout).toContain(`Config: ${configPath}`);
      expect(result.stdout).toContain(`PID file: ${join(easyproxyHome, "epx.pid")}`);
      expect(result.stdout).toContain("Runtime:");
      expect(result.stdout).toContain("Runtime source:");
      expect(result.stdout).toContain("Default provider: openai");
      expect(result.stdout).toContain("Codex autostart: disabled");
      expect(result.stdout).toContain("Service:");
      expect(result.stdout).toContain(join(easyproxyHome, "service.log"));
      expect(result.stdout).toContain("Codex autostart shim");
      // #2411: status must name the routing kind it already computes. The
      // proxy is down in this fixture, so the unused-proxy warning must stay
      // quiet — that warning is for a LIVE proxy nothing routes through.
      expect(result.stdout).toContain("routing=");
      expect(result.stdout).not.toContain("the running proxy is unused");
    } finally {
      removeTreeWithRetry(easyproxyHome);
    }
  });

  test("restore --help prints usage without mutating Codex config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "epx-help-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const before = [
        'model_provider = "easyproxy"',
        "",
        "[model_providers.easyproxy]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });

      expectSpawnFinished(result, "epx restore --help");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: epx restore");
      expect(result.stdout).not.toContain("Plain `codex` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      removeTreeWithRetry(codexHome);
    }
  });

  test("mutating command help exits before local state changes", () => {
    const easyproxyHome = mkdtempSync(join(tmpdir(), "epx-help-state-"));
    const codexHome = mkdtempSync(join(tmpdir(), "epx-help-codex-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const markerPath = join(easyproxyHome, "service-state.json");
      const before = 'model_provider = "easyproxy"\n';
      writeFileSync(configPath, before, "utf8");
      writeFileSync(markerPath, '{"installed":true}', "utf8");

      const cases = [
        { args: ["stop", "--help"], expected: "Usage: epx stop" },
        { args: ["uninstall", "--help"], expected: "Usage: epx uninstall" },
        { args: ["service", "uninstall", "--help"], expected: "Usage: epx service" },
        { args: ["codex-shim", "uninstall", "--help"], expected: "Usage: epx codex-shim" },
      ];

      for (const testCase of cases) {
        const result = runCli(testCase.args, {
          CODEX_HOME: codexHome,
          EASYPROXY_HOME: easyproxyHome,
        });
        expectSpawnFinished(result, `epx ${testCase.args.join(" ")}`);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(testCase.expected);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readFileSync(markerPath, "utf8")).toBe('{"installed":true}');
      }
    } finally {
      removeTreeWithRetry(easyproxyHome);
      removeTreeWithRetry(codexHome);
    }
  });

  test("recover-history --help prints usage without opening history database", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "epx-help-"));
    try {
      const statePath = join(codexHome, "state_5.sqlite");

      const result = spawnSync(process.execPath, [cliPath, "recover-history", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });

      expectSpawnFinished(result, "epx recover-history --help");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: epx recover-history (--legacy-openai | --epx-compaction <thread-id>) --yes");
      expect(result.stdout).toContain("Recover legacy provider metadata or one easyproxy-compacted thread");
      expect(result.stdout).not.toContain("Recovered");
      expect(result.stderr).toBe("");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      removeTreeWithRetry(codexHome);
    }
  });

  test("recover-history requires exact confirmation before mutating history", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "epx-recover-confirm-"));
    const easyproxyHome = mkdtempSync(join(tmpdir(), "epx-recover-confirm-state-"));
    try {
      const rollout = join(codexHome, "rollout.jsonl");
      writeFileSync(rollout, `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-1", model_provider: "easyproxy", source: "exec" },
      })}\n`);
      const statePath = join(codexHome, "state_5.sqlite");
      const db = new Database(statePath, { create: true });
      db.exec(`CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT,
        source TEXT, has_user_event INTEGER, first_user_message TEXT
      )`);
      db.run("INSERT INTO threads VALUES ('thread-1', ?, 'easyproxy', 'exec', 1, 'legacy')", [rollout]);
      db.close();
      const databaseBefore = readFileSync(statePath);
      const rolloutBefore = readFileSync(rollout);
      const env = { CODEX_HOME: codexHome, EASYPROXY_HOME: easyproxyHome };

      for (const command of [
        ["recover-history", "--legacy-openai"],
        ["recover-history", "--legacy-openai", "--yes", "--extra"],
      ]) {
        const refused = runCli(command, env);
        expectSpawnFinished(refused, `epx ${command.join(" ")}`);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("--legacy-openai --yes");
        expect(readFileSync(statePath).equals(databaseBefore)).toBe(true);
        expect(readFileSync(rollout).equals(rolloutBefore)).toBe(true);
      }

      const confirmed = runCli(["recover-history", "--legacy-openai", "--yes"], env);
      expectSpawnFinished(confirmed, "epx recover-history --legacy-openai --yes");
      expect(confirmed.status).toBe(0);
      expect(confirmed.stdout).toContain("Recovered 1 legacy thread(s)");
      const restored = new Database(statePath, { readonly: true });
      expect(restored.query("SELECT model_provider, source FROM threads WHERE id = 'thread-1'").get())
        .toEqual({ model_provider: "openai", source: "cli" });
      restored.close();
    } finally {
      removeTreeWithRetry(easyproxyHome);
      removeTreeWithRetry(codexHome);
    }
  });

  test("recover-history repairs one explicitly selected epx1-compacted thread", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "epx-rc-"));
    const easyproxyHome = mkdtempSync(join(tmpdir(), "epx-rc-state-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      const threadId = "01a018e6-242f-7801-81b8-ffc0a5c6d589";
      const rolloutDir = join(codexHome, "sessions", "2026", "09", "07");
      mkdirSync(rolloutDir, { recursive: true });
      const rollout = join(rolloutDir, `rollout-fixture-${threadId}.jsonl`);
      const summary = `epx1:${Buffer.from("portable summary", "utf8").toString("base64")}`;
      writeFileSync(rollout, `${JSON.stringify({
        type: "compacted",
        payload: {
          replacement_history: [{ type: "compaction", id: "cmp_fixture", encrypted_content: summary }],
        },
      })}\n`, "utf8");
      const statePath = join(codexHome, "state_5.sqlite");
      const db = new Database(statePath, { create: true });
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
      db.query("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(threadId, rollout);
      db.close();

      const result = runCli(
        ["recover-history", "--epx-compaction", threadId, "--yes"],
        { CODEX_HOME: codexHome, EASYPROXY_HOME: easyproxyHome, CI: "1" },
      );

      expectSpawnFinished(result, "epx recover-history --epx-compaction");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Recovered 1 epx1 compaction item(s)");
      expect(readFileSync(rollout, "utf8")).toContain("portable summary");
      expect(readFileSync(rollout, "utf8")).not.toContain("epx1:");
      const backupDir = join(easyproxyHome, "history-recovery-backups", threadId);
      const backups = readdirSync(backupDir);
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(backupDir, backups[0]), "utf8")).toContain("epx1:");
    } finally {
      removeTreeWithRetry(easyproxyHome);
      removeTreeWithRetry(codexHome);
    }
  });

  test("start rejects unknown and partially numeric port arguments", () => {
    const cases = [
      { args: ["start", "--port", "123abc"], expected: "Invalid port number" },
      { args: ["start", "--bad"], expected: "Usage: epx start [--port <port>] [--socks5 [host:port] | --socks5-off]" },
      { args: ["start", "--port", "1234", "--extra"], expected: "Usage: epx start [--port <port>] [--socks5 [host:port] | --socks5-off]" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expectSpawnFinished(result, `epx ${testCase.args.join(" ")}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).not.toContain("Plain `codex`");
    }
  });

  test("start help wins before port validation", () => {
    const result = runCli(["start", "--port", "123abc", "--help"]);
    expectSpawnFinished(result, "epx start --port 123abc --help");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: epx start [--port <port>] [--socks5 [host:port] | --socks5-off]");
  });

  test("invalid service and codex-shim usage include remove alias", () => {
    const cases = [
      { args: ["service", "nope"], expected: "Usage: epx service [install|repair|restart|start|stop|status|uninstall|remove|claim]" },
      { args: ["codex-shim", "nope"], expected: "Usage: epx codex-shim <install|status|uninstall|remove>" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expectSpawnFinished(result, `epx ${testCase.args.join(" ")}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).toBe("");
    }
  });
});
