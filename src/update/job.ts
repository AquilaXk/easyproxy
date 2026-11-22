import { guardedRun, guardedSpawnSync, materializeMutationData } from "./mutation-guard.mjs";
import type { ChildProcess } from "node:child_process";
import { probeSpawn, probeSpawnSync } from "./mutation-guard.mjs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, getConfigDir, loadConfig } from "../config";
import { readPid, readRuntimePort, verifyPidIdentity } from "../config/process-state";
import { isProcessAlive } from "../lib/process-control";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { buildWindowsElevatedArgumentList,
  resolveTrustedWindowsPowerShellExe,
} from "../lib/windows-elevation";
import { listListenPids, scanListenPids, type ListenPidScan } from "../server/port-reclaim";
import { guardedReclaimListenPort as reclaimListenPort } from "./guarded-port-reclaim";
import { guardedKillProxy, guardedRemovePid, guardedRemoveRuntimePort, guardedDropWindowsTcp, guardedPublishJob, type KillProxy } from "./guarded-runtime-ops";
import {
  isHealthzVersion,
  isEasyproxyHealthz,
  probeHostname,
  proxyIdentityAt,
  type HealthzIdentity,
} from "../server/proxy-liveness";
import { isServiceInstalled, isServiceViable } from "../service";
import { stopWindowsServiceForRestart, WINDOWS_SERVICE_STOP_ABORT } from "./job-windows-restart";
import { createUpdateServiceHomePolicy, inspectUpdateServiceHome, type UpdateServiceHomeInspector } from "./service-home-authority";
import { runUpdateRestartWithOwnershipLease, type ServiceOwnershipResolution } from "./restart-ownership";
import { restartServiceManagerAfterUpdate, unsettledManagerRestartFailure, unsupervisedRestartFailure, type ManagerRestartFn } from "./job-supervised-restart";
import {
  type Channel, type Installer,
  PKG, STANDALONE_UPDATE_HINT,
  checkUpdatePackageIntegrity,
  currentVersion,
  defaultUpdateTag,
  detectInstall,
  detectInstallOwnership,
  latestVersion,
  miseUpdateCommand,
  updateCommand,
  updateCommandStr,
  resolveCurrentPnpmGlobalOwner,
  resolvePnpmActiveLauncher,
} from "./index";
import type { UpdateCheckDeps } from "./check-types";
import { managedReleaseDirectory } from "./managed-release";
export type { UpdateCheckDeps } from "./check-types";
import type { PnpmGlobalOwner } from "./pnpm-global-install.mjs";
import { isNewer } from "./notify";
import { isRealBunBinary } from "../lib/bun-binary-validator.mjs";
import { planWindowsTrayUpdate } from "./tray-update-plan.mjs";
import { GUI_UPDATE_FAILURE_NEXT_STEP } from "./update-failure-guidance.mjs";
import {
  npmCachePreflightFailureMessage,
  runNpmCachePreflight,
  type NpmCachePreflightReason,
} from "./npm-cache-preflight.mjs";
import { guiUpdateWorkerCommand } from "./worker-launch";
import { prepareWorkerUpdateHome, packageOnlyUpdateSucceeded } from "./job-update-home";
import { defaultWorkerTrayHandoff } from "./job-update-tray";
import { spawnWorkerPinnedStart } from "./job-pinned-start";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";
import { spawnBindProbe, strictBindProbeScript } from "./bind-probe";
import { withoutUpdateTeardownHandover, withUpdateTeardownHandover } from "./teardown-handover";
import type { WorkerLaunchContext } from "./worker-launch";

import { RELEASE_NOTES_URL, sanitizePersistedUpdateJob, summarizeCommandOutput, withheldSummary } from "./job-output-sanitize";
export { summarizeCommandOutput } from "./job-output-sanitize";
import { awaitRestartedProxyHealthy, confirmPackageManagerExplicitRestart, confirmRestartedProxy, formatPortHolders, packageManagerSelfUpdateRestartEvidence, SERVICE_RECOVERY_HEALTH_MS } from "./job-restart-verify";
export { npmSelfUpdateRestartEvidence, packageManagerSelfUpdateRestartEvidence, SERVICE_RECOVERY_HEALTH_MS } from "./job-restart-verify";
import type { GuiUpdateWorkerIo, RestartIo, RestartProxyIdentity, StartUpdateJobDeps, UpdateCheckResult, UpdateJobState, UpdateJobStatus, UpdateWorkerProcess } from "./job-types";
export type { GuiUpdateWorkerIo, RestartIo, RestartProxyIdentity, StartUpdateJobDeps, UpdateCheckResult, UpdateJobState, UpdateJobStatus } from "./job-types";

const UPDATE_JOB_FILENAME = "update-job.json";
const UPDATE_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
// A Windows `service repair` can spend up to 45s in its own serving probe after
// Task Scheduler/ACL work. The generic 60s child ceiling can kill that valid repair
// and launch a competing foreground proxy. Keep this below the update worker's 180s
// ceiling while covering the measured probe plus bounded Windows setup work.
const WINDOWS_SERVICE_REPAIR_TIMEOUT_MS = 150_000;
/** Legacy active records did not persist a worker PID, so age is their only safe recovery signal. */
export const UPDATE_JOB_LEGACY_STALE_MS = 10 * 60_000;
/** How long update restart waits for the captured port to become bindable after stop. */
export const RESTART_PORT_RECLAIM_MS = 30_000;

export class UpdateJobError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "update_error") {
    super(message);
  }
}

const defaultCheckDeps: UpdateCheckDeps = {
  currentVersion,
  detectInstall,
  detectInstallOwnership,
  latestVersion,
  managedReleaseDirectory,
  miseUpdateCommand,
};

function nodeBin(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function usesNodeLauncher(installer: Installer): boolean {
  return installer === "npm" || installer === "pnpm";
}

/**
 * Live global package Bun — not the npm rename tree the update worker may still
 * be executing from (`@aquilaxk/.easyproxy-*`). Reject the tiny postinstall
 * stub so probes fall back to the worker runtime instead of failing forever.
 */
function livePackageBunPath(): string | null {
  const launcher = packageLauncherPath();
  const root = join(dirname(launcher), "..");
  for (const name of ["bun.exe", "bun"]) {
    const candidate = join(root, "node_modules", "bun", "bin", name);
    if (isRealBunBinary(candidate)) return candidate;
  }
  return null;
}

/**
 * Port is free for post-update `epx start` only when the runtime that will
 * actually execute the start can bind. Prefer live package Bun; fall back to the
 * worker runtime. Do not require a separate `node` binary (Bun-only installs).
 */
async function strictRuntimePortAvailable(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  const script = strictBindProbeScript(port, hostname);
  const bun = livePackageBunPath();
  if (bun) return spawnBindProbe(bun, script);
  return spawnBindProbe(process.execPath, script);
}

/** Wait for no LISTEN owners plus a bindable port. Dead PIDs retain ghost TCBs;
 * SetTcpEntry needs elevation (rc 317 otherwise), so wait them out. */
async function waitForGhostListenClear(
  port: number,
  hostname: string,
  listPids: (port: number) => number[],
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  aliveFn: (pid: number) => boolean = isProcessAlive,
  authorizeMutation: (kind: "runtime") => boolean = () => true,
): Promise<{ ok: boolean; accessDenied: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let accessDenied = false;
  while (Date.now() < deadline) {
    const holders = listPids(port).filter(pid => pid !== process.pid);
    const liveHolders = holders.filter(pid => aliveFn(pid));
    // Never SetTcpEntry while a live process still owns the port (foreign or epx).
    if (process.platform === "win32" && liveHolders.length === 0) {
      if (!authorizeMutation("runtime")) return { ok: false, accessDenied };
      try {
        const drop = guardedDropWindowsTcp(authorizeMutation, port);
        if (drop.accessDenied > 0) accessDenied = true;
      } catch { /* best-effort */ }
    }
    if (holders.length === 0 && await strictRuntimePortAvailable(port, hostname)) {
      return { ok: true, accessDenied };
    }
    await sleep(500);
  }
  return { ok: false, accessDenied };
}
function packageLauncherPath(): string {
  // The launcher is <pkg-root>/bin/epx.mjs. After `npm install -g`, import.meta.url
  // can still point at npm's renamed temp tree — prefer the live package path then.
  const fromMeta = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "epx.mjs");
  if (!/[\\/]\.easyproxy-/i.test(fromMeta) && existsSync(fromMeta)) return fromMeta;
  const live = fromMeta.replace(/[\\/]@aquilaxk[\\/]\.easyproxy-[^\\/]+/i, `${sep}@aquilaxk${sep}easyproxy`);
  if (live !== fromMeta && existsSync(live)) return live;
  return fromMeta;
}

function formatCommand(bin: string, args: string[]): string {
  return `${bin} ${args.join(" ")}`;
}

function manualSourceCommand(): string {
  return "git pull && bun install && bun run build:gui";
}

export function normalizeUpdateChannel(raw: string | null | undefined, current = currentVersion()): Channel {
  return raw === "latest" || raw === "preview" ? raw : defaultUpdateTag(current);
}

export function updateJobPath(): string {
  return join(getConfigDir(), UPDATE_JOB_FILENAME);
}

function ensureJobDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJob(job: UpdateJobState, authorizeMutation: UpdateMutationAuthorizer = () => false,
  kind: "publish" | "package-publish" = "publish"): void {
  ensureJobDir();
  const data = materializeMutationData(job);
  const target = updateJobPath(), text = `${JSON.stringify(sanitizePersistedUpdateJob(data), null, 2)}\n`;
  if (data.status === "succeeded") guardedPublishJob(authorizeMutation, kind, target, text);
  else atomicWriteFile(target, text);
}

export function readUpdateJob(jobId?: string | null): UpdateJobState | null {
  try {
    const parsed = JSON.parse(readFileSync(updateJobPath(), "utf8")) as UpdateJobState;
    if (jobId && parsed.id !== jobId) return null;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Log lines are composed by this module, so brand them here rather than at nineteen call sites.
 *
 * The one thing a caller must never do is interpolate external text into a log line — an
 * `Error.message`, a vendor stream, a path we were handed. Those go through
 * `withheldSummary()`, which produces a branded description WITHOUT the text itself.
 */
function updateJob(job: UpdateJobState, patch: Partial<UpdateJobState>, logLine?: string): UpdateJobState {
  const next = prepareUpdateJob(job, patch, logLine); writeJob(next); return next;
}
/** A Windows service that could not be proven stopped aborts the restart (#7771). */
function windowsServiceStopAborted(job: UpdateJobState): false {
  updateJob(job, { status: "failed", restarted: false, error: WINDOWS_SERVICE_STOP_ABORT }, WINDOWS_SERVICE_STOP_ABORT); return false;
}
function prepareUpdateJob(job: UpdateJobState, patch: Partial<UpdateJobState>, logLine?: string): UpdateJobState {
  const current = readUpdateJob(job.id) ?? job;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    log: logLine ? [...current.log, logLine] : current.log,
  };
  return next;
}

export function updateExecutionCommand(
  installer: Installer,
  channel: Channel,
  launcher = packageLauncherPath(),
  resolvedVersion?: string | null,
): { bin: string; args: string[]; display: string } {
  if (usesNodeLauncher(installer)) {
    const bin = nodeBin();
    const args = [launcher, "update", "--tag", channel];
    // The Node launcher self-update re-resolves the tag at its own time — a residual
    // divergence window this path cannot close (documented, not claimed immutable).
    // Both npm and pnpm use it so package files are never replaced by the running Bun
    // process; the launcher then selects the manager-native update implementation.
    return { bin, args, display: formatCommand(bin, args) };
  }
  if (installer === "bun") {
    const command = updateCommand(installer, channel, resolvedVersion);
    const bin = process.platform === "win32" ? process.execPath : command.bin;
    const { args } = command;
    return { bin, args, display: updateCommandStr(installer, channel, resolvedVersion) };
  }
  return { bin: "sh", args: ["-lc", manualSourceCommand()], display: manualSourceCommand() };
}

export function restartCommand(
  serviceInstalled: boolean,
  installer: Installer,
  launcher = packageLauncherPath(),
  port?: number,
  serviceArgs?: string[],
): { mode: "service" | "proxy"; bin: string; args: string[]; display: string } {
  const mode = serviceInstalled ? "service" : "proxy";
  const pinPort = !serviceInstalled && typeof port === "number" && Number.isFinite(port) && port > 0;
  const startArgs = pinPort
    ? [launcher, "start", "--port", String(Math.trunc(port))]
    : [launcher, "start"];
  // Default to repair, which reuses a healthy registration and re-registers only a stale one.
  const svcArgs = serviceInstalled ? [launcher, ...(serviceArgs ?? ["service", "repair"])] : startArgs;
  if (usesNodeLauncher(installer)) {
    const bin = nodeBin();
    const args = svcArgs;
    return { mode, bin, args, display: formatCommand(bin, args) };
  }
  // bun/source installs restart via the runtime executable + package launcher (real
  // .exe files), not `epx.cmd` — shell-less `.cmd` spawn throws EINVAL on Windows
  // (CVE-2024-27980 hardening), the same class the npm path avoids.
  const bin = process.execPath;
  const args = svcArgs;
  return { mode, bin, args, display: formatCommand(bin, args) };
}

export function checkForUpdate(
  requestedChannel?: Channel,
  deps: UpdateCheckDeps = defaultCheckDeps,
): UpdateCheckResult {
  const current = deps.currentVersion();
  const ownership = deps.detectInstallOwnership?.();
  const installer = ownership?.installer ?? deps.detectInstall();
  const channel = requestedChannel ?? normalizeUpdateChannel(null, current);
  const managedRelease = installer === "source" && deps.managedReleaseDirectory?.() === true;
  const latest = (installer === "source" && !managedRelease) || installer === "standalone" ? null : deps.latestVersion(channel);
  const updateAvailable = !!latest && isNewer(latest, current, channel);
  let reason: string | undefined;
  let command = installer === "standalone" ? STANDALONE_UPDATE_HINT : managedRelease ? "" : installer === "source"
    ? manualSourceCommand()
    : installer === "mise"
      ? (ownership && deps.miseUpdateCommand?.(ownership)) ?? ""
      : updateExecutionCommand(installer, channel).display;

  if (managedRelease) {
    reason = latest ? "managed_release" : "latest_unavailable";
  } else if (installer === "source" || installer === "standalone") {
    reason = installer === "source" ? "source_checkout" : "standalone_install";
  } else if (installer === "mise") {
    reason = command ? "externally_managed" : "external_ownership_invalid";
  } else if (!latest) {
    reason = "latest_unavailable";
  } else if (!updateAvailable) {
    reason = "already_latest";
  }

  return {
    currentVersion: current,
    latestVersion: latest,
    channel,
    installer,
    updateAvailable,
    canUpdate: installer !== "source" && installer !== "standalone" && installer !== "mise" && updateAvailable,
    command,
    releaseNotesUrl: RELEASE_NOTES_URL,
    ...(reason ? { reason } : {}),
  };
}

function newJobId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * [Decision Log]
 * - Purpose: recover dashboard updates after a detached worker dies without unlocking concurrent live updates.
 * - Existing constraints: legacy records have no PID, while a healthy update may legitimately run for minutes.
 * - Alternatives considered: clear every active record by age, or require operators to delete the file manually.
 * - Chosen approach: trust PID liveness first and use a conservative age limit only for legacy no-PID records.
 * - Why: age-only recovery can start two installers, while never recovering leaves the dashboard permanently blocked.
 * - Impact: live PID records remain locked regardless of age; dead PIDs recover immediately; legacy records recover after ten minutes.
 */
export function staleActiveUpdateJobReason(
  job: Pick<UpdateJobState, "status" | "pid" | "updatedAt">,
  now = Date.now(),
  isAlive: (pid: number) => boolean = isProcessAlive,
): string | null {
  if (job.status !== "running" && job.status !== "restarting") return null;
  if (typeof job.pid === "number" && Number.isSafeInteger(job.pid) && job.pid > 0) {
    return isAlive(job.pid) ? null : `update worker PID ${job.pid} is no longer running`;
  }
  const updatedAt = Date.parse(job.updatedAt);
  if (Number.isFinite(updatedAt) && now - updatedAt >= UPDATE_JOB_LEGACY_STALE_MS) {
    return "legacy active update record has no worker PID and exceeded the stale window";
  }
  return null;
}

/**
 * Status view of an active record whose worker is gone (#7967). A worker killed with its service
 * cgroup never writes a terminal state, so the persisted record stays `running`. The view reports
 * it as `failed` with the reason so the dashboard stops waiting, without writing: the persisted
 * record is settled only by the next run's existing stale recovery, which holds the start path,
 * so a status poll can never overwrite a job another process started meanwhile.
 */
export function readUpdateJobForStatus(
  jobId?: string | null,
  now = Date.now(),
  isAlive: (pid: number) => boolean = isProcessAlive,
): UpdateJobState | null {
  const job = readUpdateJob(jobId);
  if (!job) return null;
  const reason = staleActiveUpdateJobReason(job, now, isAlive);
  if (!reason) return job;
  const line = `Update worker stopped before finishing: ${reason}.`;
  return { ...job, status: "failed", error: line, exitCode: null, log: [...job.log, line] };
}

/**
 * Spawn the GUI update worker without inheriting the proxy's LISTEN socket.
 *
 * On Windows, `spawn(..., { detached: true, stdio: "ignore" })` still inherits
 * inheritable handles — including Bun.serve's LISTEN socket. After stop-first
 * update kills the proxy PID, netstat keeps showing that dead PID as LISTENING
 * until every inheriting child exits. The update worker was that child, so the
 * port stayed busy for the whole job. Launch via PowerShell Start-Process so
 * the worker is a fresh process tree with no inherited LISTEN handle.
 */
export function spawnGuiUpdateWorker(
  jobId: string,
  channel: Channel,
  restart: boolean,
  context: WorkerLaunchContext = {},
): UpdateWorkerProcess {
  const args = selfLaunchArgv([
    "__gui-update-worker",
    jobId,
    channel,
    restart ? "restart" : "no-restart",
  ]);
  if (process.platform !== "win32") {
    const launch = guiUpdateWorkerCommand(process.execPath, args, context);
    return probeSpawn(launch.command, launch.argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, EPX_SERVICE: "1" },
    });
  }

  // Single -ArgumentList string with CommandLineToArgvW quoting so paths with
  // spaces survive Start-Process's space-join (array elements lose outer quotes).
  const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const argumentList = buildWindowsElevatedArgumentList(args);
  const ps = [
    `$env:EPX_SERVICE = '1'`,
    `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argumentList)} -WindowStyle Hidden -PassThru`,
    `if (-not $p) { exit 1 }`,
    `Write-Output $p.Id`,
  ].join("; ");
  const launched = probeSpawnSync(
    resolveTrustedWindowsPowerShellExe(),
    ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  const pid = Number(String(launched.stdout ?? "").trim().split(/\r?\n/).pop());
  if (launched.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    const detail = String(launched.stderr ?? launched.stdout ?? "").trim() || `status ${launched.status}`;
    throw new Error(`Windows update worker Start-Process failed: ${detail}`);
  }
  return {
    pid,
    unref() { /* Start-Process already detached */ },
    once() { /* startup errors are not wired across Start-Process */ },
  };
}

const defaultStartUpdateJobDeps: StartUpdateJobDeps = {
  checkForUpdateFn: channel => checkForUpdate(channel),
  spawnWorkerFn: spawnGuiUpdateWorker,
  isProcessAliveFn: isProcessAlive,
  nowMs: Date.now,
};

export function startUpdateJob(
  channel: Channel,
  restart: boolean,
  deps: Partial<StartUpdateJobDeps> = {},
): UpdateJobState {
  const resolvedDeps = { ...defaultStartUpdateJobDeps, ...deps };
  const running = readUpdateJob();
  if (running?.status === "running" || running?.status === "restarting") {
    const staleReason = staleActiveUpdateJobReason(
      running,
      resolvedDeps.nowMs(),
      resolvedDeps.isProcessAliveFn,
    );
    if (!staleReason) {
      throw new UpdateJobError("An update job is already running", 409, "update_already_running");
    }
    updateJob(
      running,
      { status: "failed", error: `Recovered stale update job: ${staleReason}.`, exitCode: null },
      `Recovered stale update job: ${staleReason}.`,
    );
  }

  const check = resolvedDeps.checkForUpdateFn(channel);
  if (!check.canUpdate) {
    throw new UpdateJobError(check.reason ?? "No update is available", 409, check.reason ?? "update_unavailable");
  }

  const id = newJobId();
  const now = new Date(resolvedDeps.nowMs()).toISOString();
  const job: UpdateJobState = {
    id,
    status: "running",
    startedAt: now,
    updatedAt: now,
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    channel: check.channel,
    installer: check.installer,
    restart,
    command: check.command,
    releaseNotesUrl: check.releaseNotesUrl,
    log: [`Update job queued for ${check.currentVersion} -> ${check.latestVersion}.`],
  };
  writeJob(job);

  let child: UpdateWorkerProcess;
  try {
    child = resolvedDeps.spawnWorkerFn(id, channel, restart);
  } catch (error) {
    updateJob(job, { status: "failed", error: `Could not start update worker: ${withheldSummary(error)}` }, "Update worker failed to start.");
    throw new UpdateJobError("Could not start update worker", 500, "update_worker_start_failed");
  }
  if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    updateJob(job, { status: "failed", error: "Could not start update worker: no worker PID was returned." }, "Update worker failed to start.");
    throw new UpdateJobError("Could not start update worker", 500, "update_worker_start_failed");
  }
  const startedJob = updateJob(job, { pid: child.pid }, `Update worker started as PID ${child.pid}.`);
  child.once("error", error => {
    const current = readUpdateJob(id);
    if (!current || current.pid !== child.pid || (current.status !== "running" && current.status !== "restarting")) return;
    updateJob(
      current,
      { status: "failed", error: `Update worker failed to start: ${withheldSummary(error)}` },
      "Update worker emitted a startup error.",
    );
  });
  child.unref();
  return startedJob;
}

/**
 * Run an update step and record WHAT HAPPENED, not what the tool printed.
 *
 * Raw installer output used to be persisted verbatim, which put local paths and account names
 * into a stored file. Six rounds of trying to sanitize it after the fact each produced a new
 * leak — a wrap inside the keyword, a wrap inside the account name, an indented continuation,
 * three consecutive wraps, an empty continuation line. Every fix was an attempt to reconstruct
 * arbitrary multi-line text well enough to match it, and that is not a problem a redactor can
 * win: the leak surface is whatever npm decides to print.
 *
 * So the raw stream is no longer persisted at all. The job keeps the command, its exit status,
 * and a bounded, structured summary — enough to tell a user which step failed and how, with no
 * free-form vendor text passing through the boundary. Detailed output stays ephemeral.
 */
function runLoggedCommand(
  job: UpdateJobState,
  bin: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
  authorizeMutation: UpdateMutationAuthorizer = () => false,
  kind: Parameters<UpdateMutationAuthorizer>[0] = "runtime",
): { status: number | null; signal: NodeJS.Signals | null; timedOut: boolean } {
  job = updateJob(job, {}, `$ ${formatCommand(bin, args)}`);
  if (!authorizeMutation(kind)) return { status: 1, signal: null, timedOut: false };
  const result = guardedSpawnSync(authorizeMutation, kind, bin, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const summary = summarizeCommandOutput(stdout, stderr, result.status, result.signal);
  if (summary) updateJob(job, {}, summary);
  return {
    status: result.status,
    signal: result.signal,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

/** Clear wrappers, stale state and verified epx listeners before a pinned spawn. */
function preparePortForPinnedStart(
  job: UpdateJobState, port: number,
  listPids: (port: number) => number[], aliveFn: (pid: number) => boolean,
  verifyEpx: (pid: number) => number | null = verifyPidIdentity,
  stopServiceWrappers: () => void = () => {},
  authorizeMutation: (kind: "runtime") => boolean = () => true,
): false | void {
  if (!authorizeMutation("runtime")) return false;
  stopServiceWrappers();
  const pid = readPid();
  if (pid) {
    updateJob(job, {}, `Clearing pre-start proxy PID ${pid} before pinned start.`);
    if (!authorizeMutation("runtime")) return false;
    try { guardedKillProxy(authorizeMutation, "runtime", pid); } catch { /* best-effort */ }
  }
  if (!authorizeMutation("runtime")) return false;
  guardedRemovePid(authorizeMutation, pid ?? undefined);
  if (!authorizeMutation("runtime")) return false;
  guardedRemoveRuntimePort(authorizeMutation);
  for (const holder of listPids(port)) {
    if (holder === process.pid || !aliveFn(holder)) continue;
    if (verifyEpx(holder) !== holder) {
      updateJob(
        job,
        {},
        `Leaving foreign listen holder PID ${holder} on port ${port}; refusing collateral kill.`,
      );
      continue;
    }
    updateJob(job, {}, `Stopping live epx listen holder PID ${holder} on port ${port} before pinned start.`);
    if (!authorizeMutation("runtime")) return false;
    try { guardedKillProxy(authorizeMutation, "runtime", holder); } catch { /* best-effort */ }
  }
  // Match reclaimListenPort: never SetTcpEntry while a live holder remains.
  const liveRemain = listPids(port).filter(pid => pid !== process.pid && aliveFn(pid));
  if (process.platform === "win32" && liveRemain.length === 0) {
    if (!authorizeMutation("runtime")) return false;
    try { guardedDropWindowsTcp(authorizeMutation, port); } catch { /* best-effort */ }
  }
}

function spawnDetachedStart(job: UpdateJobState, installer: Installer, port: number | undefined,
  launcher: string, authorizeMutation: UpdateMutationAuthorizer): ChildProcess {
  if (!authorizeMutation("runtime")) throw new Error("Automatic update restart refused; check 'epx service status'.");
  return spawnWorkerPinnedStart(restartCommand(false, installer, launcher, port), authorizeMutation,
    line => updateJob(job, {}, line), withheldSummary);
}

/**
 * Whether the reinstalled service actually produced a listener on the captured target.
 * change. `isServiceViable()` cannot see any of those — it reads registration state.
 */
async function serviceRestartServed(
  job: UpdateJobState,
  port: number,
  hostname: string,
  io: RestartIo = {},
): Promise<boolean> {
  const probe = io.probeProxy ?? (async (p: number, h?: string) => (
    !!(await proxyIdentityAt(p, { hostname: h }))
  ));
  const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = io.now ?? (() => Date.now());
  const deadline = now() + (io.serviceHealthTimeoutMs ?? SERVICE_RECOVERY_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Service-managed proxy answered on ${hostname}:${port}.`);
      return true;
    }
    if (now() >= deadline) return false;
    await sleep(500);
  }
}

async function restartAfterUpdate(
  job: UpdateJobState,
  captured?: { port: number; hostname: string; oldPid?: number },
  io: RestartIo = {},
): Promise<false | void | "unsupervised"> {
  const homePolicy = createUpdateServiceHomePolicy(io.serviceHomeAuthorityFn ?? inspectUpdateServiceHome,
    refusal => { updateJob(job, { status: "failed", restarted: false, error: refusal }, refusal); }, false, io.serviceHomeBaseline);
  if (!homePolicy.check(io.serviceHomeBaseline ? undefined : homePolicy.initial)) return false;
  const serviceInstalled = homePolicy.initial.kind === "same" && (io.serviceInstalledFn ?? isServiceInstalled)();
  const config = loadConfig();
  // Stop-first update already cleared pid/runtime state, so the pre-update capture is
  // the authoritative port to wait on; config is only the cold-start fallback.
  const port = captured?.port ?? config.port ?? 10100;
  const hostname = captured?.hostname ?? config.hostname ?? "127.0.0.1";
  const oldPid = typeof captured?.oldPid === "number" && captured.oldPid > 0
    ? captured.oldPid
    : undefined;
  let svcArgs: string[] | undefined;
  if (serviceInstalled) {
    try {
      const { serviceReinstallArgs } = await import("../service");
      svcArgs = serviceReinstallArgs();
    } catch { /* fallback to default service install */ }
  }
  const launcher = io.packageLauncherPathFn?.() ?? packageLauncherPath();
  const cmd = restartCommand(serviceInstalled, job.installer, launcher, port, svcArgs);
  const waitFn = io.waitForPort ?? reclaimListenPort;
  const listPids = io.listListenPidsFn ?? listListenPids;
  const verifyEpx = io.verifyEpxFn ?? verifyPidIdentity;
  const aliveFn = io.isAliveFn ?? isProcessAlive;
  // Pre-update PID plus live epx listeners on the captured port: a self-update can
  // leave a respawned child whose protected status would block reclaim and the start.
  const reclaimKillAllowlist = (): number[] => {
    const allow = new Set<number>();
    if (oldPid != null) allow.add(oldPid);
    for (const pid of listPids(port)) {
      if (pid === process.pid) continue;
      if (verifyEpx(pid) === pid) allow.add(pid);
    }
    return [...allow];
  };
  // A reclaim denial stays latched across preparation and this job's waits.
  let reclaimDenied = false;
  const reclaimGate = () => {
    try { reclaimDenied ||= !homePolicy.authorizeMutation("runtime"); } catch { reclaimDenied = true; }
    return !reclaimDenied;
  };
  const reclaimOptsFor = (onlyKillPids: number[]) => ({
    timeoutMs: RESTART_PORT_RECLAIM_MS,
    intervalMs: 100,
    scanIntervalMs: 500,
    killEpxHolders: true,
    // Scheduler wrappers mint new epx PIDs during the wait — kill every epx
    // listener, not only the pre-wait snapshot; foreign claimants stay protected.
    killAllEpxOnPort: true,
    onlyKillPids,
    mayMutateFn: reclaimGate, // the wait's awaits can span a home change; gate each kill/drop
  });
  if (serviceInstalled) {
    if (!homePolicy.authorizeMutation("runtime")) return false; // a home change during the service-args import refuses before stop/reclaim
    // schtasks /end often leaves the hidden wrapper alive; its :loop respawns
    // `epx start` and races reclaim, so end wrappers before the socket.
    if (homePolicy.authorizeMutation("service") && await (io.stopServiceWrappersFn ?? stopWindowsServiceForRestart)(homePolicy.authorizeMutation) === false) return windowsServiceStopAborted(job);
    const preServiceAllow = reclaimKillAllowlist();
    const freed = await waitFn(port, hostname, reclaimOptsFor(preServiceAllow));
    if (!freed && !reclaimGate()) return false; // a latched denial already refused the job
    let skipServiceInstall = false;
    // `service repair` reuses the live task and refreshes stale definitions via its
    // guarded path; only a caller still passing install argv keeps the old skip.
    const refreshRegisters = (svcArgs ?? []).includes("install");
    if ((io.platform ?? process.platform) === "win32" && process.env.EPX_SERVICE === "1" && refreshRegisters) {
      updateJob(job, {}, "Skipping service re-registration from the non-elevated update worker; falling back to a direct proxy start.");
      skipServiceInstall = true;
    }
    if (!freed && !skipServiceInstall) {
      updateJob(
        job,
        {},
        `Port ${port} still busy after ${Math.trunc(RESTART_PORT_RECLAIM_MS / 1000)}s; refusing to hop — reinstall may fail until the port is free.`
          + ` ${formatPortHolders(port, listPids, verifyEpx, preServiceAllow)}`,
      );
      const liveScan: ListenPidScan = io.scanListenPidsFn
        ? io.scanListenPidsFn(port)
        : io.listListenPidsFn
          // Test seam: an injected list represents a successful scan.
          ? { ok: true, pids: io.listListenPidsFn(port) }
          : scanListenPids(port);
      const liveAfter = liveScan.ok
        ? liveScan.pids.filter(pid => pid !== process.pid && aliveFn(pid))
        : null;
      if (liveAfter !== null && liveAfter.length === 0) {
        // Non-elevated `service install` will UAC-fail anyway; go straight to the
        // direct-start fallthrough instead of burning another minute on it.
        updateJob(job, {}, "Skipping service reinstall after reclaim timeout with no live holders; falling back to a direct proxy start.");
        skipServiceInstall = true;
      }
    }
    if (!skipServiceInstall) {
      // `service repair` re-activates a manager whose `epx start` child cannot join
      // this lease; holding it through the serving wait kills that child at the deadline (#5760).
      io.releaseForServiceManagerFn?.();
      if (!homePolicy.authorizeMutation("runtime")) return false;
      const prevBake = process.env.EPX_BAKE_PORT;
      process.env.EPX_BAKE_PORT = String(Math.trunc(port));
      let serviceOk = false;
      try {
        const repairTimeoutMs = (io.platform ?? process.platform) === "win32"
          ? WINDOWS_SERVICE_REPAIR_TIMEOUT_MS
          : RESTART_TIMEOUT_MS;
        const run = io.runService ?? ((j, bin, args, timeoutMs) => runLoggedCommand(j, bin, args, timeoutMs, undefined, homePolicy.authorizeMutation, "service"));
        const result = homePolicy.authorizeMutation("service") ? run(job, cmd.bin, cmd.args, repairTimeoutMs) : { status: 0, timedOut: false };
        serviceOk = homePolicy.serviceAllowed && result.status === 0;
        if (!serviceOk && homePolicy.serviceAllowed) {
          if (result.timedOut) {
            // UAC and scheduler mutation can outlive a fixed child deadline. Once the
            // worker kills that child, ownership is ambiguous: launching a foreground
            // proxy here can race a registration that completes moments later.
            updateJob(job, {}, "Service repair timed out with Task Scheduler state unknown; refusing a competing direct start.");
            throw new Error(
              "Service repair timed out with Task Scheduler state unknown; refusing a competing direct start. "
              + "Run 'epx service status', then 'epx service repair' by hand.",
            );
          }
          // The refresh that just failed was `epx service repair`. Advising `install`
          // here would send the user to re-registration (UAC, possible WinSW backend
          // switch) for a service that is already registered; name the failed command.
          updateJob(
            job,
            {},
            `Service refresh failed (exit ${result.status ?? "?"}); falling back to a direct proxy start.`
            + " Run 'epx service repair' by hand to see the reason, then 'epx service status'.",
          );
        }
      } finally {
        if (prevBake === undefined) delete process.env.EPX_BAKE_PORT;
        else process.env.EPX_BAKE_PORT = prevBake;
      }
      if (!homePolicy.authorizeMutation("runtime")) return false;
      if (serviceOk && homePolicy.serviceAllowed) {
        // Registration state cannot distinguish a serving supervisor from one that
        // registered and bound nothing — `launchctl list`/`schtasks` report both, and
        // a flapping supervisor can satisfy one probe — so ask the port first.
        const viable = (io.serviceViableFn ?? isServiceViable)();
        if (viable) {
          if (await serviceRestartServed(job, port, hostname, io)) return homePolicy.authorizeMutation("publish") ? undefined : false;
          updateJob(
            job,
            {},
            `Service reinstall exited 0 and reported viable, but nothing answered on ${hostname}:${port} `
            + `within ${Math.trunc((io.serviceHealthTimeoutMs ?? SERVICE_RECOVERY_HEALTH_MS) / 1000)}s; `
            + "falling back to a direct proxy start.",
          );
        } else {
          updateJob(
            job,
            {},
            "Service reinstall exited 0 but the background service is not viable (stale or missing assets, disabled, or conflicting); falling back to a direct proxy start.",
          );
        }
      }
    }
  }

  // #7043: a managed install asks launchd/systemd first; only the manager's own job counts as recovered.
  if (!homePolicy.authorizeMutation("runtime")) return false;
  const managed = !serviceInstalled || !homePolicy.authorizeMutation("service") ? "failed" : await (io.restartServiceManagerFn ?? restartServiceManagerAfterUpdate)(
    { port, hostname, release: io.releaseForServiceManagerFn, authorizeMutation: homePolicy.authorizeMutation }, line => updateJob(job, {}, line));
  if (managed === "supervised") return homePolicy.authorizeMutation("publish") ? undefined : false;
  if (managed === "refused") { updateJob(job, { status: "failed", restarted: false, error: "Automatic service restart was refused; check 'epx service status' before restarting manually." }); return false; }
  if (managed === "unsettled") { updateJob(job, ...unsettledManagerRestartFailure(port)); return false; }
  const fallback = serviceInstalled ? "unsupervised" as const : undefined; // every exit below is unproven ownership
  // The service refresh ran outside the lease; take it back so the veto and the kills/start below stay serialized.
  const restartVeto = io.reacquireForDirectStartFn?.();
  if (!homePolicy.authorizeMutation("runtime")) return false;
  if (restartVeto) {
    if (!homePolicy.authorizeMutation("publish")) return false;
    writeJob(prepareUpdateJob(job, restartVeto.failed ? { status: "failed", restarted: false, error: restartVeto.notice } : { status: "succeeded", restarted: false }, restartVeto.notice), homePolicy.authorizeMutation, "publish");
    return false;
  }
  const pid = (io.readPidFn ?? readPid)();
  if (pid) {
    updateJob(job, {}, `Stopping current proxy PID ${pid}.`);
    try {
      if (!homePolicy.authorizeMutation("runtime")) return false;
      guardedKillProxy(homePolicy.authorizeMutation, "runtime", pid, io.killProxyFn);
    } catch {
      // A PID that resists taskkill must not abort recovery: reclaim + pinned start
      // below are the path that repairs stuck Windows listeners.
    }
  }
  if (serviceInstalled && homePolicy.authorizeMutation("service") && await (io.stopServiceWrappersFn ?? stopWindowsServiceForRestart)(homePolicy.authorizeMutation) === false) return windowsServiceStopAborted(job);
  // Reclaim before the pinned start: a busy old socket used to hop ports or fail health.
  const directAllow = reclaimKillAllowlist();
  const freed = await waitFn(port, hostname, reclaimOptsFor(directAllow));
  if (!freed && !reclaimGate()) return false;
  if (!freed) {
    const liveHolders = listPids(port).filter(pid => pid !== process.pid && aliveFn(pid));
    updateJob(
      job,
      {},
      `Port ${port} still busy after ${Math.trunc(RESTART_PORT_RECLAIM_MS / 1000)}s (reclaim could not free the socket).`
        + ` ${formatPortHolders(port, listPids, verifyEpx, directAllow)}`,
    );
    if (liveHolders.length > 0) {
      updateJob(job, {}, `Live holder(s) remain on port ${port}; not starting on another port. Retry 'epx start --port ${port}'.`);
      return fallback;
    }
    // Dead PIDs can still own LISTEN rows (SetTcpEntry needs elevation); poll netstat until bindable.
    updateJob(
      job,
      {},
      `No live holders on port ${port}; waiting for ghost LISTEN rows to clear before pinned start.`,
    );
    // Injected spawnStart is the unit-test seam — skip the long OS wait.
    if (!io.spawnStart) {
      const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
      const cleared = await waitForGhostListenClear(port, hostname, listPids, 90_000, sleep, aliveFn, reclaimGate);
      if (!reclaimGate()) return false;
      if (cleared.accessDenied) {
        updateJob(job, {}, "SetTcpEntry is non-elevated (access denied); relying on OS ghost-LISTEN expiry.");
      }
      if (!cleared.ok) {
        updateJob(
          job,
          {},
          `Ghost LISTEN rows on port ${port} did not clear in time. `
            + `${formatPortHolders(port, listPids, verifyEpx, directAllow)} `
            + `Retry 'epx start --port ${port}'.`,
        );
        return fallback;
      }
    }
  }
  // Injected spawnStart keeps unit tests deterministic (one call). Production path
  // retries on missing /healthz after prepare + ghost-LISTEN clear.
  if (io.spawnStart) {
    if (!homePolicy.authorizeMutation("runtime")) return false;
    io.spawnStart(job, job.installer, port, launcher);
    return fallback;
  }
  const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = io.probeProxy ?? (async (p: number, host?: string) => (
    !!(await proxyIdentityAt(p, { hostname: host }))
  ));
  const probeIdentity = io.probeProxyIdentity ?? defaultProbeProxyIdentity;
  const expectedVersion = typeof job.latestVersion === "string" && job.latestVersion.length > 0
    ? job.latestVersion
    : null;
  // Service wrappers can respawn a listener during reclaim; if it already reports the
  // update target version, do not spawn a second start that exits "already running".
  {
    const identity = await probeIdentity(port, hostname);
    if (identity && expectedVersion && identity.version === expectedVersion) {
      updateJob(
        job,
        {},
        `Proxy already healthy on ${hostname}:${port} at ${expectedVersion}; skipping pinned start.`,
      );
      return fallback;
    }
  }
  const attempts = 3;
  const now = io.now ?? (() => Date.now());
  const spawnPinnedStart = io.spawnDetachedStartFn ?? spawnDetachedStart;
  const preparePort = io.preparePortForPinnedStartFn ?? preparePortForPinnedStart;
  const waitForGhost = io.waitForGhostListenClearFn ?? waitForGhostListenClear;
  // Longer than published hard-pin reclaim (30s) so a slow start can still report healthy.
  const perAttemptHealthMs = 70_000;
  let lastChild: ChildProcess | null = null;
  const killSpawnAttempt = (child: ChildProcess | null): void => {
    // A numeric PID can be reused once this particular child has exited.
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (aliveFn(child.pid)) {
      if (!homePolicy.authorizeMutation("own-child")) return;
      try { guardedKillProxy(homePolicy.authorizeMutation, "own-child", child.pid, io.killProxyFn); } catch { /* best-effort */ }
    }
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      updateJob(
        job,
        {},
        `Pinned start attempt ${attempt - 1} did not become healthy on port ${port}; `
          + `retrying (${attempt}/${attempts}).`,
      );
      killSpawnAttempt(lastChild);
      lastChild = null;
    }
    if (!homePolicy.authorizeMutation("runtime")) return false;
    // #7771: the service stop runs before the synchronous preparation so its outcome can abort.
    if (serviceInstalled && homePolicy.authorizeMutation("service") && await (io.stopServiceWrappersFn ?? stopWindowsServiceForRestart)(homePolicy.authorizeMutation) === false) return windowsServiceStopAborted(job);
    if (preparePort(job, port, listPids, aliveFn, verifyEpx, undefined, reclaimGate) === false) return false;
    const ready = await waitForGhost(
      port,
      hostname,
      listPids,
      attempt === 1 ? (freed ? 15_000 : 5_000) : 30_000,
      sleep, aliveFn, reclaimGate,
    );
    if (!reclaimGate()) return false;
    if (!ready.ok) {
      updateJob(
        job,
        {},
        `Port ${port} not bindable before pinned start attempt ${attempt}; `
          + `${formatPortHolders(port, listPids, verifyEpx, directAllow)}`,
      );
      continue;
    }
    if (!homePolicy.authorizeMutation("runtime")) return false;
    const child = spawnPinnedStart(job, job.installer, port, launcher, homePolicy.authorizeMutation);
    lastChild = child;
    const retireChild = () => {
      if (lastChild === child) lastChild = null;
      child.removeListener("exit", retireChild);
      child.removeListener("error", retireChild);
      child.removeListener("close", retireChild);
    };
    child.once("exit", retireChild);
    child.once("error", retireChild);
    child.once("close", retireChild);
    const healthDeadline = now() + perAttemptHealthMs;
    while (now() < healthDeadline) {
      if (await probe(port, hostname)) return fallback;
      await sleep(500);
    }
  }
  // Exhausted retries: do not leave a hung pinned-start child owning the port.
  killSpawnAttempt(lastChild);
  return fallback;
}

/** Compact listen-holder summary helper lives in ./job-restart-verify.ts. */
/** Exposed for tests: drives the non-service restart path with injected io. */
export function restartAfterUpdateForTests(
  job: UpdateJobState,
  captured: { port: number; hostname: string; oldPid?: number },
  io: RestartIo,
): Promise<false | void | "unsupervised"> {
  return restartAfterUpdate(job, captured, io);
}

export function confirmRestartAfterUpdateForTests(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo,
): Promise<boolean> {
  return confirmRestartedProxy(job, captured, io, updateJob);
}

async function defaultProbeProxyIdentity(
  port: number,
  hostname?: string,
): Promise<RestartProxyIdentity | null> {
  try {
    const res = await fetch(`http://${probeHostname(hostname)}:${port}/healthz`, {
      signal: AbortSignal.timeout(750),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as HealthzIdentity | null;
    if (!isEasyproxyHealthz(body)) return null;
    return {
      pid: typeof body?.pid === "number" ? body.pid : null,
      // Validate the shape at the boundary where the value ENTERS, not where it is logged.
      // `/healthz` is answered by whatever is listening on that port, so a hostile or confused
      // responder can return any string here — and the restart-evidence reasons below
      // interpolate it into a persisted field. A version is a version or it is nothing.
      ...(isHealthzVersion(body?.version) ? { version: body.version } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Post-install restart for the GUI worker.
 *
 * npm and pnpm installs run `node epx.mjs update`, which already stops the proxy and reinstalls /
 * starts the service (or falls back to a direct start). A second `service install` here
 * calls `stopWindows()` on that healthy listener, then often fails elevation from the
 * non-interactive worker — leaving the captured port (default 10100) dead until a manual
 * restart. Prefer confirming the package-manager self-update's own restart first; only re-run restart
 * when that probe fails. Bun/source installs still always take the explicit restart path.
 *
 * Probe-first applies only to service-managed npm/pnpm installs: without a service, `epx.mjs`
 * only prints `epx start` and never brings the proxy back, so waiting would always burn
 * the full health timeout. Skipping also requires update-correlated evidence (PID change
 * and/or target version) so a surviving pre-update process cannot look like success.
 * After an explicit package-manager restart the same evidence is required again — health alone is
 * not enough when a no-op restart or failed port reclaim leaves the old proxy up.
 *
 * Browser-dashboard update recovery must not require a viable Background Service: when
 * no service is installed (or reinstall leaves a non-viable/stale manager), the explicit
 * path always falls through to a direct `epx start --port` so /healthz can recover.
 */
export async function finishGuiUpdateRestart(
  job: UpdateJobState,
  captured: { port: number; hostname: string; oldPid?: number },
  installer: Installer,
  io: RestartIo = {},
): Promise<boolean> {
  if (usesNodeLauncher(installer)) {
    const serviceInstalled = (io.serviceInstalledFn ?? isServiceInstalled)();
    if (serviceInstalled) {
      // Stop-first package-manager update leaves a dead PID's LISTEN row. Polling /healthz for the
      // full 30s against that zombie keeps ESTABLISHED TCBs alive and blocks bind.
      // If nothing live owns the port, skip straight to explicit restart. A failed
      // listener scan must not look like "no listeners" — fall back to /healthz.
      const aliveFn = io.isAliveFn ?? isProcessAlive;
      const scan: ListenPidScan = io.scanListenPidsFn
        ? io.scanListenPidsFn(captured.port)
        : io.listListenPidsFn
          // Test seam: injected list is always a successful scan.
          ? { ok: true, pids: io.listListenPidsFn(captured.port) }
          : scanListenPids(captured.port);
      const liveListeners = scan.ok
        ? scan.pids.filter(pid => pid !== process.pid && aliveFn(pid))
        : null;
      if (liveListeners !== null && liveListeners.length === 0) {
        updateJob(job, {}, `${installer} self-update did not leave a live listener; performing explicit restart...`);
      } else {
        if (!scan.ok) {
          updateJob(job, {}, `Listener scan inconclusive after ${installer} self-update; probing /healthz before deciding on explicit restart...`);
        }
        const already = await awaitRestartedProxyHealthy(job, captured, io, updateJob);
        if (already.ok) {
          const identity = await (io.probeProxyIdentity ?? defaultProbeProxyIdentity)(
            captured.port,
            captured.hostname,
          );
          const evidence = packageManagerSelfUpdateRestartEvidence(job, captured, identity);
          if (evidence.ok) {
            updateJob(job, {}, `Proxy already healthy on ${captured.hostname}:${captured.port} after ${installer} self-update (${evidence.detail}); skipping redundant restart.`);
            return true;
          }
          updateJob(job, {}, `${installer} self-update left a healthy proxy but ${evidence.reason}; performing explicit restart...`);
        } else {
          updateJob(job, {}, `${installer} self-update did not leave a healthy proxy; performing explicit restart...`);
        }
      }
    }
  }
  const restartFn = io.restartAfterUpdateFn ?? restartAfterUpdate;
  const restarted = await restartFn(job, captured, io);
  if (restarted === false) return false;
  // Bun/source: health alone remains enough unless a richer identity probe is supplied.
  const confirmExplicit = !usesNodeLauncher(installer) && !io.probeProxyIdentity
    ? () => confirmRestartedProxy(job, captured, io, updateJob)
    : () => confirmPackageManagerExplicitRestart(job, captured, io, updateJob, defaultProbeProxyIdentity);
  const confirmed = await confirmExplicit();
  if (confirmed && restarted === "unsupervised") updateJob(job, ...unsupervisedRestartFailure(captured.port)); // #7043
  return confirmed && restarted !== "unsupervised";
}

export async function runGuiUpdateWorker(
  jobId: string,
  channel: Channel,
  restart: boolean,
  io: GuiUpdateWorkerIo = {},
): Promise<void> {
  let job = readUpdateJob(jobId);
  const check = (io.checkForUpdateFn ?? checkForUpdate)(channel);
  const now = new Date().toISOString();
  // Capture the live listen target BEFORE the update command runs: the stop-first update
  // flow clears pid/runtime state, so this is the last moment the real port is knowable.
  // Only trust runtime-port.json when its pid matches the live pidfile process.
  const rt = readRuntimePort();
  const livePid = readPid();
  const preUpdateConfig = loadConfig();
  const runtimeTrusted = !!(rt && livePid && rt.pid === livePid);
  const configPort = typeof preUpdateConfig.port === "number" && preUpdateConfig.port > 0
    ? preUpdateConfig.port
    : 10100;
  const captured = {
    port: runtimeTrusted ? rt.port : configPort,
    hostname: (runtimeTrusted ? rt.hostname : undefined) ?? preUpdateConfig.hostname ?? "127.0.0.1",
    ...(runtimeTrusted && livePid ? { oldPid: livePid } : {}),
  };
  let trayWasInstalled = false;
  let trayWasRunning = false;
  let activeLauncher = packageLauncherPath();
  let activeLauncherVerified = true;
  let pnpmOwner: PnpmGlobalOwner | undefined;
  let workerAuthorizeMutation: UpdateMutationAuthorizer = () => false;
  const trayRun = (args: string[], timeout: number) => {
    if (!workerAuthorizeMutation(args[1] === "start" ? "own-tray" : "tray")) return { status: 1, signal: null };
    return io.trayCommandFn ? io.trayCommandFn(job!, process.execPath, [activeLauncher, ...args], timeout)
      : runLoggedCommand(job!, process.execPath, [activeLauncher, ...args], timeout, undefined, workerAuthorizeMutation, args[1] === "start" ? "own-tray" : "tray");
  };
  if (!job) {
    job = {
      id: jobId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      channel: check.channel,
      installer: check.installer,
      restart,
      command: check.command,
      releaseNotesUrl: check.releaseNotesUrl,
      log: [],
    };
    writeJob(job);
  }
  try {
    if (!check.canUpdate) {
      throw new Error(check.reason ?? "No update is available");
    }

    if (check.installer === "pnpm") {
      const ownerResult = (io.resolvePnpmOwnerFn ?? resolveCurrentPnpmGlobalOwner)();
      if (!ownerResult.ok) throw new Error(`Could not identify pnpm's owning global installation: ${ownerResult.reason}`);
      pnpmOwner = ownerResult.owner;
    }

    // Pre-flight integrity metadata check (same lanes as the CLI): anomalous registry
    // metadata for a resolved version fails the job BEFORE anything is spawned or the
    // proxy is stopped; transient registry failure degrades to a logged skip.
    const integrity = io.integrityFn
      ? io.integrityFn(check.latestVersion)
      : checkUpdatePackageIntegrity(check.latestVersion, probeSpawnSync, check.installer, pnpmOwner);
    if (integrity.ok === false) {
      updateJob(job, { status: "failed", error: integrity.reason });
      return;
    }
    const integrityLine = integrity.ok === "skipped"
      ? `Integrity pre-flight skipped: ${integrity.reason}. Proceeding best-effort.`
      : `Verified ${PKG}@${check.latestVersion} integrity metadata ${integrity.integrity.slice(0, 24)}…`;

    const cmd = updateExecutionCommand(check.installer, channel, undefined, check.latestVersion);
    job = updateJob(job, {
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      installer: check.installer,
      command: cmd.display,
    }, integrityLine);

    if (check.installer === "npm") {
      const cachePreflight = (io.cachePreflightFn ?? runNpmCachePreflight)();
      if (!cachePreflight.ok) {
        updateJob(job, {
          status: "failed",
          error: npmCachePreflightFailureMessage(cachePreflight.reason as NpmCachePreflightReason),
        }, "Update aborted before stopping the proxy because the npm cache pre-flight failed.");
        return;
      }
    }

    let homeRefusal: string | undefined;
    const homePolicy = prepareWorkerUpdateHome(cmd, check.installer, activeLauncher, nodeBin(), channel,
      message => { homeRefusal = message; job = updateJob(job!, {}, message); }, io.serviceHomeAuthorityFn, io.launcherSupportsUpdateHomeFn);
    if (!homePolicy) { updateJob(job, { status: "failed", restarted: false, error: homeRefusal }); return; }
    workerAuthorizeMutation = homePolicy.authorizeMutation;
    job = updateJob(job, { command: cmd.display });
    const refuseWorkerHome = () => {
      if (trayWasRunning && activeLauncherVerified && homePolicy.authorizeMutation("own-tray")) trayRun(["tray", "start"], 15_000);
      updateJob(job!, { status: "failed", restarted: false, error: homeRefusal });
    };
    if (!homePolicy.packageOnly && (io.trayHandoffFn || (io.platform ?? process.platform) === "win32")) {
      try {
        if (!homePolicy.authorizeMutation("tray")) { refuseWorkerHome(); return; }
        const trayPlan = await (io.trayHandoffFn ?? defaultWorkerTrayHandoff)(plan => { trayWasInstalled = plan.refreshAfterReplacement; trayWasRunning = plan.restoreOnFailure; }, homePolicy.authorizeMutation);
        trayWasInstalled = trayPlan.refreshAfterReplacement;
        trayWasRunning = trayPlan.restoreOnFailure;
      } catch (error) {
        if (trayWasRunning && activeLauncherVerified && homePolicy.authorizeMutation("own-tray")) { try { trayRun(["tray", "start"], 15_000); } catch { /* preserve the handoff failure */ } }
        updateJob(job, {
          status: "failed", restarted: false,
          error: homeRefusal ?? `Could not stop the Windows tray; aborting before package replacement: ${withheldSummary(error)}`,
        });
        return;
      }
    }
    /* [Decision Log]
    - 목적: GUI 요청 처리 프로세스가 자신이 실행 중인 패키지를 직접 덮어쓰지 않도록 업데이트를 별도 worker에서 수행한다.
    - 대안 분석: (1) 서버에서 runUpdate 직접 호출: process.exit/stdio/실행 파일 교체 위험. (2) GUI에서 CLI 명령 안내만 제공: 자동 업데이트 UX 부족. (3) 숨은 worker가 Node launcher/Bun 전역 명령을 실행: 상태 추적과 안전한 재시작이 가능.
    - 선택 근거: 현재 CLI의 package-manager self-update 우회를 재사용하면서도 GUI 서버 요청 생명주기와 설치 작업을 분리할 수 있어 가장 안정적이다.
    */
    // #7423: this job restarts the proxy itself, so the update's stop hands Codex routing
    // and the routed catalog to the replacement instead of restoring native Codex for the
    // seconds in between. Without a restart the stop restores, even under an inherited marker.
    const updateEnv = restart ? withUpdateTeardownHandover(process.env) : withoutUpdateTeardownHandover(process.env);
    // Raw package-manager lanes cannot carry the baseline argv; the parent rechecks it at the boundary.
    if (!homePolicy.authorizeMutation("package")) { refuseWorkerHome(); return; }
    const result = (io.runCommandFn ?? runLoggedCommand)(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS, updateEnv, homePolicy.authorizeMutation, "package");
    if (packageOnlyUpdateSucceeded(cmd, result.status, homePolicy.packageOnly)) {
      homePolicy.check({ kind: "unknown" });
      if (!homePolicy.authorizeMutation("package-publish")) { refuseWorkerHome(); return; }
      writeJob(prepareUpdateJob(job, { status: "succeeded", restarted: false }, "Update installed. Restart the proxy manually after checking 'epx service status'."), homePolicy.authorizeMutation, "package-publish");
      return;
    }
    if (result.status !== 0) {
      if (check.installer === "pnpm") {
        const verifiedLauncher = pnpmOwner
          ? (io.resolvePnpmActiveLauncherFn ?? resolvePnpmActiveLauncher)(pnpmOwner)
          : null;
        if (verifiedLauncher) activeLauncher = verifiedLauncher;
        else activeLauncherVerified = false;
      }
      if (trayWasRunning && activeLauncherVerified && homePolicy.authorizeMutation("own-tray")) trayRun(["tray", "start"], 15_000);
      updateJob(job, {
        status: "failed",
        exitCode: result.status,
        signal: result.signal,
        error: `update command failed (${result.status ?? "?"}). ${GUI_UPDATE_FAILURE_NEXT_STEP}`,
      });
      return;
    }

    if (check.installer === "pnpm") {
      const verifiedLauncher = (io.resolvePnpmActiveLauncherFn ?? resolvePnpmActiveLauncher)(pnpmOwner!);
      if (!verifiedLauncher) throw new Error("pnpm update succeeded but no verified active launcher remains");
      activeLauncher = verifiedLauncher;
    }

    // Authority gates every post-replacement control action; refusal may only restore the
    // own tray stopped before replacement, never install/refresh a new artifact.
    if (!homePolicy.authorizeMutation("runtime")) { refuseWorkerHome(); return; }
    if (trayWasInstalled) {
      const trayArgs = planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs;
      if (!homePolicy.authorizeMutation("tray")) { refuseWorkerHome(); return; }
      const tray = trayRun(trayArgs, 20_000);
      if (tray.status !== 0) {
        updateJob(job, {}, "Windows tray refresh failed; run 'epx tray install'.");
        if (trayWasRunning && homePolicy.authorizeMutation("own-tray")) trayRun(["tray", "start"], 15_000);
      }
    }
    if (restart) {
      const outcome = await runUpdateRestartWithOwnershipLease(io.resolveOwnershipFn, async lease => {
        job = updateJob(job!, { status: "restarting" }, "Update installed. Restarting proxy...");
        return finishGuiUpdateRestart(job!, captured, check.installer, {
          ...io.restartIo,
          serviceHomeAuthorityFn: io.restartIo?.serviceHomeAuthorityFn ?? io.serviceHomeAuthorityFn, serviceHomeBaseline: homePolicy.initial,
          releaseForServiceManagerFn: lease.releaseForServiceManager,
          reacquireForDirectStartFn: lease.reacquireForDirectStart,
          packageLauncherPathFn: () => activeLauncher,
        });
      });
      if (outcome.kind === "veto") { if (!homePolicy.authorizeMutation("publish")) { refuseWorkerHome(); return; } writeJob(prepareUpdateJob(job, { status: "succeeded", restarted: false }, outcome.notice), homePolicy.authorizeMutation, "publish"); return; }
      if (!outcome.value) return;
      if (!homePolicy.authorizeMutation("publish")) { refuseWorkerHome(); return; }
      writeJob(prepareUpdateJob(job, { status: "succeeded", restarted: true }, "Restart requested and proxy is healthy."), homePolicy.authorizeMutation, "publish");
      return;
    }
    if (!homePolicy.authorizeMutation("publish")) { refuseWorkerHome(); return; }
    writeJob(prepareUpdateJob(job, { status: "succeeded", restarted: false }, "Update installed. Restart the proxy to use the new version."), homePolicy.authorizeMutation, "publish");
  } catch (err) {
    if (check.installer === "pnpm") activeLauncherVerified = false;
    if (trayWasRunning && activeLauncherVerified && workerAuthorizeMutation("own-tray")) trayRun(["tray", "start"], 15_000);
    updateJob(job, {
      status: "failed",
      error: withheldSummary(err),
    });
  }
}
