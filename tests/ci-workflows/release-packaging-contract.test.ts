import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import {
  expectedReleaseAssets,
  releaseMatrixTargets,
  STANDALONE_CONVENIENCE_ARCHIVES,
  verifyReleaseAssets,
} from "../../desktop/scripts/verify-release-assets";
import { platformFiles } from "../../desktop/scripts/updater-manifest";
import { bundlesByTarget } from "../../desktop/scripts/collect-release-assets";
import {
  standaloneArchiveName,
  standaloneTargets as sharedStandaloneTargets,
} from "../../scripts/standalone-targets";
import {
  codeSigningFooter,
  readPublishedWindowsDigests,
  readWindowsSigningOutcomes,
  WINDOWS_SIGNING_OUTCOME_SCHEMA,
} from "../../scripts/release-signing-footer";
import {
  HEADLESS_EXIT,
  runHeadlessDesktopUpdate,
  verifyWindowsMsiAuthenticode,
  type HeadlessDeps,
} from "../../src/desktop-update/headless";
import { DESKTOP_UPDATE_FEED_URL, desktopInstallerUrl } from "../../src/desktop-update/trust";
import { DesktopUpdateRefusal } from "../../src/desktop-update/release";

const tempRoots: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createMinisignFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const keyId = Buffer.from("1122334455667788", "hex");
  const pubText = `untrusted comment: minisign fixture key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPub]).toString("base64")}\n`;
  const boxPubKey = Buffer.from(pubText, "utf8").toString("base64");

  const signPayload = (bytes: Uint8Array, fileLabel: string): string => {
    const comment = `timestamp:1700000000\tfile:${fileLabel}`;
    const digest = createHash("blake2b512").update(bytes).digest();
    const sig = sign(null, digest, privateKey);
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment, "utf8")]), privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64");
    const sigText = [
      "untrusted comment: signature from fixture",
      packet,
      `trusted comment: ${comment}`,
      global.toString("base64"),
      "",
    ].join("\n");
    return Buffer.from(sigText, "utf8").toString("base64");
  };

  return { boxPubKey, signPayload };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeCheckedAsset(dir: string, name: string, bytes: Uint8Array): string {
  writeFileSync(join(dir, name), bytes);
  const digest = sha256Hex(bytes);
  writeFileSync(join(dir, `${name}.sha256`), `${digest}  ${name}\n`);
  return digest;
}

function setupMockReleaseBundle(options: {
  version: string;
  requireSignatures: boolean;
  includeConvenience?: boolean;
  omitDebSig?: boolean;
  tamperAppSig?: boolean;
}) {
  const root = createTempDir("epx-release-verify-");
  const releaseDir = join(root, "dist", "release");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  mkdirSync(releaseDir, { recursive: true });

  const workflowText = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
  writeFileSync(join(root, ".github", "workflows", "release.yml"), workflowText);

  const signer = createMinisignFixture();
  writeFileSync(
    join(root, "desktop", "src-tauri", "tauri.conf.json"),
    JSON.stringify({ plugins: { updater: { pubkey: signer.boxPubKey } } }),
  );

  for (const target of sharedStandaloneTargets) {
    const archive = standaloneArchiveName(options.version, target);
    writeCheckedAsset(releaseDir, archive, Buffer.from(`standalone:${target}:${options.version}`));
  }
  if (options.includeConvenience !== false) {
    for (const alias of STANDALONE_CONVENIENCE_ARCHIVES) {
      writeCheckedAsset(releaseDir, alias, Buffer.from(`convenience:${alias}:${options.version}`));
    }
  }

  const updaterSuffixes = new Set(Object.values(platformFiles));
  const { desktopTargets } = releaseMatrixTargets(workflowText);
  for (const target of desktopTargets) {
    for (const bundle of bundlesByTarget[target] ?? []) {
      const filename = `EasyProxy-${options.version}-${bundle.name}`;
      const payload = Buffer.from(`desktop:${target}:${bundle.name}:${options.version}`);
      writeCheckedAsset(releaseDir, filename, payload);
      if (options.requireSignatures && updaterSuffixes.has(bundle.name)) {
        if (options.omitDebSig && bundle.name === "linux-amd64.deb") continue;
        let sig = signer.signPayload(payload, filename);
        if (options.tamperAppSig && bundle.name === "macos-arm64.app.tar.gz") {
          const decoded = Buffer.from(sig, "base64").toString("utf8");
          sig = Buffer.from(
            decoded.replace("\ntrusted comment:", "\ntrusted comment: tampered"),
            "utf8",
          ).toString("base64");
        }
        writeFileSync(join(releaseDir, `${filename}.sig`), `${sig}\n`);
      }
    }
  }

  return { root, releaseDir };
}

describe("release workflow and per-arch macOS packaging contracts", () => {
  test("release.yml splits macOS architectures without lipo and verifies separate artifact sets", () => {
    const workflow = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
    const { standaloneTargets, desktopTargets } = releaseMatrixTargets(workflow);

    expect([...standaloneTargets].sort()).toEqual([...sharedStandaloneTargets].sort());
    expect(desktopTargets).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
    ]);
    expect(desktopTargets).not.toContain("universal-apple-darwin");
    expect(workflow).not.toMatch(/\blipo\b/);
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("ubuntu-24.04-arm");
    expect(workflow).toContain("pattern: standalone-*");
    expect(workflow).toContain("pattern: desktop-*");
    expect(workflow).toContain("--manifest-out dist/release/latest.json --require-signatures");
    expect(workflow).toContain("--release-receipt dist/verify/release-receipt.json");
    expect(workflow).toContain("--windows-signing-outcomes dist/windows-signing-outcomes");

    expect(platformFiles["darwin-aarch64"]).toBe("macos-arm64.app.tar.gz");
    expect(platformFiles["darwin-x86_64"]).toBe("macos-x64.app.tar.gz");
    expect(platformFiles["linux-x86_64"]).toBe("linux-x86_64.AppImage");
    expect(platformFiles["linux-x86_64-deb"]).toBe("linux-amd64.deb");
    expect(platformFiles["windows-x86_64"]).toBe("windows-x64.msi");

    // Review fixes: Windows/Linux helper check, Linux AppImage dir, macOS ad-hoc signingIdentity, SHA256SUMS checks.
    expect(workflow).toContain('test -f "${bundle}/native-bin/win32-x64/easyproxy-remote-workspace-helper.exe"');
    expect(workflow).not.toContain('test -f "${bundle}/native-bin/${triple}/${helper_exe}"');
    expect(workflow).toContain('bash desktop/scripts/verify-linux-sidecar.sh "$appimage_dir"');
    expect(workflow).toContain('{"bundle":{"macOS":{"signingIdentity":"-"}}}');

    const verifyLinux = readFileSync(repoPath("desktop", "scripts", "verify-linux-sidecar.sh"), "utf8");
    expect(verifyLinux).toContain('if [ -f "$target" ]');
    expect(verifyLinux).toContain('elif [ -d "$target" ]');
    expect(verifyLinux).toContain("usr/lib/EasyProxy/native-bin/linux-x64");
    expect(verifyLinux).toContain("sha256sum -c SHA256SUMS");

    const verifyMac = readFileSync(repoPath("desktop", "scripts", "verify-macos-runtime.sh"), "utf8");
    expect(verifyMac).toContain("actual = plistlib.loads(raw) if raw.strip() else {}");
    expect(verifyMac).toContain('shasum", "-a", "256", "-c", "SHA256SUMS"');
    expect(verifyMac).toContain("signingIdentity");
  });

  test("expectedReleaseAssets includes all versioned standalone archives, convenience aliases, and desktop updater signatures", () => {
    const workflow = readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8");
    const { desktopTargets } = releaseMatrixTargets(workflow);
    const assets = expectedReleaseAssets({ version: "2.99.0", desktopTargets, requireSignatures: true });

    for (const alias of STANDALONE_CONVENIENCE_ARCHIVES) {
      expect(assets).toContain(alias);
      expect(assets).toContain(`${alias}.sha256`);
    }
    expect(assets).toContain("EasyProxy-2.99.0-macos-arm64.dmg");
    expect(assets).toContain("EasyProxy-2.99.0-macos-arm64.app.tar.gz.sig");
    expect(assets).toContain("EasyProxy-2.99.0-macos-x64.dmg");
    expect(assets).toContain("EasyProxy-2.99.0-macos-x64.app.tar.gz.sig");
    expect(assets).toContain("EasyProxy-2.99.0-windows-x64.msi.sig");
    expect(assets).toContain("EasyProxy-2.99.0-linux-amd64.deb.sig");
    expect(assets).not.toContain("EasyProxy-2.99.0-macos-arm64.dmg.sig");
    expect(assets).not.toContain("EasyProxy-2.99.0-macos-x64.dmg.sig");
  });

  test("verifyReleaseAssets verifies minisign signatures, emits receipt assets map matching release-signing-footer, and rejects omissions", () => {
    const version = "2.99.0";
    const { root, releaseDir } = setupMockReleaseBundle({ version, requireSignatures: true });
    const manifestOut = join(releaseDir, "latest.json");
    const receiptOut = join(root, "dist", "verify", "release-receipt.json");

    const receipt = verifyReleaseAssets({
      version,
      dir: releaseDir,
      repo: "AquilaXk/easyproxy",
      sha: "0123456789abcdef0123456789abcdef01234567",
      repoRoot: root,
      manifestOut,
      receiptOut,
      requireSignatures: true,
    });

    expect(receipt.manifestPlatforms.sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "linux-x86_64-deb",
      "windows-x86_64",
    ]);
    expect(Object.keys(receipt.assets)).toContain(`epx-${version}-bun-windows-x64.zip`);
    expect(Object.keys(receipt.assets)).toContain(`EasyProxy-${version}-windows-x64.msi`);

    const digests = readPublishedWindowsDigests(receiptOut, version);
    expect(digests.standalone).toBe(receipt.assets[`epx-${version}-bun-windows-x64.zip`]);
    expect(digests.desktop).toBe(receipt.assets[`EasyProxy-${version}-windows-x64.msi`]);

    const outcomesDir = join(root, "outcomes");
    mkdirSync(outcomesDir, { recursive: true });
    writeFileSync(
      join(outcomesDir, "standalone.json"),
      JSON.stringify({ schema: WINDOWS_SIGNING_OUTCOME_SCHEMA, kind: "standalone", signed: true, sha256: digests.standalone, attempt: "1" }),
    );
    writeFileSync(
      join(outcomesDir, "desktop.json"),
      JSON.stringify({ schema: WINDOWS_SIGNING_OUTCOME_SCHEMA, kind: "desktop", signed: true, sha256: digests.desktop, attempt: "1" }),
    );
    const outcome = readWindowsSigningOutcomes(outcomesDir, digests);
    expect(outcome).toEqual({
      status: "signed",
      files: { standalone: "signed", desktop: "signed" },
    });
    expect(codeSigningFooter(outcome)).toContain("Authenticode-signed");

    const missingConvenience = setupMockReleaseBundle({ version, requireSignatures: true, includeConvenience: false });
    expect(() =>
      verifyReleaseAssets({
        version,
        dir: missingConvenience.releaseDir,
        repo: "AquilaXk/easyproxy",
        sha: "0123456789abcdef0123456789abcdef01234567",
        repoRoot: missingConvenience.root,
        requireSignatures: true,
      }),
    ).toThrow("easyproxy-darwin-arm64.tar.gz");

    const missingDebSig = setupMockReleaseBundle({ version, requireSignatures: true, omitDebSig: true });
    expect(() =>
      verifyReleaseAssets({
        version,
        dir: missingDebSig.releaseDir,
        repo: "AquilaXk/easyproxy",
        sha: "0123456789abcdef0123456789abcdef01234567",
        repoRoot: missingDebSig.root,
        requireSignatures: true,
      }),
    ).toThrow("linux-amd64.deb.sig");

    const strayFile = setupMockReleaseBundle({ version, requireSignatures: false });
    writeFileSync(join(strayFile.releaseDir, "standalone.json"), "{}");
    expect(() =>
      verifyReleaseAssets({
        version,
        dir: strayFile.releaseDir,
        repo: "AquilaXk/easyproxy",
        sha: "0123456789abcdef0123456789abcdef01234567",
        repoRoot: strayFile.root,
        requireSignatures: false,
      }),
    ).toThrow("Unexpected files in the release bundle");

    const badSig = setupMockReleaseBundle({ version, requireSignatures: true, tamperAppSig: true });
    expect(() =>
      verifyReleaseAssets({
        version,
        dir: badSig.releaseDir,
        repo: "AquilaXk/easyproxy",
        sha: "0123456789abcdef0123456789abcdef01234567",
        repoRoot: badSig.root,
        requireSignatures: false,
      }),
    ).toThrow("Comment signature verification failed");
  });
});

describe("windows signing plan and script fail-closed contracts", () => {
  function runSigningPlan(envOverrides: Record<string, string | undefined>) {
    const dir = createTempDir("epx-win-plan-");
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GITHUB_OUTPUT: outputFile,
    };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value !== undefined) env[key] = value;
    }
    const res = spawnSync("bash", [repoPath("scripts", "ci", "windows-signing-plan.sh")], {
      cwd: repoPath(),
      env,
      encoding: "utf8",
    });
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      output: readFileSync(outputFile, "utf8"),
    };
  }

  test("fails closed on non-dry-run when SignPath config is missing, malformed, or test-only", () => {
    const missingToken = runSigningPlan({ DRY_RUN: "false", SIGNPATH_CONFIGURED: "false" });
    expect(missingToken.status).not.toBe(0);
    expect(missingToken.stdout).toContain("::error::");

    const unsetDryRun = runSigningPlan({ SIGNPATH_CONFIGURED: "false" });
    expect(unsetDryRun.status).not.toBe(0);

    const missingVars = runSigningPlan({
      DRY_RUN: "false",
      SIGNPATH_CONFIGURED: "true",
      SIGNPATH_ORGANIZATION_ID: "org-1",
    });
    expect(missingVars.status).not.toBe(0);
    expect(missingVars.stdout).toContain("SIGNPATH_PROJECT_SLUG");

    const badOrg = runSigningPlan({
      DRY_RUN: "false",
      SIGNPATH_CONFIGURED: "true",
      SIGNPATH_ORGANIZATION_ID: "org bad!",
      SIGNPATH_PROJECT_SLUG: "easyproxy",
      SIGNPATH_SIGNING_POLICY: "release-signing",
    });
    expect(badOrg.status).not.toBe(0);

    const nonReleasePolicy = runSigningPlan({
      DRY_RUN: "false",
      SIGNPATH_CONFIGURED: "true",
      SIGNPATH_ORGANIZATION_ID: "12345678-1234-1234-1234-1234567890ab",
      SIGNPATH_PROJECT_SLUG: "easyproxy",
      SIGNPATH_SIGNING_POLICY: "test-signing",
    });
    expect(nonReleasePolicy.status).not.toBe(0);
    expect(nonReleasePolicy.stdout).toContain("release-signing");

    const validRelease = runSigningPlan({
      DRY_RUN: "false",
      SIGNPATH_CONFIGURED: "true",
      SIGNPATH_ORGANIZATION_ID: "12345678-1234-1234-1234-1234567890ab",
      SIGNPATH_PROJECT_SLUG: "easyproxy",
      SIGNPATH_SIGNING_POLICY: "release-signing",
    });
    expect(validRelease.status).toBe(0);
    expect(validRelease.output).toBe("mode=sign\npolicy=release-signing\ntrust=release\n");
  });

  test("allows skip or test trust only when DRY_RUN is explicitly true", () => {
    const drySkip = runSigningPlan({ DRY_RUN: "true", SIGNPATH_CONFIGURED: "false" });
    expect(drySkip.status).toBe(0);
    expect(drySkip.output).toBe("mode=skip\npolicy=\ntrust=\n");

    const dryTest = runSigningPlan({
      DRY_RUN: "true",
      SIGNPATH_CONFIGURED: "true",
      SIGNPATH_ORGANIZATION_ID: "org-uuid",
      SIGNPATH_PROJECT_SLUG: "easyproxy",
      SIGNPATH_SIGNING_POLICY: "test-signing",
    });
    expect(dryTest.status).toBe(0);
    expect(dryTest.output).toBe("mode=sign\npolicy=test-signing\ntrust=test\n");
  });

  test("signing fixture and PowerShell verification scripts uphold fail-closed contracts", () => {
    const headFixture = readFileSync(repoPath("tests", "fixtures", "release-signing-head.json"), "utf8");
    expect(headFixture).toContain("APPLE_SIGNING_IDENTITY");
    expect(headFixture).toContain("DESKTOP_SIGNING_CONFIGURED=true");
    expect(headFixture).toContain("DESKTOP_SIGNING_CONFIGURED=false");
    expect(headFixture).toContain("native-bin");
    expect(headFixture).toContain("SHA256SUMS");
    expect(headFixture).toContain('-FailOnError:($env:DRY_RUN -ne \\"true\\")');
    expect(headFixture).toContain('"DRY_RUN": "${{ inputs.dry-run }}"');
    expect(headFixture).toContain('"continue-on-error": "${{ inputs.dry-run == \'true\' }}"');

    const applyPs = readFileSync(repoPath("scripts", "ci", "apply-signed-windows-artifact.ps1"), "utf8");
    expect(applyPs).toContain('if ($FailOnError -or $Trust -eq "release") { throw }');
    expect(applyPs).toContain("finally {");
    expect(applyPs).toContain("Remove-Item -LiteralPath $stage -Recurse -Force");

    const verifyPs = readFileSync(repoPath("scripts", "ci", "verify-authenticode.ps1"), "utf8");
    expect(verifyPs).toContain("[string]$SubjectPattern = $env:WINDOWS_SIGNING_SUBJECT_REGEX");
    expect(verifyPs).toContain("-Include *.exe,*.dll,*.node");
    expect(verifyPs).toContain("Remove-Item -LiteralPath $scratch -Recurse -Force");
  });
});

describe("headless updater Authenticode verification contract", () => {
  test("refuses MSI before moving image aside or invoking msiexec when verifyAuthenticode rejects", async () => {
    const { boxPubKey, signPayload } = createMinisignFixture();
    const version = "2.100.4";
    const msiBytes = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.from("signed-msi-payload")]);
    const events: string[] = [];
    const stagedFiles = new Map<string, Uint8Array>();

    const deps: HeadlessDeps = {
      install: {
        dir: "C:\\Program Files\\EasyProxy",
        epxExe: "C:\\Program Files\\EasyProxy\\epx.exe",
        desktopExe: "C:\\Program Files\\EasyProxy\\easyproxy-desktop.exe",
      },
      currentVersion: "2.99.0",
      fixturePublicKey: boxPubKey,
      fetch: async url => {
        if (url === DESKTOP_UPDATE_FEED_URL) {
          return new TextEncoder().encode(JSON.stringify({
            version,
            platforms: {
              "windows-x86_64": {
                url: desktopInstallerUrl(version),
                signature: signPayload(msiBytes, `EasyProxy_${version}_x64_en-US.msi`),
              },
            },
          }));
        }
        if (url === desktopInstallerUrl(version)) return msiBytes;
        throw new Error(`Unexpected URL: ${url}`);
      },
      staging: {
        create: () => { events.push("create"); return "C:\\Temp\\epx-stage-auth"; },
        write: (p, bytes) => { events.push(`write:${p}`); stagedFiles.set(p, bytes); },
        read: p => Buffer.from(stagedFiles.get(p)!),
        join: (dir, name) => `${dir}\\${name}`,
        discard: (dir) => { events.push(`discard:${dir}`); stagedFiles.clear(); },
      },
      verifyAuthenticode: () => {
        events.push("verify-authenticode");
        throw new DesktopUpdateRefusal("signature_invalid", "MSI is not Authenticode-signed");
      },
      moveAsideOwnImage: () => {
        events.push("move-aside");
        return "C:\\Program Files\\EasyProxy\\epx.exe.old";
      },
      restoreOwnImage: () => {
        events.push("restore");
        return true;
      },
      retireMovedImages: () => {
        events.push("retire");
      },
      msiexecPath: () => "C:\\Windows\\System32\\msiexec.exe",
      spawnInstaller: () => {
        events.push("msiexec");
        return { exited: Promise.resolve(0) };
      },
      timers: { schedule: () => () => {} },
      readInstalledVersion: async () => version,
      runtime: {
        findLive: () => null,
        runtimeImage: () => null,
        requestRestart: async () => false,
        desktopSupervisor: () => null,
        drainRuntime: async () => ({ ok: true }),
        restartService: async () => ({ ok: true }),
        now: () => 0,
        wait: async () => {},
      },
      log: () => {},
    };

    const result = await runHeadlessDesktopUpdate({}, deps);
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("signature_invalid");
    expect(result.exitCode).toBe(HEADLESS_EXIT.unchanged);
    expect(events).toContain("verify-authenticode");
    expect(events).not.toContain("move-aside");
    expect(events).not.toContain("msiexec");
    expect(events.at(-1)).toBe("discard:C:\\Temp\\epx-stage-auth");
  });

  test("verifyWindowsMsiAuthenticode passes path via env and rejects invalid status, missing timestamp, or timeout", async () => {
    const msiPath = "C:\\Users\\qa\\AppData\\Local\\Temp\\EasyProxy; rm -rf.msi";
    let capturedCommand = "";
    let capturedArgs: readonly string[] = [];
    let capturedEnv: Record<string, string | undefined> = {};

    await verifyWindowsMsiAuthenticode(msiPath, {
      powershellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      spawn: async (command, args, env) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedEnv = env;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "Valid",
            hasSigner: true,
            hasTimestamp: true,
            message: "Signature verified.",
          }),
          stderr: "",
        };
      },
    });

    expect(capturedCommand).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(capturedArgs.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(capturedArgs[3]).toContain("$env:EPX_MSI_PATH");
    expect(capturedArgs[3]).not.toContain(msiPath);
    expect(capturedEnv.EPX_MSI_PATH).toBe(msiPath);

    for (const badResult of [
      { exitCode: 0, stdout: JSON.stringify({ status: "NotSigned", hasSigner: false, hasTimestamp: false, message: "not signed" }), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ status: "Valid", hasSigner: true, hasTimestamp: false, message: "missing timestamp" }), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ status: "Valid", hasSigner: false, hasTimestamp: true, message: "missing signer" }), stderr: "" },
      { exitCode: 1, stdout: "", stderr: "access denied" },
      { exitCode: 0, stdout: "not-json", stderr: "" },
      { exitCode: null, stdout: "", stderr: "", timedOut: true },
    ]) {
      await expect(
        verifyWindowsMsiAuthenticode(msiPath, {
          powershellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          spawn: async () => badResult,
        }),
      ).rejects.toThrow(DesktopUpdateRefusal);
    }
  });
});
