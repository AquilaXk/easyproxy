import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StageNativeHelpersOptions {
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly hostTargetValue?: string;
  readonly codesign?: (path: string) => number;
}

export interface StagedNativeHelpersResult {
  readonly epxChildPath?: string;
  readonly epxChildSumsPath?: string;
  readonly remoteWorkspaceHelperPath?: string;
}

function defaultCodesign(path: string): number {
  return Bun.spawnSync(["codesign", "--force", "--sign", "-", path], {
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode ?? 1;
}

/**
 * Stage built native Rust helpers (`epx-child` and `easyproxy-remote-workspace-helper`)
 * alongside a host-targeted standalone `epx` executable under `native-bin/`.
 */
export function stageStandaloneNativeHelpers(
  repoRoot: string,
  output: string,
  target: string,
  options: StageNativeHelpersOptions = {},
): StagedNativeHelpersResult {
  const platform = options.hostPlatform ?? process.platform;
  const architecture = options.hostArch ?? process.arch;
  const isPosix = platform !== "win32";
  const sign = options.codesign ?? defaultCodesign;

  if (isPosix) {
    chmodSync(output, 0o755);
  }

  const hostTargetValue = options.hostTargetValue
    ?? `bun-${platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux"}-${architecture === "arm64" ? "arm64" : "x64"}`;
  if (target !== hostTargetValue) {
    return {};
  }

  const nativeBinDir = join(output, "native-bin");
  let createdNativeBin = false;
  let epxChildPath: string | undefined;
  let epxChildSumsPath: string | undefined;
  let remoteWorkspaceHelperPath: string | undefined;

  const childTriple = target.slice("bun-".length);
  const plainChild = target.startsWith("bun-windows-") ? "epx-child.exe" : "epx-child";
  const childSource = join(repoRoot, "native", "epx-child", "target", "release", plainChild);
  if (existsSync(childSource)) {
    const childOutDir = join(nativeBinDir, childTriple);
    mkdirSync(childOutDir, { recursive: true });
    createdNativeBin = true;

    const stagedChild = join(childOutDir, plainChild);
    copyFileSync(childSource, stagedChild);
    if (isPosix) {
      chmodSync(stagedChild, 0o755);
    }
    if (platform === "darwin") {
      const signCode = sign(stagedChild);
      if (signCode !== 0) {
        throw new Error(`codesign failed for ${stagedChild} (exit ${signCode})`);
      }
    }

    const digest = createHash("sha256").update(readFileSync(stagedChild)).digest("hex");
    const sumsPath = join(childOutDir, "SHA256SUMS");
    writeFileSync(sumsPath, `${digest}  ${plainChild}\n`);
    if (isPosix) {
      chmodSync(sumsPath, 0o644);
      chmodSync(childOutDir, 0o755);
    }
    epxChildPath = stagedChild;
    epxChildSumsPath = sumsPath;
  }

  if (platform === "darwin" || platform === "win32") {
    const helperExe = platform === "win32"
      ? "easyproxy-remote-workspace-helper.exe"
      : "easyproxy-remote-workspace-helper";
    const helperSource = join(repoRoot, "native", "remote-workspace-helper", "target", "release", helperExe);
    if (existsSync(helperSource)) {
      const helperOutDir = join(nativeBinDir, `${platform}-${architecture}`);
      mkdirSync(helperOutDir, { recursive: true });
      createdNativeBin = true;

      const stagedHelper = join(helperOutDir, helperExe);
      copyFileSync(helperSource, stagedHelper);
      if (isPosix) {
        chmodSync(stagedHelper, 0o755);
        chmodSync(helperOutDir, 0o755);
      }
      if (platform === "darwin") {
        const signCode = sign(stagedHelper);
        if (signCode !== 0) {
          throw new Error(`codesign failed for ${stagedHelper} (exit ${signCode})`);
        }
      }
      remoteWorkspaceHelperPath = stagedHelper;
    }
  }

  if (isPosix && createdNativeBin) {
    chmodSync(nativeBinDir, 0o755);
  }

  return { epxChildPath, epxChildSumsPath, remoteWorkspaceHelperPath };
}
