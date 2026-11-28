import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

/**
 * Release workflow macOS signing gate (QA 2026-11-28): Apple secrets all empty ships ad-hoc signed and not notarized,
 * all six present signs and notarizes, a partial set fails a real release. Updater signing stays mandatory.
 * The step scripts are run for real with a stubbed `security`; only the three branches and the gates around them are covered.
 */
interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}
const workflowText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
const workflow = Bun.YAML.parse(workflowText) as { jobs: Record<string, { steps: WorkflowStep[] }> };

function step(job: string, name: string): WorkflowStep {
  const found = workflow.jobs[job]?.steps.find(candidate => candidate.name === name);
  if (!found?.run) throw new Error(`release.yml ${job} has no run step named "${name}"`);
  return found;
}

const APPLE_KEYS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
] as const;
// The import step pipes APPLE_CERTIFICATE through `base64 --decode`; GNU base64 (Linux CI) rejects non-base64 input where macOS accepts it.
const FAKE_P12_BASE64 = Buffer.from("not-a-real-p12").toString("base64");
const FULL_APPLE = Object.fromEntries(APPLE_KEYS.map(key => [key,
  key === "APPLE_TEAM_ID" ? "ABCD123456" : key === "APPLE_CERTIFICATE" ? FAKE_P12_BASE64 : `value-of-${key}`]));

const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** Run a workflow step's script in bash with a no-op `security` on PATH. */
function runStep(job: string, name: string, env: Record<string, string>, cwd?: string) {
  const root = makeTemp("epx-unsigned-gate-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "security"), 0o755);
  const githubEnv = join(root, "github_env");
  writeFileSync(githubEnv, "");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  const res = spawnSync("bash", ["-c", step(job, name).run!], {
    cwd: cwd ?? repoPath(),
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root,
      GITHUB_ENV: githubEnv,
      RUNNER_TEMP: runnerTemp,
      ...env,
    },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, githubEnv: readFileSync(githubEnv, "utf8") };
}

const IMPORT_STEPS = [
  { job: "package-standalone", name: "Import Apple signing certificate", flag: "STANDALONE_SIGNING_CONFIGURED" },
  { job: "package-desktop", name: "Import the release signing certificate", flag: "DESKTOP_SIGNING_CONFIGURED" },
] as const;

describe("macOS Apple credential gate in the release workflow", () => {
  for (const { job, name, flag } of IMPORT_STEPS) {
    describe(`${job}: ${name}`, () => {
      test("no Apple secrets: a real release and a dry run proceed unsigned with a notice", () => {
        for (const dryRun of ["false", "true"]) {
          const res = runStep(job, name, { DRY_RUN: dryRun });
          expect(res.status).toBe(0);
          expect(res.githubEnv).toBe(`${flag}=false\n`);
          expect(res.out).toContain("::notice::Apple signing secrets are not configured");
          expect(res.out).not.toContain("::error::");
        }
      });

      test("all six Apple secrets: signing is configured", () => {
        for (const dryRun of ["false", "true"]) {
          const res = runStep(job, name, { DRY_RUN: dryRun, ...FULL_APPLE });
          expect(res.status).toBe(0);
          expect(res.githubEnv).toContain(`${flag}=true\n`);
          expect(res.githubEnv).not.toContain(`${flag}=false`);
        }
      });

      test("a partial set fails a real release naming only the missing keys, and stays unsigned in a dry run", () => {
        const partial = { ...FULL_APPLE, APPLE_ID: "", APPLE_TEAM_ID: "" };
        const real = runStep(job, name, { DRY_RUN: "false", ...partial });
        expect(real.status).toBe(1);
        expect(real.out).toContain("::error::Apple signing secrets are partially configured");
        expect(real.out).toContain("Missing: APPLE_ID APPLE_TEAM_ID");
        expect(real.out).not.toContain("value-of-");
        expect(real.githubEnv).toBe("");

        for (const key of APPLE_KEYS) {
          const oneMissing = runStep(job, name, { DRY_RUN: "false", ...FULL_APPLE, [key]: "" });
          expect(oneMissing.status).toBe(1);
        }

        const dry = runStep(job, name, { DRY_RUN: "true", ...partial });
        expect(dry.status).toBe(0);
        expect(dry.githubEnv).toBe(`${flag}=false\n`);
        expect(dry.out).not.toContain("::error::");
      });
    });
  }

  test("the standalone sign step keeps the ad-hoc binary when signing is off and fails when the state is undecided", () => {
    const name = "Sign macOS standalone bundle";
    const off = runStep("package-standalone", name, { STANDALONE_SIGNING_CONFIGURED: "false", TARGET: "darwin-arm64" });
    expect(off.status).toBe(0);
    expect(off.out).toContain("ad-hoc signature");
    const undecided = runStep("package-standalone", name, { TARGET: "darwin-arm64" });
    expect(undecided.status).toBe(1);
    expect(undecided.out).toContain("::error::");
    expect(workflowText).not.toContain("Refusing unsigned macOS standalone release");
  });

  test("the desktop extension and addon steps skip when unsigned and keep failing closed once signing is configured", () => {
    const widget = "Verify the extension carries the release signature";
    const unsigned = runStep("package-desktop", widget, { APPLE_TEAM_ID: "", DESKTOP_SIGNING_CONFIGURED: "false" });
    expect(unsigned.status).toBe(0);
    const configuredWithoutTeam = runStep("package-desktop", widget, { APPLE_TEAM_ID: "", DESKTOP_SIGNING_CONFIGURED: "true" });
    expect(configuredWithoutTeam.status).toBe(1);

    const cwd = makeTemp("epx-unsigned-addons-");
    mkdirSync(join(cwd, "desktop", "src-tauri", "resources", "keyring"), { recursive: true });
    writeFileSync(join(cwd, "desktop", "src-tauri", "resources", "keyring", "keyring.darwin-arm64.node"), "x");
    const addons = "Sign the packaged keyring addons and native-bin helpers";
    for (const dryRun of ["false", "true"]) {
      const res = runStep("package-desktop", addons, { DESKTOP_SIGNING_CONFIGURED: "false", DRY_RUN: dryRun }, cwd);
      expect(res.status).toBe(0);
      expect(res.out).toContain("stay as prepared");
    }
    const missingAddon = runStep("package-desktop", addons, { DESKTOP_SIGNING_CONFIGURED: "false" }, makeTemp("epx-no-addons-"));
    expect(missingAddon.status).toBe(1);
  });

  test("every desktop step that reads the signing state fails when the import step left it undecided", () => {
    const cwd = makeTemp("epx-undecided-addons-");
    mkdirSync(join(cwd, "desktop", "src-tauri", "resources", "keyring"), { recursive: true });
    writeFileSync(join(cwd, "desktop", "src-tauri", "resources", "keyring", "keyring.darwin-arm64.node"), "x");
    const steps = [
      "Prepare macOS Tauri entitlements override",
      "Verify the extension carries the release signature",
      "Sign the packaged keyring addons and native-bin helpers",
      "Verify macOS app runtime and Mach-O signatures",
    ];
    for (const name of steps) {
      expect(step("package-desktop", name).run).not.toContain("DESKTOP_SIGNING_CONFIGURED:-false");
      for (const state of [undefined, "", "yes", "TRUE"]) {
        const env: Record<string, string> = { APPLE_TEAM_ID: "ABCD123456", DRY_RUN: "false", DESKTOP_TARGET: "aarch64-apple-darwin" };
        if (state !== undefined) env.DESKTOP_SIGNING_CONFIGURED = state;
        const res = runStep("package-desktop", name, env, cwd);
        expect(res.status).toBe(1);
        expect(res.out).toContain("::error::The macOS desktop signing state was not decided");
      }
    }
    expect(workflowText).not.toContain("DESKTOP_SIGNING_CONFIGURED:-false");
  });

  test("the packaged app verification asserts the team only when signing is configured or a team is set", () => {
    const verifyApp = step("package-desktop", "Verify macOS app runtime and Mach-O signatures").run!;
    expect(verifyApp).toContain('[ -n "${APPLE_TEAM_ID:-}" ] || [ "${DESKTOP_SIGNING_CONFIGURED}" = "true" ]');
    expect(verifyApp).toContain("TeamIdentifier=$APPLE_TEAM_ID");
    expect(workflowText).not.toContain("A real release");
  });
});

describe("protections that stay in force without platform signing", () => {
  test("the upfront credential check runs in every job that builds or publishes", () => {
    for (const job of ["verify", "package-standalone", "package-desktop"]) {
      const upfront = step(job, "Verify signing and updater credentials upfront");
      expect(upfront.run).toContain("bun scripts/ci/verify-release-credentials.ts");
      expect(upfront.env?.TAURI_SIGNING_PRIVATE_KEY).toBe("${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
    }
  });

  test("a real desktop release still requires the updater key and signs updater artifacts with it", () => {
    const assertKey = workflow.jobs["package-desktop"].steps.find(
      candidate => candidate.name === "Assert Tauri updater signing key for releases",
    );
    expect(assertKey?.if).toBe("needs.verify.outputs.dry_run != 'true'");
    expect(assertKey?.run).toContain("TAURI_SIGNING_PRIVATE_KEY is required for non-dry-run desktop releases.");
    const build = step("package-desktop", "Build desktop bundles");
    expect(build.env?.TAURI_SIGNING_PRIVATE_KEY).toBe("${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
    expect(build.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}");
  });

  test("the update trust-root check still runs with --check", () => {
    expect(workflowText).toContain("bun scripts/generate-update-trust-root.ts --check");
  });

  test("the notarization step stays gated on a configured Apple set", () => {
    const notarize = workflow.jobs["package-standalone"].steps.find(
      candidate => candidate.name === "Notarize macOS standalone Mach-Os",
    );
    expect(notarize?.if).toBe("runner.os == 'macOS' && env.STANDALONE_SIGNING_CONFIGURED == 'true'");
  });
});
