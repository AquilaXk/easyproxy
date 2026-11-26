/**
 * Wire types for the Antigravity and agy connect routes
 * (src/server/management/gateway-client-routes.ts). Every note, override and refusal carries a
 * code; the page translates the code and never shows the server's English sentence.
 */
import { readJsonIfOk } from "../../fetch-json";

export type GatewayClientId = "antigravity" | "agy";
export type GatewayClientState = "connected" | "disconnected" | "drifted";
export type GatewayClientAction = "connect" | "disconnect";
export type GatewayNoteCode =
  | "restart-app" | "no-google-sign-in" | "agy-follows-app" | "settings-not-json" | "settings-not-object"
  | "no-restore-record" | "new-terminal" | "agy-version" | "windows-unverified" | "agy-env-exported";
export type GatewayOverrideCode = "admin-gateway" | "admin-unreadable" | "env-gateway";

export interface GatewayClientStatus {
  id: GatewayClientId;
  label: string;
  state: GatewayClientState;
  files: { path: string; role: string; exists: boolean }[];
  overrides: { source: "admin_settings" | "env"; code: GatewayOverrideCode; detail: string }[];
  notes: { code: GatewayNoteCode; text: string }[];
  defaultModel?: string;
}

/**
 * `reached` is false when the request never produced a readable answer from the proxy. A refusal
 * carries a `code`, with a home-relative `profilePath` for agy restore refusals;
 * a success carries what was done: `changed` and, for a disconnect, `restore`.
 */
export interface GatewayClientActionOutcome {
  reached: boolean;
  ok: boolean;
  code: string | null;
  message: string | null;
  profilePath: string | null;
  changed: boolean;
  restore: "exact" | "path-wise" | "none" | null;
}

export async function loadGatewayClients(apiBase: string, signal?: AbortSignal): Promise<GatewayClientStatus[] | null> {
  try {
    const response = await fetch(`${apiBase}/api/gateway-clients`, { signal });
    const body = await readJsonIfOk<{ clients?: unknown }>(response);
    return Array.isArray(body?.clients) ? body.clients as GatewayClientStatus[] : null;
  } catch {
    return null;
  }
}

export interface GatewayModelOption {
  id: string;
  provider?: string;
}

const GATEWAY_PROVIDER_PRIORITY: Record<string, number> = {
  "google-antigravity": 0,
  google: 1,
  anthropic: 2,
};

export async function loadGatewayModelOptions(apiBase: string, signal?: AbortSignal): Promise<GatewayModelOption[]> {
  try {
    const response = await fetch(`${apiBase}/api/models`, { signal });
    const body = await readJsonIfOk<unknown>(response);
    const list = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : [];
    const byId = new Map<string, GatewayModelOption>();
    for (const item of list) {
      if (item && typeof item === "object") {
        const record = item as { id?: unknown; provider?: unknown; namespaced?: unknown; disabled?: unknown; superseded?: unknown };
        if (record.disabled === true || record.superseded === true) continue;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) continue;
        const explicitProvider = typeof record.provider === "string" ? record.provider.trim() : "";
        const namespaced = typeof record.namespaced === "string" ? record.namespaced.trim() : "";
        const inferredProvider = explicitProvider || (namespaced.includes("/") ? namespaced.slice(0, namespaced.indexOf("/")) : "");
        const prev = byId.get(id);
        const nextPriority = GATEWAY_PROVIDER_PRIORITY[inferredProvider] ?? 99;
        const prevPriority = prev ? (GATEWAY_PROVIDER_PRIORITY[prev.provider ?? ""] ?? 99) : 100;
        if (!prev || nextPriority < prevPriority) {
          byId.set(id, inferredProvider ? { id, provider: inferredProvider } : { id });
        }
      } else if (typeof item === "string") {
        const id = item.trim();
        if (!id || byId.has(id)) continue;
        const slash = id.indexOf("/");
        const provider = slash > 0 ? id.slice(0, slash) : "";
        byId.set(id, provider ? { id, provider } : { id });
      }
    }
    return [...byId.values()].sort((a, b) => (
      (GATEWAY_PROVIDER_PRIORITY[a.provider ?? ""] ?? 99)
      - (GATEWAY_PROVIDER_PRIORITY[b.provider ?? ""] ?? 99)
    ));
  } catch {
    return [];
  }
}

const RESTORES = new Set(["exact", "path-wise", "none"]);

type ActionBody = { ok?: unknown; code?: unknown; message?: unknown; profilePath?: unknown; changed?: unknown; restore?: unknown };

function actionOutcome(statusOk: boolean, body: ActionBody): GatewayClientActionOutcome {
  return {
    reached: true,
    ok: statusOk && body.ok === true,
    code: typeof body.code === "string" ? body.code : null,
    message: typeof body.message === "string" && body.message ? body.message : null,
    profilePath: typeof body.profilePath === "string" && body.profilePath.startsWith("~/") ? body.profilePath : null,
    changed: body.changed === true,
    restore: typeof body.restore === "string" && RESTORES.has(body.restore) ? body.restore as GatewayClientActionOutcome["restore"] : null,
  };
}

/** A refusal (409, 400, 404) carries its own code, so it is read rather than discarded. */
export async function runGatewayClientAction(
  apiBase: string,
  id: GatewayClientId,
  action: GatewayClientAction,
  model?: string,
): Promise<GatewayClientActionOutcome> {
  try {
    const response = await fetch(`${apiBase}/api/gateway-clients/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    });
    if (!response.ok) {
      // A 4xx refusal may carry an action code. Other failure statuses have no action body.
      if (response.status < 400 || response.status >= 500) {
        return { reached: true, ok: false, code: null, message: null, profilePath: null, changed: false, restore: null };
      }
      return actionOutcome(false, await response.json() as ActionBody);
    }
    return actionOutcome(true, await response.json() as ActionBody);
  } catch {
    return { reached: false, ok: false, code: null, message: null, profilePath: null, changed: false, restore: null };
  }
}
