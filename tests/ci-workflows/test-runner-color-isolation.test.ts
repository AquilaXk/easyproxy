import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolatedTestEnvironment,
  runTestLane,
  TERMINAL_COLOR_OVERRIDE_ENV,
} from "../../scripts/test";
import { resolveInheritedTestRunLock, TEST_RUN_ID_ENV } from "../../scripts/test-run-lock";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

describe("test runner color isolation", () => {
  test("strips forced-color overrides from isolated sandboxes with OS case semantics", () => {
    const isolated = createIsolatedTestEnvironment({
      PATH: "/test/bin",
      FIXTURE: "keep",
      FORCE_COLOR: "1",
      CLICOLOR_FORCE: "1",
    });
    try {
      for (const name of TERMINAL_COLOR_OVERRIDE_ENV) expect(name in isolated.env).toBe(false);
      expect(isolated.env.FIXTURE).toBe("keep");
      expect(isolated.env.NO_COLOR).toBeUndefined();
    } finally {
      isolated.cleanup();
    }

    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    for (const platform of ["win32", "linux", "darwin"] as const) {
      let scoped: ReturnType<typeof createIsolatedTestEnvironment> | undefined;
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: platform });
        scoped = createIsolatedTestEnvironment({ force_color: "1", CliColor_Force: "1" });
        expect(scoped.env.force_color).toBe(platform === "win32" ? undefined : "1");
        expect(scoped.env.CliColor_Force).toBe(platform === "win32" ? undefined : "1");
      } finally {
        Object.defineProperty(process, "platform", descriptor);
        scoped?.cleanup();
      }
    }
  });

  test("runTestLane suppresses parallel FORCE_COLOR injection and preload scrubs bare runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "epx-color-lane-"));
    const first = join(root, "first.test.ts");
    const second = join(root, "second.test.ts");
    const laneProbe = [
      'import { expect, test } from "bun:test";',
      'test("no forced ansi on child numeric output", () => {',
      '  expect("FORCE_COLOR" in process.env).toBe(false);',
      '  expect("CLICOLOR_FORCE" in process.env).toBe(false);',
      '  const plain = Bun.spawnSync([process.execPath, "-e", "console.log(70000)"], { stdout: "pipe" });',
      '  expect(plain.exitCode).toBe(0);',
      '  expect(new TextDecoder().decode(plain.stdout).trim()).toBe("70000");',
      '});',
    ].join("\n");
    writeFileSync(first, laneProbe);
    writeFileSync(second, laneProbe);
    const oldForce = process.env.FORCE_COLOR;
    const oldCliForce = process.env.CLICOLOR_FORCE;
    process.env.FORCE_COLOR = "1";
    process.env.CLICOLOR_FORCE = "1";
    try {
      const runId = process.env[TEST_RUN_ID_ENV]!;
      const lane = await runTestLane(
        { label: "color isolation fixture", args: ["--parallel=2", first, second], timeoutMs: SPAWN_BUDGET_MS },
        runId,
        resolveInheritedTestRunLock({ wrappedRunId: runId, env: process.env }),
        true,
        { stdout: () => {}, stderr: () => {} },
      );
      expect(lane.exitCode, lane.output).toBe(0);

      // Bare `bun test` (without scripts/test.ts) still removes FORCE_COLOR/CLICOLOR_FORCE in tests/preload.ts.
      const bareProbe = join(root, "bare.test.ts");
      writeFileSync(bareProbe, [
        'import { expect, test } from "bun:test";',
        'test("preload clears FORCE_COLOR for explicit env children", () => {',
        '  expect("FORCE_COLOR" in process.env).toBe(false);',
        '  expect("CLICOLOR_FORCE" in process.env).toBe(false);',
        '  const plain = Bun.spawnSync([process.execPath, "-e", "console.log(70000)"], { env: { ...process.env }, stdout: "pipe" });',
        '  expect(new TextDecoder().decode(plain.stdout).trim()).toBe("70000");',
        '});',
      ].join("\n"));
      const bare = Bun.spawnSync([process.execPath, "test", bareProbe], {
        cwd: repoRoot(),
        env: { ...process.env, EPX_TEST_NO_QUEUE: "1", FORCE_COLOR: "1", CLICOLOR_FORCE: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: SPAWN_BUDGET_MS,
      });
      expect(bare.exitCode, new TextDecoder().decode(bare.stdout) + new TextDecoder().decode(bare.stderr)).toBe(0);
    } finally {
      if (oldForce === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = oldForce;
      if (oldCliForce === undefined) delete process.env.CLICOLOR_FORCE; else process.env.CLICOLOR_FORCE = oldCliForce;
      removeTreeWithRetry(root);
    }
  }, { timeout: SPAWN_BUDGET_MS });
});
