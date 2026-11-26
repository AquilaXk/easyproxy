#!/usr/bin/env bun
/**
 * Post-release end-to-end verification job for release.yml.
 *
 * Confirms the public GitHub release state, releases/latest pointer (when
 * non-prerelease), complete uploaded asset set, and updater manifest payload
 * URLs/signatures after publication completes.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platformFiles, type UpdaterManifest } from "../../desktop/scripts/updater-manifest";
import { expectedReleaseAssets, releaseMatrixTargets } from "../../desktop/scripts/verify-release-assets";
import {
  currentLatestTag,
  runGh,
  runGhJson,
  type GhRunner,
  type GitHubReleaseAssetSummary,
  type GitHubReleaseSummary,
} from "./release-guard";

export interface PostReleaseCheckOptions {
  repo: string;
  version: string;
  tag: string;
  prerelease: boolean;
  requireManifest: boolean;
  workflowPath?: string;
  summaryPath?: string;
  gh?: GhRunner;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function verifyPublishedReleaseAssets(options: {
  assets: readonly GitHubReleaseAssetSummary[];
  expectedNames: readonly string[];
}): string[] {
  const problems: string[] = [];
  const names = options.assets.map(asset => asset.name);
  const nameCounts = new Map<string, number>();
  for (const name of names) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) problems.push(`duplicate release asset: ${name}`);
  }
  for (const expected of options.expectedNames) {
    if (!nameCounts.has(expected)) problems.push(`missing published release asset: ${expected}`);
  }
  const expectedSet = new Set(options.expectedNames);
  for (const name of names) {
    if (!expectedSet.has(name)) problems.push(`unexpected published release asset: ${name}`);
  }
  for (const asset of options.assets) {
    if (asset.state !== "uploaded" || !(asset.size > 0)) {
      problems.push(`incomplete published release asset: ${asset.name} (state=${asset.state}, size=${asset.size})`);
    }
  }
  return problems;
}

export function verifyPublishedManifest(options: {
  manifest: UpdaterManifest;
  repo: string;
  version: string;
  tag: string;
  assets: readonly GitHubReleaseAssetSummary[];
}): string[] {
  const problems: string[] = [];
  if (options.manifest.version !== options.version) {
    problems.push(`latest.json version ${options.manifest.version} != ${options.version}`);
  }
  const assetNames = new Set(options.assets.map(asset => asset.name));
  const expectedPlatforms = Object.keys(platformFiles).sort();
  const actualPlatforms = Object.keys(options.manifest.platforms ?? {}).sort();
  if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
    problems.push(`latest.json platforms (${actualPlatforms.join(", ")}) != expected (${expectedPlatforms.join(", ")})`);
  }
  for (const [platform, suffix] of Object.entries(platformFiles)) {
    const entry = options.manifest.platforms?.[platform];
    if (!entry) continue;
    const expectedFilename = `EasyProxy-${options.version}-${suffix}`;
    const expectedUrl = `https://github.com/${options.repo}/releases/download/${options.tag}/${expectedFilename}`;
    if (entry.url !== expectedUrl) {
      problems.push(`latest.json ${platform} url is ${entry.url}, expected ${expectedUrl}`);
    }
    if (!assetNames.has(expectedFilename)) {
      problems.push(`latest.json ${platform} references missing asset ${expectedFilename}`);
    }
    if (!entry.signature?.trim()) {
      problems.push(`latest.json ${platform} has empty signature`);
    }
  }
  return problems;
}

export async function runPostReleaseCheck(options: PostReleaseCheckOptions): Promise<string[]> {
  const gh = options.gh ?? runGh;
  const sleep = options.sleep ?? defaultSleep;
  const workflowText = readFileSync(
    options.workflowPath ?? join(import.meta.dir, "../../.github/workflows/release.yml"),
    "utf8",
  );
  const { desktopTargets } = releaseMatrixTargets(workflowText);
  const expectedNames = expectedReleaseAssets({
    version: options.version,
    desktopTargets,
    requireSignatures: options.requireManifest,
  });
  if (options.requireManifest) {
    expectedNames.push("latest.json");
  }

  const release = runGhJson<GitHubReleaseSummary>(
    ["api", `repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`],
    gh,
  );
  const problems: string[] = [];
  if (release.draft) {
    problems.push(`Release ${options.tag} is still marked as draft`);
  }
  if (release.prerelease !== options.prerelease) {
    problems.push(`Release ${options.tag} prerelease=${release.prerelease}, expected ${options.prerelease}`);
  }

  if (!options.prerelease) {
    let latestTag: string | null = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      latestTag = currentLatestTag(options.repo, gh);
      if (latestTag === options.tag) break;
      if (attempt < 5) await sleep(3_000);
    }
    if (latestTag !== options.tag) {
      problems.push(`GitHub releases/latest is ${latestTag ?? "none"}, expected ${options.tag}`);
    }
  }

  const assets = release.id
    ? runGhJson<GitHubReleaseAssetSummary[] | GitHubReleaseAssetSummary[][]>(
        ["api", "--paginate", "--slurp", `repos/${options.repo}/releases/${release.id}/assets?per_page=100`],
        gh,
      ).flat()
    : (release.assets ?? []);

  problems.push(...verifyPublishedReleaseAssets({ assets, expectedNames }));

  if (options.requireManifest) {
    const manifestAsset = assets.find(asset => asset.name === "latest.json");
    if (manifestAsset?.id) {
      const raw = gh(["api", `repos/${options.repo}/releases/assets/${manifestAsset.id}`, "-H", "Accept: application/octet-stream"]);
      const manifest = JSON.parse(raw) as UpdaterManifest;
      problems.push(...verifyPublishedManifest({
        manifest,
        repo: options.repo,
        version: options.version,
        tag: options.tag,
        assets,
      }));
    }
  }

  const summary = [
    `## Post-release verification (${options.tag})`,
    "",
    `- Assets checked: ${assets.length} (expected ${expectedNames.length})`,
    `- Prerelease: ${options.prerelease}`,
    `- Updater manifest required: ${options.requireManifest}`,
    `- Findings: ${problems.length}`,
    ...(problems.length > 0 ? ["", ...problems.map(p => `- ERROR: ${p}`)] : []),
    "",
  ].join("\n");
  console.log(summary);
  if (options.summaryPath) {
    appendFileSync(options.summaryPath, `${summary}\n`);
  }
  return problems;
}

function arg(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

if (import.meta.main) {
  const repo = arg("--repo") ?? process.env.GITHUB_REPOSITORY;
  const version = arg("--version") ?? process.env.VERSION;
  const tag = arg("--tag") ?? process.env.TAG;
  const prerelease = (arg("--prerelease") ?? process.env.PRERELEASE) === "true";
  const requireManifest = (arg("--require-manifest") ?? process.env.REQUIRE_MANIFEST) === "true";
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!repo || !version || !tag) {
    throw new Error("Missing required flags/env: --repo, --version, --tag");
  }
  const problems = await runPostReleaseCheck({
    repo,
    version,
    tag,
    prerelease,
    requireManifest,
    ...(summaryPath ? { summaryPath } : {}),
  });
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    process.exitCode = 1;
  }
}
