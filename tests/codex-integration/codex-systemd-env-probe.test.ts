import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnit } from "../../src/service/systemd";
import { inspectServiceManagerInstallation, type ProbeRunner } from "../../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../../src/integrations/native/ownership-preflight";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const envKeys = ["CODEX_HOME", "EASYPROXY_HOME", "CODEX_SQLITE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
let previous: (string | undefined)[];
let testHome: string;
let unitPath: string;
beforeEach(() => {
  previous = envKeys.map(key => process.env[key]);
  testHome = mkdtempSync(join(tmpdir(), "epx-systemd-env-"));
  process.env.XDG_CONFIG_HOME = join(testHome, ".config");
  process.env.XDG_DATA_HOME = join(testHome, ".local", "share");
  delete process.env.CODEX_SQLITE_HOME;
  const unitDir = join(testHome, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  unitPath = join(unitDir, "easyproxy-proxy.service");
});
afterEach(() => {
  envKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  removeTreeWithRetry(testHome);
});

for (const offline of [false, true]) describe(`systemd home decoding (${offline ? "offline" : "online"})`, () => {
  function probe() {
    const run: ProbeRunner = (file, args) => {
      expect(file).toBe("systemctl");
      expect(args.slice(0, 3)).toEqual(["--user", "show", "easyproxy-proxy"]);
      return {
        status: offline ? 1 : 0, timedOut: false, spawnFailed: false,
        stderr: offline ? "Failed to connect to bus" : "",
        stdout: offline ? "" : `LoadState=loaded\nActiveState=active\nFragmentPath=${unitPath}\nNeedDaemonReload=no\n`,
      };
    };
    return { run, platform: "linux" as const, home: testHome };
  }

  test("production buildUnit values round trip quotes, percent, backslash, spaces and newline", () => {
    const codexHome = join(testHome, 'a "quoted" 50% \\ path\nsecond', ".codex");
    const easyproxyHome = join(testHome, 'b \\n literal %% "value"', ".easyproxy");
    process.env.CODEX_HOME = codexHome;
    process.env.EASYPROXY_HOME = easyproxyHome;
    const unit = buildUnit([], {
      launcher: "/fixture/bin/epx",
      runtime: { path: "/fixture/bin/bun", source: "bundled", overrideEnv: "EASYPROXY_BUN_PATH" },
    });
    const codexLines = unit.split("\n").filter(line => line.startsWith('Environment="CODEX_HOME='));
    const epxLines = unit.split("\n").filter(line => line.startsWith('Environment="EASYPROXY_HOME='));
    expect(codexLines).toHaveLength(1);
    expect(epxLines).toHaveLength(1);
    const codexSuffix = process.platform === "win32"
      ? String.raw`\\a \"quoted\" 50%% \\ path\nsecond\\.codex"`
      : String.raw`/a \"quoted\" 50%% \\ path\nsecond/.codex"`;
    const epxSuffix = process.platform === "win32"
      ? String.raw`\\b \\n literal %%%% \"value\"\\.easyproxy"`
      : String.raw`/b \\n literal %%%% \"value\"/.easyproxy"`;
    expect(codexLines[0]!).toEndWith(codexSuffix);
    expect(epxLines[0]!).toEndWith(epxSuffix);
    writeFileSync(unitPath, unit);
    const result = inspectServiceManagerInstallation(probe());
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0]?.homes).toEqual({ codexHome, easyproxyHome });
    expect(result.claims[0]?.registration).toBe(offline ? "absent" : "present");
  });

  test("handwritten systemd environment preserves literal backslashes and escaped characters", () => {
    const codexHome = '/fixture/a "quoted" 50% \\ path\nsecond/.codex';
    const easyproxyHome = '/fixture/b \\n literal %% "value"/.easyproxy';
    writeFileSync(unitPath, ["[Service]",
      String.raw`Environment="CODEX_HOME=/fixture/a \"quoted\" 50%% \\ path\nsecond/.codex"`,
      String.raw`Environment="EASYPROXY_HOME=/fixture/b \\n literal %%%% \"value\"/.easyproxy"`,
    ].join("\n"));
    const result = inspectServiceManagerInstallation(probe());
    expect(result.kind).toBe("present");
    if (result.kind !== "present") throw new Error("expected fixture service");
    expect(result.claims[0]?.homes).toEqual({ codexHome, easyproxyHome });
    expect(result.claims[0]?.registration).toBe(offline ? "absent" : "present");
  });

  test("legacy simple bare assignments remain literal and omitted homes remain null", () => {
    writeFileSync(unitPath, "[Service]\nEnvironment=CODEX_HOME=/fixture/.codex\n");
    const result = inspectServiceManagerInstallation(probe());
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0]?.homes).toEqual({ codexHome: "/fixture/.codex", easyproxyHome: null });
  });

  test("comment backslashes and an escaped trailing backslash do not continue a directive", () => {
    writeFileSync(unitPath, [
      "[Service]", "# ignored \\", "; ignored \\", "Description=literal\\\\",
      "Environment=CODEX_HOME=/fixture/.codex",
    ].join("\n"));
    const result = inspectServiceManagerInstallation(probe());
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0]?.homes.codexHome).toBe("/fixture/.codex");
  });

  test("non-environment directives are skipped, including X- extensions", () => {
    writeFileSync(unitPath, [
      "[Unit]",
      "Description=EasyProxy Proxy Server",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "X-Custom=ignored extension",
      "# a comment",
      "; another comment",
      "ExecStart=\"/bin/sh\" -lc \"epx start\"",
      "Environment=EASYPROXY_HOME=/fixture/.easyproxy",
    ].join("\n"));
    const result = inspectServiceManagerInstallation(probe());
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0]?.homes).toEqual({ codexHome: null, easyproxyHome: "/fixture/.easyproxy" });
  });

  test.each([
    ["unknown escape", 'Environment="CODEX_HOME=/fixture/\\q"'],
    ["unsupported hex escape", 'Environment="CODEX_HOME=/fixture/\\x41"'],
    ["systemd specifier", 'Environment="CODEX_HOME=%h/.codex"'],
    ["single trailing percent", 'Environment="CODEX_HOME=/fixture/50%"'],
    ["unclosed quote", 'Environment="CODEX_HOME=/fixture/.codex'],
    ["escaped closing quote", 'Environment="CODEX_HOME=/fixture/\\"'],
    ["extra quoted assignment", 'Environment="CODEX_HOME=/fixture/.codex" "CODEX_HOME=/foreign"'],
    ["duplicate home", 'Environment=CODEX_HOME=/fixture/.codex\nEnvironment=CODEX_HOME=/foreign'],
    ["duplicate identical home", 'Environment=CODEX_HOME=/fixture/.codex\nEnvironment=CODEX_HOME=/fixture/.codex'],
    ["bare whitespace", 'Environment=CODEX_HOME=/fixture/with space'],
    ["empty home", 'Environment=CODEX_HOME='],
    ["reset assignment", 'Environment='],
    ["missing assignment separator", 'Environment="CODEX_HOME"'],
    ["continued directive name", 'Environment\\\n="CODEX_HOME=/foreign"'],
    ["continued directive across comments", 'Environment\\\n# ignored\n; ignored\n="CODEX_HOME=/foreign"'],
    ["continuation consuming a home assignment", 'ExecStart=/fixture/bin/epx \\\nEnvironment="CODEX_HOME=/fixture/.codex"'],
    ["bare directive without =", 'Environment'],
    ["environment-file directive", 'EnvironmentFile=/fixture/env.list'],
    ["pass-environment directive", 'PassEnvironment=EASYPROXY_HOME'],
    ["unset-environment directive", 'UnsetEnvironment=EASYPROXY_HOME'],
    ["suffixed environment directive", 'EnvironmentOther="EASYPROXY_HOME=/foreign"'],
    ["extension environment directive", 'X-Environment="EASYPROXY_HOME=/foreign"'],
    ["escaped directive name", 'Environ\\x6dent="EASYPROXY_HOME=/foreign"'],
    ["specifier directive name", 'Environmen%74="EASYPROXY_HOME=/foreign"'],
    ["spaced directive name", 'Environ ment="EASYPROXY_HOME=/foreign"'],
    ["include directive", '.include /fixture/extra.conf'],
  ])("%s makes the whole definition unknown despite another matching home", (_, malformed) => {
    const homes = { codexHome: "/fixture/.codex", easyproxyHome: "/fixture/.easyproxy" };
    const statePath = join(testHome, "service-state.json");
    writeFileSync(statePath, JSON.stringify({ version: 1, ...homes }));
    writeFileSync(unitPath, `[Service]\nEnvironment="EASYPROXY_HOME=${homes.easyproxyHome}"\n${malformed}\n`);
    expect(inspectNativeCodexOwnership({
      ...probe(), statePaths: [statePath], currentHomes: homes, realpathSync: path => path,
    }).ownership).toBe("unknown");
    expect(inspectServiceManagerInstallation(probe()).kind).toBe("unknown");
  });
});
