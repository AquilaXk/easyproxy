import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCredentialVaultCacheForTests,
  CREDENTIAL_VAULT_BACKEND_ENV,
  CREDENTIAL_VAULT_ENV_KEY,
  CredentialVaultError,
  setCredentialVaultKeyringFactoryForTests,
} from "../../src/lib/credential-vault";
import { saveCredential, getAccountSet, countLocalOAuthCredentialSlots, getAuthStorePath } from "../../src/oauth/store";
import { observeActiveOAuthAccessToken } from "../../src/oauth";
import {
  getCodexAccountCredential,
  inspectLocalCodexCredentialSlots,
  peekCodexAccountRecordStore,
  saveCodexAccountCredential,
} from "../../src/codex/account-store";
import { containsConfiguredCredentialExcerpt } from "../../src/server/configured-credentials";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

let testDir = "";
let prevHome: string | undefined;
let prevVaultKey: string | undefined;
let prevVaultBackend: string | undefined;

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  clearCredentialVaultCacheForTests();
  setCredentialVaultKeyringFactoryForTests(null);
  prevHome = process.env.EASYPROXY_HOME;
  prevVaultKey = process.env[CREDENTIAL_VAULT_ENV_KEY];
  prevVaultBackend = process.env[CREDENTIAL_VAULT_BACKEND_ENV];
  delete process.env[CREDENTIAL_VAULT_ENV_KEY];
  delete process.env[CREDENTIAL_VAULT_BACKEND_ENV];
  testDir = mkdtempSync(join(tmpdir(), "epx-cred-vault-"));
  process.env.EASYPROXY_HOME = testDir;
});

afterEach(async () => {
  setCredentialVaultKeyringFactoryForTests(null);
  clearCredentialVaultCacheForTests();
  if (prevHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = prevHome;
  if (prevVaultKey === undefined) delete process.env[CREDENTIAL_VAULT_ENV_KEY];
  else process.env[CREDENTIAL_VAULT_ENV_KEY] = prevVaultKey;
  if (prevVaultBackend === undefined) delete process.env[CREDENTIAL_VAULT_BACKEND_ENV];
  else process.env[CREDENTIAL_VAULT_BACKEND_ENV] = prevVaultBackend;
  await flushConfigDirHardeningForTests();
  if (testDir) removeTreeWithRetry(testDir);
});

describe("credential vault storage for auth.json and codex-accounts.json", () => {
  test("headless file vault creates 0600 keyfile and seals auth.json + codex-accounts.json secrets", async () => {
    await saveCredential("kiro", {
      access: "kiro-access-secret-987654",
      refresh: "kiro-refresh-secret-654321",
      expires: Date.now() + 3_600_000,
      email: "vault-user@example.test",
      accountId: "kiro-acct-1",
      kiro: {
        authType: "aws_sso_oidc",
        ssoRegion: "us-east-1",
        apiRegion: "us-east-1",
        clientId: "kiro-public-client-id",
        clientSecret: "kiro-client-secret-top",
      },
    });
    saveCodexAccountCredential("codex-slot-1", {
      accessToken: "codex-access-secret-112233",
      refreshToken: "codex-refresh-secret-445566",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "cgpt-acct-1",
    });

    const keyfilePath = join(testDir, ".credential-vault-key");
    expect(existsSync(keyfilePath)).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(keyfilePath).mode & 0o777).toBe(0o600);
    }

    const rawAuth = readFileSync(getAuthStorePath(), "utf8");
    const rawCodex = readFileSync(join(testDir, "codex-accounts.json"), "utf8");
    expect(rawAuth).toContain('"__vault"');
    expect(rawAuth).not.toContain("kiro-access-secret-987654");
    expect(rawAuth).not.toContain("kiro-refresh-secret-654321");
    expect(rawAuth).not.toContain("kiro-client-secret-top");
    expect(rawAuth).toContain("kiro-public-client-id");

    expect(rawCodex).toContain('"__vault"');
    expect(rawCodex).not.toContain("codex-access-secret-112233");
    expect(rawCodex).not.toContain("codex-refresh-secret-445566");
    expect(rawCodex).toContain("cgpt-acct-1");

    const loadedOAuth = getAccountSet("kiro")?.accounts[0]?.credential;
    expect(loadedOAuth?.access).toBe("kiro-access-secret-987654");
    expect(loadedOAuth?.refresh).toBe("kiro-refresh-secret-654321");
    expect(loadedOAuth?.kiro?.clientSecret).toBe("kiro-client-secret-top");

    const loadedCodex = getCodexAccountCredential("codex-slot-1");
    expect(loadedCodex?.accessToken).toBe("codex-access-secret-112233");
    expect(loadedCodex?.refreshToken).toBe("codex-refresh-secret-445566");
    expect(loadedCodex?.chatgptAccountId).toBe("cgpt-acct-1");

    expect(countLocalOAuthCredentialSlots(JSON.parse(rawAuth))).toBe(1);
    expect(inspectLocalCodexCredentialSlots(JSON.parse(rawCodex)).count).toBe(1);
    expect(containsConfiguredCredentialExcerpt("leaked kiro-access-secret-987654 token")).toBe(true);
    expect(observeActiveOAuthAccessToken("kiro", readFileSync(getAuthStorePath()))).toMatchObject({
      kind: "available",
      snapshot: { accessToken: "kiro-access-secret-987654" },
    });
  });

  test("EASYPROXY_VAULT_KEY seals without creating .credential-vault-key and fails closed if key changes", async () => {
    process.env[CREDENTIAL_VAULT_ENV_KEY] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await saveCredential("xai", {
      access: "env-xai-access-secret",
      refresh: "env-xai-refresh-secret",
      expires: Date.now() + 3_600_000,
      email: "env@example.test",
    });
    saveCodexAccountCredential("codex-env-1", {
      accessToken: "env-codex-access",
      refreshToken: "env-codex-refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "cgpt-env-1",
    });

    expect(existsSync(join(testDir, ".credential-vault-key"))).toBe(false);
    const rawAuthBefore = readFileSync(getAuthStorePath(), "utf8");
    expect(rawAuthBefore).toContain('"env:');

    process.env[CREDENTIAL_VAULT_ENV_KEY] = "wrong-passphrase-for-test";
    clearCredentialVaultCacheForTests();
    expect(() => getAccountSet("xai")).toThrow(CredentialVaultError);
    expect(peekCodexAccountRecordStore()).toEqual({});
    expect(() => saveCodexAccountCredential("codex-new", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 1000,
      chatgptAccountId: "cgpt-new",
    })).toThrow(CredentialVaultError);
    // Locked vault files remain intact on disk (never moved to .invalid-* or wiped).
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(rawAuthBefore);

    delete process.env[CREDENTIAL_VAULT_ENV_KEY];
    clearCredentialVaultCacheForTests();
    expect(() => getAccountSet("xai")).toThrow(CredentialVaultError);

    process.env[CREDENTIAL_VAULT_ENV_KEY] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    clearCredentialVaultCacheForTests();
    expect(getAccountSet("xai")?.accounts[0]?.credential.access).toBe("env-xai-access-secret");
    expect(getCodexAccountCredential("codex-env-1")?.refreshToken).toBe("env-codex-refresh");
  });

  test("OS keychain backend stores 256-bit key in keyring without keyfile and verifies read-back", async () => {
    const ring = new Map<string, string>();
    setCredentialVaultKeyringFactoryForTests((service, account) => ({
      getPassword: () => ring.get(`${service}:${account}`) ?? null,
      setPassword: (value: string) => { ring.set(`${service}:${account}`, value); },
    }));
    process.env[CREDENTIAL_VAULT_BACKEND_ENV] = "keychain";

    await saveCredential("anthropic", {
      access: "keyring-ant-access",
      refresh: "keyring-ant-refresh",
      expires: Date.now() + 3_600_000,
      email: "ring@example.test",
    });

    expect(existsSync(join(testDir, ".credential-vault-key"))).toBe(false);
    expect(ring.size).toBe(1);
    const rawAuth = readFileSync(getAuthStorePath(), "utf8");
    expect(rawAuth).toContain('"keyring:');
    expect(rawAuth).not.toContain("keyring-ant-access");
    expect(getAccountSet("anthropic")?.accounts[0]?.credential.refresh).toBe("keyring-ant-refresh");

    // Simulate failed keychain read-back when creating a brand new home.
    clearCredentialVaultCacheForTests();
    const brokenDir = mkdtempSync(join(tmpdir(), "epx-cred-vault-broken-ring-"));
    try {
      process.env.EASYPROXY_HOME = brokenDir;
      setCredentialVaultKeyringFactoryForTests(() => ({
        getPassword: () => null,
        setPassword: () => { /* drop write silently to fail readback */ },
      }));
      await expect(saveCredential("anthropic", {
        access: "a",
        refresh: "r",
        expires: Date.now() + 1000,
      })).rejects.toThrow(CredentialVaultError);
    } finally {
      removeTreeWithRetry(brokenDir);
    }
  });

  test("tampered ciphertext, cross-slot AAD swap, and symlinked keyfile fail closed", async () => {
    await saveCredential("anthropic", {
      access: "slot-a-access",
      refresh: "slot-a-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-a",
    });
    await saveCredential("anthropic", {
      access: "slot-b-access",
      refresh: "slot-b-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-b",
    });

    const parsed = JSON.parse(readFileSync(getAuthStorePath(), "utf8"));
    const slot0Vault = parsed.anthropic.accounts[0].credential.__vault;
    const slot1Vault = parsed.anthropic.accounts[1].credential.__vault;
    // Cross-slot envelope swap must fail AAD + SHA-256 verification.
    parsed.anthropic.accounts[0].credential.__vault = slot1Vault;
    writeFileSync(getAuthStorePath(), JSON.stringify(parsed, null, 2), "utf8");
    clearCredentialVaultCacheForTests();
    expect(() => getAccountSet("anthropic")).toThrow(CredentialVaultError);
    expect(observeActiveOAuthAccessToken("anthropic", readFileSync(getAuthStorePath()))).toEqual({ kind: "malformed" });

    // Restore original and tamper envelopeSha256.
    parsed.anthropic.accounts[0].credential.__vault = {
      ...slot0Vault,
      envelopeSha256: "0".repeat(64),
    };
    writeFileSync(getAuthStorePath(), JSON.stringify(parsed, null, 2), "utf8");
    expect(() => getAccountSet("anthropic")).toThrow(CredentialVaultError);

    // Symlinked .credential-vault-key refuses with VAULT_STORAGE_UNSAFE.
    const symlinkHome = mkdtempSync(join(tmpdir(), "epx-cred-vault-sym-"));
    try {
      mkdirSync(symlinkHome, { recursive: true });
      const externalKey = join(testDir, ".credential-vault-key");
      symlinkSync(externalKey, join(symlinkHome, ".credential-vault-key"));
      process.env.EASYPROXY_HOME = symlinkHome;
      clearCredentialVaultCacheForTests();
      await expect(saveCredential("xai", {
        access: "x",
        refresh: "y",
        expires: Date.now() + 1000,
      })).rejects.toThrow(CredentialVaultError);
    } finally {
      removeTreeWithRetry(symlinkHome);
    }
  });

  test("copied headless home and legacy plaintext stores upgrade cleanly", async () => {
    writeFileSync(getAuthStorePath(), JSON.stringify({
      xai: {
        access: "legacy-plain-access",
        refresh: "legacy-plain-refresh",
        expires: Date.now() + 3_600_000,
      },
    }), "utf8");
    expect(getAccountSet("xai")?.accounts[0]?.credential.access).toBe("legacy-plain-access");

    saveCodexAccountCredential("copy-slot", {
      accessToken: "copy-access",
      refreshToken: "copy-refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "cgpt-copy",
    });

    const clonedHome = mkdtempSync(join(tmpdir(), "epx-cred-vault-clone-"));
    try {
      cpSync(testDir, clonedHome, { recursive: true });
      process.env.EASYPROXY_HOME = clonedHome;
      clearCredentialVaultCacheForTests();
      expect(getCodexAccountCredential("copy-slot")?.accessToken).toBe("copy-access");
    } finally {
      removeTreeWithRetry(clonedHome);
    }
  });
});
