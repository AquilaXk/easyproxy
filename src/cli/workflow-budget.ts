import { WORKFLOW_BUDGET_BOUNDS } from "../config/schema/workflow-budget";
import type { WorkflowBudgetEvent, WorkflowBudgetSnapshot } from "../lib/workflow-budget";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const MAX_ROOT_ID_LENGTH = 200;

export const WORKFLOW_BUDGET_USAGE = `Usage:
  epx workflow-budget [status] [--root <id>] [--limit <n>] [--json]
  epx workflow-budget clear [<root-id>] [--root <id>] [--json]
  epx workflow-budget settings [show|set|reset] [--max-concurrent-children <2..64>] [--max-physical-sends <1..10000>] [--max-distinct-children <1..1024>] [--reset] [--json]`;

interface WorkflowBudgetRootEntry extends WorkflowBudgetSnapshot {
  rootId: string;
}

interface WorkflowBudgetStatusResponse {
  roots?: WorkflowBudgetRootEntry[];
  root?: WorkflowBudgetRootEntry | null;
  events?: WorkflowBudgetEvent[];
}

interface WorkflowBudgetClearResponse {
  cleared?: boolean;
  root?: string;
  before?: WorkflowBudgetSnapshot;
}

interface WorkflowBudgetSettingsResponse {
  maxConcurrentChildren: number;
  maxPhysicalSends: number;
  maxDistinctChildren: number;
  interactiveReserve?: number;
  windowMs?: number;
  defaults?: {
    maxConcurrentChildren: number;
    maxPhysicalSends: number;
    maxDistinctChildren: number;
  };
  bounds?: typeof WORKFLOW_BUDGET_BOUNDS;
}

function normalizeRootId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_ROOT_ID_LENGTH) {
    throw new CliUsageError(
      `root must be a non-empty string of at most ${MAX_ROOT_ID_LENGTH} characters`,
      WORKFLOW_BUDGET_USAGE,
    );
  }
  return trimmed;
}

function takeUniqueOption(args: string[], flag: string): string | undefined {
  const value = takeOption(args, flag);
  if (value !== undefined && args.includes(flag)) {
    throw new CliUsageError(`${flag} was given more than once`, WORKFLOW_BUDGET_USAGE);
  }
  return value;
}

function takeUniqueInt(
  args: string[],
  flag: string,
  bounds: { min?: number; max?: number },
): number | undefined {
  let value: number | undefined;
  try {
    value = takeIntegerOption(args, flag, bounds);
  } catch (error) {
    if (error instanceof CliUsageError) throw new CliUsageError(error.message, WORKFLOW_BUDGET_USAGE);
    throw error;
  }
  if (value !== undefined && args.includes(flag)) {
    throw new CliUsageError(`${flag} was given more than once`, WORKFLOW_BUDGET_USAGE);
  }
  return value;
}

function formatRootLine(root: WorkflowBudgetRootEntry): string {
  return `  ${root.rootId}: active=${root.active} sends=${root.sends}/${root.maxPhysicalSends} (lifetime ${root.lifetimeSends}) children=${root.children}/${root.maxDistinctChildren}`;
}

function formatEventLine(event: WorkflowBudgetEvent): string {
  const timestamp = Number.isFinite(event.at) ? new Date(event.at).toISOString() : String(event.at);
  const reason = event.reason ? ` reason=${event.reason}` : "";
  const scope = event.spendScope ? ` spend=${event.spendScope}/${event.spendLimit ?? "?"}` : "";
  return `  [${timestamp}] ${event.kind} root=${event.rootId}${reason}${scope} sends=${event.sends} children=${event.children}`;
}

function formatStatusLines(data: WorkflowBudgetStatusResponse, filteredRoot: string | undefined): string[] {
  const lines: string[] = [];
  if (filteredRoot !== undefined || "root" in data) {
    if (!data.root) lines.push(`Root ${filteredRoot ?? "(unknown)"}: not currently tracked`);
    else lines.push("Root:", formatRootLine(data.root));
  } else if (Array.isArray(data.roots)) {
    if (data.roots.length === 0) lines.push("Tracked roots: none");
    else lines.push(`Tracked roots (${data.roots.length}):`, ...data.roots.map(formatRootLine));
  } else {
    lines.push(...summaryLines(data));
  }
  if (Array.isArray(data.events)) {
    if (data.events.length === 0) lines.push("Events: none");
    else lines.push(`Events (${data.events.length}):`, ...data.events.map(formatEventLine));
  }
  return lines;
}

function formatSettingsLines(data: WorkflowBudgetSettingsResponse, heading: string): string[] {
  if (
    typeof data.maxConcurrentChildren !== "number"
    || typeof data.maxPhysicalSends !== "number"
    || typeof data.maxDistinctChildren !== "number"
  ) {
    return summaryLines(data);
  }
  const defaults = data.defaults;
  const bounds = data.bounds ?? WORKFLOW_BUDGET_BOUNDS;
  const lineFor = (
    name: keyof typeof WORKFLOW_BUDGET_BOUNDS,
    value: number,
  ): string => {
    const defText = defaults ? `default ${defaults[name]}, ` : "";
    return `  ${name}: ${value} (${defText}range ${bounds[name].min}..${bounds[name].max})`;
  };
  const lines = [
    heading,
    lineFor("maxConcurrentChildren", data.maxConcurrentChildren),
    lineFor("maxPhysicalSends", data.maxPhysicalSends),
    lineFor("maxDistinctChildren", data.maxDistinctChildren),
  ];
  if (typeof data.interactiveReserve === "number") {
    lines.push(`  interactiveReserve: ${data.interactiveReserve} (read-only)`);
  }
  if (typeof data.windowMs === "number") {
    lines.push(`  windowMs: ${data.windowMs} (read-only)`);
  }
  return lines;
}

async function handleStatus(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  const rawRoot = takeUniqueOption(args, "--root");
  const limit = takeUniqueInt(args, "--limit", { min: 0 });
  rejectArgs(args, WORKFLOW_BUDGET_USAGE);

  const root = rawRoot === undefined ? undefined : normalizeRootId(rawRoot);
  const params = new URLSearchParams();
  if (root !== undefined) params.set("root", root);
  if (limit !== undefined) params.set("limit", String(limit));
  const query = params.toString();
  const path = query ? `/api/workflow-budget?${query}` : "/api/workflow-budget";
  const data = await runtimeRequest<WorkflowBudgetStatusResponse>(path, { redirect: "error" }, deps);
  printData(data, wantsJson, formatStatusLines(data, root));
}

async function handleClear(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  const flagRoot = takeUniqueOption(args, "--root");
  const positionalRoot = args.length > 0 && !args[0]!.startsWith("-") ? args.shift() : undefined;
  rejectArgs(args, WORKFLOW_BUDGET_USAGE);

  if (positionalRoot !== undefined && flagRoot !== undefined) {
    throw new CliUsageError("specify either positional <root-id> or --root, not both", WORKFLOW_BUDGET_USAGE);
  }
  const rawRoot = positionalRoot ?? flagRoot;
  if (rawRoot === undefined) {
    throw new CliUsageError("clear requires <root-id> or --root <id>", WORKFLOW_BUDGET_USAGE);
  }
  const root = normalizeRootId(rawRoot);
  const data = await runtimeRequest<WorkflowBudgetClearResponse>(
    "/api/workflow-budget/clear",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
      redirect: "error",
    },
    deps,
  );
  const lines = data.before
    ? [
        `Cleared workflow budget for root ${data.root ?? root} (was active=${data.before.active}, sends=${data.before.sends}, children=${data.before.children})`,
      ]
    : summaryLines(data);
  printData(data, wantsJson, lines);
}

async function handleSettings(args: string[], deps: RuntimeApiDeps): Promise<void> {
  let explicitAction: "show" | "set" | "reset" | undefined;
  if (args.length > 0 && !args[0]!.startsWith("-")) {
    const token = args.shift()!;
    if (token !== "show" && token !== "set" && token !== "reset") {
      throw new CliUsageError(`unknown workflow-budget settings action ${token}`, WORKFLOW_BUDGET_USAGE);
    }
    explicitAction = token;
  }

  const wantsJson = takeFlag(args, "--json");
  const resetFlag = takeFlag(args, "--reset");
  const maxConcurrentChildren = takeUniqueInt(
    args,
    "--max-concurrent-children",
    WORKFLOW_BUDGET_BOUNDS.maxConcurrentChildren,
  );
  const maxPhysicalSends = takeUniqueInt(
    args,
    "--max-physical-sends",
    WORKFLOW_BUDGET_BOUNDS.maxPhysicalSends,
  );
  const maxDistinctChildren = takeUniqueInt(
    args,
    "--max-distinct-children",
    WORKFLOW_BUDGET_BOUNDS.maxDistinctChildren,
  );
  rejectArgs(args, WORKFLOW_BUDGET_USAGE);

  const payload: Record<string, number> = {};
  if (maxConcurrentChildren !== undefined) payload.maxConcurrentChildren = maxConcurrentChildren;
  if (maxPhysicalSends !== undefined) payload.maxPhysicalSends = maxPhysicalSends;
  if (maxDistinctChildren !== undefined) payload.maxDistinctChildren = maxDistinctChildren;
  const hasCeiling = Object.keys(payload).length > 0;

  if (explicitAction === "show" && (resetFlag || hasCeiling)) {
    throw new CliUsageError("settings show does not accept --reset or ceiling flags", WORKFLOW_BUDGET_USAGE);
  }
  if ((explicitAction === "reset" || resetFlag) && hasCeiling) {
    throw new CliUsageError("reset cannot be combined with ceiling flags", WORKFLOW_BUDGET_USAGE);
  }
  if (explicitAction === "set" && resetFlag) {
    throw new CliUsageError("settings set cannot be combined with --reset", WORKFLOW_BUDGET_USAGE);
  }
  if (explicitAction === "set" && !hasCeiling) {
    throw new CliUsageError("settings set requires at least one ceiling flag", WORKFLOW_BUDGET_USAGE);
  }

  const action: "show" | "set" | "reset" =
    explicitAction ?? (resetFlag ? "reset" : hasCeiling ? "set" : "show");

  if (action === "show") {
    const data = await runtimeRequest<WorkflowBudgetSettingsResponse>(
      "/api/workflow-budget/settings",
      { redirect: "error" },
      deps,
    );
    printData(data, wantsJson, formatSettingsLines(data, "Workflow budget settings:"));
    return;
  }

  const body = action === "reset" ? "null" : JSON.stringify(payload);
  const heading = action === "reset" ? "Workflow budget settings reset:" : "Workflow budget settings updated:";
  const data = await runtimeRequest<WorkflowBudgetSettingsResponse>(
    "/api/workflow-budget/settings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
    },
    deps,
  );
  printData(data, wantsJson, formatSettingsLines(data, heading));
}

export async function handleWorkflowBudgetCommand(
  argv: string[],
  deps: RuntimeApiDeps = {},
): Promise<number> {
  return await runCliAction(async () => {
    const args = [...argv];
    const sub = args.length === 0 || args[0]!.startsWith("-") ? "status" : args.shift()!;
    if (sub === "status") await handleStatus(args, deps);
    else if (sub === "clear") await handleClear(args, deps);
    else if (sub === "settings") await handleSettings(args, deps);
    else throw new CliUsageError(`unknown workflow-budget command ${sub}`, WORKFLOW_BUDGET_USAGE);
  });
}
