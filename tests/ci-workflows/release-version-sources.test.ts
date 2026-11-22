import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERSION_SOURCE_PATHS,
  readVersionSources,
  writeVersionSources,
} from "../../scripts/release-version-sources";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

/**
 * Every spawnSync below is bounded by the shared spawned-child deadline: Bun's test
 * timeout cannot interrupt a synchronous wait, so an unbounded child that wedges on
 * a lock or a runner stall pins its whole batch until the shard deadline cuts it
 * (Linux test 1/4 batch 6, run 37736425700). A bounded child fails this one test instead.
 *
 * The npm package and the desktop app read their version from different files. When only
 * package.json moved, dev carried 2.62.0 for npm while tauri.conf.json, Cargo.toml and the
 * easyproxy-desktop Cargo.lock entry still said 2.61.0, so a release would have shipped an app
 * that reports the previous version under an updater manifest naming the new one, and the
 * updater would re-offer that release forever.
 *
 * The first test is the tripwire for that drift and parses each file itself rather than trusting
 * the module under test. The rest pin that every path which moves the version moves all four.
 */

const CLI = repoPath("scripts", "release-version-sources.ts");

function packageVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** Copies of the real four files in a scratch root, so rewrites never touch the checkout. */
function scratchCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "epx-version-sources-"));
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  for (const path of VERSION_SOURCE_PATHS) copyFileSync(repoPath(...path.split("/")), join(root, ...path.split("/")));
  return root;
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(VERSION_SOURCE_PATHS.map(path => [path, readFileSync(join(root, ...path.split("/")), "utf8")]));
}

function runCli(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], { timeout: INTERNAL_DEADLINE_MS, killSignal: "SIGKILL" });
  return { exitCode: proc.exitCode, stderr: new TextDecoder().decode(proc.stderr) };
}

describe("release version sources", () => {
  test("every version source in the working tree carries package.json's version", () => {
    const root = repoRoot();
    const expected = packageVersion(root);
    const tauri = (JSON.parse(readFileSync(repoPath("desktop", "src-tauri", "tauri.conf.json"), "utf8")) as { version?: string }).version;
    const manifest = /^\[package\][^]*?^version = "([^"]+)"$/m.exec(readFileSync(repoPath("desktop", "src-tauri", "Cargo.toml"), "utf8"))?.[1];
    const lock = [...readFileSync(repoPath("desktop", "src-tauri", "Cargo.lock"), "utf8")
      .matchAll(/^\[\[package\]\]\r?\nname = "easyproxy-desktop"\r?\nversion = "([^"]+)"$/gm)].map(match => match[1]);

    expect({ tauri, manifest, lock }).toEqual({ tauri: expected, manifest: expected, lock: [expected] });
    expect(readVersionSources(root)).toEqual(VERSION_SOURCE_PATHS.map(path => ({ path, version: expected })));
  });

  test("the source list is package.json plus the three desktop files", () => {
    expect([...VERSION_SOURCE_PATHS]).toEqual([
      "package.json",
      "desktop/src-tauri/tauri.conf.json",
      "desktop/src-tauri/Cargo.toml",
      "desktop/src-tauri/Cargo.lock",
    ]);
  });

  test("a sync moves each real source by exactly its version line", () => {
    const root = scratchCopy();
    const before = snapshot(root);
    expect(writeVersionSources(root, "9.9.9")).toEqual([...VERSION_SOURCE_PATHS]);
    const after = snapshot(root);
    for (const path of VERSION_SOURCE_PATHS) {
      const old = before[path]!.split("\n");
      const moved = after[path]!.split("\n");
      expect(moved.length, path).toBe(old.length);
      const changed = moved.flatMap((line, index) => (line === old[index] ? [] : [line]));
      expect(changed.length, path).toBe(1);
      expect(changed[0], path).toContain('"9.9.9"');
    }
    // The lock line that moved is the desktop crate's, not a dependency sharing its version.
    expect(after["desktop/src-tauri/Cargo.lock"]).toMatch(/^name = "easyproxy-desktop"\nversion = "9\.9\.9"$/m);
    expect(readVersionSources(root).map(reading => reading.version)).toEqual(VERSION_SOURCE_PATHS.map(() => "9.9.9"));
    expect(readdirSync(join(root, "desktop", "src-tauri")).filter(name => name.includes(".tmp-"))).toEqual([]);

    // Idempotent: the --publish re-run of a dry run must not produce a diff.
    expect(writeVersionSources(root, "9.9.9")).toEqual([]);
    expect(snapshot(root)).toEqual(after);
  });

  test("a malformed version is refused before any file is written", () => {
    const root = scratchCopy();
    const before = snapshot(root);
    for (const version of ['9.9.9"', "9.9.9\nversion = \"1.0.0\"", "v9.9.9", "9.9", ""]) {
      expect(() => writeVersionSources(root, version), JSON.stringify(version)).toThrow(/malformed version/);
    }
    expect(snapshot(root)).toEqual(before);
  });

  test("a missing or ambiguous source fails with every file untouched", () => {
    const missing = scratchCopy();
    unlinkSync(join(missing, "desktop", "src-tauri", "Cargo.lock"));
    const packageBefore = readFileSync(join(missing, "package.json"), "utf8");
    const tauriBefore = readFileSync(join(missing, "desktop", "src-tauri", "tauri.conf.json"), "utf8");
    expect(() => writeVersionSources(missing, "9.9.9")).toThrow(/Cargo\.lock is missing/);
    expect(readFileSync(join(missing, "package.json"), "utf8")).toBe(packageBefore);
    expect(readFileSync(join(missing, "desktop", "src-tauri", "tauri.conf.json"), "utf8")).toBe(tauriBefore);

    const duplicated = scratchCopy();
    const lockPath = join(duplicated, "desktop", "src-tauri", "Cargo.lock");
    writeFileSync(lockPath, readFileSync(lockPath, "utf8") + '\n[[package]]\nname = "easyproxy-desktop"\nversion = "0.0.1"\n', "utf8");
    const duplicatedBefore = snapshot(duplicated);
    expect(() => writeVersionSources(duplicated, "9.9.9")).toThrow(/easyproxy-desktop/);
    expect(snapshot(duplicated)).toEqual(duplicatedBefore);

    // A nested "version" that comes first must not be bumped in place of a missing top-level one.
    const nested = scratchCopy();
    writeFileSync(join(nested, "desktop", "src-tauri", "tauri.conf.json"), '{\n  "plugin": { "version": "1.0.0" }\n}\n', "utf8");
    const nestedBefore = snapshot(nested);
    expect(() => writeVersionSources(nested, "9.9.9")).toThrow(/tauri\.conf\.json/);
    expect(snapshot(nested)).toEqual(nestedBefore);
  });

  test("the check CLI fails naming the drifted source and passes when they agree", () => {
    const root = scratchCopy();
    const version = packageVersion(root);
    expect(runCli("check", version, "--root", root).exitCode).toBe(0);
    expect(runCli("check", "--root", root).exitCode).toBe(0);

    const tauriPath = join(root, "desktop", "src-tauri", "tauri.conf.json");
    writeFileSync(tauriPath, readFileSync(tauriPath, "utf8").replace('"version": "' + version + '"', '"version": "0.0.1"'), "utf8");
    for (const args of [["check", version], ["check"]]) {
      const drifted = runCli(...args, "--root", root);
      expect(drifted.exitCode).not.toBe(0);
      expect(drifted.stderr).toContain("desktop/src-tauri/tauri.conf.json carries 0.0.1, expected " + version);
    }
    expect(runCli("check", "9.9.9", "--root", root).stderr).toContain("package.json carries " + version + ", expected 9.9.9");
    expect(runCli("nonsense").exitCode).not.toBe(0);
  });
});

type WorkflowStep = { name?: string; shell?: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

function workflowSteps(file: string, job: string): WorkflowStep[] {
  const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", file), "utf8")) as Workflow;
  return workflow.jobs?.[job]?.steps ?? [];
}

function stepIndex(steps: WorkflowStep[], name: string): number {
  const index = steps.findIndex(step => step.name === name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  return index;
}

describe("every version move covers all four sources", () => {
  test("release.yml verifies all four version sources before packaging", () => {
    const verify = workflowSteps("release.yml", "verify");
    const gate = verify[stepIndex(verify, "Verify release metadata and gates")]!;
    expect(gate.run).toContain("bun scripts/release-version-sources.ts check");
  });

  const bashTest = process.platform === "win32" ? test.skip : test;
  bashTest("CLI sync and check stamp and validate all four files atomically", () => {
    const root = scratchCopy();
    try {
      const version = "9.8.7-preview.20261108.1";
      const before = snapshot(root);
      const sync = Bun.spawnSync(
        [process.execPath, CLI, "sync", version, "--root", root],
        { timeout: INTERNAL_DEADLINE_MS, stdout: "pipe", stderr: "pipe" },
      );
      expect(sync.exitCode, sync.stderr.toString()).toBe(0);
      const check = Bun.spawnSync(
        [process.execPath, CLI, "check", version, "--root", root],
        { timeout: INTERNAL_DEADLINE_MS, stdout: "pipe", stderr: "pipe" },
      );
      expect(check.exitCode, check.stderr.toString()).toBe(0);
      expect(readVersionSources(root).map(entry => entry.version)).toEqual([version, version, version, version]);
      const after = snapshot(root);
      for (const path of VERSION_SOURCE_PATHS) expect(after[path], path).not.toBe(before[path]);
    } finally { removeTreeWithRetry(root); }
  });
});
