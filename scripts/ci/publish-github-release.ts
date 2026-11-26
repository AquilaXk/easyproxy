#!/usr/bin/env bun
/**
 * Publish a GitHub Release atomically from the verified release bundle.
 *
 * Stages assets into a hidden draft release (or resumes an existing draft/release),
 * verifies the uploaded assets remotely against the verified local byte sizes
 * and SHA-256 receipt, and clears the draft flag only after the entire asset
 * set is confirmed uploaded on GitHub.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReleaseVerificationReceipt } from "../../desktop/scripts/verify-release-assets";
import {
  isHttp404,
  runGh,
  runGhJson,
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
    } else {
      const recorded = receipt.assets[name];
      if (!recorded && !name.endsWith(".sha256") && !name.endsWith(".sig")) {
        throw new Error(`Release asset missing from verification receipt: ${name}`);
      }
      if (recorded && recorded !== digest) {
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
  return assets;
}

export function verifyRemoteReleaseAssets(
  remote: readonly GitHubReleaseAssetSummary[],
  local: readonly LocalReleaseAsset[],
): void {
  const byName = new Map<string, GitHubReleaseAssetSummary[]>();
  for (const asset of remote) {
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
    if (actual.state !== "uploaded" || actual.size !== expected.size) {
      throw new Error(
        `Remote release asset ${expected.name} failed verification (state=${actual.state}, size=${actual.size}, expected=${expected.size})`,
      );
    }
  }
}

function findReleaseByTag(repo: string, tag: string, gh: GhRunner): GitHubReleaseSummary | null {
  try {
    return runGhJson<GitHubReleaseSummary>(["api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], gh);
  } catch (error) {
    if (isHttp404(error)) {
      const all = runGhJson<GitHubReleaseSummary[] | GitHubReleaseSummary[][]>(
        ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`],
        gh,
      ).flat();
      return all.find(release => release.tag_name === tag) ?? null;
    }
    throw error;
  }
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

  let release = findReleaseByTag(options.repo, options.tag, gh);
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
    release = findReleaseByTag(options.repo, options.tag, gh);
  }

  if (!release?.id) {
    throw new Error(`Unable to locate draft or existing GitHub Release for ${options.tag}`);
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

  const remoteAssets = runGhJson<GitHubReleaseAssetSummary[] | GitHubReleaseAssetSummary[][]>(
    ["api", "--paginate", "--slurp", `repos/${options.repo}/releases/${release.id}/assets?per_page=100`],
    gh,
  ).flat();
  verifyRemoteReleaseAssets(remoteAssets, localAssets);

  gh([
    "release",
    "edit",
    options.tag,
    "--repo",
    options.repo,
    "--draft=false",
    `--prerelease=${options.prerelease ? "true" : "false"}`,
    `--latest=${options.prerelease ? "false" : "true"}`,
    "--notes-file",
    options.notesPath,
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
