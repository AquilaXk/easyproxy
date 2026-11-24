import { lstatSync, readFileSync } from "node:fs";
import {
  MAX_BACKUP_PASSPHRASE_BYTES,
  MAX_PROFILE_BACKUP_BYTES,
  ProfileBackupError,
  exportProfileBackup,
  inspectProfileBackup,
  readProfileBackupFile,
  restoreProfileBackup,
  writeProfileBackupOutputFile,
  type InspectProfileBackupResult,
  type ProfileBackupBundle,
  type ProfileBackupMode,
  type RestoreProfileBackupResult,
} from "../config/profile-backup";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../server/management/body";
import { findLiveProxy } from "../server/proxy-liveness";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  terminalSafeText,
  type RuntimeApiDeps,
} from "./runtime-api";

export const PROFILE_BACKUP_USAGE = `Usage:
  epx config backup export --mode <encrypted|redacted> --out <path> [--passphrase-file <path> | --passphrase-env <var> | --passphrase-stdin] [--json]
  epx config backup inspect <path> [--passphrase-file <path> | --passphrase-env <var> | --passphrase-stdin] [--json]
  epx config backup restore <path> --yes [--passphrase-file <path> | --passphrase-env <var> | --passphrase-stdin] [--json]`;

function readPassphraseOption(args: string[]): string | undefined {
  const inline = takeOption(args, "--passphrase");
  const filePath = takeOption(args, "--passphrase-file");
  const envName = takeOption(args, "--passphrase-env");
  const useStdin = takeFlag(args, "--passphrase-stdin");

  const sources = [inline !== undefined, filePath !== undefined, envName !== undefined, useStdin].filter(Boolean).length;
  if (sources > 1) {
    throw new CliUsageError("specify at most one passphrase source (--passphrase-file, --passphrase-env, --passphrase-stdin, or --passphrase)", PROFILE_BACKUP_USAGE);
  }
  if (inline !== undefined) return inline;
  if (envName !== undefined) {
    const val = process.env[envName];
    if (!val) throw new CliUsageError(`passphrase environment variable "${envName}" is empty or unset`, PROFILE_BACKUP_USAGE);
    return val;
  }
  if (filePath !== undefined) {
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      throw new CliUsageError(`passphrase file not found: ${filePath}`, PROFILE_BACKUP_USAGE);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CliUsageError(`refusing non-regular or symlinked passphrase file: ${filePath}`, PROFILE_BACKUP_USAGE);
    }
    const raw = readBoundedRegularFileSync(filePath, MAX_BACKUP_PASSPHRASE_BYTES + 4).toString("utf8");
    return raw.replace(/\r?\n$/, "");
  }
  if (useStdin) {
    if (process.stdin.isTTY) {
      throw new CliUsageError("--passphrase-stdin cannot be used on an interactive TTY", PROFILE_BACKUP_USAGE);
    }
    const raw = readFileSync(0, "utf8");
    const trimmed = raw.replace(/\r?\n$/, "");
    if (Buffer.byteLength(trimmed, "utf8") > MAX_BACKUP_PASSPHRASE_BYTES) {
      throw new CliUsageError(`passphrase exceeds ${MAX_BACKUP_PASSPHRASE_BYTES} UTF-8 bytes`, PROFILE_BACKUP_USAGE);
    }
    return trimmed;
  }
  const envDefault = process.env.EPX_BACKUP_PASSPHRASE;
  return envDefault && envDefault.length > 0 ? envDefault : undefined;
}

async function shouldUseLiveProxy(deps: RuntimeApiDeps): Promise<boolean> {
  if (deps.baseUrl) return true;
  const live = await (deps.findLiveProxy ?? findLiveProxy)();
  return Boolean(live && live.role !== "client");
}

function tryPrepareLiveBackupRequestBody(rawBuf: Buffer, passphrase?: string): string | null {
  if (rawBuf.byteLength > MANAGEMENT_JSON_BODY_MAX_BYTES) return null;
  let parsedBundle: unknown;
  try {
    parsedBundle = JSON.parse(rawBuf.toString("utf8"));
  } catch {
    return null;
  }
  const bodyText = JSON.stringify({
    bundle: parsedBundle,
    ...(passphrase !== undefined ? { passphrase } : {}),
  });
  return Buffer.byteLength(bodyText, "utf8") <= MANAGEMENT_JSON_BODY_MAX_BYTES ? bodyText : null;
}

export async function runProfileBackupSubcommand(
  rawArgs: string[],
  inheritedJson = false,
  deps: RuntimeApiDeps = {},
): Promise<void> {
  const args = [...rawArgs];
  const wantsJson = takeFlag(args, "--json") || inheritedJson;
  const action = args.shift()?.toLowerCase();
  if (!action) throw new CliUsageError("backup subcommand is required (export, inspect, restore)", PROFILE_BACKUP_USAGE);

  if (action === "export") {
    const modeRaw = takeOption(args, "--mode") ?? "encrypted";
    const outPath = takeOption(args, "--out");
    const passphrase = readPassphraseOption(args);
    rejectArgs(args, PROFILE_BACKUP_USAGE);
    if (modeRaw !== "encrypted" && modeRaw !== "redacted") {
      throw new CliUsageError(`invalid --mode "${modeRaw}"; expected encrypted or redacted`, PROFILE_BACKUP_USAGE);
    }
    if (!outPath) {
      throw new CliUsageError("--out <path> is required for backup export", PROFILE_BACKUP_USAGE);
    }
    const mode: ProfileBackupMode = modeRaw;
    try {
      const bodyText = JSON.stringify({
        mode,
        ...(passphrase !== undefined ? { passphrase } : {}),
      });
      const bundle = Buffer.byteLength(bodyText, "utf8") <= MANAGEMENT_JSON_BODY_MAX_BYTES && (await shouldUseLiveProxy(deps))
        ? await runtimeRequest<ProfileBackupBundle>("/api/profile/backup/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bodyText,
          }, deps)
        : await exportProfileBackup({ mode, passphrase });
      writeProfileBackupOutputFile(outPath, bundle);
      printData(
        { ok: true, schema: bundle.schema, mode: bundle.mode, outPath, summary: bundle.summary },
        wantsJson,
        [`Exported ${mode} profile backup to ${terminalSafeText(outPath)} (${bundle.summary.providerCount} providers).`],
      );
    } catch (error) {
      if (error instanceof ProfileBackupError) throw new CliUsageError(error.message);
      throw error;
    }
    return;
  }

  if (action === "inspect") {
    const filePath = takeOption(args, "--file") ?? args.shift();
    const passphrase = readPassphraseOption(args);
    rejectArgs(args, PROFILE_BACKUP_USAGE);
    if (!filePath) throw new CliUsageError("backup file path is required for inspect", PROFILE_BACKUP_USAGE);
    try {
      const rawBuf = readProfileBackupFile(filePath, MAX_PROFILE_BACKUP_BYTES);
      const liveBody = tryPrepareLiveBackupRequestBody(rawBuf, passphrase);
      const result = liveBody !== null && (await shouldUseLiveProxy(deps))
        ? await runtimeRequest<InspectProfileBackupResult>("/api/profile/backup/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: liveBody,
          }, deps)
        : await inspectProfileBackup(rawBuf, passphrase, MAX_PROFILE_BACKUP_BYTES);
      printData(result, wantsJson, [
        `Backup ${result.schema} (${result.mode}) valid=${result.valid}: ${result.summary.providerCount} providers, files=[${result.summary.includedFiles.join(", ")}]`,
      ]);
    } catch (error) {
      if (error instanceof ProfileBackupError) throw new CliUsageError(error.message);
      throw error;
    }
    return;
  }

  if (action === "restore") {
    const filePath = takeOption(args, "--file") ?? args.shift();
    const yes = takeFlag(args, "--yes");
    const passphrase = readPassphraseOption(args);
    rejectArgs(args, PROFILE_BACKUP_USAGE);
    if (!filePath) throw new CliUsageError("backup file path is required for restore", PROFILE_BACKUP_USAGE);
    if (!yes) throw new CliUsageError("backup restore requires --yes", PROFILE_BACKUP_USAGE);
    await (await import("./link-child")).printLinkChildLocalWriteNotice();
    try {
      const rawBuf = readProfileBackupFile(filePath, MAX_PROFILE_BACKUP_BYTES);
      const liveBody = tryPrepareLiveBackupRequestBody(rawBuf, passphrase);
      const result = liveBody !== null && (await shouldUseLiveProxy(deps))
        ? await runtimeRequest<RestoreProfileBackupResult>("/api/profile/backup/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: liveBody,
          }, deps)
        : await restoreProfileBackup(rawBuf, { passphrase, maxBytes: MAX_PROFILE_BACKUP_BYTES });
      printData(result, wantsJson, [
        `Restored ${result.mode} profile backup (${result.restoredFiles.join(", ")}). Pre-restore snapshot: ${terminalSafeText(result.preRestoreSnapshotPath)}`,
      ]);
    } catch (error) {
      if (error instanceof ProfileBackupError) throw new CliUsageError(error.message);
      throw error;
    }
    return;
  }

  throw new CliUsageError(`unknown config backup action "${action}"`, PROFILE_BACKUP_USAGE);
}

export async function handleProfileBackupCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    await runProfileBackupSubcommand(argv, false, deps);
  });
}
