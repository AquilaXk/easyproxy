import { mutatePersistedConfig } from "../config";
import { readConfigDiagnostics } from "../config/diagnostics";
import { adoptPersistedOtlp } from "../config/live-reconcile";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { otlpConfigSchema } from "../config/schema/otlp";
import { jsonResponse } from "../server/auth-cors";
import type { ManagementContext } from "../server/management/context";
import type { EpxOtlpConfig } from "../types";
import { flushOtlpSpans, projectMaskedOtlpConfig } from "./otlp";

export async function handleGetOtlpRoute(ctx: ManagementContext): Promise<Response> {
  const disk = readConfigDiagnostics({ passive: true }).config;
  return jsonResponse(projectMaskedOtlpConfig(disk?.otlp ?? ctx.config.otlp), 200, ctx.req, ctx.config);
}

export async function handlePutOtlpRoute(ctx: ManagementContext): Promise<Response> {
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body", code: "invalid_json" }, 400, ctx.req, ctx.config);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "OTLP config body must be a JSON object", code: "invalid_otlp_config" }, 400, ctx.req, ctx.config);
  }
  const raw = body as Record<string, unknown>;
  const existing = ctx.config.otlp;
  const candidate: Record<string, unknown> = {
    ...(existing ? structuredClone(existing) : {}),
    ...raw,
  };
  if (raw.headers === null) delete candidate.headers;
  if (raw.serviceName === null) delete candidate.serviceName;
  if (raw.endpoint === null) delete candidate.endpoint;

  const parsed = otlpConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    return jsonResponse(
      {
        error: `invalid OTLP configuration${field ? ` (${field})` : ""}: ${issue?.message ?? "validation failed"}`,
        code: "invalid_otlp_config",
      },
      400,
      ctx.req,
      ctx.config,
    );
  }

  const nextOtlp: EpxOtlpConfig = parsed.data;
  const outcome = await withConfigDirHardeningSettled(getConfigDir(), () =>
    mutatePersistedConfig((fresh) => {
      const changed = JSON.stringify(fresh.otlp) !== JSON.stringify(nextOtlp);
      fresh.otlp = structuredClone(nextOtlp);
      return { changed, value: nextOtlp };
    }),
  );
  if (outcome.status === "unavailable") {
    return jsonResponse(
      { error: `Configuration is ${outcome.reason}`, code: "config_unavailable" },
      503,
      ctx.req,
      ctx.config,
    );
  }
  adoptPersistedOtlp(ctx.config, nextOtlp);
  return jsonResponse({ ok: true, ...projectMaskedOtlpConfig(nextOtlp) }, 200, ctx.req, ctx.config);
}

export async function handleDeleteOtlpRoute(ctx: ManagementContext): Promise<Response> {
  const outcome = await withConfigDirHardeningSettled(getConfigDir(), () =>
    mutatePersistedConfig((fresh) => {
      const changed = fresh.otlp !== undefined;
      delete fresh.otlp;
      return { changed, value: undefined };
    }),
  );
  if (outcome.status === "unavailable") {
    return jsonResponse(
      { error: `Configuration is ${outcome.reason}`, code: "config_unavailable" },
      503,
      ctx.req,
      ctx.config,
    );
  }
  adoptPersistedOtlp(ctx.config, undefined);
  await flushOtlpSpans(1_500);
  return jsonResponse({ ok: true, enabled: false }, 200, ctx.req, ctx.config);
}
