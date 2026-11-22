import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDetectionStatus, type InstallDetectionStatus } from "../../src/cli/status-install";
import { getDefaultConfig } from "../../src/config";
import { detectInstallOwnershipFromPath, type InstallDetectionDeps } from "../../src/update/install-detection.mjs";
import { repoPath } from "../helpers/repo-root";

/**
 * `epx status --json` `install` is GOAT's adopt/advise input (goat-si/goat#684 §5 step 3), so
 * it must be the verdict `epx update` itself acts on — the same detector over the same path —
 * and must name its evidence without printing that path.
 */

const lexicalOnly: InstallDetectionDeps = {
  exists: () => false,
  probe: () => "absent",
  realpath: () => { throw new Error("no realpath for synthetic paths"); },
};

function verdictFor(packagePath: string, deps: InstallDetectionDeps = lexicalOnly): InstallDetectionStatus {
  return installDetectionStatus(() => detectInstallOwnershipFromPath(packagePath, deps));
}

const MISE_ROOT = "/tmp/test-user/.local/share/mise/installs/npm-aquilaxk-easyproxy";
const miseRecord = (record: "present" | "unreadable"): InstallDetectionDeps => ({
  ...lexicalOnly,
  probe: path => path === `${MISE_ROOT}/.mise.backend.toml` ? record : "absent",
  readFile: () => 'short = "npm:easyproxy"\nfull = "npm:easyproxy"\n',
});

describe("epx status --json install-method matrix", () => {
  const cases: Array<[string, string, InstallDetectionDeps | undefined, InstallDetectionStatus]> = [
    ["bun global", "/tmp/test-user/.bun/install/global/node_modules/easyproxy/src/update", undefined,
      { method: "bun", evidence: { basis: "package-layout" } }],
    ["npm global", "/usr/lib/node_modules/easyproxy/src/update", undefined,
      { method: "npm", evidence: { basis: "package-layout" } }],
    ["pnpm virtual store", "/tmp/test-user/.local/share/pnpm/global/v11/node_modules/.pnpm/@aquilaxk+easyproxy@2.90.0/node_modules/easyproxy/src/update", undefined,
      { method: "pnpm", evidence: { basis: "package-layout" } }],
    ["pnpm on Windows", "C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\@aquilaxk+easyproxy@2.90.0\\node_modules\\@aquilaxk\\easyproxy\\src\\update", undefined,
      { method: "pnpm", evidence: { basis: "package-layout" } }],
    ["mise npm backend", `${MISE_ROOT}/2.90.0/node_modules/easyproxy/src/update`, miseRecord("present"),
      { method: "mise", evidence: { basis: "mise-backend-record", mise: { tool: "npm:easyproxy", backend: "npm:easyproxy" } } }],
    ["mise with an unreadable backend record", `${MISE_ROOT}/2.90.0/node_modules/easyproxy/src/update`, miseRecord("unreadable"),
      { method: "mise", evidence: { basis: "mise-backend-record", error: "metadata_unreadable" } }],
    ["source checkout", "/work/easyproxy/src/update", undefined,
      { method: "source", evidence: { basis: "package-layout" } }],
  ];

  for (const [name, packagePath, deps, expected] of cases) {
    test(name, () => {
      const verdict = verdictFor(packagePath, deps);
      expect(verdict).toEqual(expected);
      // Evidence is a class, never the path it was read from.
      expect(JSON.stringify(verdict)).not.toContain("test-user");
      expect(JSON.stringify(verdict)).not.toContain("/work/");
    });
  }

  test("the compiled standalone binary", () => {
    expect(installDetectionStatus(() => ({ installer: "standalone" })))
      .toEqual({ method: "standalone", evidence: { basis: "standalone-binary" } });
  });

  test("a detector failure is unknown, not a guess", () => {
    expect(installDetectionStatus(() => { throw new Error("fileURLToPath failed"); }))
      .toEqual({ method: "unknown", evidence: { basis: "unavailable", error: "detection_failed" } });
  });

  test("epx status --json carries the verdict for this checkout", () => {
    const home = mkdtempSync(join(tmpdir(), "epx-status-install-"));
    try {
      mkdirSync(join(home, "codex"), { recursive: true });
      // Port 9 (discard) is never an easyproxy proxy, so status reads nothing live.
      writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), port: 9, hostname: "127.0.0.1", codexAutoStart: false }));
      const run = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "status", "--json"], {
        cwd: repoPath(),
        env: { ...process.env, EASYPROXY_HOME: home, CODEX_HOME: join(home, "codex") },
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      const json = JSON.parse(run.stdout) as { schemaVersion: number; install: InstallDetectionStatus };
      expect(json.schemaVersion).toBe(1);
      expect(json.install).toEqual({ method: "source", evidence: { basis: "package-layout" } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
