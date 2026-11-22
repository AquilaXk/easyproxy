import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFullInstallCensus, remoteFullInstallCensusArgv } from "../../src/link/remote-plant";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O1 --require-ephemeral: the census walks every full epx candidate the gated argv would try (the served-runtime
 * census, Desktop, system and PATH) and does not stop at an epx-child, unlike runtime inspection.
 */
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "epx-census-")); });
afterAll(() => { if (dir) removeTreeWithRetry(dir); });

function executable(path: string, body: string): void {
  writeFileSync(path, "#!/bin/sh\n" + body + "\n");
  chmodSync(path, 0o755);
}

function census(home: string, bin: string): { code: number; stdout: string } {
  const argv = remoteFullInstallCensusArgv();
  // Relocate the remote machine's absolute paths, including its appended PATH entries.
  argv[2] = argv[2]!
    .replaceAll("/Applications/EasyProxy.app", "$HOME/system/Applications/EasyProxy.app")
    .replaceAll("/usr/bin/epx", "$HOME/system/usr/bin/epx")
    .replaceAll("/opt/homebrew/bin", "$HOME/system/opt/homebrew/bin")
    .replaceAll("/usr/local/bin", "$HOME/system/usr/local/bin");
  for (const tool of ["uname", "dd", "wc", "awk"]) {
    const systemTool = Bun.which(tool, { PATH: "/usr/bin:/bin" });
    if (!systemTool) throw new Error(`missing POSIX census fixture tool: ${tool}`);
    symlinkSync(systemTool, join(bin, tool));
  }
  const result = Bun.spawnSync(["/bin/sh", ...argv.slice(1)], {
    cwd: home, env: { HOME: home, PATH: bin, EASYPROXY_HOME: join(home, ".easyproxy") }, stdin: "ignore",
  });
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString() };
}

test.skipIf(process.platform === "win32")("a Child with epx-child state and a full epx on PATH reports the full install", () => {
  const home = join(dir, "both"), bin = join(home, "bin");
  mkdirSync(join(home, ".easyproxy", "child"), { recursive: true });
  writeFileSync(join(home, ".easyproxy", "child", "state.json"), "{}");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  executable(join(home, ".local", "bin", "epx-child"), "echo 'easyproxy 2.99.0'");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "epx"), "echo 'easyproxy 2.99.0'");
  const result = census(home, bin);
  expect(result.code).toBe(0);
  expect(parseFullInstallCensus(result.stdout)).toBe("present");
});

test.skipIf(process.platform === "win32")("an epx-child alone, or an epx that cannot run, reports none", () => {
  const home = join(dir, "child-only"), bin = join(home, "bin");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  executable(join(home, ".local", "bin", "epx-child"), "echo 'easyproxy 2.99.0'");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "epx"), "exit 1");
  const result = census(home, bin);
  expect(result.code).toBe(0);
  expect(parseFullInstallCensus(result.stdout)).toBe("none");
});

test("the parser needs the closing marker and reads anything else as unknown", () => {
  expect(parseFullInstallCensus("epx-census:done\n")).toBe("none");
  expect(parseFullInstallCensus("login banner\nepx-census:full\nepx-census:done\n")).toBe("present");
  expect(parseFullInstallCensus("epx-census:full\n")).toBeNull();
  expect(parseFullInstallCensus("")).toBeNull();
});
