import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageStandaloneNativeHelpers } from "../../scripts/standalone-native-helpers";
import { packagedDesktopResourceDir, packagedKeyringCandidates } from "../../src/lib/keyring-native";
import { resolveChildBinarySource } from "../../src/link/child-binary-source";
import { discoverRemoteWorkspaceNativeHelper } from "../../src/remote-control/workspace-command-runner";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `epx-standalone-helpers-${label}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) removeTreeWithRetry(dir);
});

describe("standalone native helper staging and $bunfs resolution", () => {
  test("build-standalone removes .worker-bundles in finally and stages native helpers", () => {
    const script = readFileSync(repoPath("scripts", "build-standalone.ts"), "utf8");
    const finallyStart = script.indexOf("} finally {");
    expect(finallyStart).toBeGreaterThan(-1);
    const finallyBlock = script.slice(finallyStart, script.indexOf("if (compileExitCode !== 0)", finallyStart));
    expect(finallyBlock).toContain("restoreGenPlaceholder()");
    expect(finallyBlock).toContain("rmSync(workerOut, { recursive: true, force: true })");
    expect(script).toContain("stageStandaloneNativeHelpers(repoRoot, output, target)");
  });

  test("stageStandaloneNativeHelpers signs darwin helpers before hashing and enforces safe permissions", () => {
    const root = makeTempDir("stage");
    const repo = join(root, "repo");
    const output = join(root, "out");
    const childSrc = join(repo, "native", "epx-child", "target", "release", "epx-child");
    const helperSrc = join(repo, "native", "remote-workspace-helper", "target", "release", "easyproxy-remote-workspace-helper");
    mkdirSync(join(childSrc, ".."), { recursive: true });
    mkdirSync(join(helperSrc, ".."), { recursive: true });
    mkdirSync(output, { recursive: true, mode: 0o775 });
    writeFileSync(childSrc, "unsigned-child-payload", { mode: 0o775 });
    writeFileSync(helperSrc, "unsigned-helper-payload", { mode: 0o775 });

    const signedOrder: string[] = [];
    const staged = stageStandaloneNativeHelpers(repo, output, "bun-darwin-arm64", {
      hostPlatform: "darwin",
      hostArch: "arm64",
      hostTargetValue: "bun-darwin-arm64",
      codesign: path => {
        signedOrder.push(path);
        writeFileSync(path, readFileSync(path, "utf8") + "-signed");
        return 0;
      },
    });

    expect(staged.epxChildPath).toBe(join(output, "native-bin", "darwin-arm64", "epx-child"));
    expect(staged.epxChildSumsPath).toBe(join(output, "native-bin", "darwin-arm64", "SHA256SUMS"));
    expect(staged.remoteWorkspaceHelperPath).toBe(
      join(output, "native-bin", "darwin-arm64", "easyproxy-remote-workspace-helper"),
    );
    expect(signedOrder).toEqual([staged.epxChildPath!, staged.remoteWorkspaceHelperPath!]);

    const expectedHash = createHash("sha256").update(readFileSync(staged.epxChildPath!)).digest("hex");
    expect(readFileSync(staged.epxChildSumsPath!, "utf8")).toBe(`${expectedHash}  epx-child\n`);

    if (process.platform !== "win32") {
      expect(statSync(output).mode & 0o777).toBe(0o755);
      expect(statSync(join(output, "native-bin")).mode & 0o777).toBe(0o755);
      expect(statSync(join(output, "native-bin", "darwin-arm64")).mode & 0o777).toBe(0o755);
      expect(statSync(staged.epxChildPath!).mode & 0o777).toBe(0o755);
      expect(statSync(staged.epxChildSumsPath!).mode & 0o777).toBe(0o644);
      expect(statSync(staged.remoteWorkspaceHelperPath!).mode & 0o777).toBe(0o755);
    }

    // Resolving through standaloneRootDir finds staged epx-child + SHA256SUMS cleanly
    const resolved = resolveChildBinarySource("darwin-arm64", {
      repoRoot: join(root, "virtual-bunfs-root"),
      execPath: join(root, "symlink-bin", "epx"),
      standaloneRootDir: output,
      allowLocalRelease: false,
      env: {},
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.artifact.source).toBe("sidecar");
      expect(resolved.artifact.sha256).toBe(expectedHash);
    }

    // Tampered staged epx-child fails closed
    writeFileSync(staged.epxChildPath!, "tampered");
    const tampered = resolveChildBinarySource("darwin-arm64", {
      repoRoot: join(root, "virtual-bunfs-root"),
      execPath: join(root, "symlink-bin", "epx"),
      standaloneRootDir: output,
      allowLocalRelease: false,
      env: {},
    });
    expect(tampered).toEqual({ ok: false, reason: "checksum_mismatch" });
  });

  test("stageStandaloneNativeHelpers strips group/world write bits on Linux under umask 0002", () => {
    const root = makeTempDir("linux");
    const repo = join(root, "repo");
    const output = join(root, "out");
    const childSrc = join(repo, "native", "epx-child", "target", "release", "epx-child");
    mkdirSync(join(childSrc, ".."), { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(childSrc, "elf-child", { mode: 0o775 });
    chmodSync(childSrc, 0o775);

    const staged = stageStandaloneNativeHelpers(repo, output, "bun-linux-x64", {
      hostPlatform: "linux",
      hostArch: "x64",
      hostTargetValue: "bun-linux-x64",
    });
    expect(existsSync(staged.epxChildPath!)).toBe(true);
    expect(staged.remoteWorkspaceHelperPath).toBeUndefined();
    if (process.platform !== "win32") {
      expect(statSync(staged.epxChildPath!).mode & 0o022).toBe(0);
      expect(statSync(staged.epxChildSumsPath!).mode & 0o022).toBe(0);
    }
    const resolved = resolveChildBinarySource("linux-x64", {
      hostPlatform: "linux",
      hostArch: "x64",
      repoRoot: join(root, "virtual-bunfs-root"),
      execPath: join(root, "symlink-bin", "epx"),
      standaloneRootDir: output,
      allowLocalRelease: false,
      env: {},
    });
    expect(resolved.ok).toBe(true);
  });

  test("discoverRemoteWorkspaceNativeHelper resolves standaloneRootDir first and fails closed on unsafe files", () => {
    const root = makeTempDir("helper-discovery");
    const stagedDir = join(root, "native-bin", "darwin-arm64");
    mkdirSync(stagedDir, { recursive: true });
    const helperPath = join(stagedDir, "easyproxy-remote-workspace-helper");
    writeFileSync(helperPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    chmodSync(helperPath, 0o755);

    const found = discoverRemoteWorkspaceNativeHelper({
      platform: "darwin",
      architecture: "arm64",
      standaloneRootDir: root,
    });
    expect(found).toBeDefined();
    expect(found?.sha256).toBe(createHash("sha256").update(readFileSync(helperPath)).digest("hex"));

    if (process.platform !== "win32") {
      // Group-writable helper is rejected fail-closed without falling through to repo release build
      chmodSync(helperPath, 0o775);
      expect(discoverRemoteWorkspaceNativeHelper({
        platform: "darwin",
        architecture: "arm64",
        standaloneRootDir: root,
      })).toBeUndefined();

      // Symlinked helper is rejected fail-closed
      const realTarget = join(root, "real-helper");
      writeFileSync(realTarget, "x", { mode: 0o755 });
      const symDir = join(root, "sym-standalone");
      mkdirSync(join(symDir, "native-bin", "darwin-arm64"), { recursive: true });
      symlinkSync(realTarget, join(symDir, "native-bin", "darwin-arm64", "easyproxy-remote-workspace-helper"));
      expect(discoverRemoteWorkspaceNativeHelper({
        platform: "darwin",
        architecture: "arm64",
        standaloneRootDir: symDir,
      })).toBeUndefined();
    }
  });

  test("resolves packaged macOS .app and Linux usr/bin desktop native-bin layouts and rejects unsafe helpers", () => {
    const root = makeTempDir("desktop-native-bin");
    const macAppExec = join(root, "EasyProxy.app", "Contents", "MacOS", "epx");
    const macChildDir = join(root, "EasyProxy.app", "Contents", "Resources", "native-bin", "darwin-arm64");
    mkdirSync(join(macAppExec, ".."), { recursive: true });
    mkdirSync(macChildDir, { recursive: true });
    const macChildPath = join(macChildDir, "epx-child");
    const macChildBytes = Buffer.from("mac-desktop-child", "utf8");
    const macChildDigest = createHash("sha256").update(macChildBytes).digest("hex");
    writeFileSync(macChildPath, macChildBytes, { mode: 0o755 });
    writeFileSync(join(macChildDir, "SHA256SUMS"), `${macChildDigest}  epx-child\n`, { mode: 0o644 });
    const macHelperPath = join(macChildDir, "easyproxy-remote-workspace-helper");
    writeFileSync(macHelperPath, "#!/bin/sh\necho helper\n", { mode: 0o755 });
    if (process.platform !== "win32") {
      chmodSync(macChildPath, 0o755);
      chmodSync(join(macChildDir, "SHA256SUMS"), 0o644);
      chmodSync(macHelperPath, 0o755);
    }

    const macChild = resolveChildBinarySource("darwin-arm64", {
      hostPlatform: "darwin",
      hostArch: "arm64",
      repoRoot: join(root, "absent-repo"),
      execPath: macAppExec,
      allowLocalRelease: false,
      env: {},
    });
    expect(macChild.ok).toBe(true);
    if (macChild.ok) {
      expect(macChild.artifact.source).toBe("sidecar");
      expect(macChild.artifact.sha256).toBe(macChildDigest);
    }

    const macHelper = discoverRemoteWorkspaceNativeHelper({
      platform: "darwin",
      architecture: "arm64",
      execPath: macAppExec,
    });
    expect(macHelper).toBeDefined();
    expect(macHelper?.sha256).toBe(createHash("sha256").update(readFileSync(macHelperPath)).digest("hex"));

    if (process.platform !== "win32") {
      chmodSync(macHelperPath, 0o775);
      expect(discoverRemoteWorkspaceNativeHelper({
        platform: "darwin",
        architecture: "arm64",
        execPath: macAppExec,
      })).toBeUndefined();
      chmodSync(macHelperPath, 0o755);

      chmodSync(macChildPath, 0o775);
      expect(resolveChildBinarySource("darwin-arm64", {
        hostPlatform: "darwin",
        hostArch: "arm64",
        repoRoot: join(root, "absent-repo"),
        execPath: macAppExec,
        allowLocalRelease: false,
        env: {},
      })).toEqual({ ok: false, reason: "checksum_mismatch" });
    }

    const linuxBundleExec = join(root, "appimage", "usr", "bin", "epx");
    const linuxChildDir = join(root, "appimage", "usr", "lib", "EasyProxy", "native-bin", "linux-x64");
    mkdirSync(join(linuxBundleExec, ".."), { recursive: true });
    mkdirSync(linuxChildDir, { recursive: true });
    const linuxChildPath = join(linuxChildDir, "epx-child");
    const linuxChildBytes = Buffer.from("linux-desktop-child", "utf8");
    const linuxChildDigest = createHash("sha256").update(linuxChildBytes).digest("hex");
    writeFileSync(linuxChildPath, linuxChildBytes, { mode: 0o755 });
    writeFileSync(join(linuxChildDir, "SHA256SUMS"), `${linuxChildDigest}  epx-child\n`, { mode: 0o644 });
    if (process.platform !== "win32") {
      chmodSync(linuxChildPath, 0o755);
      chmodSync(join(linuxChildDir, "SHA256SUMS"), 0o644);
    }

    const linuxChild = resolveChildBinarySource("linux-x64", {
      hostPlatform: "linux",
      hostArch: "x64",
      repoRoot: join(root, "absent-repo"),
      execPath: linuxBundleExec,
      allowLocalRelease: false,
      env: {},
    });
    expect(linuxChild.ok).toBe(true);
    if (linuxChild.ok) {
      expect(linuxChild.artifact.source).toBe("sidecar");
      expect(linuxChild.artifact.sha256).toBe(linuxChildDigest);
    }

    const nonUsrExec = join(root, "appimage", "opt", "bin", "epx");
    mkdirSync(join(nonUsrExec, ".."), { recursive: true });
    expect(resolveChildBinarySource("linux-x64", {
      hostPlatform: "linux",
      hostArch: "x64",
      repoRoot: join(root, "absent-repo"),
      execPath: nonUsrExec,
      easyproxyHome: join(root, "empty-home"),
      allowLocalRelease: false,
      env: {},
    })).toEqual({ ok: false, reason: "artifact_not_found" });

    // Standalone macOS directory outside Contents/MacOS must not resolve ../Resources/native-bin or ../Resources/keyring.
    const nonAppMacDir = join(root, "standalone-mac", "bin");
    const nonAppSiblingResources = join(root, "standalone-mac", "Resources", "native-bin", "darwin-arm64");
    const fakeNonAppHelperBytes = Buffer.from("#!/bin/sh\necho non-app-standalone\n", "utf8");
    const fakeNonAppHelperSha = createHash("sha256").update(fakeNonAppHelperBytes).digest("hex");
    mkdirSync(nonAppMacDir, { recursive: true });
    mkdirSync(nonAppSiblingResources, { recursive: true });
    writeFileSync(join(nonAppSiblingResources, "epx-child"), macChildBytes, { mode: 0o755 });
    writeFileSync(join(nonAppSiblingResources, "SHA256SUMS"), `${macChildDigest}  epx-child\n`, { mode: 0o644 });
    writeFileSync(join(nonAppSiblingResources, "easyproxy-remote-workspace-helper"), fakeNonAppHelperBytes, { mode: 0o755 });
    expect(packagedDesktopResourceDir(nonAppMacDir, "darwin")).toBeUndefined();
    expect(packagedKeyringCandidates({ root: nonAppMacDir, platform: "darwin", arch: "arm64" })).toEqual([
      join(nonAppMacDir, "keyring", "keyring.darwin-arm64.node"),
    ]);
    expect(resolveChildBinarySource("darwin-arm64", {
      hostPlatform: "darwin",
      hostArch: "arm64",
      repoRoot: join(root, "absent-repo"),
      execPath: join(nonAppMacDir, "epx"),
      easyproxyHome: join(root, "empty-home"),
      allowLocalRelease: false,
      env: {},
    })).toEqual({ ok: false, reason: "artifact_not_found" });
    const nonAppResolvedHelper = discoverRemoteWorkspaceNativeHelper({
      platform: "darwin",
      architecture: "arm64",
      execPath: join(nonAppMacDir, "epx"),
    });
    expect(nonAppResolvedHelper?.sha256).not.toBe(fakeNonAppHelperSha);
  });
});
