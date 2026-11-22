import { isProcessAlive } from "../lib/process-control";
import { proxyIdentityAt } from "../server/proxy-liveness";
import type { Installer } from "./index";
import type { RestartIo, RestartProxyIdentity, UpdateJobState } from "./job-types";

const RESTART_HEALTH_TIMEOUT_MS = 30_000;
const RESTART_STABILITY_WINDOW_MS = 15_000;

/**
 * Health window for deciding whether a service-managed restart served, before
 * falling back to a direct start. Deliberately shorter than the final verdict
 * window: being wrong here costs one extra start attempt; being wrong the other way
 * leaves the user with no proxy at all.
 *
 * It runs AFTER the child's own 20s install probe, so a reinstall that exits 0 but
 * never serves spends up to 45s before the fallback — inside the 60s restart budget.
 */
export const SERVICE_RECOVERY_HEALTH_MS = 25_000;

type UpdateJobFn = (job: UpdateJobState, patch: Partial<UpdateJobState>, logLine?: string) => UpdateJobState;
type ProbeIdentityFn = (port: number, hostname?: string) => Promise<RestartProxyIdentity | null>;

/** Compact listen-holder summary for update-job logs when reclaim fails. */
export function formatPortHolders(
  port: number,
  listPids: (port: number) => number[],
  verifyEpx: (pid: number) => number | null,
  allow: number[],
): string {
  const allowSet = new Set(allow);
  const holders = listPids(port).map(pid => {
    const tags = [
      verifyEpx(pid) === pid ? "epx" : "foreign",
      allowSet.has(pid) ? "allow" : "deny",
      isProcessAlive(pid) ? "live" : "dead",
    ];
    return `${pid}(${tags.join(",")})`;
  });
  return `holders=[${holders.join(", ") || "none"}] allow=[${allow.join(", ") || "none"}]`;
}

function restartFailureHint(port: number, installer: Installer): string {
  const reinstall = installer === "pnpm"
    ? "pnpm add -g --allow-build=bun easyproxy"
    : installer === "bun"
      ? "bun add -g easyproxy"
      : installer === "source"
        ? "git pull && bun install"
        : "npm install -g --allow-scripts=bun easyproxy";
  return `Update installed, but the restarted proxy did not stay healthy on port ${port}. `
    + `Try 'epx start --port ${port}'. `
    + "If the update log shows bun postinstall or EPERM warnings, "
    + `reinstall with '${reinstall}'.`;
}

type AwaitHealthyResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "flapped" };

/**
 * Wait for an identity-checked /healthz on the captured listen target, then require a short
 * stability window. Soft: never marks the job failed (callers decide whether to fail or retry).
 */
export async function awaitRestartedProxyHealthy(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo = {},
  updateJob: UpdateJobFn,
): Promise<AwaitHealthyResult> {
  // Fresh post-update starts are busy with catalog sync / OAuth; a single 750ms
  // /healthz miss must not fail the job. Use a longer probe and tolerate brief blips.
  const probe = io.probeProxy ?? (async (port: number, hostname?: string) => (
    !!(await proxyIdentityAt(port, { hostname }, { timeoutMs: 2_000, attempts: 3 }))
  ));
  const sleep = io.sleepMs ?? (async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
  const now = io.now ?? (() => Date.now());
  const port = captured.port;
  const hostname = captured.hostname;
  const startDeadline = now() + (io.healthTimeoutMs ?? RESTART_HEALTH_TIMEOUT_MS);
  /** Consecutive failed probes before the stability window counts as a flap. */
  const stabilityMissLimit = 3;

  while (true) {
    // Always make one identity-aware probe at or after the boundary. A replacement
    // becoming healthy on the final tick must not be mistaken for a timeout.
    const finalProbe = now() >= startDeadline;
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Proxy reported healthy on ${hostname}:${port}; confirming it stays up...`);
      const stableUntil = now() + RESTART_STABILITY_WINDOW_MS;
      let misses = 0;
      while (now() < stableUntil) {
        if (await probe(port, hostname)) {
          misses = 0;
        } else {
          misses += 1;
          if (misses >= stabilityMissLimit) {
            updateJob(job, {}, `Proxy became unhealthy on ${hostname}:${port} during the stability window.`);
            return { ok: false, reason: "flapped" };
          }
        }
        await sleep(500);
      }
      updateJob(job, {}, `Proxy stayed healthy for ${Math.trunc(RESTART_STABILITY_WINDOW_MS / 1000)}s after restart.`);
      return { ok: true };
    }
    if (finalProbe) break;
    await sleep(Math.min(250, Math.max(0, startDeadline - now())));
  }

  return { ok: false, reason: "timeout" };
}

/**
 * Confirm that the detached/service restart really came back and stayed up. The GUI worker
 * used to mark success immediately after spawning the new process, which hid Windows cases
 * where npm left the bundled Bun runtime half-updated and the restarted proxy died seconds
 * later. A healthy /healthz must appear, then remain healthy for one short stability window.
 */
export async function confirmRestartedProxy(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo = {},
  updateJob: UpdateJobFn,
): Promise<boolean> {
  /* [Decision Log]
  - 목적과 의도: GUI update job이 detached restart 요청만 보고 성공 처리하지 않도록, 실제 프록시 복귀 여부를 확인한다.
  - 기존 구현 및 제약 조건: update-job.json은 probeSpawn/service reinstall 직후 `succeeded`로 끝났고, Windows npm/Bun 교체 실패처럼 몇 초 후 죽는 재시작을 잡지 못했다.
  - 검토한 주요 대안: (1) 포트 점유만 확인 — 외부 프로세스/죽기 직전 프로세스를 성공으로 오인할 수 있다. (2) 무기한 /healthz 폴링 — UX가 느려지고 worker 종료 시점이 불명확하다. (3) 짧은 healthy 등장 + 안정성 창 확인 — 실제 복귀를 확인하면서도 대기 시간을 제한할 수 있다.
  - 선택한 방식: identity-aware /healthz probe가 일정 시간 안에 나타나고, 추가 안정성 창 동안 유지되는지 확인한다.
  - 다른 대안 대신 이 방식을 선택한 이유: GUI는 "업데이트가 설치됐지만 재시작은 실패"를 분리해 알려줘야 하며, 이 방식이 가장 적은 오탐으로 그 경계를 만든다.
  - 장점, 단점 및 영향: 장점은 silent restart failure가 update-job 상태로 드러난다는 점이다. 단점은 설정상 성공 판정 창이 30초 도착 + 15초 안정성으로 늘어나고 경계 probe 지연이 추가될 수 있다는 점이며, 대신 실제 복귀를 더 정확히 반영한다.
  */
  const result = await awaitRestartedProxyHealthy(job, captured, io, updateJob);
  if (result.ok) return true;
  const port = captured.port;
  const hostname = captured.hostname;
  const error = result.reason === "flapped"
    ? `proxy restart became unhealthy on ${hostname}:${port}`
    : `proxy restart never became healthy on ${hostname}:${port}`;
  updateJob(job, {
    status: "failed",
    restarted: false,
    error,
  }, restartFailureHint(port, job.installer));
  return false;
}

/**
 * Health alone is not enough to skip the GUI worker restart: a surviving pre-update
 * process is still identity-healthy. Require update-correlated evidence — a new PID
 * when the pre-update PID was captured, and/or /healthz reporting the job's target
 * version when PID evidence is unavailable.
 */
export function packageManagerSelfUpdateRestartEvidence(
  job: Pick<UpdateJobState, "latestVersion">,
  captured: { oldPid?: number },
  identity: RestartProxyIdentity | null,
): { ok: true; detail: string } | { ok: false; reason: string } {
  if (!identity) return { ok: false, reason: "could not read proxy identity" };

  const oldPid = typeof captured.oldPid === "number" && captured.oldPid > 0
    ? captured.oldPid
    : undefined;
  const livePid = typeof identity.pid === "number" && identity.pid > 0 ? identity.pid : null;
  const expected = typeof job.latestVersion === "string" && job.latestVersion.length > 0
    ? job.latestVersion
    : null;
  const versionMatches = expected !== null && identity.version === expected;

  if (oldPid !== undefined) {
    if (livePid === oldPid) {
      return { ok: false, reason: "still the pre-update PID" };
    }
    if (livePid !== null) {
      if (expected !== null && identity.version && identity.version !== expected) {
        // Never echo the REPORTED version: `/healthz` is answered by whatever holds the port,
        // and `2.7.41-JaneDoe` is valid semver. Say that it mismatched, and name only the
        // version we expected — which is ours.
        return { ok: false, reason: `new pid but reported version did not match expected ${expected}` };
      }
      return { ok: true, detail: `pid changed ${oldPid}→${livePid}` };
    }
    // Pre-update PID known but healthz omitted pid — only accept matching target version.
    // On a match the reported value equals `expected`, so render the trusted one.
    if (versionMatches) return { ok: true, detail: `version ${expected}` };
    return { ok: false, reason: "no PID in healthz and version did not match the update target" };
  }

  if (versionMatches) return { ok: true, detail: `version ${expected}` };
  if (expected !== null && identity.version && identity.version !== expected) {
    return { ok: false, reason: `reported version did not match expected ${expected}` };
  }
  return { ok: false, reason: "no pre-update PID capture and no expected-version match" };
}

// Kept as a compatibility export for callers and existing integrations that used the
// original npm-specific name before pnpm became a supported package-manager path.
export const npmSelfUpdateRestartEvidence = packageManagerSelfUpdateRestartEvidence;

/**
 * After an explicit package-manager (or identity-aware) restart, require update-correlated
 * evidence — not merely a healthy EasyProxy listener. A no-op restart or a
 * failed port reclaim can leave the pre-update process on the captured port;
 * `confirmRestartedProxy` alone would treat that as success.
 */
export async function confirmPackageManagerExplicitRestart(
  job: UpdateJobState,
  captured: { port: number; hostname: string; oldPid?: number },
  io: RestartIo = {},
  updateJob: UpdateJobFn,
  defaultProbeIdentity: ProbeIdentityFn,
): Promise<boolean> {
  const healthy = await awaitRestartedProxyHealthy(job, captured, io, updateJob);
  if (!healthy.ok) {
    const port = captured.port;
    const hostname = captured.hostname;
    const error = healthy.reason === "flapped"
      ? `proxy restart became unhealthy on ${hostname}:${port}`
      : `proxy restart never became healthy on ${hostname}:${port}`;
    updateJob(job, {
      status: "failed",
      restarted: false,
      error,
    }, restartFailureHint(port, job.installer));
    return false;
  }

  const identity = await (io.probeProxyIdentity ?? defaultProbeIdentity)(
    captured.port,
    captured.hostname,
  );
  const evidence = packageManagerSelfUpdateRestartEvidence(job, captured, identity);
  if (!evidence.ok) {
    updateJob(job, {
      status: "failed",
      restarted: false,
      error: `proxy restart did not show update-correlated identity (${evidence.reason})`,
    }, restartFailureHint(captured.port, job.installer));
    return false;
  }

  updateJob(
    job,
    {},
    `Proxy restart confirmed on ${captured.hostname}:${captured.port} (${evidence.detail}).`,
  );
  return true;
}
