import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { encodeOrchestratedExpect, issueOrchestratedResultCapability } from "../../src/update/orchestrated-session.mjs";
import { createUpdatePlanToken } from "../../src/update/orchestrated-token.mjs";
import { inspectUpdateMarker, inspectUpdateSyncMutex } from "../../src/update/sync-update-mutex.mjs";
import { isUpdateInFlight } from "../../src/update/sync-update-mutex";

function expireFixtureFence(home: string) {
  const path = join(home, "update-orchestrated.json"), marker = JSON.parse(readFileSync(path, "utf8"));
  expect(["failed", "installed", "refused"]).toContain(marker.phase);
  expect(inspectUpdateSyncMutex(home)).toBe("free");
  if (marker.fenceUntil === undefined) { expect(inspectUpdateMarker(home)).toBe("free"); return; }
  expect(inspectUpdateMarker(home, { now: () => marker.fenceUntil })).toBe("free");
  marker.fenceUntil = marker.startedAt;
  writeFileSync(path, JSON.stringify(marker));
}

function expectSyncAdmission(pkg: string, cwd: string, env: Record<string, string | undefined>, admitted: boolean) {
  const sync = spawnSync(process.execPath, [join(pkg, "src/cli/index.ts"), "sync", "--local-only", "--expect-link", "lnk_0000000000000000"],
    { cwd, env, encoding: "utf8", timeout: 30000 });
  // A disconnected-link refusal is reached only after the update guard admits sync.
  expect({ status: sync.status, stderr: sync.stderr }).toMatchObject({ status: admitted ? 5 : 7 });
}

test.skipIf(process.platform === "win32")("pnpm child reports unchanged active tree without rollback and installs the pinned version", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "epx-pnpm-child-")));
  const home = join(root, "home"), group = join(root, "global/v11"), bin = join(root, "bin");
  const store = join(root, "store", "v11");
  const pkg = join(group, "node_modules/easyproxy"), result = join(root, "result.json"), log = join(root, "pnpm.log");
  mkdirSync(home); mkdirSync(bin); mkdirSync(pkg, { recursive: true }); mkdirSync(store, { recursive: true });
  try {
    cpSync(repoPath("src"), join(pkg, "src"), { recursive: true }); cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
    const launcher = join(pkg, "bin/epx.mjs"), launcherSource = readFileSync(launcher, "utf8");
    const instrumented = launcherSource.replace('import { existsSync, readFileSync, readdirSync } from "node:fs";',
      'import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";').replace('    // Never replace package files under a live proxy',
      '    writeFileSync(process.env.EPX_FIXTURE_STOP_BOUNDARY, "reached");\n    // Never replace package files under a live proxy');
    if (instrumented === launcherSource) throw new Error("stop boundary injection point missing");
    writeFileSync(launcher, instrumented);
    const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")); manifest.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
    cpSync(repoPath("node_modules"), join(pkg, "node_modules"), { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(group, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
    const executable = Bun.which("node"); if (!executable) throw new Error("Node required");
    const node = spawnSync(executable, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
    if (!node || !node.startsWith("/")) throw new Error("Node executable is not an absolute path");
    for (const name of ["epx", "easyproxy"]) { writeFileSync(join(bin, name), `#!/bin/sh\nexec '${node}' '${pkg}/bin/epx.mjs' "$@"\n`); chmodSync(join(bin, name), 0o755); }
    writeFileSync(join(bin, "pnpm"), `#!${node}\nconst fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),e=process.env;\nfs.appendFileSync(e.EPX_FIXTURE_LOG,JSON.stringify({args:a,outcome:JSON.parse(fs.readFileSync(e.EPX_FIXTURE_RESULT)),mutex:fs.existsSync(p.join(e.EASYPROXY_HOME,'sync-update.mutation.lock'))})+'\\n');\nconst m=JSON.parse(fs.readFileSync(p.join(e.EPX_FIXTURE_PKG,'package.json')));\nif(a[0]==='list') console.log(JSON.stringify([{path:e.EPX_FIXTURE_GROUP,dependencies:{'easyproxy':{version:m.version,path:e.EPX_FIXTURE_PKG}}}]));\nelse if(a[0]==='root') console.log(e.EPX_FIXTURE_GROUP+'/node_modules');\nelse if(a[0]==='config') console.log(a[2]==='store-dir'?(e.EPX_FIXTURE_CHILD_STORE && e.EPX_UPDATE_ORCHESTRATED_CHILD==='1' ? e.EPX_FIXTURE_CHILD_STORE : e.EPX_FIXTURE_STORE):a[2]==='global-dir'?p.dirname(e.EPX_FIXTURE_GROUP):a[2]==='global-bin-dir'?e.EPX_FIXTURE_BIN:a[2]==='virtual-store-dir'&&e.EPX_UPDATE_ORCHESTRATED_CHILD==='1'&&e.EPX_FIXTURE_CHILD_VIRTUAL_STORE?e.EPX_FIXTURE_CHILD_VIRTUAL_STORE:'undefined');\nelse if(a[0]==='store') console.log(e.EPX_FIXTURE_CHILD_STORE && e.EPX_UPDATE_ORCHESTRATED_CHILD==='1' ? e.EPX_FIXTURE_CHILD_STORE : e.EPX_FIXTURE_STORE);\nelse if(a[0]==='view') console.log(a.includes('dist.integrity')?'sha512-YWJj':'2.1.0');\nelse if(a[0]==='add'){if(e.EPX_FIXTURE_FAIL==='1')process.exit(1);m.version='2.1.0';fs.writeFileSync(p.join(e.EPX_FIXTURE_PKG,'package.json'),JSON.stringify(m));}\nelse process.exit(90);\n`); chmodSync(join(bin, "pnpm"), 0o755);
    const token = createUpdatePlanToken({ currentVersion: "2.0.0", targetVersion: "2.1.0", installer: "pnpm", cliRoot: pkg, servingRoot: null, runtimeOwner: "none", runtime: null });
    const encoded = encodeOrchestratedExpect({ home, cliRoot: pkg, servingRoot: null, runtimePid: null, planToken: token });
    const args = [join(pkg, "bin/epx.mjs"), "update", "--version", "2.1.0", "--orchestrated-expect", encoded, "--orchestrated-result", result];
    const env = { ...process.env, HOME: root, USERPROFILE: root, EASYPROXY_HOME: home, CODEX_HOME: join(root, "codex"),
      EPX_TEST_HOME_GUARD: "1", EPX_REAL_HOME: process.env.EPX_REAL_HOME ?? homedir(), EPX_UPDATE_ORCHESTRATED_CHILD: "1", EASYPROXY_BUN_PATH: process.execPath,
      PATH: bin, EPX_FIXTURE_LOG: log, EPX_FIXTURE_PKG: pkg, EPX_FIXTURE_GROUP: group, EPX_FIXTURE_BIN: bin, EPX_FIXTURE_STORE: store, EPX_FIXTURE_RESULT: result,
      EPX_FIXTURE_STOP_BOUNDARY: join(root, "stop-boundary") };
    const firstCapability = issueOrchestratedResultCapability(result).capability;
    const legacy = spawnSync(node, args, { cwd: root, env: { ...env, EPX_UPDATE_RESULT_CAPABILITY: firstCapability }, encoding: "utf8", timeout: 30000 });
    expect({ status: legacy.status, stderr: legacy.stderr }).toMatchObject({ status: 10 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "refused", error: "plan-changed" });
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
    expect(legacy.status).toBe(10);
    expect(existsSync(env.EPX_FIXTURE_STOP_BOUNDARY)).toBe(false);
    expireFixtureFence(home);
    rmSync(result, { force: true });
    // A legacy global group (hoisted, .modules.yaml): its owner pins no store, as on the released updater.
    const owner = { commandPath: join(bin, "pnpm"), packagePath: pkg, globalDir: join(root, "global"), globalRoot: group, globalBinDir: bin };
    const expectIndex = args.indexOf("--orchestrated-expect") + 1;
    const pinned = (pnpmOwner: object) => encodeOrchestratedExpect({ home, cliRoot: pkg, servingRoot: null, runtimePid: null, planToken: token,
      pnpmOwner: pnpmOwner as typeof owner });
    const otherStore = join(root, "other-store", "v11"); mkdirSync(otherStore, { recursive: true });
    const withStore = { ...owner, store: otherStore, storePath: otherStore, virtualStoreDirs: [] };
    for (const changed of [withStore, { ...owner, commandPath: join(bin, "epx") }, { ...owner, globalBinDir: home }]) {
      args[expectIndex] = pinned(changed);
      const capability = issueOrchestratedResultCapability(result).capability;
      const refused = spawnSync(node, args, { cwd: root, env: { ...env, EPX_UPDATE_RESULT_CAPABILITY: capability }, encoding: "utf8", timeout: 30000 });
      expect(refused.status).toBe(10);
      expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "refused", error: "plan-changed" });
      expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
      expect(readFileSync(log, "utf8")).not.toContain('"add"');
      expect(existsSync(env.EPX_FIXTURE_STOP_BOUNDARY)).toBe(false);
      expireFixtureFence(home);
      rmSync(result, { force: true });
    }
    args[expectIndex] = pinned(owner);
    const failureCapability = issueOrchestratedResultCapability(result).capability;
    const failed = spawnSync(node, args, { cwd: root, env: { ...env, EPX_UPDATE_RESULT_CAPABILITY: failureCapability, EPX_FIXTURE_FAIL: "1" }, encoding: "utf8", timeout: 30000 });
    expect(existsSync(env.EPX_FIXTURE_STOP_BOUNDARY)).toBe(true);
    expect({ status: failed.status, stdout: failed.stdout, stderr: failed.stderr }).toMatchObject({ status: 1 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "failed", rollbackPerformed: false });
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
    expireFixtureFence(home);
    rmSync(result, { force: true });
    const nextCapability = issueOrchestratedResultCapability(result).capability;
    const updated = spawnSync(node, args, { cwd: root, env: { ...env, EPX_UPDATE_RESULT_CAPABILITY: nextCapability }, encoding: "utf8", timeout: 30000 });
    expect({ status: updated.status, stdout: updated.stdout, stderr: updated.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "installed", activeRoot: pkg });
    expect(JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8")).fenceUntil).toBeUndefined();
    expect(isUpdateInFlight(home)).toBe(false);
    expectSyncAdmission(pkg, root, env, true);
    expect(readFileSync(log, "utf8")).toContain("easyproxy@2.1.0");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.find(call => call.args[0] === "list").outcome.phase).toBe("preflight");
    expect(calls.find(call => call.args[0] === "add")).toMatchObject({ outcome: { phase: "mutating" }, mutex: true });
    expect(calls.some(call => call.args[0] === "view" && call.args.includes("dist.integrity") && call.args.includes("easyproxy@2.1.0"))).toBe(true);
    expect(calls.find(call => call.args[0] === "add").args).toContain("easyproxy@2.1.0");
    expireFixtureFence(home);
    const restored = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); restored.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(restored));
    const parentArgs = [join(pkg, "bin/epx.mjs"), "update", "--yes", "--json"];
    rmSync(env.EPX_FIXTURE_STOP_BOUNDARY);
    const parentEnv = { ...env, EPX_UPDATE_ORCHESTRATED_CHILD: "0" };
    const parent = (extraEnv = {}) => spawnSync(node, parentArgs, { cwd: root, env: { ...parentEnv, ...extraEnv }, encoding: "utf8", timeout: 30000 });
    const logBefore = readFileSync(log, "utf8").split("\n").filter(line => line.includes('"add"')).length;
    const unchanged = parent({ EPX_FIXTURE_FAIL: "1" });
    expect({ status: unchanged.status, stderr: unchanged.stderr }).toMatchObject({ status: 11 });
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ rolledBack: false, applied: false });
    expireFixtureFence(home);
    const parentApplied = parent();
    expect({ status: parentApplied.status, stderr: parentApplied.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(parentApplied.stdout)).toMatchObject({ applied: true, toVersion: "2.1.0" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90000);
