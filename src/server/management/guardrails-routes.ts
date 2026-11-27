import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { deleteConfigTopLevelKey, mutatePersistedConfig, validateConfigCandidate } from "../../config";
import {
  outboundSecretGuardSchema,
  promptCacheInjectionSchema,
  toolOutputCompressionSchema,
} from "../../config/schema/leaf-validators";
import { inspectPromptContextJson, type ContextInspectionReport, type PromptCacheBreakevenRates } from "../../lib/context-inspector";
import { resolveMatchedPrice } from "../../usage/cost";
import { inspectAndApplyOutboundSecretGuard } from "../../lib/outbound-secret-guard";
import { injectPromptCacheBreakpointsInPlace } from "../../lib/prompt-cache-injection";
import { compressResponsesToolOutputsInPlace } from "../../lib/tool-output-compression";
import { getOutboundHygieneStats } from "../outbound-payload-hygiene";
import { readBoundedJsonRequestBody } from "../request-decompress";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";

const ALLOWED_KEYS = new Set(["outboundSecretGuard", "toolOutputCompression", "promptCacheInjection"]);
const DRY_RUN_ALLOWED_KEYS = new Set([
  "text",
  "duplicatePass",
  "outboundSecretGuard",
  "toolOutputCompression",
  "promptCacheInjection",
]);
const MAX_DRY_RUN_TEXT_CHARS = 65_536;
const MAX_DRY_RUN_BODY_BYTES = 512 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveDryRunBreakevenRates(model: string | null): PromptCacheBreakevenRates | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  const candidates = slash > 0
    ? [[model.slice(0, slash), model.slice(slash + 1)]] as const
    : [["anthropic", model], ["openai", model], ["google", model]] as const;
  for (const [provider, modelId] of candidates) {
    const matched = resolveMatchedPrice(provider, modelId);
    if (matched) {
      return {
        inputPerMTok: matched.cost4.input,
        outputPerMTok: matched.cost4.output,
        cacheReadPerMTok: matched.cost4.cacheRead,
        cacheWritePerMTok: matched.cost4.cacheWrite,
      };
    }
  }
  return undefined;
}

function guardrailsView(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const rawComp = config.toolOutputCompression;
  const response = jsonResponse({
    outboundSecretGuard: {
      mode: config.outboundSecretGuard?.mode ?? "off",
    },
    toolOutputCompression: {
      enabled: rawComp?.enabled === true,
      minChars: rawComp?.minChars ?? 12_000,
      headChars: rawComp?.headChars ?? 4_000,
      tailChars: rawComp?.tailChars ?? 4_000,
      stripAnsi: rawComp?.stripAnsi !== false,
      ...(rawComp?.compactJson !== undefined ? { compactJson: rawComp.compactJson } : {}),
      ...(rawComp?.foldRepetitiveLines !== undefined ? { foldRepetitiveLines: rawComp.foldRepetitiveLines } : {}),
      ...(rawComp?.deduplicateIdentical !== undefined ? { deduplicateIdentical: rawComp.deduplicateIdentical } : {}),
      ...(rawComp?.dedupMinChars !== undefined ? { dedupMinChars: rawComp.dedupMinChars } : {}),
    },
    promptCacheInjection: {
      enabled: config.promptCacheInjection?.enabled === true,
      ttl: config.promptCacheInjection?.ttl ?? "auto",
      stripVolatileSystemTimestamps: config.promptCacheInjection?.stripVolatileSystemTimestamps === true,
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

  let previewCacheInjection = config.promptCacheInjection;
  if (body.promptCacheInjection !== undefined) {
    const parsedCache = promptCacheInjectionSchema.safeParse(body.promptCacheInjection);
    if (!parsedCache.success) {
      return jsonResponse({ error: "invalid promptCacheInjection options", code: "invalid_request" }, 400, req, config);
    }
    previewCacheInjection = { ...(config.promptCacheInjection ?? {}), ...parsedCache.data };
  }

  if (body.duplicatePass !== undefined && typeof body.duplicatePass !== "boolean") {
    return jsonResponse({ error: "duplicatePass must be a boolean", code: "invalid_request" }, 400, req, config);
  }
  const duplicatePass = body.duplicatePass === true;
  const originalChars = duplicatePass ? body.text.length * 2 : body.text.length;
  const samplePayload = duplicatePass
    ? {
        input: [
          { type: "function_call_output", call_id: "call_dryrun_1", output: body.text },
          { type: "function_call_output", call_id: "call_dryrun_2", output: body.text },
        ],
      }
    : { input: [{ type: "function_call_output", call_id: "call_dryrun_1", output: body.text }] };
  const secretGuard = inspectAndApplyOutboundSecretGuard(samplePayload, previewGuard);
  const guardedSample = (secretGuard.body ?? samplePayload) as typeof samplePayload;
  const compression = secretGuard.blocked
    ? { compressedItems: 0, savedChars: 0, compactedJsonItems: 0, foldedLogItems: 0, deduplicatedItems: 0, estimatedSavedTokens: 0, body: guardedSample }
    : compressResponsesToolOutputsInPlace(guardedSample, previewCompression);
  const compressedSample = (compression.body ?? guardedSample) as typeof samplePayload;

  let injectedCacheBreakpoints = 0;
  let normalizedTimestamps = 0;
  let contextInspection: ContextInspectionReport | undefined;
  let payloadGuard = secretGuard;
  const trimmedText = body.text.trim();
  if (!payloadGuard.blocked && trimmedText.startsWith("{") && trimmedText.endsWith("}")) {
    const preInspect = inspectPromptContextJson(trimmedText);
    if (preInspect.ok && preInspect.cache.wireFormat !== "unknown") {
      try {
        const clonedPayload = JSON.parse(trimmedText) as Record<string, unknown>;
        const inspectedGuard = inspectAndApplyOutboundSecretGuard(clonedPayload, previewGuard);
        if (inspectedGuard.blocked) {
          payloadGuard = inspectedGuard;
          contextInspection = undefined;
        } else {
          if (inspectedGuard.redactions > payloadGuard.redactions || inspectedGuard.matches > payloadGuard.matches) {
            payloadGuard = inspectedGuard;
          }
          const guardedCtxPayload = inspectedGuard.body ?? clonedPayload;
          const compCtx = compressResponsesToolOutputsInPlace(guardedCtxPayload, previewCompression);
          const compressedCtxPayload = compCtx.body ?? guardedCtxPayload;
          const cacheRes = injectPromptCacheBreakpointsInPlace(compressedCtxPayload, previewCacheInjection);
          const finalCtxPayload = cacheRes.body ?? compressedCtxPayload;
          injectedCacheBreakpoints = cacheRes.injectedBreakpoints;
          normalizedTimestamps = cacheRes.normalizedTimestamps;
          const dryRunRates = resolveDryRunBreakevenRates(preInspect.model);
          const postInspect = inspectPromptContextJson(JSON.stringify(finalCtxPayload), dryRunRates ? { rates: dryRunRates } : undefined);
          if (postInspect.ok) contextInspection = postInspect;
        }
      } catch {
        // Fail closed: never expose preInspect parsed from unredacted raw input.
        contextInspection = undefined;
      }
    }
  }

  const previewText = payloadGuard.blocked
    ? ""
    : duplicatePass
      ? compressedSample.input[1]!.output
      : compressedSample.input[0]!.output;
  const outputChars = payloadGuard.blocked
    ? 0
    : compressedSample.input.reduce((sum, item) => sum + item.output.length, 0);

  const estSavedTokens = compression.estimatedSavedTokens ?? Math.floor(compression.savedChars / 4);
  const response = jsonResponse({
    blocked: payloadGuard.blocked,
    limitExceeded: payloadGuard.limitExceeded,
    matches: payloadGuard.matches,
    redactions: payloadGuard.redactions,
    findings: payloadGuard.findings,
    compressedItems: compression.compressedItems,
    ...((compression.compactedJsonItems ?? 0) > 0 ? { compactedJsonItems: compression.compactedJsonItems } : {}),
    ...((compression.foldedLogItems ?? 0) > 0 ? { foldedLogItems: compression.foldedLogItems } : {}),
    ...((compression.deduplicatedItems ?? 0) > 0 ? { deduplicatedItems: compression.deduplicatedItems } : {}),
    ...(injectedCacheBreakpoints > 0 ? { injectedCacheBreakpoints } : {}),
    ...(normalizedTimestamps > 0 ? { normalizedTimestamps } : {}),
    ...(contextInspection ? { contextInspection } : {}),
    originalChars,
    outputChars,
    savedChars: compression.savedChars,
    ...(estSavedTokens > 0 ? { estimatedSavedTokens: estSavedTokens } : {}),
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
    return jsonResponse({
      error: "only outboundSecretGuard, toolOutputCompression, and promptCacheInjection are supported",
      code: "invalid_request",
    }, 400, req, config);
  }

  const candidate = { ...config };
  if (body.outboundSecretGuard !== undefined) {
    if (body.outboundSecretGuard === null) {
      delete candidate.outboundSecretGuard;
    } else if (!isPlainRecord(body.outboundSecretGuard)) {
      return jsonResponse({ error: "outboundSecretGuard must be an object", code: "invalid_request" }, 400, req, config);
    } else {
      const parsedGuard = outboundSecretGuardSchema.safeParse(body.outboundSecretGuard);
      if (!parsedGuard.success) {
        return jsonResponse({ error: "invalid outboundSecretGuard options", code: "invalid_request" }, 400, req, config);
      }
      candidate.outboundSecretGuard = { ...(config.outboundSecretGuard ?? {}), ...parsedGuard.data };
    }
  }
  if (body.toolOutputCompression !== undefined) {
    if (body.toolOutputCompression === null) {
      delete candidate.toolOutputCompression;
    } else if (!isPlainRecord(body.toolOutputCompression)) {
      return jsonResponse({ error: "toolOutputCompression must be an object", code: "invalid_request" }, 400, req, config);
    } else {
      const parsedCompression = toolOutputCompressionSchema.safeParse(body.toolOutputCompression);
      if (!parsedCompression.success) {
        return jsonResponse({ error: "invalid toolOutputCompression options", code: "invalid_request" }, 400, req, config);
      }
      candidate.toolOutputCompression = { ...(config.toolOutputCompression ?? {}), ...parsedCompression.data };
    }
  }
  if (body.promptCacheInjection !== undefined) {
    if (body.promptCacheInjection === null) {
      delete candidate.promptCacheInjection;
    } else if (!isPlainRecord(body.promptCacheInjection)) {
      return jsonResponse({ error: "promptCacheInjection must be an object", code: "invalid_request" }, 400, req, config);
    } else {
      const parsedCache = promptCacheInjectionSchema.safeParse(body.promptCacheInjection);
      if (!parsedCache.success) {
        return jsonResponse({ error: "invalid promptCacheInjection options", code: "invalid_request" }, 400, req, config);
      }
      candidate.promptCacheInjection = { ...(config.promptCacheInjection ?? {}), ...parsedCache.data };
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
  const validatedCacheInjection = validation.config.promptCacheInjection
    ? structuredClone(validation.config.promptCacheInjection)
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
    if (body.promptCacheInjection !== undefined) {
      changed = true;
      if (validatedCacheInjection === undefined) deleteConfigTopLevelKey(persisted, "promptCacheInjection");
      else persisted.promptCacheInjection = structuredClone(validatedCacheInjection);
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
  if (body.promptCacheInjection !== undefined) {
    if (validatedCacheInjection === undefined) deleteConfigTopLevelKey(config, "promptCacheInjection");
    else config.promptCacheInjection = validatedCacheInjection;
  }

  return guardrailsView(ctx);
}
