import { describe, expect, test } from "bun:test";

import { serviceChildOwnershipDecision, serviceChildStayOutExitCode } from "../../src/service/service-child-ownership";
import type { ServiceOwnershipResolution } from "../../src/service/state";

const owned = (owner: "cli" | "desktop"): ServiceOwnershipResolution => ({
  kind: "owned",
  ownership: {
    owner,
    installId: "install-1",
    consentGeneration: 2,
  },
  revision: 1,
});

describe("service child ownership gate", () => {
  test("an ordinary child without supervisor markers proceeds regardless of ownership", () => {
    // `epx claude` and `epx opencode` set EPX_SERVICE=1 on the proxies they
    // spawn; the gate must not read that as a managed service job.
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { EPX_SERVICE: "1" },
      { EPX_WINDOWS_WRAPPER_PROTOCOL: "0" },
    ];
    for (const env of envs) {
      expect(serviceChildOwnershipDecision(env, () => owned("desktop"))).toEqual({ kind: "proceed" });
    }
  });

  test("a marker-less legacy Windows wrapper child stays out when the desktop owns the runtime", () => {
    // Registrations installed before EPX_WINDOWS_WRAPPER_PROTOCOL existed carry
    // only EPX_SERVICE=1. Their parent is still the cmd.exe running the canonical
    // wrapper script — the proof is parent evidence, not an env marker. Without
    // this check the boot wrapper resurrected an npm proxy over a desktop-owned
    // runtime; exiting 0 makes the legacy 'ERRORLEVEL NEQ 0' loop stand down.
    const env = { EPX_SERVICE: "1" };
    const deps = {
      platform: "win32" as const,
      parentPid: () => 4242,
      processCommandLine: (pid: number) =>
        pid === 4242 ? 'C:\\Windows\\System32\\cmd.exe /c "C:\\cfg\\easyproxy-service.cmd"' : undefined,
      serviceHostPaths: () => ["C:\\cfg\\easyproxy-service.cmd", "C:\\cfg\\easyproxy-service-launcher.vbs", "C:\\cfg\\winsw\\easyproxy-proxy-native.exe"],
    };
    const decision = serviceChildOwnershipDecision(env, () => owned("desktop"), deps);
    expect(decision.kind).toBe("stay-out");
    if (decision.kind !== "stay-out") return;
    expect(decision.refusal).toContain("desktop app owns the runtime");
    expect(serviceChildStayOutExitCode(env)).toBe(0);
  });

  test("a marker-less WinSW service child is identified by its host executable", () => {
    const deps = {
      platform: "win32" as const,
      parentPid: () => 5151,
      processCommandLine: () => '"C:\\cfg\\winsw\\easyproxy-proxy-native.exe"',
      serviceHostPaths: () => ["C:\\cfg\\easyproxy-service.cmd", "C:\\cfg\\winsw\\easyproxy-proxy-native.exe"],
    };
    const decision = serviceChildOwnershipDecision({ EPX_SERVICE: "1" }, () => owned("desktop"), deps);
    expect(decision.kind).toBe("stay-out");
  });

  test("marker-less POSIX children proceed: no ppid-based supervisor guess", () => {
    // Deliberate scope-out: reparented companions can look init-spawned and
    // systemd --user units are not init children, so POSIX supervision is only
    // trusted when the explicit EPX_SERVICE_MANAGED marker is present.
    for (const platform of ["darwin", "linux"] as const) {
      for (const ppid of [1, 1337]) {
        const decision = serviceChildOwnershipDecision(
          { EPX_SERVICE: "1" },
          () => owned("desktop"),
          { platform, parentPid: () => ppid, processCommandLine: () => undefined, serviceHostPaths: () => [] },
        );
        expect(decision.kind).toBe("proceed");
      }
    }
  });

  test("an `epx claude` companion with only EPX_SERVICE=1 proceeds even under desktop ownership", () => {
    // The companion's parent is the invoking CLI, never a registered service
    // host — so the same EPX_SERVICE=1 env that flags the wrapper must not
    // refuse a proxy no manager supervises.
    const deps = {
      platform: "win32" as const,
      parentPid: () => 9000,
      processCommandLine: () => '"C:\\tools\\bun.exe" "C:\\pkg\\src\\cli\\index.ts" claude',
      serviceHostPaths: () => ["C:\\cfg\\easyproxy-service.cmd", "C:\\cfg\\winsw\\easyproxy-proxy-native.exe"],
    };
    expect(serviceChildOwnershipDecision({ EPX_SERVICE: "1" }, () => owned("desktop"), deps)).toEqual({
      kind: "proceed",
    });
  });

  test("a partial-path lookalike in the parent command line is not service-host evidence", () => {
    const deps = {
      platform: "win32" as const,
      parentPid: () => 4242,
      processCommandLine: () => "C:\\Windows\\System32\\cmd.exe /c C:\\cfg\\easyproxy-service.cmd.bak",
      serviceHostPaths: () => ["C:\\cfg\\easyproxy-service.cmd"],
    };
    expect(serviceChildOwnershipDecision({ EPX_SERVICE: "1" }, () => owned("desktop"), deps)).toEqual({
      kind: "proceed",
    });
  });

  test("a lookalike before the real path still finds the wrapper token", () => {
    const deps = {
      platform: "win32" as const,
      parentPid: () => 4242,
      processCommandLine: () =>
        'C:\\Windows\\System32\\cmd.exe /c C:\\cfg\\easyproxy-service.cmd.bak "C:\\cfg\\easyproxy-service.cmd"',
      serviceHostPaths: () => ["C:\\cfg\\easyproxy-service.cmd"],
    };
    const decision = serviceChildOwnershipDecision({ EPX_SERVICE: "1" }, () => owned("desktop"), deps);
    expect(decision.kind).toBe("stay-out");
  });

  test("an unreadable parent command line cannot refuse a marker-less child", () => {
    const deps = {
      platform: "win32" as const,
      parentPid: () => 4242,
      processCommandLine: () => undefined,
      serviceHostPaths: () => ["C:\\cfg\\easyproxy-service.cmd"],
    };
    expect(serviceChildOwnershipDecision({ EPX_SERVICE: "1" }, () => owned("desktop"), deps)).toEqual({
      kind: "proceed",
    });
  });

  test("a supervised child stays out when the desktop owns the runtime", () => {
    for (const env of [
      { EPX_SERVICE_MANAGED: "1", EPX_SERVICE: "1" },
      { EPX_WINDOWS_WRAPPER_PROTOCOL: "1", EPX_SERVICE: "1" },
      // A stray marker without EPX_SERVICE still reads as supervised: after
      // detachedStartEnvironment strips all three, a marker-only process should
      // not exist — and if it somehow does, refusing under a foreign owner is
      // the conservative answer.
      { EPX_SERVICE_MANAGED: "1" },
      { EPX_WINDOWS_WRAPPER_PROTOCOL: "1" },
    ]) {
      const decision = serviceChildOwnershipDecision(env, () => owned("desktop"));
      expect(decision.kind).toBe("stay-out");
      if (decision.kind !== "stay-out") return;
      expect(decision.refusal).toContain("desktop app owns the runtime");
    }
  });

  test("a supervised child proceeds for its own cli registration or no claim", () => {
    const env = { EPX_SERVICE_MANAGED: "1", EPX_SERVICE: "1" };
    expect(serviceChildOwnershipDecision(env, () => owned("cli"))).toEqual({ kind: "proceed" });
    expect(serviceChildOwnershipDecision(env, () => ({ kind: "none", revision: 0 }))).toEqual({ kind: "proceed" });
  });

  test("an unreadable ownership record stays out rather than guessing", () => {
    const env = { EPX_WINDOWS_WRAPPER_PROTOCOL: "1", EPX_SERVICE: "1" };
    const decision = serviceChildOwnershipDecision(
      env,
      () => ({ kind: "unknown", reason: "service-state.json is unreadable" }),
    );
    expect(decision.kind).toBe("stay-out");
    if (decision.kind !== "stay-out") return;
    expect(decision.refusal).toContain("could not be determined");
  });

  test("the stay-out exit is the wrapper protocol code only inside the Windows wrapper", () => {
    expect(serviceChildStayOutExitCode({ EPX_SERVICE: "1", EPX_WINDOWS_WRAPPER_PROTOCOL: "1" })).toBe(42);
    expect(serviceChildStayOutExitCode({ EPX_SERVICE_MANAGED: "1", EPX_SERVICE: "1" })).toBe(0);
  });
});
