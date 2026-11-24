import { z } from "zod/v4";
import {
  ECOSYSTEM_CLI_IDS,
  ECOSYSTEM_SYNC_KINDS,
  EcosystemSyncError,
  applyEcosystemSync,
  getEcosystemSyncStatus,
  previewEcosystemSync,
  restoreEcosystemSync,
} from "../../ecosystem/cli-sync";
import { IntegrationWriterLockBusyError } from "../../integrations/writer-lock";
import { WindowsSecretAclSettleTimeoutError } from "../../lib/windows-secret-acl";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

const PlanBodySchema = z.object({
  source: z.enum(ECOSYSTEM_CLI_IDS),
  targets: z.array(z.enum(ECOSYSTEM_CLI_IDS)).min(1),
  kinds: z.array(z.enum(ECOSYSTEM_SYNC_KINDS)).optional(),
  overwrite: z.boolean().optional(),
}).strict();

const RestoreBodySchema = z.object({
  batchId: z.string().min(1).max(128).optional(),
  force: z.boolean().optional(),
}).strict();

function ecosystemErrorResponse(error: unknown, ctx: ManagementContext): Response {
  const { req, config } = ctx;
  if (error instanceof EcosystemSyncError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status, req, config);
  }
  if (error instanceof IntegrationWriterLockBusyError) {
    return jsonResponse({ error: "Ecosystem sync is busy; retry shortly.", code: "ecosystem_sync_busy" }, 409, req, config);
  }
  if (error instanceof WindowsSecretAclSettleTimeoutError) {
    return jsonResponse({ error: error.message, code: "windows_acl_timeout" }, 500, req, config);
  }
  throw error;
}

export async function handleEcosystemSyncRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/ecosystem/sync" && req.method === "GET") {
    try {
      return jsonResponse(getEcosystemSyncStatus(), 200, req, config);
    } catch (error) {
      return ecosystemErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/ecosystem/sync/preview" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "Invalid JSON body", code: "invalid_json" }, 400, req, config);
    }
    const parsed = PlanBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid ecosystem sync preview request", code: "invalid_request" }, 400, req, config);
    }
    try {
      return jsonResponse(previewEcosystemSync(parsed.data), 200, req, config);
    } catch (error) {
      return ecosystemErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/ecosystem/sync/apply" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "Invalid JSON body", code: "invalid_json" }, 400, req, config);
    }
    const parsed = PlanBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid ecosystem sync apply request", code: "invalid_request" }, 400, req, config);
    }
    try {
      return jsonResponse(await applyEcosystemSync(parsed.data), 200, req, config);
    } catch (error) {
      return ecosystemErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/ecosystem/sync/restore" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "Invalid JSON body", code: "invalid_json" }, 400, req, config);
    }
    const parsed = RestoreBodySchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid ecosystem sync restore request", code: "invalid_request" }, 400, req, config);
    }
    try {
      return jsonResponse(await restoreEcosystemSync(parsed.data), 200, req, config);
    } catch (error) {
      return ecosystemErrorResponse(error, ctx);
    }
  }

  return null;
}
