import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { deleteConfigTopLevelKey, mutatePersistedConfig, validateConfigCandidate } from "../../config";
import { outboundSecretGuardSchema, toolOutputCompressionSchema } from "../../config/schema/leaf-validators";
import { inspectAndApplyOutboundSecretGuard } from "../../lib/outbound-secret-guard";
import { compressResponsesToolOutputsInPlace } from "../../lib/tool-output-compression";
import { getOutboundHygieneStats } from "../outbound-payload-hygiene";
import { readBoundedJsonRequestBody } from "../request-decompress";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";

const ALLOWED_KEYS = new Set(["outboundSecretGuard", "toolOutputCompression"]);
const DRY_RUN_ALLOWED_KEYS = new Set(["text", "outboundSecretGuard", "toolOutputCompression"]);
const MAX_DRY_RUN_TEXT_CHARS = 65_536;
const MAX_DRY_RUN_BODY_BYTES = 512 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function guardrailsView(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const response = jsonResponse({
    outboundSecretGuard: {
      mode: config.outboundSecretGuard?.mode ?? "off",
    },
    toolOutputCompression: {
      enabled: config.toolOutputCompression?.enabled === true,
      minChars: config.toolOutputCompression?.minChars ?? 12_000,
      headChars: config.toolOutputCompression?.headChars ?? 4_000,
      tailChars: config.toolOutputCompression?.tailChars ?? 4_000,
      stripAnsi: config.toolOutputCompression?.stripAnsi !== false,
    },
    stats: getOutboundHygieneStats(),
  }, 200, req, config);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleGuardrailsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname === "/api/gateway-guardrails" && req.method === "GET") {
    return guardrailsView(ctx);
  }
  if (url.pathname === "/api/gateway-guardrails" && req.method === "PUT") {
    return await updateGuardrails(ctx);
  }
  if (url.pathname === "/api/gateway-guardrails/dry-run" && req.method === "POST") {
    return await dryRunGuardrails(ctx);
  }
  return null;
}

async function dryRunGuardrails(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: unknown;
  try {
    body = await readBoundedJsonRequestBody(req, MAX_DRY_RUN_BODY_BYTES);
  } catch (error) {
    return managementBodyTooLargeResponse(error, req, config)
      ?? jsonResponse({ error: "invalid JSON body", code: "invalid_request" }, 400, req, config);
  }
  if (!isPlainRecord(body)) {
    return jsonResponse({ error: "request body must be a JSON object", code: "invalid_request" }, 400, req, config);
  }
  for (const key of Object.keys(body)) {
    if (!DRY_RUN_ALLOWED_KEYS.has(key)) {
      return jsonResponse({ error: `unsupported field: ${key}`, code: "invalid_request" }, 400, req, config);
    }
  }
  if (typeof body.text !== "string") {
    return jsonResponse({ error: "text must be a string", code: "invalid_request" }, 400, req, config);
  }
  if (body.text.length > MAX_DRY_RUN_TEXT_CHARS) {
    return jsonResponse(
      { error: `text exceeds maximum length of ${MAX_DRY_RUN_TEXT_CHARS} characters`, code: "payload_too_large" },
      413,
      req,
      config,
    );
  }

  let previewGuard = config.outboundSecretGuard;
  if (body.outboundSecretGuard !== undefined) {
    const parsedGuard = outboundSecretGuardSchema.safeParse(body.outboundSecretGuard);
    if (!parsedGuard.success) {
      return jsonResponse({ error: "invalid outboundSecretGuard options", code: "invalid_request" }, 400, req, config);
    }
    previewGuard = { ...(config.outboundSecretGuard ?? {}), ...parsedGuard.data };
  }

  let previewCompression = config.toolOutputCompression;
  if (body.toolOutputCompression !== undefined) {
    const parsedCompression = toolOutputCompressionSchema.safeParse(body.toolOutputCompression);
    if (!parsedCompression.success) {
      return jsonResponse({ error: "invalid toolOutputCompression options", code: "invalid_request" }, 400, req, config);
    }
    previewCompression = { ...(config.toolOutputCompression ?? {}), ...parsedCompression.data };
  }

  const originalChars = body.text.length;
  const samplePayload = { input: [{ type: "function_call_output", output: body.text }] };
  const secretGuard = inspectAndApplyOutboundSecretGuard(samplePayload, previewGuard);
  const compression = secretGuard.blocked
    ? { compressedItems: 0, savedChars: 0 }
    : compressResponsesToolOutputsInPlace(samplePayload, previewCompression);
  const previewText = secretGuard.blocked ? "" : samplePayload.input[0]!.output;

  const response = jsonResponse({
    blocked: secretGuard.blocked,
    limitExceeded: secretGuard.limitExceeded,
    matches: secretGuard.matches,
    redactions: secretGuard.redactions,
    findings: secretGuard.findings,
    compressedItems: compression.compressedItems,
    originalChars,
    outputChars: previewText.length,
    savedChars: compression.savedChars,
    previewText,
  }, 200, req, config);
  response.headers.set("cache-control", "no-store");
  return response;
}

async function updateGuardrails(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    return managementBodyTooLargeResponse(error, req, config)
      ?? jsonResponse({ error: "invalid JSON body", code: "invalid_request" }, 400, req, config);
  }
  if (!isPlainRecord(body)) {
    return jsonResponse({ error: "request body must be a JSON object", code: "invalid_request" }, 400, req, config);
  }
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some(k => !ALLOWED_KEYS.has(k))) {
    return jsonResponse({ error: "only outboundSecretGuard and toolOutputCompression are supported", code: "invalid_request" }, 400, req, config);
  }

  const candidate = { ...config };
  if (body.outboundSecretGuard !== undefined) {
    if (body.outboundSecretGuard === null) {
      delete candidate.outboundSecretGuard;
    } else if (!isPlainRecord(body.outboundSecretGuard)) {
      return jsonResponse({ error: "outboundSecretGuard must be an object", code: "invalid_request" }, 400, req, config);
    } else {
      candidate.outboundSecretGuard = body.outboundSecretGuard as NonNullable<typeof candidate.outboundSecretGuard>;
    }
  }
  if (body.toolOutputCompression !== undefined) {
    if (body.toolOutputCompression === null) {
      delete candidate.toolOutputCompression;
    } else if (!isPlainRecord(body.toolOutputCompression)) {
      return jsonResponse({ error: "toolOutputCompression must be an object", code: "invalid_request" }, 400, req, config);
    } else {
      candidate.toolOutputCompression = body.toolOutputCompression as NonNullable<typeof candidate.toolOutputCompression>;
    }
  }

  const validation = validateConfigCandidate(candidate);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error, code: "invalid_request" }, 400, req, config);
  }

  const validatedSecretGuard = validation.config.outboundSecretGuard
    ? structuredClone(validation.config.outboundSecretGuard)
    : undefined;
  const validatedCompression = validation.config.toolOutputCompression
    ? structuredClone(validation.config.toolOutputCompression)
    : undefined;

  const outcome = mutatePersistedConfig(persisted => {
    let changed = false;
    if (body.outboundSecretGuard !== undefined) {
      changed = true;
      if (validatedSecretGuard === undefined) deleteConfigTopLevelKey(persisted, "outboundSecretGuard");
      else persisted.outboundSecretGuard = structuredClone(validatedSecretGuard);
    }
    if (body.toolOutputCompression !== undefined) {
      changed = true;
      if (validatedCompression === undefined) deleteConfigTopLevelKey(persisted, "toolOutputCompression");
      else persisted.toolOutputCompression = structuredClone(validatedCompression);
    }
    return { changed, value: true };
  });

  if (outcome.status === "unavailable") {
    return jsonResponse(
      { error: `config.json is ${outcome.reason}; guardrails settings were not saved`, code: "config_unavailable" },
      409,
      req,
      config,
    );
  }

  if (body.outboundSecretGuard !== undefined) {
    if (validatedSecretGuard === undefined) deleteConfigTopLevelKey(config, "outboundSecretGuard");
    else config.outboundSecretGuard = validatedSecretGuard;
  }
  if (body.toolOutputCompression !== undefined) {
    if (validatedCompression === undefined) deleteConfigTopLevelKey(config, "toolOutputCompression");
    else config.toolOutputCompression = validatedCompression;
  }

  return guardrailsView(ctx);
}
