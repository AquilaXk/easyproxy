import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import {
  compareSemver,
  currentLatestTag,
  isHttp404,
  parseSemverTag,
  selectLatestStableRelease,
  type GhRunner,
} from "../../scripts/ci/release-guard";
import { checkLatestPointer } from "../../scripts/ci/latest-guard";
import { validateReleaseCredentials } from "../../scripts/ci/verify-release-credentials";
import {
  loadVerifiedLocalBundle,
  publishGitHubRelease,
  verifyRemoteReleaseAssets,
} from "../../scripts/ci/publish-github-release";
import {
  runPostReleaseCheck,
  verifyPublishedManifest,
  verifyPublishedReleaseAssets,
} from "../../scripts/ci/post-release-check";
import { buildReleaseTimingReport, reportCurrentReleaseTiming } from "../../scripts/ci/release-timing-report";
import { expectedReleaseAssets, releaseMatrixTargets } from "../../desktop/scripts/verify-release-assets";
import { platformFiles } from "../../desktop/scripts/updater-manifest";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("release guards and semver selection", () => {
  test("selectLatestStableRelease picks highest non-draft non-prerelease vX.Y.Z release", () => {
    expect(parseSemverTag("v1.2.3")).toEqual([1, 2, 3]);
    expect(() => parseSemverTag("v1.2.3-preview.1")).toThrow("Invalid stable release tag");
    expect(() => parseSemverTag("v01.2.3")).toThrow("Invalid stable release tag");
    expect(compareSemver("v1.10.0", "v1.2.9")).toBeGreaterThan(0);

    const selected = selectLatestStableRelease([
      { tag_name: "v2.0.0-preview.1", draft: false, prerelease: true },
      { tag_name: "v3.0.0", draft: true, prerelease: false },
      { tag_name: "helper-v9", draft: false, prerelease: false },
      { tag_name: "v1.2.0", draft: false, prerelease: false },
      { tag_name: "v1.10.0", draft: false, prerelease: false },
      { tag_name: "v1.9.9", draft: false, prerelease: false },
    ]);
    expect(selected?.tag_name).toBe("v1.10.0");
  });

  test("currentLatestTag returns null only on explicit HTTP 404 and fails closed on 500", () => {
    const err404 = Object.assign(new Error("gh: Not Found (HTTP 404)"), { stderr: "HTTP 404" });
    expect(isHttp404(err404)).toBe(true);
    expect(currentLatestTag("AquilaXk/easyproxy", () => { throw err404; })).toBeNull();

    const err500 = Object.assign(new Error("Internal Server Error (HTTP 500)"), { stderr: "HTTP 500" });
    expect(isHttp404(err500)).toBe(false);
    expect(() => currentLatestTag("AquilaXk/easyproxy", () => { throw err500; })).toThrow("HTTP 500");
  });

  test("checkLatestPointer passes on empty or aligned repo and fails when drifted", () => {
    const summaryPath = join(createTempDir("epx-latest-guard-"), "summary.md");
    expect(checkLatestPointer({
      repo: "AquilaXk/easyproxy",
      summaryPath,
      gh: () => "[]",
    })).toBe(0);

    const okGh: GhRunner = args => {
      if (args.some(arg => arg.includes("/releases?"))) {
        return JSON.stringify([[{ tag_name: "v0.1.0", draft: false, prerelease: false }]]);
      }
      return "v0.1.0\n";
    };
    expect(checkLatestPointer({ repo: "AquilaXk/easyproxy", summaryPath, gh: okGh })).toBe(0);

    const driftGh: GhRunner = args => {
      if (args.some(arg => arg.includes("/releases?"))) {
        return JSON.stringify([[{ tag_name: "v0.2.0", draft: false, prerelease: false }]]);
      }
      return "v0.1.0-preview.1\n";
    };
    expect(checkLatestPointer({ repo: "AquilaXk/easyproxy", summaryPath, gh: driftGh })).toBe(1);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("expected `v0.2.0`");
  });
});

describe("fail-fast release credential validation", () => {
  const validEnv = {
    DRY_RUN: "false",
    APPLE_CERTIFICATE: "base64cert",
    APPLE_CERTIFICATE_PASSWORD: "secret",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (ABCD123456)",
    APPLE_ID: "release@example.test",
    APPLE_PASSWORD: "app-password",
    APPLE_TEAM_ID: "ABCD123456",
    TAURI_SIGNING_PRIVATE_KEY: "minisign-secret-key",
    SIGNPATH_API_TOKEN: "sp-token",
    SIGNPATH_ORGANIZATION_ID: "12345678-1234-1234-1234-1234567890ab",
    SIGNPATH_PROJECT_SLUG: "easyproxy",
    SIGNPATH_SIGNING_POLICY_SLUG: "release-signing",
  };

  test("accepts full release credential set and skips dry runs", () => {
    expect(() => validateReleaseCredentials({ DRY_RUN: "true" })).not.toThrow();
    expect(() => validateReleaseCredentials(validEnv)).not.toThrow();
  });

  test("rejects missing keys, malformed team ID, or non-release SignPath policy", () => {
    expect(() => validateReleaseCredentials({ ...validEnv, TAURI_SIGNING_PRIVATE_KEY: "" })).toThrow("1 issue");
    expect(() => validateReleaseCredentials({ ...validEnv, APPLE_TEAM_ID: "bad-id" })).toThrow("1 issue");
    expect(() => validateReleaseCredentials({ ...validEnv, SIGNPATH_SIGNING_POLICY_SLUG: "test-signing" })).toThrow("1 issue");
  });
});

describe("atomic release publishing and post-release verification", () => {
  test("loadVerifiedLocalBundle enforces receipt digest match and non-empty files", () => {
    const dir = createTempDir("epx-pub-local-");
    const bundleDir = join(dir, "bundle");
    const receiptPath = join(dir, "receipt.json");
    const notesPath = join(dir, "notes.md");
    writeFileSync(notesPath, "Release notes\n");
    const payload = Buffer.from("installer-bytes");
    writeFileSync(join(dir, "unused"), "");

    const { mkdirSync } = require("node:fs");
    mkdirSync(bundleDir);
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), payload);
    writeFileSync(
      receiptPath,
      JSON.stringify({
        version: "0.1.0",
        repo: "AquilaXk/easyproxy",
        sha: "a".repeat(40),
        expectedFiles: 1,
        checksumsVerified: 0,
        signaturesVerified: 0,
        manifestPlatforms: [],
        assets: { "EasyProxy-0.1.0-windows-x64.msi": sha256(payload) },
      }),
    );

    const assets = loadVerifiedLocalBundle({
      bundleDir,
      receiptPath,
      version: "0.1.0",
      sourceSha: "a".repeat(40),
    });
    expect(assets).toHaveLength(1);

    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), "tampered");
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.1.0", sourceSha: "a".repeat(40) }),
    ).toThrow("changed after verification");

    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), payload);
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.2.0", sourceSha: "a".repeat(40) }),
    ).toThrow("receipt version");
  });

  test("publishGitHubRelease stages draft, verifies remote uploaded sizes, and edits to public", () => {
    const dir = createTempDir("epx-pub-remote-");
    const bundleDir = join(dir, "bundle");
    const receiptPath = join(dir, "receipt.json");
    const notesPath = join(dir, "notes.md");
    const { mkdirSync } = require("node:fs");
    mkdirSync(bundleDir);
    const payload = Buffer.from("verified-msi-payload");
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), payload);
    writeFileSync(notesPath, "## Notes\n");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        version: "0.1.0",
        repo: "AquilaXk/easyproxy",
        sha: "b".repeat(40),
        expectedFiles: 1,
        checksumsVerified: 0,
        signaturesVerified: 0,
        manifestPlatforms: [],
        assets: { "EasyProxy-0.1.0-windows-x64.msi": sha256(payload) },
      }),
    );

    const calls: string[][] = [];
    let draftCreated = false;
    const mockGh: GhRunner = args => {
      calls.push(args);
      if (args[0] === "api" && args[1]?.includes("/releases/tags/")) {
        if (!draftCreated) throw Object.assign(new Error("HTTP 404"), { stderr: "HTTP 404" });
        return JSON.stringify({ id: 77, tag_name: "v0.1.0", draft: true, prerelease: false });
      }
      if (args[0] === "api" && args[1] === "--paginate" && args[3]?.includes("/releases?per_page=100")) {
        return draftCreated ? JSON.stringify([[{ id: 77, tag_name: "v0.1.0", draft: true, prerelease: false }]]) : "[]";
      }
      if (args[0] === "release" && args[1] === "create") {
        expect(args).toContain("--draft");
        draftCreated = true;
        return "";
      }
      if (args[0] === "api" && args[3]?.includes("/releases/77/assets")) {
        return JSON.stringify([[{ name: "EasyProxy-0.1.0-windows-x64.msi", state: "uploaded", size: payload.length }]]);
      }
      return "";
    };

    const result = publishGitHubRelease({
      repo: "AquilaXk/easyproxy",
      version: "0.1.0",
      tag: "v0.1.0",
      sourceSha: "b".repeat(40),
      prerelease: false,
      isTagPush: false,
      bundleDir,
      receiptPath,
      notesPath,
      gh: mockGh,
    });
    expect(result).toEqual({ releaseId: 77, uploaded: 1 });
    const editCall = calls.find(call => call[0] === "release" && call[1] === "edit");
    expect(editCall).toContain("--draft=false");
    expect(editCall).toContain("--latest=true");

    expect(() =>
      verifyRemoteReleaseAssets(
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", state: "starter", size: 0 }],
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", path: "x", size: payload.length, sha256: "x" }],
      ),
    ).toThrow("failed verification");
  });

  test("post-release-check validates complete published assets, latest pointer, and updater manifest", async () => {
    const workflowText = readFileSync(repoPath(".github/workflows/release.yml"), "utf8");
    const { desktopTargets } = releaseMatrixTargets(workflowText);
    const version = "0.1.0";
    const tag = "v0.1.0";
    const expected = [...expectedReleaseAssets({ version, desktopTargets, requireSignatures: true }), "latest.json"];
    const remoteAssets = expected.map((name, index) => ({
      id: 100 + index,
      name,
      state: "uploaded",
      size: 1234,
    }));
    const manifest = {
      version,
      notes: "Release notes",
      pub_date: "2026-01-01T00:00:00Z",
      platforms: Object.fromEntries(
        Object.entries(platformFiles).map(([platform, suffix]) => [
          platform,
          {
            url: `https://github.com/AquilaXk/easyproxy/releases/download/${tag}/EasyProxy-${version}-${suffix}`,
            signature: "signed-box",
          },
        ]),
      ),
    };

    expect(verifyPublishedReleaseAssets({ assets: remoteAssets, expectedNames: expected })).toEqual([]);
    expect(verifyPublishedManifest({
      manifest,
      repo: "AquilaXk/easyproxy",
      version,
      tag,
      assets: remoteAssets,
    })).toEqual([]);

    const summaryPath = join(createTempDir("epx-post-check-"), "summary.md");
    const okProblems = await runPostReleaseCheck({
      repo: "AquilaXk/easyproxy",
      version,
      tag,
      prerelease: false,
      requireManifest: true,
      summaryPath,
      sleep: async () => {},
      gh: args => {
        if (args[1] === `repos/AquilaXk/easyproxy/releases/tags/${encodeURIComponent(tag)}`) {
          return JSON.stringify({ id: 55, tag_name: tag, draft: false, prerelease: false });
        }
        if (args[1] === "repos/AquilaXk/easyproxy/releases/latest") {
          return `${tag}\n`;
        }
        if (args[3]?.includes("/releases/55/assets")) {
          return JSON.stringify([remoteAssets]);
        }
        if (args[1]?.includes("/releases/assets/")) {
          return JSON.stringify(manifest);
        }
        throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
      },
    });
    expect(okProblems).toEqual([]);

    const brokenManifestProblems = verifyPublishedManifest({
      manifest: {
        version: "0.0.9",
        notes: "",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: {
          ...manifest.platforms,
          "windows-x86_64": { url: "https://evil.example.test/malware.msi", signature: "" },
        },
      },
      repo: "AquilaXk/easyproxy",
      version,
      tag,
      assets: remoteAssets,
    });
    expect(brokenManifestProblems.length).toBeGreaterThanOrEqual(3);
  });

  test("release timing report identifies material regressions without alerting on short steps", () => {
    const baseline = {
      jobs: [{
        name: "desktop | linux",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:02:00Z",
        steps: [
          { name: "Build Linux AppImage bundle", started_at: "2026-01-01T00:00:10Z", completed_at: "2026-01-01T00:01:10Z" },
          { name: "Fast check", started_at: "2026-01-01T00:01:10Z", completed_at: "2026-01-01T00:01:15Z" },
        ],
      }],
    };
    const current = {
      jobs: [{
        name: "desktop | linux",
        started_at: "2026-01-02T00:00:00Z",
        completed_at: "2026-01-02T00:03:00Z",
        steps: [
          { name: "Build Linux AppImage bundle", started_at: "2026-01-02T00:00:10Z", completed_at: "2026-01-02T00:01:40Z" },
          { name: "Fast check", started_at: "2026-01-02T00:01:40Z", completed_at: "2026-01-02T00:01:50Z" },
        ],
      }],
    };

    const report = buildReleaseTimingReport(current, baseline);
    expect(report.currentWorkflowSeconds).toBe(180);
    expect(report.baselineWorkflowSeconds).toBe(120);
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0]?.key).toBe("desktop | linux / Build Linux AppImage bundle");
    expect(report.regressions[0]?.percent).toBe(50);
    expect(report.markdown).toContain("desktop \\| linux / Build Linux AppImage bundle");

    const summaryPath = join(createTempDir("epx-timing-"), "summary.md");
    reportCurrentReleaseTiming({
      repo: "AquilaXk/easyproxy",
      runId: "200",
      workflow: "release.yml",
      summaryPath,
      gh: args => {
        if (args.some(a => a.includes("/runs/200/jobs"))) return JSON.stringify([current]);
        if (args.some(a => a.includes("/workflows/release.yml/runs"))) {
          return JSON.stringify({ workflow_runs: [{ id: 100 }] });
        }
        if (args.some(a => a.includes("/runs/100/jobs"))) return JSON.stringify([baseline]);
        throw new Error(`Unexpected gh invocation: ${args.join(" ")}`);
      },
    });
    expect(readFileSync(summaryPath, "utf8")).toContain("Step regressions (>10% and >=15s): 1");
  });
});
