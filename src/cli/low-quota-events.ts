import type { LowQuotaEvent } from "../codex/low-quota-events";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const LOW_QUOTA_EVENTS_MAX_LIMIT = 100;

export const LOW_QUOTA_EVENTS_USAGE = `Usage:
  epx observe low-quota-events [--limit <0..100>] [--json]
  epx logs low-quota-events [--limit <0..100>] [--json]`;

interface LowQuotaEventsResponse {
  events?: LowQuotaEvent[];
}

function takeUniqueLimit(args: string[]): number | undefined {
  let limit: number | undefined;
  try {
    limit = takeIntegerOption(args, "--limit", { min: 0, max: LOW_QUOTA_EVENTS_MAX_LIMIT });
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliUsageError(error.message, LOW_QUOTA_EVENTS_USAGE);
    }
    throw error;
  }
  if (limit !== undefined && args.includes("--limit")) {
    throw new CliUsageError("--limit was given more than once", LOW_QUOTA_EVENTS_USAGE);
  }
  return limit;
}

function formatEventLine(event: LowQuotaEvent): string {
  const ts = Number.isFinite(event.timestamp)
    ? new Date(event.timestamp).toISOString()
    : String(event.timestamp);
  const reset = event.resetAt !== null && Number.isFinite(event.resetAt)
    ? ` resetAt=${new Date(event.resetAt).toISOString()}`
    : "";
  return `  [${ts}] account=${event.accountId} window=${event.window} used=${event.percentUsed}% status=${event.status} delivery=${event.delivery}${reset}`;
}

export async function handleLowQuotaEventsCommand(
  argv: string[],
  deps: RuntimeApiDeps = {},
): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const limit = takeUniqueLimit(args);
  rejectArgs(args, LOW_QUOTA_EVENTS_USAGE);

  const path = limit === undefined
    ? "/api/codex-auth/low-quota-events"
    : `/api/codex-auth/low-quota-events?limit=${limit}`;
  const data = await runtimeRequest<LowQuotaEventsResponse>(path, { redirect: "error" }, deps);
  const events = Array.isArray(data.events) ? data.events : [];
  const lines = events.length === 0
    ? ["Low-quota events: none"]
    : [`Low-quota events (${events.length}):`, ...events.map(formatEventLine)];
  printData(data, wantsJson, lines);
}
