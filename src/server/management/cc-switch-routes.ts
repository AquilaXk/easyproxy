import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { expandUserPath, getConfigDir, saveConfigPreservingClaudeCode } from "../../config";
import { assertPlainLocalPath } from "../../codex/orca-auth-source";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { probeProviderKeychain } from "../../providers/api-key-resolve";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

const ALLOWED_CC_SWITCH_SOURCE_EXT_RE = /\.(?:db|sqlite|sqlite3|json)$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

const EASYPROXY_SENSITIVE_FILENAMES = [
  "config.json",
  "auth.json",
  "codex-accounts.json",
  "cc-switch-provider-import-journal.json",
  "local-credentials.json",
  "responses-state.json",
  "thought-signature-replay.json",
  "service-state.json",
  "runtime-port.json",
  "tray-state.json",
  "tray-heartbeat.json",
  "codex-shim.json",
  "codex-runtime.json",
  "codex-runtime-clamp.json",
  "catalog-backup.json",
  "version.json",
  "update-job.json",
  ".easyproxy-owner.json",
  ".easyproxy-uninstall.json",
  "config-mutation.sqlite",
  "codex-affinity.sqlite",
  "local-credential-publication.sqlite",
] as const;

const EASYPROXY_SENSITIVE_SUBDIRS = [
  "codex-accounts",
  "profiles",
  "backups",
  "local-credential-observers",
] as const;

function fsCompareKey(path: string): string {
  return CASE_INSENSITIVE_FS ? path.toLowerCase() : path;
}

function safeRealpathIfExists(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isSensitiveEasyProxyTarget(resolved: string): boolean {
  const rawConfigDir = resolve(getConfigDir());
  const configDirs = new Set([rawConfigDir, safeRealpathIfExists(rawConfigDir)]);
  const codexHomeRaw = process.env.CODEX_HOME?.trim();
  const codexHome = codexHomeRaw ? resolve(expandUserPath(codexHomeRaw)) : join(homedir(), ".codex");
  const codexHomes = new Set([codexHome, safeRealpathIfExists(codexHome)]);

  const candidateKeys = new Set([
    fsCompareKey(resolved),
    fsCompareKey(safeRealpathIfExists(resolved)),
  ]);

  for (const dir of configDirs) {
    for (const file of EASYPROXY_SENSITIVE_FILENAMES) {
      if (candidateKeys.has(fsCompareKey(join(dir, file)))) return true;
    }
    for (const sub of EASYPROXY_SENSITIVE_SUBDIRS) {
      const prefix = fsCompareKey(join(dir, sub) + sep);
      for (const candidate of candidateKeys) {
        if (candidate.startsWith(prefix)) return true;
      }
    }
  }
  for (const dir of codexHomes) {
    if (candidateKeys.has(fsCompareKey(join(dir, "auth.json")))) return true;
  }
  return false;
}

function validateCcSwitchRouteSourcePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) {
    throw new Error("sourcePath must be a non-empty local file path");
  }
  const expanded = trimmed.startsWith("~/") || trimmed.startsWith("~\\")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;
  if (!isAbsolute(expanded)) {
    throw new Error("sourcePath must be an absolute local CC-Switch .db/.sqlite/.sqlite3/.json file path");
  }
  const resolved = resolve(expanded);
  if (!ALLOWED_CC_SWITCH_SOURCE_EXT_RE.test(resolved)) {
    throw new Error("sourcePath must reference a CC-Switch .db, .sqlite, .sqlite3, or .json file");
  }
  if (isSensitiveEasyProxyTarget(resolved)) {
    throw new Error("sourcePath cannot target EasyProxy runtime config or auth store files");
  }
  try {
    assertPlainLocalPath(resolved);
    const stat = lstatSync(resolved, { bigint: true });
    if (!stat.isFile()) {
      throw new Error("sourcePath must point to a regular local file");
    }
    if (stat.nlink > 1n) {
      throw new Error("sourcePath cannot be a hard-linked file");
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message === "sourcePath must point to a regular local file"
      || error.message === "sourcePath cannot be a hard-linked file"
    )) {
      throw error;
    }
    throw new Error("sourcePath must be an existing readable plain local CC-Switch file");
  }
  return resolved;
}

export async function handleCcSwitchRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog } = ctx;
  if (req.method !== "POST") return null;
  if (
    url.pathname !== "/api/providers/cc-switch/preview"
    && url.pathname !== "/api/providers/cc-switch/apply"
    && url.pathname !== "/api/providers/cc-switch/restore"
  ) {
    return null;
  }

  let rawBody: unknown = {};
  try {
    rawBody = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body", code: "invalid_json" }, 400);
  }
  if (!isPlainRecord(rawBody)) {
    return jsonResponse({ error: "request body must be an object", code: "invalid_request" }, 400);
  }

  const {
    CcSwitchImportError,
    discoverDefaultCcSwitchSources,
    hasActiveCcSwitchImportJournal,
    runCcSwitchLiveProviderImport,
  } = await import("../../providers/cc-switch-import");

  const defaultSources = discoverDefaultCcSwitchSources();
  const journalActive = hasActiveCcSwitchImportJournal();

  if (url.pathname === "/api/providers/cc-switch/restore") {
    try {
      const result = runCcSwitchLiveProviderImport({
        mode: "restore",
        config,
        saveConfig: deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode,
      });
      reconcileLiveStateStores();
      const catalogRefresh = await convergeCodexCatalog();
      return jsonResponse({ ...result, journalActive: hasActiveCcSwitchImportJournal(), catalogRefresh });
    } catch (error) {
      if (error instanceof CcSwitchImportError) {
        return jsonResponse({ error: error.message, code: "cc_switch_restore_failed" }, 400);
      }
      throw error;
    }
  }

  let sourcePath: string | undefined;
  if (rawBody.sourcePath !== undefined) {
    if (typeof rawBody.sourcePath !== "string" || !rawBody.sourcePath.trim() || rawBody.sourcePath.includes("\0")) {
      return jsonResponse({ error: "sourcePath must be a non-empty local file path", code: "invalid_source_path" }, 400);
    }
    try {
      sourcePath = validateCcSwitchRouteSourcePath(rawBody.sourcePath);
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "invalid CC-Switch source path",
        code: "invalid_source_path",
      }, 400);
    }
  } else {
    sourcePath = defaultSources[0]?.path;
  }

  const selectedProviders = rawBody.selectedProviders === undefined
    ? undefined
    : Array.isArray(rawBody.selectedProviders) && rawBody.selectedProviders.every(id => typeof id === "string")
      ? rawBody.selectedProviders
      : null;
  if (selectedProviders === null) {
    return jsonResponse({ error: "selectedProviders must be an array of provider IDs", code: "invalid_request" }, 400);
  }
  if (rawBody.allowPrivateNetwork !== undefined && typeof rawBody.allowPrivateNetwork !== "boolean") {
    return jsonResponse({ error: "allowPrivateNetwork must be a boolean", code: "invalid_request" }, 400);
  }
  const allowPrivateNetwork = rawBody.allowPrivateNetwork === true;
  if (rawBody.includeApiKeys !== undefined && typeof rawBody.includeApiKeys !== "boolean") {
    return jsonResponse({ error: "includeApiKeys must be a boolean", code: "invalid_request" }, 400);
  }
  const includeApiKeys = rawBody.includeApiKeys !== false;
  if (rawBody.storeInKeychain !== undefined && typeof rawBody.storeInKeychain !== "boolean") {
    return jsonResponse({ error: "storeInKeychain must be a boolean", code: "invalid_request" }, 400);
  }
  const storeInKeychain = rawBody.storeInKeychain === true;
  const keychainAvailable = probeProviderKeychain().available;

  if (url.pathname === "/api/providers/cc-switch/preview") {
    if (!sourcePath) {
      return jsonResponse({
        available: false,
        keychainAvailable,
        defaultSources,
        journalActive,
        mode: "preview",
        discovered: 0,
        eligible: 0,
        imported: 0,
        conflicts: 0,
        conflictNames: [],
        invalid: 0,
        invalidReasons: {},
        providers: [],
      });
    }
    try {
      const preview = runCcSwitchLiveProviderImport({
        mode: "preview",
        config,
        saveConfig: deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode,
        sourcePath,
        selectedProviders,
        allowPrivateNetwork,
      });
      return jsonResponse({ available: true, keychainAvailable, defaultSources, journalActive, ...preview });
    } catch (error) {
      if (error instanceof CcSwitchImportError) {
        return jsonResponse({ error: error.message, code: "cc_switch_preview_failed" }, 400);
      }
      throw error;
    }
  }

  if (rawBody.consent !== true) {
    return jsonResponse({
      error: "Explicit user consent (consent: true) is required before importing CC-Switch providers.",
      code: "cc_switch_consent_required",
    }, 400);
  }
  if (!sourcePath) {
    return jsonResponse({ error: "No CC-Switch source file was provided or detected.", code: "cc_switch_source_not_found" }, 404);
  }
  try {
    const applied = runCcSwitchLiveProviderImport({
      mode: "apply",
      config,
      saveConfig: deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode,
      sourcePath,
      selectedProviders,
      allowPrivateNetwork,
      consent: true,
      includeApiKeys,
      storeInKeychain,
    });
    reconcileLiveStateStores();
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ...applied, journalActive: hasActiveCcSwitchImportJournal(), catalogRefresh });
  } catch (error) {
    if (error instanceof CcSwitchImportError) {
      return jsonResponse({ error: error.message, code: "cc_switch_apply_failed" }, 400);
    }
    throw error;
  }
}
