import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

  test("README assets/ targets exist on disk and relative embeds are included in package.json files", () => {
    const pkg = JSON.parse(readText("package.json")) as { files?: string[] };
    const pkgFiles = new Set(pkg.files ?? []);
    const readme = readText("README.md");
    const allAssetRefs = new Set<string>();
    const relativeEmbeds = new Set<string>();
    for (const match of readme.matchAll(/assets\/[\w.-]+\.(?:png|gif|svg|jpe?g|webp)/g)) {
      allAssetRefs.add(match[0]);
    }
    for (const match of readme.matchAll(/(?:src=["']|\]\()(assets\/[\w.-]+\.(?:png|gif|svg|jpe?g|webp))/g)) {
      relativeEmbeds.add(match[1]!);
    }
    expect(relativeEmbeds.size).toBeGreaterThanOrEqual(4);
    for (const rel of allAssetRefs) {
      expect(existsSync(join(ROOT, rel)), `missing ${rel}`).toBe(true);
    }
    for (const rel of relativeEmbeds) {
      expect(pkgFiles.has(rel) || pkgFiles.has("assets"), `unpacked ${rel}`).toBe(true);
    }
  });

  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("Windows-capable release workflow steps with bash syntax declare shell: bash", () => {
    interface WorkflowStep {
      name?: string;
      if?: string;
      shell?: string;
      run?: string;
      env?: Record<string, string>;
    }
    interface WorkflowJob {
      "runs-on"?: string;
      strategy?: { matrix?: { include?: Array<{ os?: string }> } };
      steps?: WorkflowStep[];
    }
    const parsed = Bun.YAML.parse(readText(".github/workflows/release.yml")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const violations: string[] = [];
    for (const [jobId, job] of Object.entries(parsed.jobs ?? {})) {
      const matrixOs = (job.strategy?.matrix?.include ?? []).map(row => row.os);
      const canRunOnWindows = job["runs-on"] === "windows-latest" || matrixOs.includes("windows-latest");
      if (!canRunOnWindows) continue;
      for (const step of job.steps ?? []) {
        if (!step.run) continue;
        const usesBash = step.run.includes("set -euo pipefail") || step.run.includes("[[ ");
        const nonWindowsOnly =
          typeof step.if === "string"
          && (step.if.includes("runner.os == 'macOS'") || step.if.includes("runner.os == 'Linux'"));
        if (usesBash && !nonWindowsOnly && step.shell !== "bash") {
          violations.push(`${jobId}:${step.name ?? "(unnamed)"}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("desktop release bundling unsets empty signing env vars and sets PATCHELF for AppImage", () => {
    interface WorkflowStep {
      name?: string;
      shell?: string;
      run?: string;
      env?: Record<string, string>;
    }
    const parsed = Bun.YAML.parse(readText(".github/workflows/release.yml")) as {
      jobs?: Record<string, { steps?: WorkflowStep[] }>;
    };
    const desktopSteps = parsed.jobs?.["package-desktop"]?.steps ?? [];
    const buildDesktop = desktopSteps.find(step => step.name === "Build desktop bundles");
    expect(buildDesktop?.shell).toBe("bash");
    expect(buildDesktop?.run).toContain('unset "$v"');
    for (const key of ["APPLE_CERTIFICATE", "APPLE_ID", "TAURI_SIGNING_PRIVATE_KEY"]) {
      expect(buildDesktop?.run).toContain(key);
    }

    const appImage = desktopSteps.find(step => step.name === "Build Linux AppImage bundle");
    expect(appImage?.env?.PATCHELF).toBe("${{ github.workspace }}/desktop/scripts/appimage-patchelf.py");
    expect(appImage?.run).toContain('unset "$v"');
    expect(appImage?.run).toContain("TAURI_SIGNING_PRIVATE_KEY");

    const deb = desktopSteps.find(step => step.name === "Build Linux deb bundle");
    expect(deb?.run).toContain('unset "$v"');
    expect(deb?.run).toContain("TAURI_SIGNING_PRIVATE_KEY");
  });

  test.skipIf(process.platform === "win32")("appimage-patchelf preserves prepared epx sidecar bytes under CARGO_TARGET_DIR", () => {
    const work = mkdtempSync(join(tmpdir(), "epx-patchelf-"));
    tempDirs.push(work);
    const fakeRepo = join(work, "repo");
    const scriptDst = join(fakeRepo, "desktop", "scripts", "appimage-patchelf.py");
    const binariesDir = join(fakeRepo, "desktop", "src-tauri", "binaries");
    const preparedEpx = join(binariesDir, "epx-x86_64-unknown-linux-gnu");
    const cargoTargetDir = join(work, "appimage-target");
    const appDirBin = join(
      cargoTargetDir,
      "x86_64-unknown-linux-gnu",
      "release",
      "bundle",
      "appimage",
      "EasyProxy.AppDir",
      "usr",
      "bin",
    );
    const appDirEpx = join(appDirBin, "epx");

    mkdirSync(join(fakeRepo, "desktop", "scripts"), { recursive: true });
    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(appDirBin, { recursive: true });
    copyFileSync(repoPath("desktop", "scripts", "appimage-patchelf.py"), scriptDst);
    chmodSync(scriptDst, 0o755);

    const payload = Buffer.from("\x7fELF-fake-bun-sidecar-and-js-trailer");
    writeFileSync(preparedEpx, payload);
    writeFileSync(appDirEpx, payload);

    const res = spawnSync(
      scriptDst,
      ["--set-rpath", "$ORIGIN/../lib", appDirEpx],
      {
        env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Preserving compiled epx bytes");
    expect(readFileSync(appDirEpx)).toEqual(payload);
  });
});
