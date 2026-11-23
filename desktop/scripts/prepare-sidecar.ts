import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { adHocSignSidecar, shouldAdHocSignSidecar } from "./sidecar-signing";

const targetByTriple: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

const NATIVE_HELPER_EXECUTABLES = new Set(["epx-child", "easyproxy-remote-workspace-helper"]);

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

function hostTriple(): string | undefined {
  const result = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return undefined;
  const host = result.stdout.toString().match(/^host:\s*(\S+)$/m)?.[1];
  return host;
}

function normalizeNativeBinPermissions(dir: string): void {
  if (process.platform === "win32" || !existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      normalizeNativeBinPermissions(full);
    } else if (entry.isFile()) {
      chmodSync(full, NATIVE_HELPER_EXECUTABLES.has(entry.name) ? 0o755 : 0o644);
    }
  }
}

function signPackagedKeyringAddons(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      signPackagedKeyringAddons(full);
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      const signed = adHocSignSidecar(full);
      if (signed !== 0) process.exit(signed);
    }
  }
}

function signPackagedNativeBin(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      signPackagedNativeBin(full);
      continue;
    }
    if (!entry.isFile() || !NATIVE_HELPER_EXECUTABLES.has(entry.name)) continue;
    const signed = adHocSignSidecar(full);
    if (signed !== 0) process.exit(signed);
    if (process.platform !== "win32") chmodSync(full, 0o755);
    if (entry.name === "epx-child") {
      const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
      const sumsPath = join(dir, "SHA256SUMS");
      writeFileSync(sumsPath, `${digest}  ${entry.name}\n`);
      if (process.platform !== "win32") chmodSync(sumsPath, 0o644);
    }
  }
}

const repoRoot = resolve(import.meta.dir, "../..");
const triple =
  argument("--target") ??
  process.env.TARGET ??
  process.env.RUST_TARGET ??
  Bun.env.RUST_TARGET ??
  hostTriple();
if (!triple || !targetByTriple[triple]) {
  throw new Error(
    `Unsupported Rust target ${triple ?? "(host unavailable)"}; pass --target ${Object.keys(targetByTriple).join("|")}`,
  );
}

const target = targetByTriple[triple];
const source = join(repoRoot, "dist", "standalone", target);
const executable = join(source, target.startsWith("bun-windows-") ? "epx.exe" : "epx");
// Preparation must consume this checkout, never a stale executable/addon pair left in dist.
const result = Bun.spawnSync([
  process.execPath,
  "run",
  "build:standalone",
  "--target",
  target,
], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode);

const desktopRoot = resolve(import.meta.dir, "..");
const binaries = join(desktopRoot, "src-tauri", "binaries");
const resources = join(desktopRoot, "src-tauri", "resources", "gui", "dist");
const keyringResources = join(desktopRoot, "src-tauri", "resources", "keyring");
const nativeBinResources = join(desktopRoot, "src-tauri", "resources", "native-bin");
rmSync(keyringResources, { recursive: true, force: true });
rmSync(nativeBinResources, { recursive: true, force: true });
rmSync(resources, { recursive: true, force: true });
mkdirSync(binaries, { recursive: true });
mkdirSync(keyringResources, { recursive: true });
mkdirSync(nativeBinResources, { recursive: true });
mkdirSync(resources, { recursive: true });
const destination = join(binaries, `epx-${triple}${target.startsWith("bun-windows-") ? ".exe" : ""}`);
copyFileSync(executable, destination);
cpSync(join(source, "keyring"), keyringResources, { recursive: true });
const sourceNativeBin = join(source, "native-bin");
if (existsSync(sourceNativeBin)) {
  cpSync(sourceNativeBin, nativeBinResources, { recursive: true });
  normalizeNativeBinPermissions(nativeBinResources);
}
if (shouldAdHocSignSidecar(process.platform, target)) {
  const signed = adHocSignSidecar(destination);
  if (signed !== 0) process.exit(signed);
  signPackagedKeyringAddons(keyringResources);
  signPackagedNativeBin(nativeBinResources);
}
cpSync(join(repoRoot, "gui", "dist"), resources, { recursive: true });
console.log(`Prepared ${destination}`);
