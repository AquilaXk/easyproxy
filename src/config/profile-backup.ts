import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { readClientConnectionState } from "../client/state";
import { integrationsDir } from "../integrations/ownership";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import {
  CredentialVaultError,
  sealAuthStoreDocument,
  sealCodexStoreDocument,
  unsealAuthStoreDocument,
  unsealCodexStoreDocument,
} from "../lib/credential-vault";
import { assertJsonNestingDepth, JsonNestingDepthExceededError } from "../lib/json-depth-guard";
import { packageVersion } from "../lib/package-version";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { publishCredentialSync } from "../local-credentials/generation";
import { advanceCodexCredentialMutationEpoch } from "../codex/credential-mutation-epoch";
import { invalidateCodexAccountStoreCache } from "../codex/account-store";
import { osStoreAccounts } from "../local-credentials/references";
import { createOAuthFileLock, getAuthStoreLockPath, getAuthStorePath, invalidateAuthStoreCache, OAUTH_REFRESH_LOCK_WAIT_MS } from "../oauth/store";
import { REDACTED_PROVIDER_FIELDS } from "../server/auth-cors";
import type { EpxConfig } from "../types";
import { atomicWriteFileNoFollow, atomicWriteFileNoFollowUnclaimed } from "./atomic-write";
import { readConfigDiagnostics, validateConfigCandidate } from "./diagnostics";
import { bumpGenerationForCooperatingConfigWrite, withConfigMutationLockSync } from "./mutation-lock";
import { getConfigDir, getConfigPath, withConfigDirHardeningSettled } from "./paths";
import { ConfigWritePublishedError, persistConfigUnlocked } from "./persist-unlocked";
import { projectPersistedConfigMigrations } from "./persisted-projections";
import { projectConfigRebaseProvenance } from "./rebase-provenance";

export const PROFILE_BACKUP_SCHEMA = "epx.profile.backup/1" as const;
export const MAX_PROFILE_BACKUP_BYTES = 32 * 1024 * 1024;
export const MAX_PROFILE_BACKUP_DEPTH = 16;
export const MAX_PRE_RESTORE_SNAPSHOTS = 5;
export const MIN_BACKUP_PASSPHRASE_CHARS = 8;
export const MAX_BACKUP_PASSPHRASE_BYTES = 512;

export const BACKUP_SCRYPT_N = 32768;
export const BACKUP_SCRYPT_R = 8;
export const BACKUP_SCRYPT_P = 1;
export const BACKUP_SCRYPT_KEY_LEN = 32;
export const BACKUP_SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type ProfileBackupMode = "encrypted" | "redacted";

export class ProfileBackupError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "profile_backup_error",
  ) {
    super(message);
    this.name = "ProfileBackupError";
  }
}

export interface ProfileBackupSummary {
  providerCount: number;
  oauthAccountCount: number;
  codexAccountCount: number;
  hasLocalCredentials: boolean;
  integrationRecordCount: number;
  includedFiles: string[];
}

export interface ProfileBackupKdf {
  name: "scrypt";
  salt: string;
  n: 32768;
  r: 8;
  p: 1;
  keyLen: 32;
}

export interface ProfileBackupCipher {
  name: "aes-256-gcm";
  iv: string;
  tag: string;
}

export interface ProfileBackupFilesPayload {
  files: {
    "config.json": Record<string, unknown>;
    "auth.json"?: Record<string, unknown>;
    "codex-accounts.json"?: Record<string, unknown>;
    "local-credentials.json"?: Record<string, unknown>;
    "integrations/records.json"?: Record<string, unknown>;
  };
}

export interface EncryptedProfileBackupBundle {
  schema: typeof PROFILE_BACKUP_SCHEMA;
  mode: "encrypted";
  createdAt: string;
  appVersion: string;
  summary: ProfileBackupSummary;
  kdf: ProfileBackupKdf;
  cipher: ProfileBackupCipher;
  ciphertext: string;
}

export interface RedactedProfileBackupBundle {
  schema: typeof PROFILE_BACKUP_SCHEMA;
  mode: "redacted";
  createdAt: string;
  appVersion: string;
  summary: ProfileBackupSummary;
  payload: ProfileBackupFilesPayload;
}

export type ProfileBackupBundle = EncryptedProfileBackupBundle | RedactedProfileBackupBundle;

export interface InspectProfileBackupResult {
  schema: typeof PROFILE_BACKUP_SCHEMA;
  mode: ProfileBackupMode;
  createdAt: string;
  appVersion: string;
  valid: boolean;
  summary: ProfileBackupSummary;
  configValidation: { ok: boolean; error?: string };
}

export interface RestoreProfileBackupResult {
  schemaVersion: 1;
  mode: ProfileBackupMode;
  restoredFiles: string[];
  removedFiles: string[];
  preRestoreSnapshotPath: string;
  summary: ProfileBackupSummary;
}

const SummarySchema = z.object({
  providerCount: z.number().int().min(0),
  oauthAccountCount: z.number().int().min(0),
  codexAccountCount: z.number().int().min(0),
  hasLocalCredentials: z.boolean(),
  integrationRecordCount: z.number().int().min(0),
  includedFiles: z.array(z.string().min(1)).min(1).max(16),
}).strict();

const EncryptedBundleSchema = z.object({
  schema: z.literal(PROFILE_BACKUP_SCHEMA),
  mode: z.literal("encrypted"),
  createdAt: z.string().min(1).max(64),
  appVersion: z.string().min(1).max(64),
  summary: SummarySchema,
  kdf: z.object({
    name: z.literal("scrypt"),
    salt: z.string().min(16).max(128),
    n: z.literal(BACKUP_SCRYPT_N),
    r: z.literal(BACKUP_SCRYPT_R),
    p: z.literal(BACKUP_SCRYPT_P),
    keyLen: z.literal(BACKUP_SCRYPT_KEY_LEN),
  }).strict(),
  cipher: z.object({
    name: z.literal("aes-256-gcm"),
    iv: z.string().min(12).max(64),
    tag: z.string().min(16).max(64),
  }).strict(),
  ciphertext: z.string().min(1),
}).strict();

const RedactedBundleSchema = z.object({
  schema: z.literal(PROFILE_BACKUP_SCHEMA),
  mode: z.literal("redacted"),
  createdAt: z.string().min(1).max(64),
  appVersion: z.string().min(1).max(64),
  summary: SummarySchema,
  payload: z.object({
    files: z.object({
      "config.json": z.record(z.string(), z.unknown()),
      "integrations/records.json": z.record(z.string(), z.unknown()).optional(),
    }).strict(),
  }).strict(),
}).strict();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJsonString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonString(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJsonString(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildEncryptedAad(header: {
  schema: typeof PROFILE_BACKUP_SCHEMA;
  mode: "encrypted";
  createdAt: string;
  appVersion: string;
  kdf: ProfileBackupKdf;
  summary: ProfileBackupSummary;
}): Buffer {
  const canonical = canonicalJsonString({
    schema: header.schema,
    mode: header.mode,
    createdAt: header.createdAt,
    appVersion: header.appVersion,
    kdf: header.kdf,
    summary: header.summary,
  });
  return Buffer.from(canonical, "utf8");
}

function validatePassphrase(passphrase: unknown): Buffer {
  if (typeof passphrase !== "string") {
    throw new ProfileBackupError("Backup passphrase is required for encrypted mode.", 400, "invalid_backup_passphrase");
  }
  if (passphrase.length < MIN_BACKUP_PASSPHRASE_CHARS) {
    throw new ProfileBackupError(
      `Backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_CHARS} characters.`,
      400,
      "invalid_backup_passphrase",
    );
  }
  const buf = Buffer.from(passphrase, "utf8");
  if (buf.byteLength > MAX_BACKUP_PASSPHRASE_BYTES) {
    throw new ProfileBackupError(
      `Backup passphrase must not exceed ${MAX_BACKUP_PASSPHRASE_BYTES} UTF-8 bytes.`,
      400,
      "invalid_backup_passphrase",
    );
  }
  return buf;
}

export function readProfileBackupFile(filePath: string, maxBytes = MAX_PROFILE_BACKUP_BYTES): Buffer {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      throw new ProfileBackupError(`Backup file not found: ${filePath}`, 404, "backup_file_not_found");
    }
    throw new ProfileBackupError(`Cannot inspect backup file: ${(error as Error).message}`, 400, "backup_io_error");
  }
  if (stat.isSymbolicLink()) {
    throw new ProfileBackupError("Refusing symlinked backup file", 400, "backup_symlink_refused");
  }
  if (!stat.isFile()) {
    throw new ProfileBackupError("Backup path must be a regular file", 400, "backup_invalid_file");
  }
  try {
    return readBoundedRegularFileSync(filePath, maxBytes);
  } catch (error) {
    const msg = (error as Error)?.message ?? String(error);
    if (msg.includes("not bounded regular data") || msg.includes("exceeds byte limit")) {
      throw new ProfileBackupError(`Backup file exceeds limit of ${maxBytes} bytes`, 413, "backup_too_large");
    }
    throw new ProfileBackupError(`Cannot read backup file: ${msg}`, 400, "backup_io_error");
  }
}

export interface ProfileBackupTestHooks {
  authLockWaitTimeoutMs?: number;
  onBeforeWriteStore?: (storeKey: string, storePath: string) => void;
}

let profileBackupTestHooks: ProfileBackupTestHooks | null = null;

export function setProfileBackupTestHooks(hooks: ProfileBackupTestHooks | null): void {
  profileBackupTestHooks = hooks;
}

const MAX_PRE_RESTORE_RAW_TEXT_CHARS = 1024 * 1024;

export type PreRestoreStoreEntry =
  | { kind: "absent" }
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "corrupt"; rawText: string };

interface StoreFileSnapshot {
  path: string;
  rawBytes: Buffer | null;
  entry: PreRestoreStoreEntry;
}

function readOptionalBoundedStoreBytes(filePath: string, maxBytes = MAX_PROFILE_BACKUP_BYTES): Buffer | undefined {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return undefined;
    throw new ProfileBackupError(`Cannot read ${filePath}: ${(error as Error).message}`, 400, "backup_io_error");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProfileBackupError(`Refusing non-regular or symlinked store file: ${filePath}`, 400, "backup_symlink_refused");
  }
  try {
    return readBoundedRegularFileSync(filePath, maxBytes);
  } catch (error) {
    const msg = (error as Error)?.message ?? String(error);
    if (msg.includes("not bounded regular data") || msg.includes("exceeds byte limit")) {
      throw new ProfileBackupError(`Profile store file exceeds limit of ${maxBytes} bytes: ${filePath}`, 413, "backup_too_large");
    }
    throw new ProfileBackupError(`Cannot read ${filePath}: ${msg}`, 400, "backup_io_error");
  }
}

function parseOptionalJsonObjectBytes(bytes: Buffer, filePath: string): Record<string, unknown> {
  try {
    assertJsonNestingDepth(bytes, MAX_PROFILE_BACKUP_DEPTH);
  } catch (error) {
    if (error instanceof JsonNestingDepthExceededError) {
      throw new ProfileBackupError(error.message, 400, "backup_depth_exceeded");
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProfileBackupError(`Invalid JSON in profile store file: ${filePath}`, 400, "backup_invalid_json");
  }
  if (!isPlainRecord(parsed)) {
    throw new ProfileBackupError(`Expected JSON object in ${filePath}`, 400, "backup_invalid_schema");
  }
  return parsed;
}

function readOptionalJsonObject(filePath: string, maxBytes = MAX_PROFILE_BACKUP_BYTES): Record<string, unknown> | undefined {
  const bytes = readOptionalBoundedStoreBytes(filePath, maxBytes);
  if (!bytes) return undefined;
  return parseOptionalJsonObjectBytes(bytes, filePath);
}

function readStoreSnapshotAndBytes(
  filePath: string,
  maxBytes = MAX_PROFILE_BACKUP_BYTES,
): StoreFileSnapshot {
  const bytes = readOptionalBoundedStoreBytes(filePath, maxBytes);
  if (!bytes) return { path: filePath, rawBytes: null, entry: { kind: "absent" } };
  try {
    return {
      path: filePath,
      rawBytes: bytes,
      entry: { kind: "json", value: parseOptionalJsonObjectBytes(bytes, filePath) },
    };
  } catch (error) {
    const isMalformed =
      error instanceof SyntaxError
      || (error instanceof ProfileBackupError && (error.code === "backup_invalid_json" || error.code === "backup_invalid_schema"));
    if (!isMalformed) throw error;
    const raw = bytes.toString("utf8");
    const rawText = raw.length > MAX_PRE_RESTORE_RAW_TEXT_CHARS
      ? `${raw.slice(0, MAX_PRE_RESTORE_RAW_TEXT_CHARS)}\n...[truncated]`
      : raw;
    return {
      path: filePath,
      rawBytes: bytes,
      entry: { kind: "corrupt", rawText },
    };
  }
}

/**
 * Reads an existing profile store file once for pre-restore snapshots and recovery.
 * Symlinks, non-regular files, and byte-cap violations still fail closed; only malformed
 * JSON or non-object payloads degrade to a bounded raw-text snapshot fallback.
 */
export function readSnapshotEntryForBackup(
  filePath: string,
  maxBytes = MAX_PROFILE_BACKUP_BYTES,
): PreRestoreStoreEntry {
  return readStoreSnapshotAndBytes(filePath, maxBytes).entry;
}

const REDACTED_SECRET_FIELD_KEYS = new Set([
  "apiKey",
  "exaApiKey",
  "accessToken",
  "refreshToken",
  "idToken",
  "password",
  "clientSecret",
  "webhookUrl",
]);

function stripResidualSecretsRecursive(value: unknown, parentKey?: string): void {
  if (parentKey === "modelCosts") return;
  if (Array.isArray(value)) {
    for (const item of value) stripResidualSecretsRecursive(item);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (REDACTED_SECRET_FIELD_KEYS.has(key)) {
      delete value[key];
    } else {
      stripResidualSecretsRecursive(child, key);
    }
  }
}

function stripRedactedConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(config);
  delete cloned.telemetry;
  delete cloned.apiKeys;
  delete cloned.proxy;

  if (isPlainRecord(cloned.providers)) {
    for (const providerValue of Object.values(cloned.providers)) {
      if (!isPlainRecord(providerValue)) continue;
      for (const field of REDACTED_PROVIDER_FIELDS) {
        delete providerValue[field];
      }
    }
  }

  if (isPlainRecord(cloned.codexRoleCapability)) {
    if (isPlainRecord(cloned.codexRoleCapability.artificialAnalysis)) {
      delete cloned.codexRoleCapability.artificialAnalysis.apiKey;
      if (Object.keys(cloned.codexRoleCapability.artificialAnalysis).length === 0) {
        delete cloned.codexRoleCapability.artificialAnalysis;
      }
    }
    if (Object.keys(cloned.codexRoleCapability).length === 0) {
      delete cloned.codexRoleCapability;
    }
  }

  if (isPlainRecord(cloned.webSearchSidecar)) {
    delete cloned.webSearchSidecar.exaApiKey;
  }

  if (isPlainRecord(cloned.quotaResetNotify)) {
    delete cloned.quotaResetNotify.webhookUrl;
    const hasCommand = Array.isArray(cloned.quotaResetNotify.command)
      ? cloned.quotaResetNotify.command.length > 0
      : Boolean(cloned.quotaResetNotify.command);
    if (cloned.quotaResetNotify.enabled === true && !hasCommand) {
      cloned.quotaResetNotify.enabled = false;
    }
  }

  if (isPlainRecord(cloned.otlp)) {
    delete cloned.otlp.headers;
  }

  stripResidualSecretsRecursive(cloned);
  return cloned;
}

function countOAuthAccounts(authDoc: Record<string, unknown> | undefined): number {
  if (!authDoc) return 0;
  let total = 0;
  for (const val of Object.values(authDoc)) {
    if (Array.isArray(val)) total += val.length;
    else if (isPlainRecord(val)) total += 1;
  }
  return total;
}

function countCodexAccounts(codexDoc: Record<string, unknown> | undefined): number {
  if (!codexDoc) return 0;
  if (isPlainRecord(codexDoc.accounts)) return Object.keys(codexDoc.accounts).length;
  if (Array.isArray(codexDoc.accounts)) return codexDoc.accounts.length;
  return 0;
}

function countIntegrationRecords(recordsDoc: Record<string, unknown> | undefined): number {
  if (!recordsDoc) return 0;
  if (Array.isArray(recordsDoc.records)) return recordsDoc.records.length;
  if (isPlainRecord(recordsDoc.records)) return Object.keys(recordsDoc.records).length;
  return Object.keys(recordsDoc).length;
}

export async function exportProfileBackup(options: {
  mode: ProfileBackupMode;
  passphrase?: string;
}): Promise<ProfileBackupBundle> {
  if (options.mode !== "encrypted" && options.mode !== "redacted") {
    throw new ProfileBackupError(`Unsupported backup mode: ${String(options.mode)}`, 400, "invalid_backup_mode");
  }

  let passphraseBuf: Buffer | null = null;
  if (options.mode === "encrypted") {
    passphraseBuf = validatePassphrase(options.passphrase);
  }

  const configDir = getConfigDir();
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source === "fallback" && diagnostics.error) {
    throw new ProfileBackupError(`Current configuration is invalid (${diagnostics.error})`, 400, "invalid_config");
  }

  const rawConfigOnDisk = readOptionalJsonObject(getConfigPath());
  const configDoc = structuredClone((rawConfigOnDisk ?? diagnostics.config) as Record<string, unknown>);
  delete configDoc.telemetry;

  const recordsPath = join(integrationsDir(configDir), "records.json");
  const recordsDoc = readOptionalJsonObject(recordsPath);

  const createdAt = new Date().toISOString();
  const appVersion = packageVersion("0.0.0");

  if (options.mode === "redacted") {
    const redactedConfig = stripRedactedConfigSecrets(configDoc);
    const files: RedactedProfileBackupBundle["payload"]["files"] = {
      "config.json": redactedConfig,
      ...(recordsDoc ? { "integrations/records.json": recordsDoc } : {}),
    };
    const includedFiles = Object.keys(files);
    const providerCount = isPlainRecord(redactedConfig.providers) ? Object.keys(redactedConfig.providers).length : 0;

    return {
      schema: PROFILE_BACKUP_SCHEMA,
      mode: "redacted",
      createdAt,
      appVersion,
      summary: {
        providerCount,
        oauthAccountCount: 0,
        codexAccountCount: 0,
        hasLocalCredentials: false,
        integrationRecordCount: countIntegrationRecords(recordsDoc),
        includedFiles,
      },
      payload: { files },
    };
  }

  const rawAuthDoc = readOptionalJsonObject(getAuthStorePath());
  const rawCodexDoc = readOptionalJsonObject(join(configDir, "codex-accounts.json"));
  let authDoc: Record<string, unknown> | undefined;
  let codexDoc: Record<string, unknown> | undefined;
  try {
    authDoc = rawAuthDoc ? unsealAuthStoreDocument(rawAuthDoc, configDir) : undefined;
    codexDoc = rawCodexDoc ? unsealCodexStoreDocument(rawCodexDoc, configDir) : undefined;
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      throw new ProfileBackupError(error.message, error.status, "backup_vault_unavailable");
    }
    throw error;
  }

  // local-credentials.json tracks host-local OS Keychain / Credential Manager tickets & epoch;
  // it is deliberately excluded from portable profile backups.
  const files: ProfileBackupFilesPayload["files"] = {
    "config.json": configDoc,
    ...(authDoc ? { "auth.json": authDoc } : {}),
    ...(codexDoc ? { "codex-accounts.json": codexDoc } : {}),
    ...(recordsDoc ? { "integrations/records.json": recordsDoc } : {}),
  };
  const includedFiles = Object.keys(files);
  const providerCount = isPlainRecord(configDoc.providers) ? Object.keys(configDoc.providers).length : 0;

  const summary: ProfileBackupSummary = {
    providerCount,
    oauthAccountCount: countOAuthAccounts(authDoc),
    codexAccountCount: countCodexAccounts(codexDoc),
    hasLocalCredentials: osStoreAccounts(configDoc as unknown as EpxConfig).length > 0,
    integrationRecordCount: countIntegrationRecords(recordsDoc),
    includedFiles,
  };

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const kdf: ProfileBackupKdf = {
    name: "scrypt",
    salt: salt.toString("base64"),
    n: BACKUP_SCRYPT_N,
    r: BACKUP_SCRYPT_R,
    p: BACKUP_SCRYPT_P,
    keyLen: BACKUP_SCRYPT_KEY_LEN,
  };

  let derivedKey: Buffer | null = null;
  try {
    derivedKey = scryptSync(passphraseBuf!, salt, BACKUP_SCRYPT_KEY_LEN, {
      N: BACKUP_SCRYPT_N,
      r: BACKUP_SCRYPT_R,
      p: BACKUP_SCRYPT_P,
      maxmem: BACKUP_SCRYPT_MAXMEM,
    });
    const aad = buildEncryptedAad({
      schema: PROFILE_BACKUP_SCHEMA,
      mode: "encrypted",
      createdAt,
      appVersion,
      kdf,
      summary,
    });
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify({ files }), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      schema: PROFILE_BACKUP_SCHEMA,
      mode: "encrypted",
      createdAt,
      appVersion,
      summary,
      kdf,
      cipher: {
        name: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
      },
      ciphertext: encrypted.toString("base64"),
    };
  } finally {
    derivedKey?.fill(0);
    passphraseBuf?.fill(0);
  }
}

function parseRawBundleInput(input: unknown, maxBytes = MAX_PROFILE_BACKUP_BYTES): Record<string, unknown> {
  let rawObject: unknown;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    const rawBuf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    if (rawBuf.byteLength > maxBytes) {
      throw new ProfileBackupError(`Backup bundle exceeds limit of ${maxBytes} bytes`, 413, "backup_too_large");
    }
    try {
      assertJsonNestingDepth(rawBuf, MAX_PROFILE_BACKUP_DEPTH);
    } catch (error) {
      if (error instanceof JsonNestingDepthExceededError) {
        throw new ProfileBackupError(error.message, 400, "backup_depth_exceeded");
      }
      throw error;
    }
    try {
      rawObject = JSON.parse(rawBuf.toString("utf8"));
    } catch {
      throw new ProfileBackupError("Backup bundle is not valid JSON", 400, "backup_invalid_json");
    }
  } else {
    const serialized = Buffer.from(JSON.stringify(input ?? null), "utf8");
    if (serialized.byteLength > maxBytes) {
      throw new ProfileBackupError(`Backup bundle exceeds limit of ${maxBytes} bytes`, 413, "backup_too_large");
    }
    try {
      assertJsonNestingDepth(serialized, MAX_PROFILE_BACKUP_DEPTH);
    } catch (error) {
      if (error instanceof JsonNestingDepthExceededError) {
        throw new ProfileBackupError(error.message, 400, "backup_depth_exceeded");
      }
      throw error;
    }
    rawObject = input;
  }

  if (!isPlainRecord(rawObject)) {
    throw new ProfileBackupError("Backup bundle must be a JSON object", 400, "backup_invalid_schema");
  }
  return rawObject;
}

function decryptAndExtractBundle(
  input: unknown,
  passphrase?: string,
  maxBytes = MAX_PROFILE_BACKUP_BYTES,
): { bundle: ProfileBackupBundle; files: ProfileBackupFilesPayload["files"] } {
  const raw = parseRawBundleInput(input, maxBytes);
  const mode = raw.mode;
  if (mode === "redacted") {
    const parsed = RedactedBundleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProfileBackupError(`Invalid redacted profile backup bundle: ${parsed.error.issues[0]?.message ?? "schema error"}`, 400, "backup_invalid_schema");
    }
    return {
      bundle: parsed.data,
      files: {
        "config.json": parsed.data.payload.files["config.json"],
        ...(parsed.data.payload.files["integrations/records.json"]
          ? { "integrations/records.json": parsed.data.payload.files["integrations/records.json"] }
          : {}),
      },
    };
  }

  if (mode === "encrypted") {
    const parsed = EncryptedBundleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProfileBackupError(`Invalid encrypted profile backup bundle: ${parsed.error.issues[0]?.message ?? "schema error"}`, 400, "backup_invalid_schema");
    }
    const passphraseBuf = validatePassphrase(passphrase);
    const bundle = parsed.data;
    const salt = Buffer.from(bundle.kdf.salt, "base64");
    const iv = Buffer.from(bundle.cipher.iv, "base64");
    const tag = Buffer.from(bundle.cipher.tag, "base64");
    const ciphertext = Buffer.from(bundle.ciphertext, "base64");
    if (salt.byteLength !== 32 || iv.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
      passphraseBuf.fill(0);
      throw new ProfileBackupError("Encrypted backup cryptographic parameters are malformed", 400, "invalid_backup_passphrase");
    }

    let derivedKey: Buffer | null = null;
    try {
      derivedKey = scryptSync(passphraseBuf, salt, BACKUP_SCRYPT_KEY_LEN, {
        N: BACKUP_SCRYPT_N,
        r: BACKUP_SCRYPT_R,
        p: BACKUP_SCRYPT_P,
        maxmem: BACKUP_SCRYPT_MAXMEM,
      });
      const aad = buildEncryptedAad({
        schema: bundle.schema,
        mode: "encrypted",
        createdAt: bundle.createdAt,
        appVersion: bundle.appVersion,
        kdf: bundle.kdf,
        summary: bundle.summary,
      });
      const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const decryptedBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (decryptedBuf.byteLength > MAX_PROFILE_BACKUP_BYTES) {
        throw new ProfileBackupError("Decrypted backup payload exceeds 32 MiB limit", 413, "backup_too_large");
      }
      assertJsonNestingDepth(decryptedBuf, MAX_PROFILE_BACKUP_DEPTH);
      const parsedInner = JSON.parse(decryptedBuf.toString("utf8")) as unknown;
      if (!isPlainRecord(parsedInner) || !isPlainRecord(parsedInner.files) || !isPlainRecord(parsedInner.files["config.json"])) {
        throw new ProfileBackupError("Decrypted backup files payload is malformed", 400, "backup_invalid_schema");
      }
      const rawFiles = parsedInner.files as Record<string, unknown>;
      const files: ProfileBackupFilesPayload["files"] = {
        "config.json": rawFiles["config.json"] as Record<string, unknown>,
      };
      // Host-local local-credentials.json is ignored even if present in legacy bundles.
      for (const optKey of ["auth.json", "codex-accounts.json", "integrations/records.json"] as const) {
        const val = rawFiles[optKey];
        if (val !== undefined) {
          if (!isPlainRecord(val)) {
            throw new ProfileBackupError(`Backup store ${optKey} must be a JSON object`, 400, "backup_invalid_schema");
          }
          files[optKey] = val;
        }
      }
      return { bundle, files };
    } catch (error) {
      if (error instanceof ProfileBackupError) throw error;
      if (error instanceof JsonNestingDepthExceededError) {
        throw new ProfileBackupError(error.message, 400, "backup_depth_exceeded");
      }
      throw new ProfileBackupError("Wrong backup passphrase or tampered backup bundle.", 400, "invalid_backup_passphrase");
    } finally {
      derivedKey?.fill(0);
      passphraseBuf.fill(0);
    }
  }

  throw new ProfileBackupError(`Invalid backup schema or mode: ${String(mode)}`, 400, "backup_invalid_schema");
}

export async function inspectProfileBackup(
  input: unknown,
  passphrase?: string,
  maxBytes = MAX_PROFILE_BACKUP_BYTES,
): Promise<InspectProfileBackupResult> {
  const { bundle, files } = decryptAndExtractBundle(input, passphrase, maxBytes);
  const candidateConfig = structuredClone(files["config.json"]);
  delete candidateConfig.telemetry;
  const validation = validateConfigCandidate(candidateConfig);

  return {
    schema: bundle.schema,
    mode: bundle.mode,
    createdAt: bundle.createdAt,
    appVersion: bundle.appVersion,
    valid: validation.ok,
    summary: bundle.summary,
    configValidation: validation.ok ? { ok: true } : { ok: false, error: validation.error },
  };
}

function writePreRestoreSnapshot(
  configDir: string,
  preReadEntries?: ReadonlyMap<string, PreRestoreStoreEntry>,
): string {
  const backupsDir = join(configDir, "backups");
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(backupsDir, 0o700);
    } catch {
      /* platform may ignore chmod */
    }
  }

  // Host-local local-credentials.json is never exported, overwritten, or removed by portable backups.
  const entries: Array<[string, PreRestoreStoreEntry]> = [
    ["config.json", preReadEntries?.get("config.json") ?? readSnapshotEntryForBackup(getConfigPath())],
    ["auth.json", preReadEntries?.get("auth.json") ?? readSnapshotEntryForBackup(getAuthStorePath())],
    ["codex-accounts.json", preReadEntries?.get("codex-accounts.json") ?? readSnapshotEntryForBackup(join(configDir, "codex-accounts.json"))],
    ["integrations/records.json", preReadEntries?.get("integrations/records.json") ?? readSnapshotEntryForBackup(join(integrationsDir(configDir), "records.json"))],
  ];
  const snapshotFiles: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (entry.kind === "json") snapshotFiles[key] = entry.value;
    else if (entry.kind === "corrupt") snapshotFiles[key] = { corrupted: true, rawText: entry.rawText };
  }

  const snapshot: Record<string, unknown> = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    files: snapshotFiles,
  };

  const fileName = `pre-restore-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const snapshotPath = join(backupsDir, fileName);
  atomicWriteFileNoFollow(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const existing = readdirSync(backupsDir)
    .filter(name => name.startsWith("pre-restore-") && name.endsWith(".json"))
    .sort();
  if (existing.length > MAX_PRE_RESTORE_SNAPSHOTS) {
    const excess = existing.slice(0, existing.length - MAX_PRE_RESTORE_SNAPSHOTS);
    for (const oldFile of excess) {
      const target = join(backupsDir, oldFile);
      try {
        if (!lstatSync(target).isSymbolicLink()) unlinkSync(target);
      } catch {
        /* ignore cleanup races */
      }
    }
  }
  return snapshotPath;
}

interface StoreMutationRollback {
  path: string;
  preBytes: Buffer | null;
  credentialStore?: "auth.json" | "codex-accounts.json";
}

function invalidateRestoredCredentialStore(record: Pick<StoreMutationRollback, "path" | "credentialStore">): void {
  if (record.credentialStore === "auth.json") {
    invalidateAuthStoreCache(record.path);
  } else if (record.credentialStore === "codex-accounts.json") {
    invalidateCodexAccountStoreCache();
    advanceCodexCredentialMutationEpoch();
  }
}

function compensateAuxStoreMutations(rollbackRecords: StoreMutationRollback[]): void {
  const rollbackErrors: unknown[] = [];
  for (let i = rollbackRecords.length - 1; i >= 0; i--) {
    const record = rollbackRecords[i]!;
    try {
      const applyRollback = () => {
        if (record.preBytes !== null) {
          mkdirSync(dirname(record.path), { recursive: true, mode: 0o700 });
          atomicWriteFileNoFollow(record.path, record.preBytes);
        } else {
          try {
            const stat = lstatSync(record.path);
            if (!stat.isSymbolicLink() && stat.isFile()) {
              unlinkSync(record.path);
            }
          } catch (err) {
            if ((err as { code?: string })?.code !== "ENOENT") throw err;
          }
        }
      };
      if (record.credentialStore) {
        publishCredentialSync(applyRollback);
        invalidateRestoredCredentialStore(record);
      } else {
        applyRollback();
      }
    } catch (rollbackErr) {
      rollbackErrors.push(rollbackErr);
    }
  }
  if (rollbackErrors.length > 0) {
    const first = rollbackErrors[0];
    throw first instanceof Error ? first : new Error(String(first));
  }
}

export async function restoreProfileBackup(
  input: unknown,
  options: { passphrase?: string; maxBytes?: number } = {},
): Promise<RestoreProfileBackupResult> {
  const { bundle, files } = decryptAndExtractBundle(
    input,
    options.passphrase,
    options.maxBytes ?? MAX_PROFILE_BACKUP_BYTES,
  );
  const configDir = getConfigDir();
  assertNotRealHomeUnderTest(configDir);

  const authLock = createOAuthFileLock({
    path: getAuthStoreLockPath(),
    waitTimeoutMs: profileBackupTestHooks?.authLockWaitTimeoutMs ?? OAUTH_REFRESH_LOCK_WAIT_MS,
  });
  const lease = await authLock.acquire();

  try {
    // Canonical lock order: authLock -> configDirHardening -> withConfigMutationLockSync -> persistConfigUnlocked (-> publishCredentialSync -> publicationFence).
    return await withConfigDirHardeningSettled(configDir, () =>
      withConfigMutationLockSync(() => {
        const configPath = getConfigPath();
        const recordsPath = join(integrationsDir(configDir), "records.json");
        const authPath = getAuthStorePath();
        const codexPath = join(configDir, "codex-accounts.json");

        // Single-read snapshot & rollback source for every portable store on disk.
        const configSnap = readStoreSnapshotAndBytes(configPath);
        const authSnap = readStoreSnapshotAndBytes(authPath);
        const codexSnap = readStoreSnapshotAndBytes(codexPath);
        const recordsSnap = readStoreSnapshotAndBytes(recordsPath);

        const currentDisk = configSnap.entry.kind === "json" ? configSnap.entry.value : undefined;
        const currentDiagnostics = readConfigDiagnostics({ passive: true });
        const currentConfig = currentDisk ?? (currentDiagnostics.config as unknown as Record<string, unknown>);
        const clientState = readClientConnectionState();

        const nextConfig = structuredClone(files["config.json"]);
        if (currentConfig.telemetry !== undefined) {
          nextConfig.telemetry = structuredClone(currentConfig.telemetry);
        } else {
          delete nextConfig.telemetry;
        }

        if (clientState.kind === "connected" || currentConfig.runtimeRole === "client") {
          nextConfig.runtimeRole = currentConfig.runtimeRole ?? "client";
          if (currentConfig.client !== undefined) {
            nextConfig.client = structuredClone(currentConfig.client);
          } else if (clientState.kind === "connected") {
            nextConfig.client = structuredClone(clientState.value);
          }
          if (currentConfig.hub !== undefined) {
            nextConfig.hub = structuredClone(currentConfig.hub);
          }
        }

        const validation = validateConfigCandidate(nextConfig);
        if (!validation.ok) {
          throw new ProfileBackupError(
            `Restored configuration failed schema validation: ${validation.error}`,
            400,
            "backup_invalid_config",
          );
        }

        const preReadMap = new Map<string, PreRestoreStoreEntry>([
          ["config.json", configSnap.entry],
          ["auth.json", authSnap.entry],
          ["codex-accounts.json", codexSnap.entry],
          ["integrations/records.json", recordsSnap.entry],
        ]);
        const preRestoreSnapshotPath = writePreRestoreSnapshot(configDir, preReadMap);
        const restoredFiles: string[] = [];
        const removedFiles: string[] = [];

        const validatedConfig: EpxConfig = structuredClone(validation.config);
        const projected = projectPersistedConfigMigrations(
          currentDisk as unknown as EpxConfig | undefined,
          projectConfigRebaseProvenance(validatedConfig),
        );

        const rollbackRecords: StoreMutationRollback[] = [];
        try {
          if (files["integrations/records.json"]) {
            profileBackupTestHooks?.onBeforeWriteStore?.("integrations/records.json", recordsPath);
            mkdirSync(dirname(recordsPath), { recursive: true, mode: 0o700 });
            atomicWriteFileNoFollow(recordsPath, `${JSON.stringify(files["integrations/records.json"], null, 2)}\n`);
            rollbackRecords.push({ path: recordsPath, preBytes: recordsSnap.rawBytes });
            restoredFiles.push("integrations/records.json");
          }

          if (bundle.mode === "encrypted") {
            const encryptedStores: Array<{
              key: "auth.json" | "codex-accounts.json";
              snap: StoreFileSnapshot;
            }> = [
              { key: "auth.json", snap: authSnap },
              { key: "codex-accounts.json", snap: codexSnap },
            ];
            for (const store of encryptedStores) {
              const payloadDoc = files[store.key];
              if (payloadDoc) {
                let diskDoc: Record<string, unknown>;
                try {
                  diskDoc = store.key === "auth.json"
                    ? sealAuthStoreDocument(payloadDoc, configDir)
                    : sealCodexStoreDocument(payloadDoc, configDir);
                } catch (error) {
                  if (error instanceof CredentialVaultError) {
                    throw new ProfileBackupError(error.message, error.status, "backup_vault_unavailable");
                  }
                  throw error;
                }
                profileBackupTestHooks?.onBeforeWriteStore?.(store.key, store.snap.path);
                mkdirSync(dirname(store.snap.path), { recursive: true, mode: 0o700 });
                publishCredentialSync(() => atomicWriteFileNoFollow(store.snap.path, `${JSON.stringify(diskDoc, null, 2)}\n`));
                rollbackRecords.push({ path: store.snap.path, preBytes: store.snap.rawBytes, credentialStore: store.key });
                invalidateRestoredCredentialStore({ path: store.snap.path, credentialStore: store.key });
                restoredFiles.push(store.key);
              } else if (store.snap.rawBytes !== null) {
                profileBackupTestHooks?.onBeforeWriteStore?.(store.key, store.snap.path);
                const stat = lstatSync(store.snap.path);
                if (stat.isSymbolicLink() || !stat.isFile()) {
                  throw new ProfileBackupError(
                    `Refusing non-regular or symlinked store file: ${store.snap.path}`,
                    400,
                    "backup_symlink_refused",
                  );
                }
                publishCredentialSync(() => unlinkSync(store.snap.path));
                rollbackRecords.push({ path: store.snap.path, preBytes: store.snap.rawBytes, credentialStore: store.key });
                invalidateRestoredCredentialStore({ path: store.snap.path, credentialStore: store.key });
                removedFiles.push(store.key);
              }
            }
          }

          profileBackupTestHooks?.onBeforeWriteStore?.("config.json", configPath);
          if (persistConfigUnlocked(projected)) {
            bumpGenerationForCooperatingConfigWrite();
          }
          restoredFiles.push("config.json");
        } catch (error) {
          if (!(error instanceof ConfigWritePublishedError) && rollbackRecords.length > 0) {
            try {
              compensateAuxStoreMutations(rollbackRecords);
            } catch (rollbackError) {
              throw new Error(
                `Profile restore failed (${error instanceof Error ? error.message : String(error)}) and rollback compensation failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
                { cause: error },
              );
            }
          }
          throw error;
        }

        return {
          schemaVersion: 1,
          mode: bundle.mode,
          restoredFiles,
          removedFiles,
          preRestoreSnapshotPath,
          summary: bundle.summary,
        };
      }),
    );
  } finally {
    await lease.release();
  }
}

export function writeProfileBackupOutputFile(filePath: string, bundle: ProfileBackupBundle): void {
  const target = resolve(filePath);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new ProfileBackupError(`Refusing to overwrite symlink: ${filePath}`, 400, "backup_symlink_refused");
  }
  mkdirSync(dirname(target), { recursive: true });
  atomicWriteFileNoFollowUnclaimed(target, `${JSON.stringify(bundle, null, 2)}\n`);
}
