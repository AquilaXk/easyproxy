import { z } from "zod/v4";
import { clearModelCache } from "../../codex/model-cache";
import { clearThreadAccountMap } from "../../codex/routing";
import { reconcileLiveConfigFromDisk } from "../../config";
import { ConfigMutationLockError } from "../../config/mutation-lock";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";
import {
  ProfileBackupError,
  exportProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from "../../config/profile-backup";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { WindowsSecretAclSettleTimeoutError } from "../../lib/windows-secret-acl";
import { OAuthFileLockError } from "../../oauth/file-lock";
import { OAuthMutationBusyError } from "../../oauth/store";
import { clearKeyCooldowns } from "../../providers/key-failover";
import { clearAccountQuotaCache, clearProviderQuotaCache } from "../../providers/quota";
import { jsonResponse } from "../auth-cors";
import { MANAGEMENT_JSON_BODY_MAX_BYTES, readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

const ExportBodySchema = z.object({
  mode: z.enum(["encrypted", "redacted"]),
  passphrase: z.string().optional(),
}).strict();

const InspectOrRestoreBodySchema = z.object({
  bundle: z.unknown(),
  passphrase: z.string().optional(),
}).strict();

function profileBackupErrorResponse(error: unknown, ctx: ManagementContext): Response {
  const { req, config } = ctx;
  if (error instanceof ProfileBackupError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status, req, config);
  }
  if (
    error instanceof OAuthFileLockError
    || error instanceof OAuthMutationBusyError
    || error instanceof ConfigMutationLockError
  ) {
    return jsonResponse({ error: error.message, code: "profile_backup_busy" }, 409, req, config);
  }
  if (error instanceof ConfigWritePublishedError) {
    return jsonResponse({ error: error.message, code: "config_write_partially_published" }, 500, req, config);
  }
  if (error instanceof WindowsSecretAclSettleTimeoutError) {
    return jsonResponse({ error: error.message, code: "windows_acl_timeout" }, 500, req, config);
  }
  throw error;
}

export async function handleProfileBackupRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, convergeCodexCatalog } = ctx;

  if (url.pathname === "/api/profile/backup/export" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "Invalid JSON body", code: "invalid_json" }, 400, req, config);
    }
    const parsed = ExportBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid backup export request", code: "invalid_request" }, 400, req, config);
    }
    try {
      const bundle = await exportProfileBackup(parsed.data);
      return jsonResponse(bundle, 200, req, config);
    } catch (error) {
      return profileBackupErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/profile/backup/preview" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "Invalid JSON body", code: "invalid_json" }, 400, req, config);
    }
    const parsed = InspectOrRestoreBodySchema.safeParse(rawBody);
    if (!parsed.success || parsed.data.bundle === undefined) {
      return jsonResponse({ error: "bundle is required", code: "invalid_request" }, 400, req, config);
    }
    try {
      const inspected = await inspectProfileBackup(
        parsed.data.bundle,
        parsed.data.passphrase,
        MANAGEMENT_JSON_BODY_MAX_BYTES,
      );
      return jsonResponse(inspected, 200, req, config);
    } catch (error) {
      return profileBackupErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/profile/backup/restore" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "Invalid JSON body", code: "invalid_json" }, 400, req, config);
    }
    const parsed = InspectOrRestoreBodySchema.safeParse(rawBody);
    if (!parsed.success || parsed.data.bundle === undefined) {
      return jsonResponse({ error: "bundle is required", code: "invalid_request" }, 400, req, config);
    }
    try {
      const baseline = structuredClone(config);
      const restored = await restoreProfileBackup(parsed.data.bundle, {
        passphrase: parsed.data.passphrase,
        maxBytes: MANAGEMENT_JSON_BODY_MAX_BYTES,
      });
      reconcileLiveConfigFromDisk(config, baseline);
      clearAccountQuotaCache();
      clearProviderQuotaCache();
      clearKeyCooldowns();
      clearThreadAccountMap();
      clearModelCache();
      reconcileLiveStateStores();
      const catalogRefresh = await convergeCodexCatalog();
      return jsonResponse({ ...restored, catalogRefresh }, 200, req, config);
    } catch (error) {
      return profileBackupErrorResponse(error, ctx);
    }
  }

  return null;
}
