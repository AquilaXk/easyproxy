import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportProfileBackup,
  inspectProfileBackup,
  MAX_PROFILE_BACKUP_BYTES,
  readProfileBackupFile,
  readSnapshotEntryForBackup,
  restoreProfileBackup,
  setProfileBackupTestHooks,
} from "../../src/config/profile-backup";
import { getDefaultConfig, getConfigPath, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleConfigCommand } from "../../src/cli/config-command";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { createOAuthFileLock, getAuthStoreLockPath } from "../../src/oauth/store";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let sandboxRoot: string;
let configDir: string;
let prevEasyproxyHome: string | undefined;

function makeBackupRequest(path: string, method: "POST", body: unknown): Request {
  return new ManagementRequest(`http://127.0.0.1:10100${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedRichProfile(dir: string): void {
  const cfg = getDefaultConfig();
  cfg.proxy = "http://globaluser:globalpass@proxy.example.test:8080";
  cfg.providers["custom-anth"] = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-top-secret-key",
    apiKeyPool: [{ id: "k1", key: "sk-ant-pool-secret" }, { id: "k2", key: "keychain:os-vault-slot" }],
    headers: { "X-Custom-Secret": "hdr-secret-val" },
    proxy: "http://puser:ppass@provider-proxy.example.test:8080",
    mcpServers: {
      srv: { command: "npx", args: ["-y", "srv"], env: { MCP_SECRET: "mcp-env-secret" } },
    },
    desktopExecutor: {
      command: "node",
      args: ["exec.js"],
      env: { EXEC_SECRET: "exec-env-secret" },
    },
    promptCacheKey: "prompt-cache-stay-intact",
    modelCosts: {
      "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    defaultModel: "claude-sonnet-4-5",
  } as typeof cfg.providers[string];
  cfg.codexRoleCapability = {
    artificialAnalysis: { apiKey: "aa-secret-key" },
  };
  cfg.webSearchSidecar = {
    backend: "openai",
    exaApiKey: "exa-secret-key",
  };
  cfg.quotaResetNotify = {
    enabled: true,
    webhookUrl: "https://hooks.example.test/secret-hook",
  };
  cfg.apiKeys = [{ key: "epx-client-secret-key", name: "dev-laptop" }] as typeof cfg.apiKeys;
  cfg.telemetry = { decision: "accepted", decidedAt: "2026-02-02T00:00:00.000Z" };
  saveConfig(cfg);
  // Ensure source on-disk telemetry and optional fields exist cleanly for tests.
  const srcDisk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
  srcDisk.telemetry = { decision: "accepted", decidedAt: "2026-02-02T00:00:00.000Z" };
  srcDisk.proxy = "http://globaluser:globalpass@proxy.example.test:8080";
  srcDisk.codexRoleCapability = { artificialAnalysis: { apiKey: "aa-secret-key" } };
  srcDisk.webSearchSidecar = { backend: "openai", exaApiKey: "exa-secret-key" };
  srcDisk.quotaResetNotify = { enabled: true, webhookUrl: "https://hooks.example.test/secret-hook" };
  writeFileSync(getConfigPath(), JSON.stringify(srcDisk, null, 2));

  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    anthropic: [{ id: "acct-1", accessToken: "oauth-tok-secret" }],
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({
    accounts: { "codex-1": { refreshToken: "codex-refresh-secret" } },
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "local-credentials.json"), JSON.stringify({
    version: 1,
    epoch: randomUUID(),
    sequence: 4,
    pending: [],
    keyAccounts: ["local-cred-secret-account"],
    absentAccounts: [],
    coverage: null,
  }, null, 2), { mode: 0o600 });
  mkdirSync(join(dir, "integrations"), { recursive: true });
  writeFileSync(join(dir, "integrations", "records.json"), JSON.stringify({
    records: [{ clientId: "opencode", state: "applied" }],
  }, null, 2), { mode: 0o600 });
}

beforeEach(() => {
  prevEasyproxyHome = process.env.EASYPROXY_HOME;
  sandboxRoot = mkdtempSync(join(tmpdir(), "epx-profile-backup-"));
  configDir = join(sandboxRoot, "epx-home");
  mkdirSync(configDir, { recursive: true });
  process.env.EASYPROXY_HOME = configDir;
  seedRichProfile(configDir);
});

afterEach(() => {
  setProfileBackupTestHooks(null);
  resetSiblingStartForTests();
  if (prevEasyproxyHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = prevEasyproxyHome;
  removeTreeWithRetry(sandboxRoot);
});

describe("full profile backup and restore (epx.profile.backup/1)", () => {
  test("exports encrypted bundle with AAD integrity, excludes host-local local-credentials.json, and restores while preserving telemetry and client topology", async () => {
    const bundle = await exportProfileBackup({ mode: "encrypted", passphrase: "correct-horse-battery" });
    expect(bundle.schema).toBe("epx.profile.backup/1");
    expect(bundle.mode).toBe("encrypted");
    expect(bundle.kdf?.n).toBe(32768);
    expect(bundle.summary.providerCount).toBeGreaterThanOrEqual(2);
    expect(bundle.summary.hasLocalCredentials).toBe(true);
    expect(bundle.summary.includedFiles).not.toContain("local-credentials.json");
    expect(JSON.stringify(bundle)).not.toContain("sk-ant-top-secret-key");
    expect(JSON.stringify(bundle)).not.toContain("oauth-tok-secret");
    expect(JSON.stringify(bundle)).not.toContain("local-cred-secret-account");
    expect(JSON.stringify(bundle)).not.toContain("2026-02-02T00:00:00.000Z");

    // Inspect succeeds with right passphrase and fails closed on wrong passphrase or tampered AAD
    const inspected = await inspectProfileBackup(bundle, "correct-horse-battery");
    expect(inspected.valid).toBe(true);
    expect(inspected.summary.includedFiles).toContain("auth.json");
    expect(inspected.summary.includedFiles).not.toContain("local-credentials.json");

    await expect(inspectProfileBackup(bundle, "wrong-passphrase")).rejects.toMatchObject({
      code: "invalid_backup_passphrase",
    });

    const tampered = structuredClone(bundle);
    tampered.summary.providerCount = 999;
    await expect(inspectProfileBackup(tampered, "correct-horse-battery")).rejects.toMatchObject({
      code: "invalid_backup_passphrase",
    });

    // Target machine has different telemetry, active connected client topology, AND its own local-credentials.json
    const targetDir = join(sandboxRoot, "target-home");
    mkdirSync(targetDir, { recursive: true });
    process.env.EASYPROXY_HOME = targetDir;
    const targetCfg = getDefaultConfig();
    targetCfg.runtimeRole = "client";
    targetCfg.client = {
      serverUrl: "https://hub.example.com",
      managementUrl: "https://hub.example.com",
      managementTransport: "direct",
      selectedClients: [],
      tokenEnv: "EASYPROXY_API_AUTH_TOKEN",
      apiKeyId: "dev-99",
      tokenFingerprint: "a".repeat(64),
      protocolVersion: 1,
      connectedAt: "2026-01-01T00:00:00.000Z",
    } as typeof targetCfg.client;
    saveConfig(targetCfg);
    const targetDisk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    targetDisk.telemetry = { decision: "declined", decidedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(getConfigPath(), JSON.stringify(targetDisk, null, 2));
    writeFileSync(join(targetDir, "auth.json"), JSON.stringify({ stale: true }));
    const targetEpoch = randomUUID();
    const targetLocalCreds = JSON.stringify({
      version: 1,
      epoch: targetEpoch,
      sequence: 99,
      pending: [],
      keyAccounts: ["target-existing-os-account"],
      absentAccounts: [],
      coverage: null,
    }, null, 2);
    writeFileSync(join(targetDir, "local-credentials.json"), targetLocalCreds, { mode: 0o600 });

    const restored = await restoreProfileBackup(bundle, { passphrase: "correct-horse-battery" });
    expect(restored.restoredFiles).toContain("config.json");
    expect(restored.restoredFiles).toContain("auth.json");
    expect(restored.restoredFiles).not.toContain("local-credentials.json");
    expect(restored.removedFiles).not.toContain("local-credentials.json");
    const afterTargetLocalCreds = JSON.parse(readFileSync(join(targetDir, "local-credentials.json"), "utf8")) as {
      epoch: string;
      keyAccounts: string[];
    };
    expect(afterTargetLocalCreds.epoch).toBe(targetEpoch);
    expect(afterTargetLocalCreds.keyAccounts).toContain("target-existing-os-account");
    expect(afterTargetLocalCreds.keyAccounts).not.toContain("local-cred-secret-account");
    expect(existsSync(restored.preRestoreSnapshotPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(restored.preRestoreSnapshotPath).mode & 0o777).toBe(0o600);
    }

    const afterCfg = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(afterCfg.providers["custom-anth"].apiKey).toBe("sk-ant-top-secret-key");
    expect(afterCfg.telemetry.decision).toBe("declined");
    expect(afterCfg.telemetry.decidedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(afterCfg.runtimeRole).toBe("client");
    expect(afterCfg.client.apiKeyId).toBe("dev-99");
    expect(JSON.parse(readFileSync(join(targetDir, "auth.json"), "utf8")).anthropic[0].accessToken).toBe("oauth-tok-secret");
    expect(JSON.parse(readFileSync(join(targetDir, "codex-accounts.json"), "utf8")).accounts["codex-1"].refreshToken).toBe("codex-refresh-secret");
  });

  test("redacted mode strips all nested/provider secrets while preserving valid schema, and pre-restore snapshots cap at 5", async () => {
    const redacted = await exportProfileBackup({ mode: "redacted" });
    expect(redacted.mode).toBe("redacted");
    expect(redacted.summary.hasLocalCredentials).toBe(false);
    const inspectedRedacted = await inspectProfileBackup(redacted);
    expect(inspectedRedacted.valid).toBe(true);

    const serialized = JSON.stringify(redacted);
    for (const leaked of [
      "sk-ant-top-secret-key",
      "sk-ant-pool-secret",
      "hdr-secret-val",
      "epx-client-secret-key",
      "oauth-tok-secret",
      "codex-refresh-secret",
      "local-cred-secret-account",
      "globaluser",
      "globalpass",
      "puser",
      "ppass",
      "mcp-env-secret",
      "exec-env-secret",
      "aa-secret-key",
      "exa-secret-key",
      "https://hooks.example.test/secret-hook",
      "2026-02-02T00:00:00.000Z",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(serialized).toContain("prompt-cache-stay-intact");
    if (redacted.mode === "redacted") {
      const cfg = redacted.payload.files["config.json"];
      expect(cfg.proxy).toBeUndefined();
      expect(cfg.codexRoleCapability).toBeUndefined();
      expect((cfg.webSearchSidecar as Record<string, unknown> | undefined)?.exaApiKey).toBeUndefined();
      expect((cfg.quotaResetNotify as Record<string, unknown> | undefined)?.enabled).toBe(false);
      expect((cfg.quotaResetNotify as Record<string, unknown> | undefined)?.webhookUrl).toBeUndefined();
      const prov = (cfg.providers as Record<string, Record<string, unknown>>)["custom-anth"]!;
      expect(prov.proxy).toBeUndefined();
      expect(prov.mcpServers).toBeUndefined();
      expect(prov.desktopExecutor).toBeUndefined();
      expect(prov.modelCosts).toEqual({ "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    }
    expect(redacted.summary.includedFiles).not.toContain("auth.json");

    // Trigger 7 restores and assert max 5 snapshots retained
    for (let i = 0; i < 7; i++) {
      await restoreProfileBackup(redacted);
    }
    const backups = readdirSync(join(configDir, "backups")).filter(f => f.startsWith("pre-restore-"));
    expect(backups.length).toBeLessThanOrEqual(5);
  });

  test("enforces passphrase length, nesting depth, symlink refusal, and >32MiB file cap", async () => {
    await expect(exportProfileBackup({ mode: "encrypted", passphrase: "short" })).rejects.toThrow(/8/i);
    await expect(exportProfileBackup({ mode: "encrypted", passphrase: "a".repeat(513) })).rejects.toThrow(/512|long|byte/i);

    const symPath = join(sandboxRoot, "sym-backup.json");
    const realFile = join(sandboxRoot, "real.json");
    writeFileSync(realFile, "{}");
    symlinkSync(realFile, symPath);
    expect(() => readProfileBackupFile(symPath, MAX_PROFILE_BACKUP_BYTES)).toThrow(/symlink/i);

    const deepJson = `${"[".repeat(18)}1${"]".repeat(18)}`;
    await expect(inspectProfileBackup(deepJson)).rejects.toThrow(/depth|nesting/i);
  });

  test("management routes export, preview, restore and honor sibling guard", async () => {
    const config = getDefaultConfig();
    const deps = {
      saveConfig: (c: typeof config) => saveConfig(c),
      saveConfigPreservingClaudeCode: (c: typeof config) => saveConfig(c),
      onQuit: () => {},
      convergeCodexCatalog: async () => ({ status: "ok" as const, modelCount: 0 }),
    } as never;

    const callMgmt = (req: Request) => handleManagementAPI(req, new URL(req.url), config, deps);

    const exportRes = await callMgmt(makeBackupRequest("/api/profile/backup/export", "POST", {
      mode: "encrypted",
      passphrase: "route-secret-passphrase",
    }));
    expect(exportRes?.status).toBe(200);
    const bundle = await exportRes!.json();

    const wrongRes = await callMgmt(makeBackupRequest("/api/profile/backup/preview", "POST", {
      bundle,
      passphrase: "wrong-passphrase",
    }));
    expect(wrongRes?.status).toBe(400);
    expect((await wrongRes!.json() as { code: string }).code).toBe("invalid_backup_passphrase");

    markSiblingStart(10100);
    const siblingRes = await callMgmt(makeBackupRequest("/api/profile/backup/restore", "POST", {
      bundle,
      passphrase: "route-secret-passphrase",
    }));
    expect(siblingRes?.status).toBe(409);
    resetSiblingStartForTests();

    const restoreRes = await callMgmt(makeBackupRequest("/api/profile/backup/restore", "POST", {
      bundle,
      passphrase: "route-secret-passphrase",
    }));
    expect(restoreRes?.status).toBe(200);
    expect(config.providers["custom-anth"]?.apiKey).toBe("sk-ant-top-secret-key");
  });

  test("CLI config backup export/inspect/restore handles --passphrase-file and --yes", async () => {
    const passFile = join(sandboxRoot, "pass.txt");
    const outFile = join(sandboxRoot, "profile.epxbackup.json");
    writeFileSync(passFile, "cli-strong-passphrase\n", { mode: 0o600 });

    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    try {
      const expCode = await handleConfigCommand([
        "backup", "export", "--mode", "encrypted", "--out", outFile, "--passphrase-file", passFile, "--json",
      ]);
      expect(expCode).toBe(0);
      expect(existsSync(outFile)).toBe(true);

      const insCode = await handleConfigCommand([
        "backup", "inspect", outFile, "--passphrase-file", passFile, "--json",
      ]);
      expect(insCode).toBe(0);
      expect(JSON.parse(logs.at(-1)!).valid).toBe(true);

      const noYesCode = await handleConfigCommand([
        "backup", "restore", outFile, "--passphrase-file", passFile, "--json",
      ]);
      expect(noYesCode).toBe(2);

      const resCode = await handleConfigCommand([
        "backup", "restore", outFile, "--passphrase-file", passFile, "--yes", "--json",
      ]);
      expect(resCode).toBe(0);
      expect(JSON.parse(logs.at(-1)!).restoredFiles).toContain("config.json");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("restoreProfileBackup recovers when disk config.json has corrupted JSON and keeps bounded raw fallback in pre-restore snapshot", async () => {
    const bundle = await exportProfileBackup({ mode: "encrypted", passphrase: "recover-passphrase" });
    const corruptRaw = "{ not valid json ::: broken";
    writeFileSync(getConfigPath(), corruptRaw, "utf8");

    const restored = await restoreProfileBackup(bundle, { passphrase: "recover-passphrase" });
    expect(restored.restoredFiles).toContain("config.json");
    const restoredCfg = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(restoredCfg.providers["custom-anth"].apiKey).toBe("sk-ant-top-secret-key");

    const snapshot = JSON.parse(readFileSync(restored.preRestoreSnapshotPath, "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(snapshot.files["config.json"]).toEqual({
      corrupted: true,
      rawText: corruptRaw,
    });

    // Oversized store files must still fail closed rather than degrading to raw fallback.
    expect(() => readSnapshotEntryForBackup(getConfigPath(), 16)).toThrow(/limit|bytes|exceeds/i);

    // Symlinked store files must still fail closed rather than collapsing into fallback.
    const symlinkTarget = join(sandboxRoot, "outside.json");
    writeFileSync(symlinkTarget, "{}");
    writeFileSync(join(configDir, "auth.json"), "bad");
    const symAuth = join(configDir, "codex-accounts.json");
    if (existsSync(symAuth)) {
      // Remove existing regular file to replace with symlink
      removeTreeWithRetry(symAuth);
    }
    symlinkSync(symlinkTarget, symAuth);
    await expect(restoreProfileBackup(bundle, { passphrase: "recover-passphrase" })).rejects.toMatchObject({
      code: "backup_symlink_refused",
    });
  });

  test("restoreProfileBackup compensates auxiliary stores in reverse order on mid-restore failure", async () => {
    const bundle = await exportProfileBackup({ mode: "encrypted", passphrase: "rollback-passphrase" });

    // Mutate local target stores so we can prove rollback restores prior bytes + unlinks newly created files.
    const targetDir = join(sandboxRoot, "rollback-home");
    mkdirSync(join(targetDir, "integrations"), { recursive: true });
    process.env.EASYPROXY_HOME = targetDir;
    const baseCfg = getDefaultConfig();
    baseCfg.defaultProvider = "openai-codex";
    saveConfig(baseCfg);
    const originalConfigBytes = readFileSync(getConfigPath(), "utf8");
    const originalRecordsBytes = JSON.stringify({ records: [{ clientId: "prior", state: "disabled" }] }, null, 2);
    const originalAuthBytes = JSON.stringify({ priorAuth: true }, null, 2);
    writeFileSync(join(targetDir, "integrations", "records.json"), originalRecordsBytes);
    writeFileSync(join(targetDir, "auth.json"), originalAuthBytes);
    // Leave codex-accounts.json absent initially to also verify newly created files don't linger.

    setProfileBackupTestHooks({
      onBeforeWriteStore: storeKey => {
        if (storeKey === "config.json") {
          throw new Error("simulated persistConfigUnlocked failure");
        }
      },
    });

    await expect(restoreProfileBackup(bundle, { passphrase: "rollback-passphrase" })).rejects.toThrow(
      "simulated persistConfigUnlocked failure",
    );

    expect(readFileSync(getConfigPath(), "utf8")).toBe(originalConfigBytes);
    expect(readFileSync(join(targetDir, "integrations", "records.json"), "utf8")).toBe(originalRecordsBytes);
    expect(readFileSync(join(targetDir, "auth.json"), "utf8")).toBe(originalAuthBytes);
    expect(existsSync(join(targetDir, "codex-accounts.json"))).toBe(false);
  });

  test("management route returns 409 profile_backup_busy on OAuth file lock contention and CLI routes through live proxy", async () => {
    const config = getDefaultConfig();
    const deps = {
      saveConfig: (c: typeof config) => saveConfig(c),
      saveConfigPreservingClaudeCode: (c: typeof config) => saveConfig(c),
      onQuit: () => {},
      convergeCodexCatalog: async () => ({ status: "ok" as const, modelCount: 0 }),
    } as never;
    const callMgmt = (req: Request) => handleManagementAPI(req, new URL(req.url), config, deps);

    const exportRes = await callMgmt(makeBackupRequest("/api/profile/backup/export", "POST", {
      mode: "redacted",
    }));
    expect(exportRes?.status).toBe(200);
    const bundle = await exportRes!.json();

    // Hold real auth.json file lock to deterministically force OAuthFileLockError -> HTTP 409.
    const lock = createOAuthFileLock({ path: getAuthStoreLockPath(), waitTimeoutMs: 5000 });
    const guard = await lock.acquire();
    setProfileBackupTestHooks({ authLockWaitTimeoutMs: 10 });
    try {
      const busyRes = await callMgmt(makeBackupRequest("/api/profile/backup/restore", "POST", { bundle }));
      expect(busyRes?.status).toBe(409);
      expect((await busyRes!.json() as { code: string }).code).toBe("profile_backup_busy");
    } finally {
      guard.release();
      setProfileBackupTestHooks(null);
    }

    // Verify CLI `epx config backup` routes export/inspect/restore through live non-client proxy when available.
    const seenPaths: string[] = [];
    const cliOut = join(sandboxRoot, "live-cli-backup.epxbackup.json");
    const liveDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const reqUrl = new URL(typeof input === "string" ? input : input.toString());
        seenPaths.push(reqUrl.pathname);
        const res = await handleManagementAPI(
          new ManagementRequest(reqUrl.toString(), {
            method: init?.method ?? "GET",
            headers: init?.headers,
            body: init?.body,
          }),
          reqUrl,
          config,
          deps,
        );
        return res!;
      }) as typeof fetch,
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      expect(await handleConfigCommand(["backup", "export", "--mode", "redacted", "--out", cliOut, "--json"], liveDeps)).toBe(0);
      expect(await handleConfigCommand(["backup", "inspect", cliOut, "--json"], liveDeps)).toBe(0);
      expect(await handleConfigCommand(["backup", "restore", cliOut, "--yes", "--json"], liveDeps)).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(seenPaths).toEqual([
      "/api/profile/backup/export",
      "/api/profile/backup/preview",
      "/api/profile/backup/restore",
    ]);
  });

  test("restoreProfileBackup maps CredentialVaultError to ProfileBackupError offline and invalidates cached credential stores", async () => {
    const oauthStore = await import("../../src/oauth/store");
    const codexEpoch = await import("../../src/codex/credential-mutation-epoch");
    const credentialVault = await import("../../src/lib/credential-vault");

    // Seed an OAuth account + codex-accounts.json and export an encrypted backup.
    await oauthStore.upsertCredentialByIdentity("xai", {
      access: "tok-1",
      refresh: "ref-1",
      expires: Date.now() + 60_000,
      email: "a@example.com",
    });
    writeFileSync(join(configDir, "codex-accounts.json"), JSON.stringify({
      accounts: { "codex-1": { refreshToken: "codex-refresh-1" } },
    }, null, 2), { mode: 0o600 });
    const bundle = await exportProfileBackup({ mode: "encrypted", passphrase: "vault-sync-passphrase" });

    // Populate peekAuthStoreCache and snapshot Codex mutation epoch.
    expect(oauthStore.peekAuthStore().xai?.accounts[0]?.credential.access).toBe("tok-1");
    const epochBefore = codexEpoch.codexCredentialMutationEpoch();

    // Update OAuth account to a different token before restoring older bundle.
    await oauthStore.upsertCredentialByIdentity("xai", {
      access: "tok-2",
      refresh: "ref-2",
      expires: Date.now() + 60_000,
      email: "a@example.com",
    });
    expect(oauthStore.peekAuthStore().xai?.accounts[0]?.credential.access).toBe("tok-2");

    // Restoring bundle must invalidate cached auth store and advance Codex mutation epoch.
    await restoreProfileBackup(bundle, { passphrase: "vault-sync-passphrase" });
    expect(oauthStore.peekAuthStore().xai?.accounts[0]?.credential.access).toBe("tok-1");
    expect(codexEpoch.codexCredentialMutationEpoch()).toBeGreaterThan(epochBefore);

    // Simulate unavailable credential vault during restore -> maps cleanly to ProfileBackupError (backup_vault_unavailable).
    const { spyOn } = await import("bun:test");
    const sealSpy = spyOn(credentialVault, "sealAuthStoreDocument").mockImplementation(() => {
      throw new credentialVault.CredentialVaultError("VAULT_KEY_UNAVAILABLE", "simulated offline vault missing", 503);
    });
    try {
      await expect(restoreProfileBackup(bundle, { passphrase: "vault-sync-passphrase" })).rejects.toMatchObject({
        name: "ProfileBackupError",
        code: "backup_vault_unavailable",
        status: 503,
      });
    } finally {
      sealSpy.mockRestore();
    }
  });
});
