/** The latest failed attempt overrides retained data; before the first reply, the loaded dashboard is assumed reachable. */
export function proxyHealthOnline(data: unknown, error: unknown): boolean {
  return error == null && data !== null;
}

export interface ManagementHealth {
  version: string | null;
  /** Seconds the proxy has been up; null when it does not say. */
  uptime: number | null;
}

const authStatusByHealth = new WeakMap<ManagementHealth, 401 | 403>();

/** Returns 401 or 403 when readManagementHealth observed an authorization refusal, else null. */
export function managementHealthAuthStatus(health: ManagementHealth | null | undefined): 401 | 403 | null {
  return health ? (authStatusByHealth.get(health) ?? null) : null;
}

/**
 * Which health route answers on the machine plane.
 *
 * A connected Child serves its dashboard from the machine listener, which admits the
 * unauthenticated `/healthz` and refuses every `/api/*` route but `/api/machine/*`
 * (src/client/machine-listener.ts). Everywhere else the machine and shared planes are one
 * management origin, and a Remote Hub's management ingress denies `/healthz` on purpose, so
 * the dashboard asks the authenticated management counterpart instead (#8506).
 */
export function machineHealthPath(connected: boolean): "/healthz" | "/api/system/health" {
  return connected ? "/healthz" : "/api/system/health";
}

function readVersion(body: unknown): string | null {
  const version = body && typeof body === "object" ? (body as { version?: unknown }).version : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function readUptime(body: unknown): number | null {
  const uptime = body && typeof body === "object" ? (body as { uptime?: unknown }).uptime : undefined;
  return typeof uptime === "number" && Number.isFinite(uptime) && uptime >= 0 ? uptime : null;
}

/**
 * Probe one health route. A 2xx body yields its version and uptime. A 401 or 403 means the
 * process answered and only refused this session (a public standalone before the token prompt,
 * a hub before pairing), so the proxy is reachable with nothing more known. Any other status is
 * no answer (null); a network failure or abort throws to the caller.
 */
export async function readManagementHealth(
  base: string,
  path: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagementHealth | null> {
  const res = await fetchImpl(`${base}${path}`, { signal });
  if (res.status === 401 || res.status === 403) {
    const out: ManagementHealth = { version: null, uptime: null };
    authStatusByHealth.set(out, res.status);
    return out;
  }
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return { version: readVersion(body), uptime: readUptime(body) };
}
