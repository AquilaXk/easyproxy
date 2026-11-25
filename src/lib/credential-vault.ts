import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { loadKeyringBinding } from "./keyring-native";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed } from "./test-home-guard";

const VAULT_KEYRING_SERVICE = "easyproxy.credential-vault.v1";
const VAULT_HOME_DOMAIN = "easyproxy-credential-vault-home-v1\0";
const VAULT_ENV_SALT_DOMAIN = "easyproxy-credential-vault-env-salt-v1\0";
const VAULT_KEY_ID_DOMAIN = "easyproxy-credential-vault-key-id-v1\0";
const VAULT_ENVELOPE_DOMAIN = "easyproxy-credential-vault-envelope-v1\0";
const VAULT_FILE_NAME = ".credential-vault-key";
const VAULT_KEY_BYTES = 32;
const VAULT_NONCE_BYTES = 12;
const VAULT_TAG_BYTES = 16;
const VAULT_MAX_CIPHERTEXT_B64_CHARS = 256 * 1024;
const VAULT_MAX_KEYFILE_BYTES = 4096;
const VAULT_MAX_KEYREF_CHARS = 128;
const VAULT_MEMORY_CACHE_MAX = 64;
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const HEX_LOWER_64_RE = /^[0-9a-f]{64}$/;

export const CREDENTIAL_VAULT_ENV_KEY = "EASYPROXY_VAULT_KEY";
export const CREDENTIAL_VAULT_BACKEND_ENV = "EASYPROXY_VAULT_BACKEND";

export type CredentialVaultStoreKind = "auth" | "codex-accounts";
export type CredentialVaultBackendMode = "auto" | "keychain" | "file" | "env";

export interface CredentialVaultEnvelopeV1 {
  v: 1;
  cipher: "aes-256-gcm";
  keyRef: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  envelopeSha256: string;
}

export type CredentialVaultKeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword?(): void;
};

export type CredentialVaultKeyringFactory = (
  service: string,
  account: string,
) => CredentialVaultKeyringEntry;

export class CredentialVaultError extends Error {
  readonly code:
    | "VAULT_KEY_UNAVAILABLE"
    | "VAULT_STORAGE_UNSAFE"
    | "VAULT_TAMPERED"
    | "VAULT_DECRYPT_FAILED"
    | "VAULT_INVALID_ENVELOPE";
  readonly status: number;

  constructor(code: CredentialVaultError["code"], message: string, status = 500) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
    this.status = status;
  }
}

interface ResolvedVaultKey {
  keyRef: string;
  keyId: string;
  keyBytes: Buffer;
}

interface FileVaultKeyRecord {
  version: 1;
  homeId: string;
  keyId: string;
  keyBase64: string;
}

const envKeyCache = new Map<string, ResolvedVaultKey>();
const memoryKeyCache = new Map<string, ResolvedVaultKey>();
let keyringFactoryForTests: CredentialVaultKeyringFactory | null = null;

export function setCredentialVaultKeyringFactoryForTests(
  factory: CredentialVaultKeyringFactory | null,
): void {
  keyringFactoryForTests = factory;
  clearCredentialVaultCacheForTests();
}

export function clearCredentialVaultCacheForTests(): void {
  for (const entry of envKeyCache.values()) entry.keyBytes.fill(0);
  for (const entry of memoryKeyCache.values()) entry.keyBytes.fill(0);
  envKeyCache.clear();
  memoryKeyCache.clear();
}

function setBoundedCache(
  cache: Map<string, ResolvedVaultKey>,
  cacheKey: string,
  value: ResolvedVaultKey,
): void {
  if (cache.has(cacheKey)) {
    const old = cache.get(cacheKey)!;
    if (old !== value) old.keyBytes.fill(0);
    cache.delete(cacheKey);
  }
  while (cache.size >= VAULT_MEMORY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const old = cache.get(oldest);
    old?.keyBytes.fill(0);
    cache.delete(oldest);
  }
  cache.set(cacheKey, value);
}

function sha256Hex(parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function keyIdForBytes(keyBytes: Buffer): string {
  return sha256Hex([VAULT_KEY_ID_DOMAIN, keyBytes]).slice(0, 16);
}

function canonicalizeVaultConfigDir(inputDir?: string): string {
  const target = resolve(inputDir ?? getConfigDir());
  const unresolved: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      if (!statSync(cursor).isDirectory()) {
        throw new CredentialVaultError(
          "VAULT_STORAGE_UNSAFE",
          "Credential vault configuration root is not a directory.",
          409,
        );
      }
      return join(realpathSync.native(cursor), ...unresolved.reverse());
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CredentialVaultError(
          "VAULT_STORAGE_UNSAFE",
          "Credential vault configuration root is not safely accessible.",
          409,
        );
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new CredentialVaultError(
          "VAULT_STORAGE_UNSAFE",
          "Credential vault configuration root is not safely accessible.",
          409,
        );
      }
      unresolved.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function credentialVaultHomeId(configDir?: string): string {
  return sha256Hex([VAULT_HOME_DOMAIN, canonicalizeVaultConfigDir(configDir)]);
}

function decodeStrictBase64Key(raw: string): Buffer | null {
  const normalized = raw.trim();
  if (!normalized || normalized.length > 64) return null;
  let candidate: Buffer;
  try {
    const standard = normalized.replace(/-/g, "+").replace(/_/g, "/");
    const pad = standard.length % 4 === 0 ? "" : "=".repeat(4 - (standard.length % 4));
    candidate = Buffer.from(standard + pad, "base64");
  } catch {
    return null;
  }
  if (candidate.byteLength !== VAULT_KEY_BYTES) {
    candidate.fill(0);
    return null;
  }
  const reencodedNoPad = candidate.toString("base64").replace(/=+$/, "");
  const inputNoPad = normalized.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (reencodedNoPad !== inputNoPad) {
    candidate.fill(0);
    return null;
  }
  return candidate;
}

function parseVaultBackendMode(): CredentialVaultBackendMode {
  const raw = process.env[CREDENTIAL_VAULT_BACKEND_ENV]?.trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "keychain" || raw === "file" || raw === "env") return raw;
  throw new CredentialVaultError(
    "VAULT_KEY_UNAVAILABLE",
    `Unsupported ${CREDENTIAL_VAULT_BACKEND_ENV} mode: ${raw}`,
    500,
  );
}

function isHeadlessRuntime(): boolean {
  if (keyringFactoryForTests) return false;
  if (isTestHomeGuardArmed()) return true;
  if (process.env.CI === "1" || process.env.CI === "true") return true;
  if (
    process.platform === "linux"
    && !process.env.DBUS_SESSION_BUS_ADDRESS?.trim()
    && !process.env.XDG_RUNTIME_DIR?.trim()
  ) {
    return true;
  }
  if (process.platform === "linux" && (process.env.SSH_CONNECTION || process.env.SSH_TTY)) {
    return true;
  }
  return false;
}

function resolveEnvVaultKey(required: boolean): ResolvedVaultKey | null {
  const raw = process.env[CREDENTIAL_VAULT_ENV_KEY]?.trim();
  if (!raw) {
    if (required) {
      throw new CredentialVaultError(
        "VAULT_KEY_UNAVAILABLE",
        `${CREDENTIAL_VAULT_ENV_KEY} is required to access credential vault.`,
        503,
      );
    }
    return null;
  }
  const digest = sha256Hex([raw]);
  const cacheKey = digest;
  const cached = envKeyCache.get(cacheKey);
  if (cached) return cached;

  let keyBytes: Buffer | null = null;
  if (HEX_64_RE.test(raw)) {
    keyBytes = Buffer.from(raw, "hex");
  } else {
    keyBytes = decodeStrictBase64Key(raw);
  }
  if (!keyBytes) {
    const salt = createHash("sha256").update(VAULT_ENV_SALT_DOMAIN).digest();
    const passBuf = Buffer.from(raw, "utf8");
    try {
      keyBytes = scryptSync(passBuf, salt, VAULT_KEY_BYTES, { N: 16384, r: 8, p: 1 });
    } finally {
      passBuf.fill(0);
    }
  }
  const keyId = keyIdForBytes(keyBytes);
  const resolved: ResolvedVaultKey = {
    keyRef: `env:${keyId}`,
    keyId,
    keyBytes,
  };
  setBoundedCache(envKeyCache, cacheKey, resolved);
  return resolved;
}

function keyringEntry(homeId: string): CredentialVaultKeyringEntry {
  if (keyringFactoryForTests) return keyringFactoryForTests(VAULT_KEYRING_SERVICE, homeId);
  if (isTestHomeGuardArmed()) {
    throw new CredentialVaultError(
      "VAULT_KEY_UNAVAILABLE",
      "OS keychain vault access is disabled under guarded test runs.",
      503,
    );
  }
  const binding = loadKeyringBinding();
  return new binding.Entry(VAULT_KEYRING_SERVICE, homeId) as CredentialVaultKeyringEntry;
}

function resolveKeyringVaultKey(
  homeId: string,
  options: { createIfMissing: boolean },
): ResolvedVaultKey | null {
  const homePrefix = homeId.slice(0, 16);
  const cacheKey = `keyring\0${homeId}`;
  const cached = memoryKeyCache.get(cacheKey);
  if (cached) return cached;

  let entry: CredentialVaultKeyringEntry;
  try {
    entry = keyringEntry(homeId);
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError(
      "VAULT_KEY_UNAVAILABLE",
      `OS keychain vault entry unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }

  let existingRaw: string | null = null;
  try {
    existingRaw = entry.getPassword();
  } catch (error) {
    throw new CredentialVaultError(
      "VAULT_KEY_UNAVAILABLE",
      `OS keychain vault read failed: ${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }

  if (existingRaw !== null && existingRaw !== undefined && existingRaw.length > 0) {
    const keyBytes = decodeStrictBase64Key(existingRaw);
    if (!keyBytes) {
      throw new CredentialVaultError(
        "VAULT_TAMPERED",
        "Stored OS keychain credential vault key is invalid.",
        409,
      );
    }
    const keyId = keyIdForBytes(keyBytes);
    const resolved: ResolvedVaultKey = {
      keyRef: `keyring:${homePrefix}:${keyId}`,
      keyId,
      keyBytes,
    };
    setBoundedCache(memoryKeyCache, cacheKey, resolved);
    return resolved;
  }

  if (!options.createIfMissing) return null;

  const keyBytes = randomBytes(VAULT_KEY_BYTES);
  const b64 = keyBytes.toString("base64");
  try {
    entry.setPassword(b64);
    const readback = entry.getPassword();
    if (readback !== b64) {
      throw new Error("read-back verification mismatch");
    }
  } catch (error) {
    keyBytes.fill(0);
    throw new CredentialVaultError(
      "VAULT_KEY_UNAVAILABLE",
      `OS keychain vault write failed: ${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }
  const keyId = keyIdForBytes(keyBytes);
  const resolved: ResolvedVaultKey = {
    keyRef: `keyring:${homePrefix}:${keyId}`,
    keyId,
    keyBytes,
  };
  setBoundedCache(memoryKeyCache, cacheKey, resolved);
  return resolved;
}

function readExistingFileVaultKey(canonicalConfigDir: string): ResolvedVaultKey | null {
  const keyPath = join(canonicalConfigDir, VAULT_FILE_NAME);
  let stat;
  try {
    stat = lstatSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CredentialVaultError("VAULT_STORAGE_UNSAFE", "Credential vault keyfile cannot be inspected.", 409);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CredentialVaultError("VAULT_STORAGE_UNSAFE", "Refusing non-regular or symlinked credential vault keyfile.", 409);
  }
  if (stat.size <= 0 || stat.size > VAULT_MAX_KEYFILE_BYTES) {
    throw new CredentialVaultError("VAULT_TAMPERED", "Credential vault keyfile size is invalid.", 409);
  }
  const cacheKey = `file\0${keyPath}\0${stat.ino}\0${stat.mtimeMs}`;
  const cached = memoryKeyCache.get(cacheKey);
  if (cached) return cached;

  let parsed: Partial<FileVaultKeyRecord>;
  try {
    parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Partial<FileVaultKeyRecord>;
  } catch {
    throw new CredentialVaultError("VAULT_TAMPERED", "Credential vault keyfile is malformed.", 409);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || parsed.version !== 1
    || typeof parsed.keyId !== "string"
    || typeof parsed.keyBase64 !== "string"
  ) {
    throw new CredentialVaultError("VAULT_TAMPERED", "Credential vault keyfile failed integrity validation.", 409);
  }
  const keyBytes = decodeStrictBase64Key(parsed.keyBase64);
  if (!keyBytes || keyIdForBytes(keyBytes) !== parsed.keyId) {
    keyBytes?.fill(0);
    throw new CredentialVaultError("VAULT_TAMPERED", "Credential vault keyfile key identity mismatch.", 409);
  }
  const resolved: ResolvedVaultKey = {
    keyRef: `file:${parsed.keyId}`,
    keyId: parsed.keyId,
    keyBytes,
  };
  setBoundedCache(memoryKeyCache, cacheKey, resolved);
  return resolved;
}

function getOrCreateFileVaultKey(canonicalConfigDir: string, homeId: string): ResolvedVaultKey {
  const existing = readExistingFileVaultKey(canonicalConfigDir);
  if (existing) return existing;

  assertNotRealHomeUnderTest(canonicalConfigDir);
  if (!existsSync(canonicalConfigDir)) {
    mkdirSync(canonicalConfigDir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    try { chmodSync(canonicalConfigDir, 0o700); } catch { /* best effort */ }
  }
  const keyBytes = randomBytes(VAULT_KEY_BYTES);
  const keyId = keyIdForBytes(keyBytes);
  const record: FileVaultKeyRecord = {
    version: 1,
    homeId,
    keyId,
    keyBase64: keyBytes.toString("base64"),
  };
  const keyPath = join(canonicalConfigDir, VAULT_FILE_NAME);
  const tmpPath = join(canonicalConfigDir, `${VAULT_FILE_NAME}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  let fd: number | undefined;
  let tmpCreated = false;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    fd = openSync(tmpPath, flags, 0o600);
    tmpCreated = true;
    writeFileSync(fd, payload, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(tmpPath, keyPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      keyBytes.fill(0);
      const winner = readExistingFileVaultKey(canonicalConfigDir);
      if (winner) return winner;
    }
    keyBytes.fill(0);
    throw new CredentialVaultError(
      "VAULT_STORAGE_UNSAFE",
      `Failed to initialize credential vault keyfile: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  } finally {
    if (tmpCreated) {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  }
  if (process.platform !== "win32") {
    try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  }
  const stat = lstatSync(keyPath);
  const resolved: ResolvedVaultKey = {
    keyRef: `file:${keyId}`,
    keyId,
    keyBytes,
  };
  setBoundedCache(memoryKeyCache, `file\0${keyPath}\0${stat.ino}\0${stat.mtimeMs}`, resolved);
  return resolved;
}

function resolveActiveWriteKey(canonicalConfigDir: string, homeId: string): ResolvedVaultKey {
  const backend = parseVaultBackendMode();
  if (backend === "env") {
    return resolveEnvVaultKey(true)!;
  }
  const envKey = resolveEnvVaultKey(false);
  if (envKey) return envKey;

  if (backend === "file") {
    return getOrCreateFileVaultKey(canonicalConfigDir, homeId);
  }
  if (backend === "keychain") {
    const keyring = resolveKeyringVaultKey(homeId, { createIfMissing: true });
    if (!keyring) {
      throw new CredentialVaultError("VAULT_KEY_UNAVAILABLE", "OS keychain credential vault is unavailable.", 503);
    }
    return keyring;
  }

  // Auto mode: prefer OS keychain when non-headless and no existing local file vault key exists.
  const existingFileKey = readExistingFileVaultKey(canonicalConfigDir);
  if (isHeadlessRuntime()) {
    return existingFileKey ?? getOrCreateFileVaultKey(canonicalConfigDir, homeId);
  }
  try {
    const keyring = resolveKeyringVaultKey(homeId, { createIfMissing: !existingFileKey });
    if (keyring) return keyring;
  } catch (error) {
    if (existingFileKey) return existingFileKey;
    if (error instanceof CredentialVaultError && error.code === "VAULT_TAMPERED") throw error;
    // Headless macOS SSH / Linux DBus session unavailable: fall back to 0600 file vault.
    return getOrCreateFileVaultKey(canonicalConfigDir, homeId);
  }
  return existingFileKey ?? getOrCreateFileVaultKey(canonicalConfigDir, homeId);
}

function resolveKeyForEnvelope(
  keyRef: string,
  canonicalConfigDir: string,
  homeId: string,
): ResolvedVaultKey {
  const homePrefix = homeId.slice(0, 16);
  if (keyRef.startsWith("env:")) {
    const expectedId = keyRef.slice(4);
    const resolved = resolveEnvVaultKey(true)!;
    if (resolved.keyId !== expectedId) {
      throw new CredentialVaultError(
        "VAULT_DECRYPT_FAILED",
        `${CREDENTIAL_VAULT_ENV_KEY} does not match the credential vault key (${expectedId}).`,
        409,
      );
    }
    return resolved;
  }
  if (keyRef.startsWith("keyring:")) {
    const [, refHome, refId] = keyRef.split(":");
    if (refHome !== homePrefix || !refId) {
      throw new CredentialVaultError("VAULT_TAMPERED", "Credential vault keyring reference does not match this home.", 409);
    }
    const resolved = resolveKeyringVaultKey(homeId, { createIfMissing: false });
    if (!resolved || resolved.keyId !== refId) {
      throw new CredentialVaultError("VAULT_KEY_UNAVAILABLE", "OS keychain vault key is missing or mismatched.", 503);
    }
    return resolved;
  }
  if (keyRef.startsWith("file:")) {
    const parts = keyRef.split(":");
    const refId = parts.length === 2 ? parts[1] : parts[2];
    if (!refId) {
      throw new CredentialVaultError("VAULT_TAMPERED", "Credential vault file reference is invalid.", 409);
    }
    const resolved = readExistingFileVaultKey(canonicalConfigDir);
    if (!resolved || resolved.keyId !== refId) {
      throw new CredentialVaultError("VAULT_KEY_UNAVAILABLE", "Credential vault keyfile is missing or mismatched.", 503);
    }
    return resolved;
  }
  throw new CredentialVaultError("VAULT_INVALID_ENVELOPE", `Unsupported vault keyRef: ${keyRef}`, 409);
}

function buildVaultAad(keyRef: string, store: CredentialVaultStoreKind, slotId: string): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, keyRef, store, slotId }), "utf8");
}

function computeEnvelopeDigest(
  envelope: Pick<CredentialVaultEnvelopeV1, "keyRef" | "nonce" | "ciphertext" | "tag">,
  aadBuf: Buffer,
): string {
  const aadDigest = sha256Hex([aadBuf]);
  return sha256Hex([
    VAULT_ENVELOPE_DOMAIN,
    envelope.keyRef,
    "\0",
    envelope.nonce,
    "\0",
    envelope.ciphertext,
    "\0",
    envelope.tag,
    "\0",
    aadDigest,
  ]);
}

export function isCredentialVaultEnvelope(value: unknown): value is CredentialVaultEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<CredentialVaultEnvelopeV1>;
  return (
    v.v === 1
    && v.cipher === "aes-256-gcm"
    && typeof v.keyRef === "string"
    && v.keyRef.length > 0
    && v.keyRef.length <= VAULT_MAX_KEYREF_CHARS
    && typeof v.nonce === "string"
    && typeof v.ciphertext === "string"
    && v.ciphertext.length > 0
    && v.ciphertext.length <= VAULT_MAX_CIPHERTEXT_B64_CHARS
    && typeof v.tag === "string"
    && typeof v.envelopeSha256 === "string"
    && HEX_LOWER_64_RE.test(v.envelopeSha256)
  );
}

function sealSecretPayload(
  secrets: Record<string, unknown>,
  store: CredentialVaultStoreKind,
  slotId: string,
  canonicalConfigDir: string,
  homeId: string,
): CredentialVaultEnvelopeV1 {
  const key = resolveActiveWriteKey(canonicalConfigDir, homeId);
  const aad = buildVaultAad(key.keyRef, store, slotId);
  const nonceBuf = randomBytes(VAULT_NONCE_BYTES);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key.keyBytes, nonceBuf);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tagBuf = cipher.getAuthTag();
    const base = {
      v: 1 as const,
      cipher: "aes-256-gcm" as const,
      keyRef: key.keyRef,
      nonce: nonceBuf.toString("base64"),
      ciphertext: encrypted.toString("base64"),
      tag: tagBuf.toString("base64"),
    };
    return {
      ...base,
      envelopeSha256: computeEnvelopeDigest(base, aad),
    };
  } finally {
    plaintext.fill(0);
  }
}

function unsealSecretPayload(
  rawEnvelope: unknown,
  store: CredentialVaultStoreKind,
  slotId: string,
  canonicalConfigDir: string,
  homeId: string,
): Record<string, unknown> {
  if (!isCredentialVaultEnvelope(rawEnvelope)) {
    throw new CredentialVaultError("VAULT_INVALID_ENVELOPE", `Invalid credential vault envelope for ${store}:${slotId}.`, 409);
  }
  const nonceBuf = Buffer.from(rawEnvelope.nonce, "base64");
  const tagBuf = Buffer.from(rawEnvelope.tag, "base64");
  const cipherBuf = Buffer.from(rawEnvelope.ciphertext, "base64");
  if (nonceBuf.byteLength !== VAULT_NONCE_BYTES || tagBuf.byteLength !== VAULT_TAG_BYTES || cipherBuf.byteLength === 0) {
    throw new CredentialVaultError("VAULT_INVALID_ENVELOPE", `Malformed cipher envelope parameters for ${store}:${slotId}.`, 409);
  }
  const aad = buildVaultAad(rawEnvelope.keyRef, store, slotId);
  const expectedSha = Buffer.from(computeEnvelopeDigest(rawEnvelope, aad), "hex");
  const actualSha = Buffer.from(rawEnvelope.envelopeSha256, "hex");
  if (expectedSha.byteLength !== actualSha.byteLength || !timingSafeEqual(expectedSha, actualSha)) {
    throw new CredentialVaultError("VAULT_TAMPERED", `Credential vault integrity check failed for ${store}:${slotId}.`, 409);
  }
  const key = resolveKeyForEnvelope(rawEnvelope.keyRef, canonicalConfigDir, homeId);
  let plaintext: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.keyBytes, nonceBuf);
    decipher.setAAD(aad);
    decipher.setAuthTag(tagBuf);
    plaintext = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("non-object vault payload");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError("VAULT_DECRYPT_FAILED", `Unable to decrypt credential vault entry for ${store}:${slotId}.`, 409);
  } finally {
    plaintext?.fill(0);
  }
}

export function sealOAuthCredentialObject(
  cred: Record<string, unknown>,
  slotId: string,
  configDir?: string,
): Record<string, unknown> {
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const homeId = sha256Hex([VAULT_HOME_DOMAIN, canonicalDir]);
  const copy: Record<string, unknown> = structuredClone(cred);
  const secrets: Record<string, unknown> = {
    access: typeof copy.access === "string" ? copy.access : "",
    refresh: typeof copy.refresh === "string" ? copy.refresh : "",
  };
  delete copy.access;
  delete copy.refresh;
  delete copy.__vault;

  if (copy.kiro && typeof copy.kiro === "object" && !Array.isArray(copy.kiro)) {
    const kiro = copy.kiro as Record<string, unknown>;
    if (typeof kiro.clientSecret === "string") {
      secrets.kiroClientSecret = kiro.clientSecret;
      delete kiro.clientSecret;
    }
  }
  if (copy.muse && typeof copy.muse === "object" && !Array.isArray(copy.muse)) {
    const muse = copy.muse as Record<string, unknown>;
    if (typeof muse.oauthAccessToken === "string") {
      secrets.museOauthAccessToken = muse.oauthAccessToken;
      delete muse.oauthAccessToken;
    }
  }
  if (copy.m365 && typeof copy.m365 === "object" && !Array.isArray(copy.m365)) {
    const m365 = copy.m365 as Record<string, unknown>;
    if (typeof m365.cookie === "string") {
      secrets.m365Cookie = m365.cookie;
      delete m365.cookie;
    }
  }

  copy.__vault = sealSecretPayload(secrets, "auth", slotId, canonicalDir, homeId);
  return copy;
}

export function unsealOAuthCredentialObject(
  rawCred: unknown,
  slotId: string,
  configDir?: string,
): unknown {
  if (!rawCred || typeof rawCred !== "object" || Array.isArray(rawCred)) return rawCred;
  const record = rawCred as Record<string, unknown>;
  if (!Object.hasOwn(record, "__vault")) return rawCred;
  if (typeof record.access === "string" || typeof record.refresh === "string") {
    throw new CredentialVaultError(
      "VAULT_INVALID_ENVELOPE",
      `Ambiguous mixed plaintext and sealed OAuth credential in auth:${slotId}.`,
      409,
    );
  }
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const homeId = sha256Hex([VAULT_HOME_DOMAIN, canonicalDir]);
  const secrets = unsealSecretPayload(record.__vault, "auth", slotId, canonicalDir, homeId);
  if (typeof secrets.access !== "string" || typeof secrets.refresh !== "string") {
    throw new CredentialVaultError("VAULT_INVALID_ENVELOPE", `Incomplete OAuth vault secret payload in auth:${slotId}.`, 409);
  }
  const out: Record<string, unknown> = structuredClone(record);
  delete out.__vault;
  out.access = secrets.access;
  out.refresh = secrets.refresh;
  if (typeof secrets.kiroClientSecret === "string") {
    const existingKiro = out.kiro && typeof out.kiro === "object" && !Array.isArray(out.kiro)
      ? (out.kiro as Record<string, unknown>)
      : {};
    out.kiro = { ...existingKiro, clientSecret: secrets.kiroClientSecret };
  }
  if (typeof secrets.museOauthAccessToken === "string") {
    const existingMuse = out.muse && typeof out.muse === "object" && !Array.isArray(out.muse)
      ? (out.muse as Record<string, unknown>)
      : {};
    out.muse = { ...existingMuse, oauthAccessToken: secrets.museOauthAccessToken };
  }
  if (typeof secrets.m365Cookie === "string") {
    const existingM365 = out.m365 && typeof out.m365 === "object" && !Array.isArray(out.m365)
      ? (out.m365 as Record<string, unknown>)
      : {};
    out.m365 = { ...existingM365, cookie: secrets.m365Cookie };
  }
  return out;
}

export function sealCodexCredentialObject(
  cred: Record<string, unknown>,
  accountId: string,
  configDir?: string,
): Record<string, unknown> {
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const homeId = sha256Hex([VAULT_HOME_DOMAIN, canonicalDir]);
  const copy: Record<string, unknown> = structuredClone(cred);
  const secrets: Record<string, unknown> = {
    accessToken: typeof copy.accessToken === "string" ? copy.accessToken : "",
    refreshToken: typeof copy.refreshToken === "string" ? copy.refreshToken : "",
  };
  delete copy.accessToken;
  delete copy.refreshToken;
  delete copy.__vault;
  copy.__vault = sealSecretPayload(secrets, "codex-accounts", accountId, canonicalDir, homeId);
  return copy;
}

export function unsealCodexCredentialObject(
  rawCred: unknown,
  accountId: string,
  configDir?: string,
): unknown {
  if (!rawCred || typeof rawCred !== "object" || Array.isArray(rawCred)) return rawCred;
  const record = rawCred as Record<string, unknown>;
  if (!Object.hasOwn(record, "__vault")) return rawCred;
  if (typeof record.accessToken === "string" || typeof record.refreshToken === "string") {
    throw new CredentialVaultError(
      "VAULT_INVALID_ENVELOPE",
      `Ambiguous mixed plaintext and sealed Codex credential in codex-accounts:${accountId}.`,
      409,
    );
  }
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const homeId = sha256Hex([VAULT_HOME_DOMAIN, canonicalDir]);
  const secrets = unsealSecretPayload(record.__vault, "codex-accounts", accountId, canonicalDir, homeId);
  if (typeof secrets.accessToken !== "string" || typeof secrets.refreshToken !== "string") {
    throw new CredentialVaultError("VAULT_INVALID_ENVELOPE", `Incomplete Codex vault secret payload in codex-accounts:${accountId}.`, 409);
  }
  const out: Record<string, unknown> = structuredClone(record);
  delete out.__vault;
  out.accessToken = secrets.accessToken;
  out.refreshToken = secrets.refreshToken;
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sealAuthStoreDocument(
  store: Record<string, unknown>,
  configDir?: string,
): Record<string, unknown> {
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const out: Record<string, unknown> = {};
  for (const [provider, rawValue] of Object.entries(store)) {
    if (!isPlainRecord(rawValue)) {
      out[provider] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue.accounts)) {
      const clonedSet: Record<string, unknown> = { ...rawValue };
      clonedSet.accounts = rawValue.accounts.map(entry => {
        if (!isPlainRecord(entry) || typeof entry.id !== "string" || !isPlainRecord(entry.credential)) {
          return entry;
        }
        const cred = entry.credential;
        if (typeof cred.access === "string" && typeof cred.refresh === "string") {
          return {
            ...entry,
            credential: sealOAuthCredentialObject(cred, `${provider}:${entry.id}`, canonicalDir),
          };
        }
        return entry;
      });
      out[provider] = clonedSet;
      continue;
    }
    if (typeof rawValue.access === "string" && typeof rawValue.refresh === "string") {
      out[provider] = sealOAuthCredentialObject(rawValue, `${provider}:legacy`, canonicalDir);
      continue;
    }
    out[provider] = rawValue;
  }
  return out;
}

export function unsealAuthStoreDocument(
  store: Record<string, unknown>,
  configDir?: string,
): Record<string, unknown> {
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const out: Record<string, unknown> = {};
  for (const [provider, rawValue] of Object.entries(store)) {
    if (!isPlainRecord(rawValue)) {
      out[provider] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue.accounts)) {
      const clonedSet: Record<string, unknown> = { ...rawValue };
      clonedSet.accounts = rawValue.accounts.map(entry => {
        if (!isPlainRecord(entry) || typeof entry.id !== "string" || !isPlainRecord(entry.credential)) {
          return entry;
        }
        if (Object.hasOwn(entry.credential, "__vault")) {
          return {
            ...entry,
            credential: unsealOAuthCredentialObject(entry.credential, `${provider}:${entry.id}`, canonicalDir),
          };
        }
        return entry;
      });
      out[provider] = clonedSet;
      continue;
    }
    if (Object.hasOwn(rawValue, "__vault")) {
      out[provider] = unsealOAuthCredentialObject(rawValue, `${provider}:legacy`, canonicalDir);
      continue;
    }
    out[provider] = rawValue;
  }
  return out;
}

export function sealCodexStoreDocument(
  store: Record<string, unknown>,
  configDir?: string,
): Record<string, unknown> {
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const out: Record<string, unknown> = {};
  for (const [accountId, rawEntry] of Object.entries(store)) {
    if (!isPlainRecord(rawEntry)) {
      out[accountId] = rawEntry;
      continue;
    }
    if (isPlainRecord(rawEntry.credential)) {
      const cred = rawEntry.credential;
      if (typeof cred.accessToken === "string" && typeof cred.refreshToken === "string") {
        out[accountId] = {
          ...rawEntry,
          credential: sealCodexCredentialObject(cred, accountId, canonicalDir),
        };
        continue;
      }
    }
    if (typeof rawEntry.accessToken === "string" && typeof rawEntry.refreshToken === "string") {
      out[accountId] = sealCodexCredentialObject(rawEntry, accountId, canonicalDir);
      continue;
    }
    out[accountId] = rawEntry;
  }
  return out;
}

export function unsealCodexStoreDocument(
  store: Record<string, unknown>,
  configDir?: string,
): Record<string, unknown> {
  const canonicalDir = canonicalizeVaultConfigDir(configDir);
  const out: Record<string, unknown> = {};
  for (const [accountId, rawEntry] of Object.entries(store)) {
    if (!isPlainRecord(rawEntry)) {
      out[accountId] = rawEntry;
      continue;
    }
    if (isPlainRecord(rawEntry.credential) && Object.hasOwn(rawEntry.credential, "__vault")) {
      out[accountId] = {
        ...rawEntry,
        credential: unsealCodexCredentialObject(rawEntry.credential, accountId, canonicalDir),
      };
      continue;
    }
    if (Object.hasOwn(rawEntry, "__vault")) {
      out[accountId] = unsealCodexCredentialObject(rawEntry, accountId, canonicalDir);
      continue;
    }
    out[accountId] = rawEntry;
  }
  return out;
}
