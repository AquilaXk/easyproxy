import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

const ROOT = repoPath(".");

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function packageScripts(dir: string): Set<string> {
  const pkgPath = dir ? `${dir}/package.json` : "package.json";
  const parsed = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
  return new Set(Object.keys(parsed.scripts ?? {}));
}

const PACKAGE_SCRIPTS: Record<string, Set<string>> = {
  "": packageScripts(""),
  gui: packageScripts("gui"),
  desktop: packageScripts("desktop"),
  "docs-site": packageScripts("docs-site"),
};

function workflowAndActionFiles(): string[] {
  const workflows = readdirSync(join(ROOT, ".github/workflows"))
    .filter(name => /\.ya?ml$/.test(name))
    .sort()
    .map(name => `.github/workflows/${name}`);
  const actionsDir = join(ROOT, ".github/actions");
  const actions = existsSync(actionsDir)
    ? readdirSync(actionsDir)
        .sort()
        .map(name => `.github/actions/${name}/action.yml`)
        .filter(path => existsSync(join(ROOT, path)))
    : [];
  return [...workflows, ...actions];
}

const REPO_PATH_RE =
  /(?<![\w./-])((?:scripts|desktop\/scripts|\.github\/(?:workflows|actions)|native\/[\w-]+)\/[\w./-]+\.(?:ts|tsx|mjs|cjs|sh|ps1|py|json|ya?ml|toml|rs))(?![\w/-])/g;

const BUN_RUN_RE =
  /\bbun\s+run\s+(?:--cwd\s+(\S+)\s+)?([\w:.-]+)/g;

const EXTERNAL_USES_RE = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/;
const PINNED_ACTION_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;

export function findMissingPathReferences(
  line: string,
  exists: (relativePath: string) => boolean = relativePath =>
    statSync(join(ROOT, relativePath), { throwIfNoEntry: false }) !== undefined,
): string[] {
  const missing: string[] = [];
  for (const match of line.matchAll(REPO_PATH_RE)) {
    const candidate = match[1]!;
    if (/[$*{}<>]/.test(candidate) || /\/(?:target|dist)\//.test(candidate)) continue;
    if (!exists(candidate)) {
      missing.push(candidate);
    }
  }
  return missing;
}

describe("GitHub workflow and action reference integrity", () => {
  test("every .github workflow and action YAML parses cleanly", () => {
    const files = workflowAndActionFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const parsed = Bun.YAML.parse(readText(file));
      expect(parsed, file).toBeTruthy();
    }
  });

  test("every repository path referenced in workflows exists on disk", () => {
    const missing: string[] = [];
    for (const file of workflowAndActionFiles()) {
      readText(file)
        .split("\n")
        .forEach((line, index) => {
          for (const target of findMissingPathReferences(line)) {
            missing.push(`${file}:${index + 1} ${target}`);
          }
        });
    }
    expect(missing).toEqual([]);
  });

  test("missing workflow path validator catches stale script references", () => {
    expect(
      findMissingPathReferences("run: bun scripts/ci/does-not-exist.ts", () => false),
    ).toEqual(["scripts/ci/does-not-exist.ts"]);
    expect(
      findMissingPathReferences("path: desktop/src-tauri/target/x86_64/release/bundle.deb", () => false),
    ).toEqual([]);
  });

  test("every bun run script referenced in workflows exists in its package.json", () => {
    const missing: string[] = [];
    for (const file of workflowAndActionFiles()) {
      readText(file)
        .split("\n")
        .forEach((line, index) => {
          for (const match of line.matchAll(BUN_RUN_RE)) {
            const cwd = (match[1] ?? "").replace(/^["']|["']$/g, "");
            const script = match[2]!;
            if (script.endsWith(".ts") || script.endsWith(".js") || script.endsWith(".mjs")) continue;
            if (cwd && !(cwd in PACKAGE_SCRIPTS)) continue;
            const known = cwd
              ? PACKAGE_SCRIPTS[cwd]!
              : new Set([...PACKAGE_SCRIPTS[""]!, ...PACKAGE_SCRIPTS.gui!, ...PACKAGE_SCRIPTS.desktop!]);
            if (!known.has(script)) {
              missing.push(`${file}:${index + 1} bun run ${cwd ? `--cwd ${cwd} ` : ""}${script}`);
            }
          }
        });
    }
    expect(missing).toEqual([]);
  });

  test("external actions are pinned to 40-char commit SHAs and never use deprecated actions/cache v4", () => {
    const violations: string[] = [];
    for (const file of workflowAndActionFiles()) {
      readText(file)
        .split("\n")
        .forEach((line, index) => {
          const match = EXTERNAL_USES_RE.exec(line);
          if (!match) return;
          const target = match[1]!;
          if (target.startsWith("./")) return;
          if (!PINNED_ACTION_RE.test(target)) {
            violations.push(`${file}:${index + 1} unpinned action reference: ${target}`);
          }
          if (target.startsWith("actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830")) {
            violations.push(`${file}:${index + 1} legacy Node 20 actions/cache v4 SHA`);
          }
        });
    }
    expect(violations).toEqual([]);
  });
});
