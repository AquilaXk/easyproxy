/**
 * Management API for zero-overhead heuristic scenario routing (`scenarioRouting`).
 *
 * - `GET    /api/routing/scenario`          - read current scenarioRouting config
 * - `PUT    /api/routing/scenario`          - validate and save scenarioRouting (or clear with null)
 * - `DELETE /api/routing/scenario`          - clear scenarioRouting config
 * - `POST   /api/routing/scenario/classify` - deterministic heuristic dry-run without upstream I/O
 */

import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import { deleteConfigTopLevelKey, saveConfigPreservingClaudeCode } from "../../config";
import { scenarioRoutingSchema } from "../../config/schema/scenario-routing";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { previewRouteModel } from "../../router";
import { classifyRequestScenario, SCENARIO_KINDS } from "../../routing/scenario";
import type { EpxScenarioKind, EpxScenarioRoutingConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

function persistClearedScenarioRouting(ctx: ManagementContext): Response {
  const { req, config } = ctx;
  const rollback = captureConfigTopLevelRollback(config, ["scenarioRouting"]);
  try {
    deleteConfigTopLevelKey(config, "scenarioRouting");
    saveConfigPreservingClaudeCode(config);
  } catch (error) {
    rollback();
    throw error;
  }
  reconcileLiveStateStores();
  return jsonResponse({ success: true, scenarioRouting: null }, 200, req, config);
}

export async function handleScenarioRoutingRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/routing/scenario" && req.method === "GET") {
    return jsonResponse({ scenarioRouting: config.scenarioRouting ?? null }, 200, req, config);
  }

  if (url.pathname === "/api/routing/scenario" && req.method === "DELETE") {
    return persistClearedScenarioRouting(ctx);
  }

  if (url.pathname === "/api/routing/scenario" && req.method === "PUT") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400, req, config);
    }
    const payload = Object.hasOwn(rawBody, "scenarioRouting") ? rawBody.scenarioRouting : rawBody;
    if (payload === null) {
      return persistClearedScenarioRouting(ctx);
    }

    const parsed = scenarioRoutingSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.length ? issue.path.join(".") : undefined;
      return jsonResponse({
        error: issue?.message ?? "invalid scenarioRouting configuration",
        ...(field ? { field } : {}),
      }, 400, req, config);
    }

    const next: EpxScenarioRoutingConfig = parsed.data;
    // Fail closed if any configured scenario target points to an unknown or disabled route.
    for (const kind of SCENARIO_KINDS) {
      const selector = next.routes[kind];
      if (!selector) continue;
      try {
        previewRouteModel(config, selector);
      } catch (err) {
        return jsonResponse({
          error: `scenario route "${kind}" target "${selector}" is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          field: `routes.${kind}`,
        }, 400, req, config);
      }
    }

    const rollback = captureConfigTopLevelRollback(config, ["scenarioRouting"]);
    try {
      config.scenarioRouting = next;
      saveConfigPreservingClaudeCode(config);
    } catch (error) {
      rollback();
      throw error;
    }
    reconcileLiveStateStores();
    return jsonResponse({ success: true, scenarioRouting: config.scenarioRouting }, 200, req, config);
  }

  if (url.pathname === "/api/routing/scenario/classify" && req.method === "POST") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400, req, config);
    }

    let candidateConfig = config.scenarioRouting;
    if (rawBody.scenarioRouting !== undefined) {
      const parsedCfg = scenarioRoutingSchema.safeParse(rawBody.scenarioRouting);
      if (!parsedCfg.success) {
        return jsonResponse({
          error: parsedCfg.error.issues[0]?.message ?? "invalid scenarioRouting override",
          field: "scenarioRouting",
        }, 400, req, config);
      }
      candidateConfig = parsedCfg.data;
    }

    let parsedHeaders: Record<string, string | undefined> | undefined;
    if (rawBody.headers !== undefined) {
      if (!isPlainRecord(rawBody.headers)) {
        return jsonResponse({ error: "headers must be an object of string values", field: "headers" }, 400, req, config);
      }
      parsedHeaders = {};
      const entries = Object.entries(rawBody.headers).slice(0, 32);
      for (const [k, v] of entries) {
        if (typeof v === "string") parsedHeaders[k] = v;
      }
    }
    if (rawBody.isCompaction !== undefined && typeof rawBody.isCompaction !== "boolean") {
      return jsonResponse({ error: "isCompaction must be a boolean", field: "isCompaction" }, 400, req, config);
    }
    if (rawBody.selector !== undefined && typeof rawBody.selector !== "string") {
      return jsonResponse({ error: "selector must be a string", field: "selector" }, 400, req, config);
    }

    const requestBody = rawBody.body ?? {};
    const selector = typeof rawBody.selector === "string" ? rawBody.selector : undefined;
    const hasConfiguredRules = candidateConfig !== undefined
      && SCENARIO_KINDS.some(kind =>
        Boolean(candidateConfig.routes[kind]?.trim()) || Boolean(candidateConfig.efforts?.[kind]),
      );
    const probeConfig: EpxScenarioRoutingConfig | undefined = candidateConfig
      ? {
          ...candidateConfig,
          enabled: true,
          routes: hasConfiguredRules
            ? candidateConfig.routes
            : { background: "_", longContext: "_", webSearch: "_", think: "_" },
        }
      : undefined;
    const heuristicProbe = classifyRequestScenario({
      body: requestBody,
      headers: parsedHeaders,
      isCompaction: rawBody.isCompaction === true,
      selector,
      ...(probeConfig ? { config: probeConfig } : {}),
    });
    if (probeConfig && !probeConfig.routes.longContext && !probeConfig.efforts?.longContext && heuristicProbe.estimatedTokens === 0) {
      const tokenProbe = classifyRequestScenario({ body: requestBody });
      heuristicProbe.estimatedTokens = tokenProbe.estimatedTokens;
      heuristicProbe.truncated ||= tokenProbe.truncated;
    }

    const activeMatch: EpxScenarioKind | null = candidateConfig?.enabled && hasConfiguredRules
      ? heuristicProbe.matched
      : null;
    const previewMatch: EpxScenarioKind | null = hasConfiguredRules ? heuristicProbe.matched : null;
    const targetSelector = previewMatch ? candidateConfig?.routes[previewMatch] : undefined;
    const resolvedEffort = previewMatch ? (candidateConfig?.efforts?.[previewMatch] ?? null) : null;
    let resolvedTarget: { provider: string; model: string; routeKind: string } | null = null;
    let resolveError: string | undefined;
    if (targetSelector) {
      try {
        const route = previewRouteModel(config, targetSelector);
        resolvedTarget = {
          provider: route.providerName,
          model: route.modelId,
          routeKind: route.routeKind,
        };
      } catch (err) {
        resolveError = err instanceof Error ? err.message : String(err);
      }
    }

    return jsonResponse({
      active: Boolean(candidateConfig?.enabled && hasConfiguredRules),
      matched: activeMatch,
      targetSelector: targetSelector ?? null,
      resolvedTarget,
      resolvedEffort,
      ...(resolveError ? { resolveError } : {}),
      classification: heuristicProbe,
    }, 200, req, config);
  }

  return null;
}
