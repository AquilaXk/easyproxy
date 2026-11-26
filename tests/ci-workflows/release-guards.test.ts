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
import { collectReleaseCredentialErrors, validateReleaseCredentials } from "../../scripts/ci/verify-release-credentials";
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

  test("rejects missing keys, malformed team ID, dots in SignPath IDs, or non-release SignPath policy", () => {
    expect(() => validateReleaseCredentials({ ...validEnv, TAURI_SIGNING_PRIVATE_KEY: "" })).toThrow("1 issue");
    expect(() => validateReleaseCredentials({ ...validEnv, APPLE_TEAM_ID: "bad-id" })).toThrow("1 issue");
    expect(collectReleaseCredentialErrors({ ...validEnv, SIGNPATH_ORGANIZATION_ID: "org.name" })).toEqual([
      "SIGNPATH_ORGANIZATION_ID contains invalid characters.",
    ]);
    expect(collectReleaseCredentialErrors({ ...validEnv, SIGNPATH_PROJECT_SLUG: "proj.slug" })).toEqual([
      "SIGNPATH_PROJECT_SLUG contains invalid characters.",
    ]);
    expect(() => validateReleaseCredentials({ ...validEnv, SIGNPATH_ORGANIZATION_ID: "org.name" })).toThrow("1 issue");
    expect(() => validateReleaseCredentials({ ...validEnv, SIGNPATH_PROJECT_SLUG: "proj.slug" })).toThrow("1 issue");
    expect(() => validateReleaseCredentials({ ...validEnv, SIGNPATH_SIGNING_POLICY_SLUG: "test-signing" })).toThrow("1 issue");
  });
});

describe("atomic release publishing and post-release verification", () => {
  test("loadVerifiedLocalBundle enforces receipt digest match, sidecars, latest.json, and non-empty files", () => {
    const dir = createTempDir("epx-pub-local-");
    const bundleDir = join(dir, "bundle");
    const receiptPath = join(dir, "receipt.json");
    const notesPath = join(dir, "notes.md");
    writeFileSync(notesPath, "Release notes\n");
    const payload = Buffer.from("installer-bytes");
    const updaterPayload = Buffer.from("updater-bytes");
    const { mkdirSync } = require("node:fs");
    mkdirSync(bundleDir);
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), payload);
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi.sha256"), `${sha256(payload)}  EasyProxy-0.1.0-windows-x64.msi\n`);
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-linux-amd64.AppImage.tar.gz"), updaterPayload);
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-linux-amd64.AppImage.tar.gz.sig"), "sig-bytes");
    writeFileSync(
      join(bundleDir, "latest.json"),
      JSON.stringify({
        version: "0.1.0",
        notes: "notes",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: { "linux-x86_64": { url: "https://example.invalid/app.tar.gz", signature: "sig-bytes" } },
      }),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        version: "0.1.0",
        repo: "AquilaXk/easyproxy",
        sha: "a".repeat(40),
        expectedFiles: 2,
        checksumsVerified: 1,
        signaturesVerified: 1,
        manifestPlatforms: ["linux-x86_64"],
        assets: {
          "EasyProxy-0.1.0-windows-x64.msi": sha256(payload),
          "EasyProxy-0.1.0-linux-amd64.AppImage.tar.gz": sha256(updaterPayload),
        },
      }),
    );

    const assets = loadVerifiedLocalBundle({
      bundleDir,
      receiptPath,
      version: "0.1.0",
      sourceSha: "a".repeat(40),
    });
    expect(assets).toHaveLength(5);

    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi.sha256"), `${"f".repeat(64)}  EasyProxy-0.1.0-windows-x64.msi\n`);
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.1.0", sourceSha: "a".repeat(40) }),
    ).toThrow("Checksum sidecar");
    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi.sha256"), `${sha256(payload)}  EasyProxy-0.1.0-windows-x64.msi\n`);

    writeFileSync(join(bundleDir, "orphan.app.tar.gz.sig"), "stray");
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.1.0", sourceSha: "a".repeat(40) }),
    ).toThrow("Signature sidecar");
    rmSync(join(bundleDir, "orphan.app.tar.gz.sig"));

    writeFileSync(
      join(bundleDir, "latest.json"),
      JSON.stringify({ version: "9.9.9", platforms: { "linux-x86_64": { url: "u", signature: "s" } } }),
    );
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.1.0", sourceSha: "a".repeat(40) }),
    ).toThrow("latest.json version");

    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), "tampered");
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.1.0", sourceSha: "a".repeat(40) }),
    ).toThrow("changed after verification");

    writeFileSync(join(bundleDir, "EasyProxy-0.1.0-windows-x64.msi"), payload);
    expect(() =>
      loadVerifiedLocalBundle({ bundleDir, receiptPath, version: "0.2.0", sourceSha: "a".repeat(40) }),
    ).toThrow("receipt version");
  });

  test("publishGitHubRelease stages draft, verifies remote uploaded state/digest, cleans stale assets, and guards make_latest", () => {
    const dir = createTempDir("epx-pub-remote-");
    const bundleDir = join(dir, "bundle");
    const receiptPath = join(dir, "receipt.json");
    const notesPath = join(dir, "notes.md");
    const { mkdirSync } = require("node:fs");
    mkdirSync(bundleDir);
    const payload = Buffer.from("verified-msi-payload");
    const payloadDigest = sha256(payload);
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
        assets: { "EasyProxy-0.1.0-windows-x64.msi": payloadDigest },
      }),
    );

    const calls: string[][] = [];
    let draftCreated = false;
    let pollAfterCreate = 0;
    let uploaded = false;
    const mockGh: GhRunner = args => {
      calls.push(args);
      if (args[0] === "api" && args[1]?.includes("/releases/tags/")) {
        if (!draftCreated || pollAfterCreate++ === 0) {
          throw Object.assign(new Error("HTTP 404"), { stderr: "HTTP 404" });
        }
        return JSON.stringify({
          id: 77,
          tag_name: "v0.1.0",
          draft: true,
          prerelease: false,
          target_commitish: "b".repeat(40),
        });
      }
      if (args[0] === "api" && args[1] === "--paginate" && args[3]?.includes("/releases?per_page=100")) {
        if (!draftCreated) return "[]";
        if (pollAfterCreate <= 1) return "[]";
        return JSON.stringify([[{ id: 77, tag_name: "v0.1.0", draft: true, prerelease: false, target_commitish: "b".repeat(40) }]]);
      }
      if (args[0] === "release" && args[1] === "create") {
        expect(args).toContain("--draft");
        draftCreated = true;
        return "";
      }
      if (args[0] === "api" && args[1] === "--paginate" && args[3]?.includes("/releases/77/assets")) {
        if (!uploaded) {
          return JSON.stringify([[{ id: 901, name: "stale-old.msi", state: "uploaded", size: 12 }]]);
        }
        return JSON.stringify([[{
          id: 902,
          name: "EasyProxy-0.1.0-windows-x64.msi",
          state: "uploaded",
          size: payload.length,
          digest: `sha256:${payloadDigest}`,
        }]]);
      }
      if (args[0] === "release" && args[1] === "upload") {
        uploaded = true;
        return "";
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
      sleep: () => {},
    });
    expect(result).toEqual({ releaseId: 77, uploaded: 1 });
    expect(calls.some(c => c[0] === "api" && c[2] === "DELETE" && c[3] === "repos/AquilaXk/easyproxy/releases/assets/901")).toBe(true);
    const patchCall = calls.find(c => c[0] === "api" && c[2] === "PATCH" && c[3] === "repos/AquilaXk/easyproxy/releases/77");
    expect(patchCall).toContain("draft=false");
    expect(patchCall).toContain("make_latest=true");

    // Hotfix older than existing latest stable release must not steal releases/latest
    const hotfixCalls: string[][] = [];
    let hotfixUploaded = false;
    publishGitHubRelease({
      repo: "AquilaXk/easyproxy",
      version: "0.1.0",
      tag: "v0.1.0",
      sourceSha: "b".repeat(40),
      prerelease: false,
      isTagPush: false,
      bundleDir,
      receiptPath,
      notesPath,
      sleep: () => {},
      gh: args => {
        hotfixCalls.push(args);
        if (args[0] === "api" && args[1]?.includes("/releases/tags/")) {
          return JSON.stringify({ id: 88, tag_name: "v0.1.0", draft: true, prerelease: false, target_commitish: "b".repeat(40) });
        }
        if (args[0] === "api" && args[1] === "--paginate" && args[3]?.includes("/releases?per_page=100")) {
          return JSON.stringify([[{ id: 10, tag_name: "v1.0.0", draft: false, prerelease: false }]]);
        }
        if (args[0] === "api" && args[1] === "--paginate" && args[3]?.includes("/releases/88/assets")) {
          return hotfixUploaded
            ? JSON.stringify([[{ id: 801, name: "EasyProxy-0.1.0-windows-x64.msi", state: "uploaded", size: payload.length, digest: `sha256:${payloadDigest}` }]])
            : "[]";
        }
        if (args[0] === "release" && args[1] === "upload") {
          hotfixUploaded = true;
          return "";
        }
        return "";
      },
    });
    const hotfixPatch = hotfixCalls.find(c => c[0] === "api" && c[2] === "PATCH" && c[3] === "repos/AquilaXk/easyproxy/releases/88");
    expect(hotfixPatch).toContain("make_latest=false");

    // Refuse overwriting an already-published non-draft release or wrong-commit draft
    expect(() =>
      publishGitHubRelease({
        repo: "AquilaXk/easyproxy",
        version: "0.1.0",
        tag: "v0.1.0",
        sourceSha: "b".repeat(40),
        prerelease: false,
        isTagPush: false,
        bundleDir,
        receiptPath,
        notesPath,
        sleep: () => {},
        gh: () => JSON.stringify({ id: 99, tag_name: "v0.1.0", draft: false, prerelease: false }),
      }),
    ).toThrow("already published");

    expect(() =>
      publishGitHubRelease({
        repo: "AquilaXk/easyproxy",
        version: "0.1.0",
        tag: "v0.1.0",
        sourceSha: "b".repeat(40),
        prerelease: false,
        isTagPush: false,
        bundleDir,
        receiptPath,
        notesPath,
        sleep: () => {},
        gh: () => JSON.stringify({ id: 99, tag_name: "v0.1.0", draft: true, prerelease: false, target_commitish: "c".repeat(40) }),
      }),
    ).toThrow("targets");

    expect(() =>
      verifyRemoteReleaseAssets(
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", state: "starter", size: 0 }],
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", path: "x", size: payload.length, sha256: payloadDigest }],
      ),
    ).toThrow("failed verification");

    expect(() =>
      verifyRemoteReleaseAssets(
        [
          { name: "EasyProxy-0.1.0-windows-x64.msi", state: "uploaded", size: payload.length, digest: `sha256:${payloadDigest}` },
          { name: "extra-stale.msi", state: "uploaded", size: 10 },
        ],
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", path: "x", size: payload.length, sha256: payloadDigest }],
      ),
    ).toThrow("unexpected asset");

    expect(() =>
      verifyRemoteReleaseAssets(
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", state: "uploaded", size: payload.length, digest: `sha256:${"0".repeat(64)}` }],
        [{ name: "EasyProxy-0.1.0-windows-x64.msi", path: "x", size: payload.length, sha256: payloadDigest }],
      ),
    ).toThrow("digest mismatch");
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
      digest: `sha256:${"a".repeat(64)}`,
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
    expect(
      verifyPublishedReleaseAssets({
        assets: remoteAssets.map((a, i) => (i === 0 ? { ...a, digest: "sha256:bad" } : a)),
        expectedNames: expected,
      }),
    ).toHaveLength(1);
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
      sourceSha: "d".repeat(40),
      prerelease: false,
      requireManifest: true,
      summaryPath,
      sleep: async () => {},
      gh: args => {
        if (args[1] === `repos/AquilaXk/easyproxy/releases/tags/${encodeURIComponent(tag)}`) {
          return JSON.stringify({ id: 55, tag_name: tag, draft: false, prerelease: false, target_commitish: "d".repeat(40) });
        }
        if (args[1] === "--paginate" && args[3]?.includes("/releases?per_page=100")) {
          return JSON.stringify([[{ id: 55, tag_name: tag, draft: false, prerelease: false }]]);
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

    const hotfixTagPushProblems = await runPostReleaseCheck({
      repo: "AquilaXk/easyproxy",
      version,
      tag,
      sourceSha: "d".repeat(40),
      isTagPush: true,
      prerelease: false,
      requireManifest: true,
      sleep: async () => {},
      gh: args => {
        if (args[1] === `repos/AquilaXk/easyproxy/releases/tags/${encodeURIComponent(tag)}`) {
          return JSON.stringify({ id: 55, tag_name: tag, draft: false, prerelease: false, target_commitish: "main" });
        }
        if (args[1] === "--paginate" && args[3]?.includes("/releases?per_page=100")) {
          return JSON.stringify([[
            { id: 54, tag_name: "v0.2.0", draft: false, prerelease: false },
            { id: 55, tag_name: tag, draft: false, prerelease: false },
          ]]);
        }
        if (args[1] === "repos/AquilaXk/easyproxy/releases/latest") {
          return "v0.2.0\n";
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
    expect(hotfixTagPushProblems).toEqual([]);

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
