import type { ChildProcess } from "node:child_process";
import type { readPid } from "../config/process-state";
import type { ListenPidScan } from "../server/port-reclaim";
import type { guardedReclaimListenPort as reclaimListenPort } from "./guarded-port-reclaim";
import type { KillProxy } from "./guarded-runtime-ops";
import type {
  Channel,
  checkUpdatePackageIntegrity,
  Installer,
  resolveCurrentPnpmGlobalOwner,
  resolvePnpmActiveLauncher,
} from "./index";
import type { ManagerRestartFn } from "./job-supervised-restart";
import type { defaultWorkerTrayHandoff } from "./job-update-tray";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";
import type { PnpmGlobalOwner } from "./pnpm-global-install.mjs";
import type { ServiceOwnershipResolution } from "./restart-ownership";
import type { UpdateServiceHomeInspector } from "./service-home-authority";
import type { planWindowsTrayUpdate } from "./tray-update-plan.mjs";

export type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}

export interface UpdateJobState {
  id: string;
  status: UpdateJobStatus;
  startedAt: string;
  updatedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  restart: boolean;
  command: string;
  releaseNotesUrl: string;
  log: string[];
  pid?: number;
  error?: string;
  exitCode?: number | null;
  signal?: string | null;
  restarted?: boolean;
}

export interface UpdateWorkerProcess {
  pid?: number;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface StartUpdateJobDeps {
  checkForUpdateFn: (channel: Channel) => UpdateCheckResult;
  spawnWorkerFn: (jobId: string, channel: Channel, restart: boolean) => UpdateWorkerProcess;
  isProcessAliveFn: (pid: number) => boolean;
  nowMs: () => number;
}

/** Identity snapshot used to prove a package-manager self-update replaced the pre-update process. */
export interface RestartProxyIdentity {
  pid: number | null;
  version?: string;
}

/** Test seam: the wait/spawn pair is injectable so the restart path is verifiable. */
export interface RestartIo {
  waitForPort?: typeof reclaimListenPort;
  spawnStart?: (job: UpdateJobState, installer: Installer, port?: number, launcher?: string) => void;
  /** The package launcher verified after a pnpm group switch or rollback. */
  packageLauncherPathFn?: () => string;
  /** Exercise pinned-start retries without spawning, reclaiming, or killing real processes. */
  spawnDetachedStartFn?: (
    job: UpdateJobState,
    installer: Installer,
    port: number | undefined,
    launcher: string,
    authorizeMutation: UpdateMutationAuthorizer,
  ) => ChildProcess;
  preparePortForPinnedStartFn?: (
    job: UpdateJobState,
    port: number,
    listPids: (port: number) => number[],
    aliveFn: (pid: number) => boolean,
    verifyEpx?: (pid: number) => number | null,
    stopServiceWrappers?: () => void,
    authorizeMutation?: (kind: "runtime") => boolean,
  ) => false | void;
  waitForGhostListenClearFn?: (
    port: number,
    hostname: string,
    listPids: (port: number) => number[],
    timeoutMs: number,
    sleep: (ms: number) => Promise<void>,
    aliveFn?: (pid: number) => boolean,
    authorizeMutation?: (kind: "runtime") => boolean,
  ) => Promise<{ ok: boolean; accessDenied: boolean }>;
  killProxyFn?: KillProxy;
  serviceInstalledFn?: () => boolean;
  serviceHomeAuthorityFn?: UpdateServiceHomeInspector;
  serviceHomeBaseline?: ReturnType<UpdateServiceHomeInspector>; // Worker delegation pins its original authority.
  /** Windows service stop before a restart; an explicit false aborts the restart (#7771). */
  stopServiceWrappersFn?: (authorizeMutation: UpdateMutationAuthorizer) => boolean | void | Promise<boolean | void>;
  readPidFn?: typeof readPid;
  /**
   * After a service reinstall exits 0, only trust the service path when this is true.
   * Defaults to `isServiceViable` — installed-but-stale assets must fall through
   * to a direct proxy start so dashboard updates never leave /healthz dead.
   */
  serviceViableFn?: () => boolean;
  /**
   * Free the ownership-mutation lease before a service-manager-mediated start that
   * cannot join it (#5760); wired by runUpdateRestartWithOwnershipLease.
   */
  releaseForServiceManagerFn?: () => void;
  /** Re-acquire the lease for the direct-start fallthrough, then re-run the veto; a notice stops the restart. */
  reacquireForDirectStartFn?: () => { readonly notice: string; readonly failed: boolean } | null;
  restartServiceManagerFn?: ManagerRestartFn; // launchd/systemd restart before a managed direct fallback (#7043)
  probeProxy?: (port: number, hostname?: string) => Promise<boolean>;
  /** Richer /healthz read for update-correlated restart evidence (pid + version). */
  probeProxyIdentity?: (port: number, hostname?: string) => Promise<RestartProxyIdentity | null>;
  /** Override the /healthz appearance window (default RESTART_HEALTH_TIMEOUT_MS). */
  healthTimeoutMs?: number;
  /**
   * Override the window for deciding whether a service-managed restart actually
   * served (default SERVICE_RECOVERY_HEALTH_MS). Distinct from
   * healthTimeoutMs, which is the FINAL /healthz appearance window consumed
   * by awaitRestartedProxyHealthy: this one only chooses whether to ALSO attempt a
   * direct start, so coupling them would let a test tightening one silently retune
   * the other.
   */
  serviceHealthTimeoutMs?: number;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam — defaults to process.platform so the Windows-only branch is reachable off Windows. */
  platform?: NodeJS.Platform;
  /** Service-mode install/reinstall command (defaults to spawnSync via runLoggedCommand). */
  runService?: (
    job: UpdateJobState,
    bin: string,
    args: string[],
    timeoutMs: number,
  ) => { status: number | null; signal?: NodeJS.Signals | null; timedOut?: boolean };
  /** Override the explicit restart path (used by finishGuiUpdateRestart tests). */
  restartAfterUpdateFn?: (
    job: UpdateJobState,
    captured?: { port: number; hostname: string; oldPid?: number },
    io?: RestartIo,
  ) => Promise<false | void | "unsupervised">;
  /**
   * PIDs currently LISTENing on the captured port. Used to widen the post-update
   * kill allowlist beyond the pre-update PID (Windows often leaves a respawned
   * epx child that would otherwise be treated as a protected listener).
   */
  listListenPidsFn?: (port: number) => number[];
  /**
   * Full listen-PID scan (ok/fail). When omitted, `scanListenPids` is used
   * so a probe failure is not mistaken for "no listeners".
   */
  scanListenPidsFn?: (port: number) => ListenPidScan;
  /** Identity check for listeners discovered via listListenPidsFn. */
  verifyEpxFn?: (pid: number) => number | null;
  /** Liveness check when deciding whether a reclaim timeout still has live holders. */
  isAliveFn?: (pid: number) => boolean;
}

/**
 * Test seams for the GUI update worker.
 *
 * The cache pre-flight and the install/stop step were previously reached only through module
 * globals, so "the gate runs before the stop" could only be asserted by comparing source-string
 * positions — a test that stays green even if the call is unreachable. These make the ordering
 * observable: a failed pre-flight must leave `runCommand` untouched.
 */
export interface GuiUpdateWorkerIo {
  cachePreflightFn?: () => { ok: boolean; reason: string };
  /** Force the resolved update target. A source checkout otherwise aborts before the update branch. */
  checkForUpdateFn?: (channel: Channel) => UpdateCheckResult;
  /** Bypass the registry integrity probe, which runs before the cache gate and needs network. */
  integrityFn?: (version: string | null) => ReturnType<typeof checkUpdatePackageIntegrity>;
  /** Override pnpm ownership discovery for an isolated worker test. */
  resolvePnpmOwnerFn?: () => ReturnType<typeof resolveCurrentPnpmGlobalOwner>;
  /** Resolve the launcher only after the pnpm update has verified its active group and shims. */
  resolvePnpmActiveLauncherFn?: (owner: PnpmGlobalOwner) => string | null;
  /** Restart seams used by focused worker tests; the verified launcher is always injected. */
  restartIo?: RestartIo;
  resolveOwnershipFn?: () => ServiceOwnershipResolution; // Defaults to the shared service install state.
  serviceHomeAuthorityFn?: UpdateServiceHomeInspector;
  launcherSupportsUpdateHomeFn?: (launcher: string, node: string) => boolean;
  platform?: NodeJS.Platform; // Exercise the default Windows handoff without changing the host platform.
  /** Isolated tray handoff plan for focused worker tests (default: the win32 tray handoff). */
  trayHandoffFn?: (
    capturePlan?: Parameters<typeof defaultWorkerTrayHandoff>[0],
    authorizeMutation?: UpdateMutationAuthorizer,
  ) => ReturnType<typeof planWindowsTrayUpdate> | Promise<ReturnType<typeof planWindowsTrayUpdate>>;
  /** Isolated tray command runner for focused worker tests (default: runLoggedCommand). */
  trayCommandFn?: GuiUpdateWorkerIo["runCommandFn"];
  runCommandFn?: (
    job: UpdateJobState,
    bin: string,
    args: string[],
    timeout: number,
    env?: NodeJS.ProcessEnv,
  ) => { status: number | null; signal: NodeJS.Signals | null };
}
