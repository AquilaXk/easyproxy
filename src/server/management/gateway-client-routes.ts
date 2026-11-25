/**
 * Dashboard and CLI routes that point Google's Antigravity clients (desktop app, `agy`)
 * at this proxy. Adapter only: what is written, stashed and restored lives in
 * `src/integrations/gateway-clients`. Auth and origin checks run before dispatch, so a
 * mutation here is gated like every other management POST.
 */
import type { EpxConfig } from "../../types";
import { saveConfigPreservingClaudeCode } from "../../config";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { GATEWAY_CLIENT_IDS, connectGatewayClient, gatewayActionBody, disconnectGatewayClient, gatewayClientsStatus, isGatewayClientId, productionGatewayClientContext, readAntigravityIssuedKeyId, resolveGatewayTarget, type GatewayClientContext, type GatewayClientId } from "../../integrations/gateway-clients";
import { isApiKeyExpired, jsonResponse } from "../auth-cors";
import { readOptionalManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { issueApiKeyInProcess, revokeApiKeyInProcess } from "./oauth-account-routes";
import { managementInferencePort, type ManagementContext } from "./context";

const COLLECTION_PATH = "/api/gateway-clients";
const ACTION_PATH = /^\/api\/gateway-clients\/([^/]+)\/(connect|disconnect)$/;

function refusal(ctx: ManagementContext, status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, code, message }, status, ctx.req, ctx.config);
}

async function connectModel(ctx: ManagementContext, id: GatewayClientId): Promise<{ model?: string } | Response> {
  let body: unknown;
  try { body = await readOptionalManagementJsonBody(ctx.req); } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return refusal(ctx, 400, "invalid-body", "The request body must be a JSON object.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return refusal(ctx, 400, "invalid-body", "The request body must be a JSON object.");
  if (id === "agy" && Object.hasOwn(body, "model")) {
    return refusal(ctx, 400, "invalid-body", "model is only supported by Antigravity connect.");
  }
  const model = (body as { model?: unknown }).model;
  if (model === undefined || model === null) return {};
  if (typeof model !== "string") return refusal(ctx, 400, "invalid-body", "model must be a string.");
  return { model };
}

function deriveAntigravityLoopbackScope(
  config: EpxConfig,
  model: string | undefined,
): { allowedProviders?: string[]; allowedModels?: string[] } {
  const trimmed = model?.trim();
  if (trimmed) {
    const slash = trimmed.indexOf("/");
    if (slash > 0 && slash < trimmed.length - 1) {
      return {
        allowedProviders: [trimmed.slice(0, slash)],
        allowedModels: [trimmed],
      };
    }
    return { allowedModels: [trimmed] };
  }
  const googleProviders = Object.entries(config.providers ?? {})
    .filter(([name, provider]) =>
      provider.adapter === "google-antigravity"
      || provider.adapter === "google"
      || name === "google-antigravity"
      || name.startsWith("google")
      || name.startsWith("gemini"))
    .map(([name]) => name);
  if (googleProviders.length > 0) {
    return { allowedProviders: googleProviders };
  }
  const fallbackProvider = config.defaultProvider?.trim();
  return fallbackProvider ? { allowedProviders: [fallbackProvider] } : {};
}

export async function handleGatewayClientRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  const clientCtx: GatewayClientContext = deps.gatewayClientContext?.() ?? productionGatewayClientContext();
  if (url.pathname === "/api/gateway-clients" && req.method === "GET") {
    const resolved = resolveGatewayTarget(config, managementInferencePort(ctx));
    return jsonResponse({ clients: gatewayClientsStatus(clientCtx, resolved.ok ? resolved.target : undefined) }, 200, req, config);
  }
  const match = req.method === "POST" ? ACTION_PATH.exec(url.pathname) : null;
  if (!match) return null;
  const id = match[1]!;
  if (!isGatewayClientId(id)) {
    return refusal(ctx, 404, "unknown-client", `Unknown gateway client "${id.slice(0, 40)}". Known: ${GATEWAY_CLIENT_IDS.join(", ")}.`);
  }
  const persistConfig = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
  try {
    if (match[2] === "disconnect") {
      const resolved = resolveGatewayTarget(config, managementInferencePort(ctx));
      const issuedKeyId = id === "antigravity" ? readAntigravityIssuedKeyId(clientCtx) : undefined;
      const outcome = disconnectGatewayClient(id, clientCtx, resolved.ok ? resolved.target : undefined);
      if (outcome.ok && issuedKeyId) {
        revokeApiKeyInProcess(config, issuedKeyId, persistConfig);
      }
      return jsonResponse(gatewayActionBody(outcome), outcome.ok ? 200 : 409, req, config);
    }
    const parsed = await connectModel(ctx, id);
    if (parsed instanceof Response) return parsed;
    const port = managementInferencePort(ctx);
    if (id !== "antigravity") {
      const outcome = connectGatewayClient(id, clientCtx, config, port, parsed.model);
      return jsonResponse(gatewayActionBody(outcome), outcome.ok ? 200 : 409, req, config);
    }
    const targetCheck = resolveGatewayTarget(config, port, parsed.model);
    if (!targetCheck.ok) {
      const outcome = connectGatewayClient(id, clientCtx, config, port, parsed.model);
      return jsonResponse(gatewayActionBody(outcome), 409, req, config);
    }
    const scope = deriveAntigravityLoopbackScope(config, targetCheck.target.defaultModel);
    const existingKeyId = readAntigravityIssuedKeyId(clientCtx);
    const existingEntry = existingKeyId
      ? (config.apiKeys ?? []).find(entry => entry.id === existingKeyId && entry.loopbackOnly === true && !isApiKeyExpired(entry))
      : undefined;
    let mintedNewKeyId: string | undefined;
    let previousScope: { allowedProviders?: string[]; allowedModels?: string[] } | undefined;
    let credential: { apiKey: string; issuedKeyId: string };
    if (existingEntry) {
      previousScope = {
        allowedProviders: existingEntry.allowedProviders ? [...existingEntry.allowedProviders] : undefined,
        allowedModels: existingEntry.allowedModels ? [...existingEntry.allowedModels] : undefined,
      };
      if (scope.allowedProviders) existingEntry.allowedProviders = scope.allowedProviders;
      else delete existingEntry.allowedProviders;
      if (scope.allowedModels) existingEntry.allowedModels = scope.allowedModels;
      else delete existingEntry.allowedModels;
      persistConfig(config);
      reconcileLiveStateStores();
      credential = { apiKey: existingEntry.key, issuedKeyId: existingEntry.id };
    } else {
      const minted = issueApiKeyInProcess(
        config,
        "Antigravity Gateway (Loopback)",
        undefined,
        entry => {
          entry.loopbackOnly = true;
          if (scope.allowedProviders) entry.allowedProviders = scope.allowedProviders;
          if (scope.allowedModels) entry.allowedModels = scope.allowedModels;
        },
        persistConfig,
      );
      mintedNewKeyId = minted.id;
      credential = { apiKey: minted.key, issuedKeyId: minted.id };
    }
    const outcome = connectGatewayClient(id, clientCtx, config, port, parsed.model, credential);
    if (!outcome.ok) {
      if (mintedNewKeyId) {
        revokeApiKeyInProcess(config, mintedNewKeyId, persistConfig);
      } else if (existingEntry && previousScope) {
        if (previousScope.allowedProviders) existingEntry.allowedProviders = previousScope.allowedProviders;
        else delete existingEntry.allowedProviders;
        if (previousScope.allowedModels) existingEntry.allowedModels = previousScope.allowedModels;
        else delete existingEntry.allowedModels;
        persistConfig(config);
        reconcileLiveStateStores();
      }
      return jsonResponse(gatewayActionBody(outcome), 409, req, config);
    }
    return jsonResponse({ ...gatewayActionBody(outcome), issuedApiKeyId: credential.issuedKeyId }, 200, req, config);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return refusal(ctx, 409, "io-error", `Could not update the client files: ${error instanceof Error ? error.message : String(error)}`);
  }
}
