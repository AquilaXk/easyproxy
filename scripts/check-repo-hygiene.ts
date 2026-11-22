#!/usr/bin/env bun
/**
 * Fail-closed repository hygiene and commit attribution guard.
 *
 * Ensures local agent configuration, scratch directories, submodules, retired legacy
 * folders, and AI commit-trailer traces never enter the tracked index or commit history.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const FORBIDDEN_TRACKED_SEGMENTS = new Set([
  ".agents",
  ".gemini",
  ".claude",
  ".codex",
  ".codexclaw",
  ".omo",
  ".worktrees",
  "node_modules",
  ".tmp",
]);

const FORBIDDEN_TRACKED_DIRS = [
  "devlog",
  "go",
  "docs",
  ".github/pr-assets",
  ".github/scripts",
  "assets/pr-screenshots",
  "assets/sponsors",
  "docs-site/public/pr-screenshots",
];

const FORBIDDEN_EXACT_PATHS = new Set([
  "AGENTS.md",
  "GEMINI.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".coderabbit.yaml",
  "SPONSORS.md",
  "MAINTAINERS.md",
  "CREDITS.md",
  "CONTRIBUTING.md",
  ".gitmodules",
]);

const FORBIDDEN_BASENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "AGENTS.md",
  "GEMINI.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "design-debt.md",
  "_handoff.md",
]);

const FORBIDDEN_COMMIT_RE = /Co-Authored-By:|Generated with |noreply@anthropic\.com/i;
const FORBIDDEN_SOURCE_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: "legacy readOcxProviderTableBlock identifier", re: /\breadOcxProviderTableBlock\b/ },
  {
    label: "external PR or author attribution",
    re: /Carried from PR #|Cherry-picked from @|senpi PR #|Ported from PR #|codex-router PR #|\bWibias\b|\byxr1995-maker\b|\bcodingbooo\b/i,
  },
];

function git(args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(res.stderr).trim()}`);
  }
  return new TextDecoder().decode(res.stdout);
}

export function runRepoHygieneCheck(commitRange?: string): string[] {
  const violations: string[] = [];

  if (existsSync(join(REPO_ROOT, ".gitmodules"))) {
    violations.push(".gitmodules must not exist");
  }

  const stageLines = git(["ls-files", "-s"]).split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of stageLines) {
    const [meta, path] = line.split("\t");
    const mode = meta?.split(" ")[0] ?? "";
    const rel = path ?? "";
    if (!rel) continue;

    if (mode === "160000") {
      violations.push(`gitlink (160000) tracked at ${rel}`);
    }
    if (FORBIDDEN_EXACT_PATHS.has(rel)) {
      violations.push(`forbidden root/config file tracked: ${rel}`);
    }
    const segments = rel.split("/");
    const base = segments[segments.length - 1] ?? "";
    if (FORBIDDEN_BASENAMES.has(base)) {
      violations.push(`forbidden filename tracked: ${rel}`);
    }
    if (segments.some(seg => FORBIDDEN_TRACKED_SEGMENTS.has(seg))) {
      violations.push(`forbidden local/agent directory tracked: ${rel}`);
    }
    if (FORBIDDEN_TRACKED_DIRS.some(dir => rel === dir || rel.startsWith(`${dir}/`))) {
      violations.push(`retired directory tracked: ${rel}`);
    }
    if (rel.endsWith(".bun-build")) {
      violations.push(`Bun build cache tracked: ${rel}`);
    }
    if ((rel.startsWith("src/") || rel.startsWith("gui/src/") || rel.startsWith("tests/"))
      && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) {
      const abs = join(REPO_ROOT, rel);
      if (existsSync(abs)) {
        const content = readFileSync(abs, "utf8");
        for (const rule of FORBIDDEN_SOURCE_PATTERNS) {
          if (rule.re.test(content)) {
            violations.push(`${rule.label} found in ${rel}`);
          }
        }
      }
    }
  }

  const range = commitRange ?? "HEAD -n 1";
  const logArgs = commitRange ? ["log", "--format=%H%x09%B%x00", commitRange] : ["log", "-n", "1", "--format=%H%x09%B%x00"];
  try {
    const rawLog = git(logArgs);
    for (const entry of rawLog.split("\0").map(s => s.trim()).filter(Boolean)) {
      const tabIdx = entry.indexOf("\t");
      const sha = tabIdx === -1 ? "HEAD" : entry.slice(0, tabIdx);
      const body = tabIdx === -1 ? entry : entry.slice(tabIdx + 1);
      if (FORBIDDEN_COMMIT_RE.test(body)) {
        violations.push(`commit ${sha.slice(0, 12)} contains forbidden attribution/generator trailer`);
      }
    }
  } catch {
    // Empty/unborn HEAD before initial commit is ignored unless an explicit range was supplied.
    if (commitRange) violations.push(`unable to inspect commit range: ${commitRange}`);
  }

  return violations;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let commitRange: string | undefined;
  const idx = args.indexOf("--commits");
  if (idx !== -1 && args[idx + 1]) {
    commitRange = args[idx + 1];
  }
  const violations = runRepoHygieneCheck(commitRange);
  if (violations.length > 0) {
    console.error("Repository hygiene check failed:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("Repository hygiene check passed.");
}
