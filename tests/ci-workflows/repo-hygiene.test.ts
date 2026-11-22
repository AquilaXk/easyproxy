import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { repositoryGitEnv } from "../helpers/git-fixture";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();

const FORBIDDEN_TRACKED_DIRS = [
  ".codexclaw",
  ".omo",
  ".claude",
  ".agents",
  ".gemini",
  ".codex",
  ".worktrees",
  "node_modules",
  ".tmp",
];

const FORBIDDEN_TRACKED_FILENAMES = [
  ".DS_Store",
  "Thumbs.db",
  "AGENTS.md",
  "GEMINI.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".coderabbit.yaml",
];

const AGENT_SCRATCH_FILENAMES = ["design-debt.md", "_handoff.md"];

const RETIRED_TRACKED_DIRS = [
  "go",
  "devlog",
  "docs",
  ".github/pr-assets",
  ".github/scripts",
  "assets/pr-screenshots",
  "assets/sponsors",
  "docs-site/public/pr-screenshots",
];

const RETIRED_TRACKED_FILES = [
  "SPONSORS.md",
  "MAINTAINERS.md",
  "CREDITS.md",
  "CONTRIBUTING.md",
  "assets/pr-gate-screenshot-required.png",
  "assets/pr2950-capacity-expiry.png",
  "assets/pr715-selection-order.png",
  "assets/request-pacing-dashboard.jpg",
  "assets/zh-tw-providers.png",
];

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot, env: repositoryGitEnv() });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function trackedEntries(): { mode: string; path: string }[] {
  const result = Bun.spawnSync(["git", "ls-files", "-s"], { cwd: repoRoot, env: repositoryGitEnv() });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files -s failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: meta?.split(" ")[0] ?? "", path: path ?? "" };
    });
}

const BUILD_CACHE_SUFFIX = ".bun-build";

describe("repository hygiene", () => {
  test("no local agent or session state is tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      path.split("/").some((segment) => FORBIDDEN_TRACKED_DIRS.includes(segment)),
    );

    expect(offenders).toEqual([]);
  });

  test("no Bun build cache is tracked", () => {
    const offenders = trackedFiles().filter((path) => path.endsWith(BUILD_CACHE_SUFFIX));

    expect(offenders).toEqual([]);
  });

  test("no OS metadata or local agent instruction files are tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      FORBIDDEN_TRACKED_FILENAMES.includes(path.split("/").pop() ?? ""),
    );

    expect(offenders).toEqual([]);
  });

  test("no agent scratch notes are tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      AGENT_SCRATCH_FILENAMES.includes(path.split("/").pop() ?? ""),
    );

    expect(offenders).toEqual([]);
  });

  test("retired directories stay untracked", () => {
    const offenders = trackedFiles().filter((path) =>
      RETIRED_TRACKED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`)),
    );

    expect(offenders).toEqual([]);
  });

  test("retired files stay untracked", () => {
    const tracked = new Set(trackedFiles());
    expect(RETIRED_TRACKED_FILES.filter((path) => tracked.has(path))).toEqual([]);
  });

  test("gitignore still declares the agent-state and retired directories", async () => {
    const ignore = await Bun.file(join(repoRoot, ".gitignore")).text();

    for (const dir of FORBIDDEN_TRACKED_DIRS) {
      expect(ignore).toContain(`${dir}/`);
    }

    for (const dir of RETIRED_TRACKED_DIRS) {
      expect(ignore).toContain(`${dir}/`);
    }

    expect(ignore).toContain(`*${BUILD_CACHE_SUFFIX}`);
  });
});

describe("no submodules or broken package assets", () => {
  test("no gitlink is tracked anywhere", () => {
    const gitlinks = trackedEntries().filter((entry) => entry.mode === "160000");

    expect(gitlinks.map((entry) => entry.path)).toEqual([]);
  });

  test("no .gitmodules file remains", () => {
    expect(existsSync(join(repoRoot, ".gitmodules"))).toBe(false);
  });

  test("no workflow checks out submodules", async () => {
    const listing = Bun.spawnSync(["git", "ls-files", ".github/workflows"], { cwd: repoRoot, env: repositoryGitEnv() });
    const workflows = new TextDecoder()
      .decode(listing.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(workflows.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const workflow of workflows) {
      const text = await Bun.file(join(repoRoot, workflow)).text();
      if (/submodules:\s*(true|recursive)/.test(text)) offenders.push(workflow);
    }

    expect(offenders).toEqual([]);
  });

  test("every relative README asset is actually shipped in the npm tarball", async () => {
    const readme = await Bun.file(join(repoRoot, "README.md")).text();
    const pkg = JSON.parse(await Bun.file(join(repoRoot, "package.json")).text()) as {
      files?: string[];
    };
    const shipped = pkg.files ?? [];
    expect(shipped.length).toBeGreaterThan(0);

    const relative = [...readme.matchAll(/src="(?!https?:)([^"]+)"/g)].map((match) => match[1]!);

    const shippedDirectories = shipped.filter((entry) => {
      const path = join(repoRoot, entry);
      return existsSync(path) && statSync(path).isDirectory();
    });
    const isShipped = (asset: string): boolean =>
      shipped.includes(asset)
      || shippedDirectories.some((directory) => asset.startsWith(`${directory}/`));

    expect(isShipped("assets/banner.png/missing.gif")).toBe(false);
    expect(isShipped("LICENSE/missing.png")).toBe(false);

    const missing = relative.filter((asset) => !isShipped(asset));
    expect(missing).toEqual([]);
  });
});

describe("test layout", () => {
  test("no two test files share a basename", () => {
    const byName = new Map<string, string[]>();
    for (const path of trackedFiles()) {
      if (!path.startsWith("tests/")) continue;
      if (!path.endsWith(".test.ts") && !path.endsWith(".test.tsx")) continue;
      const name = path.split("/").pop()!;
      byName.set(name, [...(byName.get(name) ?? []), path]);
    }
    const duplicates = [...byName.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => `${name}: ${paths.join(", ")}`);
    expect(duplicates).toEqual([]);
  });
});

describe("429 failover contracts stay covered", () => {
  test("every contract test this unit shipped is still tracked", () => {
    const required = [
      "always-on-429-failover.test.ts",
      "anthropic-quorum-cache.test.ts",
      "generic-oauth-failover.test.ts",
      "docs-429-failover-claims.test.ts",
    ];
    const tracked = new Set(
      trackedFiles()
        .filter((path) => path.startsWith("tests/"))
        .map((path) => path.split("/").pop()!),
    );
    const missing = required.filter((name) => !tracked.has(name));
    expect(missing).toEqual([]);
  });
});
