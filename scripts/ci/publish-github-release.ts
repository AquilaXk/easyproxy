#!/usr/bin/env bun
/**
 * Publish a GitHub Release atomically from the verified release bundle.
 *
 * Stages assets into a hidden draft release (or resumes an existing draft),
 * verifies every local sidecar/manifest and every uploaded remote asset
 * (count, state, byte size, and SHA-256 digest when provided) against the
 * verification receipt, and clears the draft flag via the release ID only
 * after the exact asset set is confirmed on GitHub.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { UpdaterManifest } from "../../desktop/scripts/updater-manifest";
import type { ReleaseVerificationReceipt } from "../../desktop/scripts/verify-release-assets";
import {
  compareSemver,
  isHttp404,
  listReleases,
  runGh,
  runGhJson,
  selectLatestStableRelease,
  STABLE_TAG_RE,
  type GhRunner,
  type GitHubReleaseAssetSummary,
  type GitHubReleaseSummary,
} from "./release-guard";

export interface LocalReleaseAsset {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface PublishReleaseOptions {
  repo: string;
  version: string;
  tag: string;
  sourceSha: string;
  prerelease: boolean;
  isTagPush: boolean;
  bundleDir: string;
  receiptPath: string;
  notesPath: string;
  gh?: GhRunner;
  sleep?: (ms: number) => void;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadVerifiedLocalBundle(options: {
  bundleDir: string;
  receiptPath: string;
  version: string;
  sourceSha: string;
}): LocalReleaseAsset[] {
  const receipt = JSON.parse(readFileSync(options.receiptPath, "utf8")) as ReleaseVerificationReceipt;
  if (receipt.version !== options.version) {
    throw new Error(`Release receipt version ${receipt.version} != ${options.version}`);
  }
  if (receipt.sha !== options.sourceSha) {
    throw new Error(`Release receipt commit ${receipt.sha} != ${options.sourceSha}`);
  }
  const bundleDir = resolve(options.bundleDir);
  const files = readdirSync(bundleDir).sort();
  if (files.length === 0) {
    throw new Error(`Release bundle directory is empty: ${bundleDir}`);
  }

  const assets: LocalReleaseAsset[] = [];
  const manifestPlatformsPresent = receipt.manifestPlatforms.length > 0;
  for (const name of files) {
    const path = join(bundleDir, name);
    const size = statSync(path).size;
    if (size <= 0) {
      throw new Error(`Empty release asset refuses publication: ${name}`);
    }
    const digest = sha256File(path);
    if (name === "latest.json") {
      if (!manifestPlatformsPresent) {
        throw new Error("Unexpected latest.json when release receipt recorded no manifest platforms");
      }
      const manifest = JSON.parse(readFileSync(path, "utf8")) as UpdaterManifest;
      if (manifest.version !== options.version) {
        throw new Error(`latest.json version ${manifest.version} != ${options.version}`);
      }
      const actualPlatforms = Object.keys(manifest.platforms ?? {}).sort();
      const expectedPlatforms = [...receipt.manifestPlatforms].sort();
      if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
        throw new Error(
          `latest.json platforms (${actualPlatforms.join(", ")}) != verified (${expectedPlatforms.join(", ")})`,
        );
      }
    } else if (name.endsWith(".sha256")) {
      const targetName = name.slice(0, -".sha256".length);
      const recordedTarget = receipt.assets[targetName];
      if (!recordedTarget || !files.includes(targetName)) {
        throw new Error(`Checksum sidecar ${name} references unverified or missing asset: ${targetName}`);
      }
      const content = readFileSync(path, "utf8");
      const match = /^([0-9a-f]{64}) [ *](\S+)\r?\n$/.exec(content);
      if (!match || match[2] !== targetName || match[1] !== recordedTarget) {
        throw new Error(`Checksum sidecar ${name} does not match verified digest for ${targetName}`);
      }
    } else if (name.endsWith(".sig")) {
      const targetName = name.slice(0, -".sig".length);
      if (!receipt.assets[targetName] || !files.includes(targetName)) {
        throw new Error(`Signature sidecar ${name} references unverified or missing asset: ${targetName}`);
      }
    } else {
      const recorded = receipt.assets[name];
      if (!recorded) {
        throw new Error(`Release asset missing from verification receipt: ${name}`);
      }
      if (recorded !== digest) {
        throw new Error(`Release asset ${name} changed after verification (${digest} != ${recorded})`);
      }
    }
    assets.push({ name, path, size, sha256: digest });
  }
  for (const recordedName of Object.keys(receipt.assets)) {
    if (!files.includes(recordedName)) {
      throw new Error(`Verified asset missing from release bundle before upload: ${recordedName}`);
    }
  }
  if (manifestPlatformsPresent && !files.includes("latest.json")) {
    throw new Error("Verified latest.json missing from release bundle before upload");
  }
  return assets;
}

export function verifyRemoteReleaseAssets(
  remote: readonly GitHubReleaseAssetSummary[],
  local: readonly LocalReleaseAsset[],
): void {
  const localByName = new Map(local.map(asset => [asset.name, asset]));
  const byName = new Map<string, GitHubReleaseAssetSummary[]>();
  for (const asset of remote) {
    if (!localByName.has(asset.name)) {
      throw new Error(`Remote release contains unexpected asset: ${asset.name}`);
    }
    const list = byName.get(asset.name) ?? [];
    list.push(asset);
    byName.set(asset.name, list);
  }
  for (const expected of local) {
    const matches = byName.get(expected.name) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Remote release must contain exactly 1 uploaded asset for ${expected.name}, found ${matches.length}`,
      );
    }
    const actual = matches[0]!;
    const expectedDigest = `sha256:${expected.sha256}`;
    if (actual.state !== "uploaded" || actual.size !== expected.size) {
      throw new Error(
        `Remote release asset ${expected.name} failed verification (state=${actual.state}, size=${actual.size}, expected=${expected.size})`,
      );
    }
    if (typeof actual.digest === "string" && actual.digest.length > 0 && actual.digest !== expectedDigest) {
      throw new Error(
        `Remote release asset ${expected.name} digest mismatch (remote=${actual.digest}, expected=${expectedDigest})`,
      );
    }
  }
}

function findReleaseByTag(repo: string, tag: string, gh: GhRunner): GitHubReleaseSummary | null {
  try {
    return runGhJson<GitHubReleaseSummary>(["api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], gh);
  } catch (error) {
    if (isHttp404(error)) {
      const all = listReleases(repo, gh);
      return all.find(release => release.tag_name === tag) ?? null;
    }
    throw error;
  }
}

function listReleaseAssets(repo: string, releaseId: number, gh: GhRunner): GitHubReleaseAssetSummary[] {
  return runGhJson<GitHubReleaseAssetSummary[] | GitHubReleaseAssetSummary[][]>(
    ["api", "--paginate", "--slurp", `repos/${repo}/releases/${releaseId}/assets?per_page=100`],
    gh,
  ).flat();
}

export function publishGitHubRelease(options: PublishReleaseOptions): { releaseId: number; uploaded: number } {
  const gh = options.gh ?? runGh;
  if (!existsSync(options.notesPath)) {
    throw new Error(`Missing release notes file: ${options.notesPath}`);
  }
  const localAssets = loadVerifiedLocalBundle({
    bundleDir: options.bundleDir,
    receiptPath: options.receiptPath,
    version: options.version,
    sourceSha: options.sourceSha,
  });
  const localNames = new Set(localAssets.map(asset => asset.name));

  let release = findReleaseByTag(options.repo, options.tag, gh);
  if (release && !release.draft) {
    throw new Error(
      `GitHub Release ${options.tag} (id=${release.id ?? "unknown"}) is already published; refusing in-place mutation`,
    );
  }
  if (release && !options.isTagPush && release.target_commitish && release.target_commitish !== options.sourceSha) {
    throw new Error(
      `Draft release ${options.tag} targets ${release.target_commitish}, expected ${options.sourceSha}`,
    );
  }

  if (!release) {
    const createArgs = [
      "release",
      "create",
      options.tag,
      "--repo",
      options.repo,
      "--draft",
      "--title",
      `EasyProxy ${options.tag}`,
      "--notes-file",
      options.notesPath,
      ...(options.isTagPush ? ["--verify-tag"] : ["--target", options.sourceSha]),
      ...(options.prerelease ? ["--prerelease"] : []),
    ];
    gh(createArgs);
    const sleep = options.sleep ?? Bun.sleepSync;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      release = findReleaseByTag(options.repo, options.tag, gh);
      if (release?.id) break;
      if (attempt < 5) sleep(1_000);
    }
  }

  if (!release?.id) {
    throw new Error(`Unable to locate draft GitHub Release for ${options.tag}`);
  }

  const existingAssets = listReleaseAssets(options.repo, release.id, gh);
  for (const stale of existingAssets) {
    if (!localNames.has(stale.name) || stale.state !== "uploaded") {
      if (!stale.id) {
        throw new Error(`Cannot clean up stale draft asset ${stale.name} without an asset id`);
      }
      gh(["api", "--method", "DELETE", `repos/${options.repo}/releases/assets/${stale.id}`]);
    }
  }

  gh([
    "release",
    "upload",
    options.tag,
    "--repo",
    options.repo,
    "--clobber",
    ...localAssets.map(asset => asset.path),
  ]);

  const remoteAssets = listReleaseAssets(options.repo, release.id, gh);
  verifyRemoteReleaseAssets(remoteAssets, localAssets);

  let makeLatest = !options.prerelease && STABLE_TAG_RE.test(options.tag);
  if (makeLatest) {
    const existingLatest = selectLatestStableRelease(listReleases(options.repo, gh));
    if (existingLatest && compareSemver(options.tag, existingLatest.tag_name) < 0) {
      makeLatest = false;
    }
  }

  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${options.repo}/releases/${release.id}`,
    "-F",
    "draft=false",
    "-F",
    `prerelease=${options.prerelease ? "true" : "false"}`,
    "-f",
    `make_latest=${makeLatest ? "true" : "false"}`,
    "-F",
    `name=EasyProxy ${options.tag}`,
    "-F",
    `body=@${options.notesPath}`,
  ]);

  return { releaseId: release.id, uploaded: localAssets.length };
}

function arg(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

if (import.meta.main) {
  const repo = arg("--repo") ?? process.env.GITHUB_REPOSITORY;
  const version = arg("--version") ?? process.env.VERSION;
  const tag = arg("--tag") ?? process.env.TAG;
  const sourceSha = arg("--sha") ?? process.env.SOURCE_SHA;
  const bundleDir = arg("--dir") ?? "dist/release";
  const receiptPath = arg("--receipt") ?? "dist/verify/release-receipt.json";
  const notesPath = arg("--notes") ?? "dist/release-notes.md";
  const prerelease = (arg("--prerelease") ?? process.env.PRERELEASE) === "true";
  const isTagPush = (arg("--tag-push") ?? process.env.IS_TAG_PUSH) === "true";

  if (!repo || !version || !tag || !sourceSha) {
    throw new Error("Missing required flags/env: --repo, --version, --tag, --sha");
  }

  const result = publishGitHubRelease({
    repo,
    version,
    tag,
    sourceSha,
    prerelease,
    isTagPush,
    bundleDir,
    receiptPath,
    notesPath,
  });
  console.log(`[publish-release] Published ${tag} (release ${result.releaseId}, ${result.uploaded} assets verified).`);
}
