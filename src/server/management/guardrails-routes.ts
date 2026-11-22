import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { deleteConfigTopLevelKey, mutatePersistedConfig, validateConfigCandidate } from "../../config";
import { getOutboundHygieneStats } from "../outbound-payload-hygiene";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";

const ALLOWED_KEYS = new Set(["outboundSecretGuard", "toolOutputCompression"]);

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
  if (url.pathname === "/api/gateway-guardrails" && req.method === "GET") return guardrailsView(ctx);
  if (url.pathname === "/api/gateway-guardrails" && req.method === "PUT") return await updateGuardrails(ctx);
  return null;
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
