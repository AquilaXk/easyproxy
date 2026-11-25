import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

const SECRET_BYTES = 32;
const DOMAIN = "easyproxy-codex-installation-id-v1\0";
const WINDOW_DOMAIN = "easyproxy-codex-window-id-v1\0";
const WINDOW_ORDINAL_SUFFIX = /:(\d{1,4})$/;

/** Sanitized, retryable refusal: neither a path nor a credential belongs in its cause. */
export class CodexInstallationIdUnavailableError extends Error {
  constructor() {
    super("Codex installation identity unavailable");
    this.name = "CodexInstallationIdUnavailableError";
  }
}

function readSecret(path: string): Buffer {
  // Refuse links and non-files; never rotate an unreadable or corrupt persisted secret.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== SECRET_BYTES) throw new CodexInstallationIdUnavailableError();
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    hardenSecretPath(path, { required: true });
    const bytes = readFileSync(fd);
    if (bytes.length !== SECRET_BYTES) throw new CodexInstallationIdUnavailableError();
    return bytes;
  } finally { closeSync(fd); }
}

function installationSecret(dir: string): Buffer {
  assertNotRealHomeUnderTest(dir);
  // Each secret file gets its own required, inheritance-protected DACL before reading or
  // writing bytes. Optional parent/sibling hardening cannot admit or refuse this file.
  const path = join(dir, "codex-installation-secret");
  try { return readSecret(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Make new files private at creation: Windows ignores POSIX mode 0600.
  hardenSecretDir(dir, { required: true });
  // Publish complete bytes without replacing another process's winning secret.
  const temporary = join(dir, `.codex-installation-secret-${randomBytes(16).toString("hex")}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      hardenSecretPath(temporary, { required: true });
      writeFileSync(fd, randomBytes(SECRET_BYTES));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return readSecret(path);
  } finally { unlinkSync(temporary); }
}

function deriveAccountUuid(domain: string, accountKey: string, configDir: string): string {
  const account = accountKey.trim();
  if (!account) throw new CodexInstallationIdUnavailableError();
  const bytes = createHmac("sha256", installationSecret(configDir)).update(domain).update(account).digest().subarray(0, 16);
  // RFC 9562 §5.4 layout; pseudorandom HMAC bits replace per-request randomness.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable per upstream account and local installation, independent of bearer/caller identity. */
export function codexInstallationIdForAccount(accountKey: string, configDir = getConfigDir()): string {
  try {
    return deriveAccountUuid(DOMAIN, accountKey, configDir);
  } catch { throw new CodexInstallationIdUnavailableError(); }
}

/**
 * Stable per-account `x-codex-window-id` derived via HMAC so rotating pool accounts never carry
 * a single caller window identifier across accounts. Preserves an optional numeric tab ordinal
 * (`:0`, `:1`, ...) while remaining idempotent on repeated isolation passes.
 */
export function codexWindowIdForAccount(accountKey: string, callerWindowId?: string, configDir = getConfigDir()): string {
  try {
    const uuid = deriveAccountUuid(WINDOW_DOMAIN, accountKey, configDir);
    const trimmed = callerWindowId?.trim() ?? "";
    const ordinalMatch = trimmed ? WINDOW_ORDINAL_SUFFIX.exec(trimmed) : null;
    return `${uuid}:${ordinalMatch ? ordinalMatch[1] : "0"}`;
  } catch { throw new CodexInstallationIdUnavailableError(); }
}
