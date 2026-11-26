#!/usr/bin/env bun
/**
 * Guard GitHub's "Latest" release pointer against drifting to a prerelease
 * or older tag when releases are published or edited.
 */
import { appendFileSync } from "node:fs";
import {
  currentLatestTag,
  listReleases,
  runGh,
  selectLatestStableRelease,
  type GhRunner,
} from "./release-guard";

function appendSummary(text: string, summaryPath = process.env.GITHUB_STEP_SUMMARY): void {
  console.log(text);
  if (summaryPath) appendFileSync(summaryPath, `${text}\n`);
}

export function checkLatestPointer(options: {
  repo?: string;
  gh?: GhRunner;
  summaryPath?: string;
} = {}): number {
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required");
  }
  const gh = options.gh ?? runGh;
  const expected = selectLatestStableRelease(listReleases(repo, gh));
  if (!expected) {
    appendSummary("No published stable release (vX.Y.Z) exists yet; nothing to guard.", options.summaryPath);
    return 0;
  }

  const actual = currentLatestTag(repo, gh);
  if (actual === expected.tag_name) {
    appendSummary(`Latest release pointer is ${actual}, matching newest stable release. OK.`, options.summaryPath);
    return 0;
  }

  const detail = [
    "## Latest release guard",
    "",
    `GitHub \`releases/latest\` points to \`${actual ?? "none"}\`, expected \`${expected.tag_name}\`.`,
    `Repair with \`gh release edit ${expected.tag_name} --latest\`.`,
  ].join("\n");
  appendSummary(detail, options.summaryPath);
  console.error(`::error::Latest release drifted: expected ${expected.tag_name}, found ${actual ?? "none"}`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = checkLatestPointer();
}
