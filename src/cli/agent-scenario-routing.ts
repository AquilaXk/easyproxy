import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import { readJsonInput, serializeManagementJson } from "./json-input";
import { scenarioRoutingSchema } from "../config/schema/scenario-routing";
import {
  DEFAULT_SCENARIO_PRECEDENCE,
  MAX_LONG_CONTEXT_THRESHOLD_TOKENS,
  MAX_THINK_BUDGET_THRESHOLD,
  MIN_LONG_CONTEXT_THRESHOLD_TOKENS,
  MIN_THINK_BUDGET_THRESHOLD,
  SCENARIO_KINDS,
} from "../routing/scenario";
import type { EpxScenarioKind } from "../types";

const USAGE = `Usage:
  epx agent scenario-routing show [--json]
  epx agent scenario-routing set (--file <FILE|-> | [--enabled <on|off>]
      [--long-context <route|->] [--think <route|->] [--background <route|->] [--web-search <route|->]
      [--long-context-threshold <tokens>] [--think-budget-threshold <tokens>]
      [--precedence <kind,kind...>] [--match-models <pattern,...|->] [--override-explicit <on|off>]) [--json]
  epx agent scenario-routing clear [--json]
  epx agent scenario-routing classify (--file <body.json|-> | [--selector <model>] [--header <k=v>]... [--compaction]) [--json]`;

const SCENARIO_SET_FLAGS = [
  "--file",
  "--enabled",
  "--long-context",
  "--think",
  "--background",
  "--web-search",
  "--long-context-threshold",
  "--think-budget-threshold",
  "--precedence",
  "--match-models",
  "--override-explicit",
];

function clearableRoute(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "-") return null;
  if (!trimmed) throw new CliUsageError("route target cannot be empty", USAGE);
  return trimmed;
}

function parseBooleanSwitch(raw: string | undefined, flag: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "on" || raw === "true") return true;
  if (raw === "off" || raw === "false") return false;
  throw new CliUsageError(`${flag} must be on or off`, USAGE);
}

function parsePrecedenceList(raw: string | undefined): EpxScenarioKind[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (items.length === 0 || items.length > SCENARIO_KINDS.length) {
    throw new CliUsageError(`--precedence accepts 1-${SCENARIO_KINDS.length} unique scenarios (${SCENARIO_KINDS.join(", ")})`, USAGE);
  }
  const seen = new Set<string>();
  const out: EpxScenarioKind[] = [];
  for (const item of items) {
    if (!(SCENARIO_KINDS as readonly string[]).includes(item)) {
      throw new CliUsageError(`unknown scenario "${item}" in --precedence`, USAGE);
    }
    if (seen.has(item)) throw new CliUsageError(`duplicate scenario "${item}" in --precedence`, USAGE);
    seen.add(item);
    out.push(item as EpxScenarioKind);
  }
  return out;
}

function formatScenarioLines(scenarioRouting: Record<string, unknown> | null): string[] {
  if (!scenarioRouting) return ["Scenario routing: not configured (disabled)"];
  const routes = (scenarioRouting.routes ?? {}) as Record<string, unknown>;
  const routeParts = SCENARIO_KINDS.map(kind => `${kind}=${typeof routes[kind] === "string" ? routes[kind] : "-"}`);
  return [
    `Scenario routing: ${scenarioRouting.enabled === true ? "enabled" : "disabled"}`,
    `Routes: ${routeParts.join("  ")}`,
    `Long-context threshold: ${typeof scenarioRouting.longContextThresholdTokens === "number" ? scenarioRouting.longContextThresholdTokens : 60000} tokens`,
    `Precedence: ${Array.isArray(scenarioRouting.precedence) ? scenarioRouting.precedence.join(" > ") : DEFAULT_SCENARIO_PRECEDENCE.join(" > ")}`,
  ];
}

async function handleShow(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ scenarioRouting: Record<string, unknown> | null }>("/api/routing/scenario", {}, deps);
  printData(result, wantsJson, formatScenarioLines(result.scenarioRouting ?? null));
}

async function handleClear(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ success: boolean; scenarioRouting: null }>("/api/routing/scenario", { method: "DELETE" }, deps);
  printData(result, wantsJson, ["Cleared scenario routing configuration."]);
}

async function handleSet(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const filePath = takeOption(args, "--file");
  const enabledRaw = takeOption(args, "--enabled");
  const longContext = clearableRoute(takeOption(args, "--long-context"));
  const think = clearableRoute(takeOption(args, "--think"));
  const background = clearableRoute(takeOption(args, "--background"));
  const webSearch = clearableRoute(takeOption(args, "--web-search"));
  const longThreshold = takeIntegerOption(args, "--long-context-threshold", {
    min: MIN_LONG_CONTEXT_THRESHOLD_TOKENS,
    max: MAX_LONG_CONTEXT_THRESHOLD_TOKENS,
  });
  const thinkThreshold = takeIntegerOption(args, "--think-budget-threshold", {
    min: MIN_THINK_BUDGET_THRESHOLD,
    max: MAX_THINK_BUDGET_THRESHOLD,
  });
  const precedence = parsePrecedenceList(takeOption(args, "--precedence"));
  const matchModelsRaw = takeOption(args, "--match-models");
  const overrideExplicit = parseBooleanSwitch(takeOption(args, "--override-explicit"), "--override-explicit");
  rejectArgs(args, USAGE);

  const scalarTouched = enabledRaw !== undefined
    || longContext !== undefined
    || think !== undefined
    || background !== undefined
    || webSearch !== undefined
    || longThreshold !== undefined
    || thinkThreshold !== undefined
    || precedence !== undefined
    || matchModelsRaw !== undefined
    || overrideExplicit !== undefined;

  if (filePath !== undefined && scalarTouched) {
    throw new CliUsageError(`--file cannot be combined with scalar flags (${SCENARIO_SET_FLAGS.filter(f => f !== "--file").join(", ")})`, USAGE);
  }
  if (filePath === undefined && !scalarTouched) {
    throw new CliUsageError("specify --file or at least one scenario-routing setting flag", USAGE);
  }

  let payload: unknown;
  if (filePath !== undefined) {
    payload = readJsonInput(filePath);
    const parsed = scenarioRoutingSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CliUsageError(parsed.error.issues[0]?.message ?? "invalid scenario-routing JSON", USAGE);
    }
    payload = parsed.data;
  } else {
    const current = await runtimeRequest<{ scenarioRouting: Record<string, unknown> | null }>("/api/routing/scenario", {}, deps);
    const base = current.scenarioRouting ?? { enabled: true, routes: {} };
    const existingRoutes = { ...((base.routes ?? {}) as Record<string, string>) };
    if (longContext === null) delete existingRoutes.longContext;
    else if (longContext !== undefined) existingRoutes.longContext = longContext;
    if (think === null) delete existingRoutes.think;
    else if (think !== undefined) existingRoutes.think = think;
    if (background === null) delete existingRoutes.background;
    else if (background !== undefined) existingRoutes.background = background;
    if (webSearch === null) delete existingRoutes.webSearch;
    else if (webSearch !== undefined) existingRoutes.webSearch = webSearch;

    const enabled = parseBooleanSwitch(enabledRaw, "--enabled") ?? (typeof base.enabled === "boolean" ? base.enabled : true);
    const draft: Record<string, unknown> = {
      ...base,
      enabled,
      routes: existingRoutes,
      ...(longThreshold !== undefined ? { longContextThresholdTokens: longThreshold } : {}),
      ...(thinkThreshold !== undefined ? { thinkBudgetThreshold: thinkThreshold } : {}),
      ...(precedence !== undefined ? { precedence } : {}),
      ...(overrideExplicit !== undefined ? { overrideExplicitRoutes: overrideExplicit } : {}),
    };
    if (matchModelsRaw !== undefined) {
      if (matchModelsRaw === "-") delete draft.matchModels;
      else draft.matchModels = matchModelsRaw.split(",").map(s => s.trim()).filter(Boolean);
    }
    const parsed = scenarioRoutingSchema.safeParse(draft);
    if (!parsed.success) {
      throw new CliUsageError(parsed.error.issues[0]?.message ?? "invalid scenario-routing settings", USAGE);
    }
    payload = parsed.data;
  }

  const result = await runtimeRequest<{ success: boolean; scenarioRouting: Record<string, unknown> }>(
    "/api/routing/scenario",
    { method: "PUT", headers: { "content-type": "application/json" }, body: serializeManagementJson(payload) },
    deps,
  );
  printData(result, wantsJson, formatScenarioLines(result.scenarioRouting));
}

async function handleClassify(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const filePath = takeOption(args, "--file");
  const selector = takeOption(args, "--selector");
  const isCompaction = takeFlag(args, "--compaction");
  const headers: Record<string, string> = {};
  while (true) {
    const headerPair = takeOption(args, "--header");
    if (headerPair === undefined) break;
    const eq = headerPair.indexOf("=");
    if (eq <= 0) throw new CliUsageError("--header requires key=value", USAGE);
    headers[headerPair.slice(0, eq).trim()] = headerPair.slice(eq + 1).trim();
  }
  rejectArgs(args, USAGE);

  const body = filePath !== undefined ? readJsonInput(filePath) : {};
  const result = await runtimeRequest<{
    active: boolean;
    matched: string | null;
    targetSelector: string | null;
    resolvedTarget: { provider: string; model: string; routeKind: string } | null;
    classification: { estimatedTokens: number; matchedScenarios: string[] };
  }>(
    "/api/routing/scenario/classify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serializeManagementJson({
        body,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(isCompaction ? { isCompaction: true } : {}),
        ...(selector ? { selector } : {}),
      }),
    },
    deps,
  );
  const lines = [
    `Scenario routing: ${result.active ? "active" : "inactive"}`,
    `Matched: ${result.matched ?? "none"} (signals: ${result.classification.matchedScenarios.join(", ") || "none"}, ~${result.classification.estimatedTokens} tokens)`,
    ...(result.resolvedTarget ? [`Target: ${result.resolvedTarget.provider}/${result.resolvedTarget.model} (${result.resolvedTarget.routeKind})`] : []),
  ];
  printData(result, wantsJson, lines);
}

export async function handleAgentScenarioRoutingCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "show", ...rest] = argv;
    if (sub === "show") await handleShow(rest, deps);
    else if (sub === "set") await handleSet(rest, deps);
    else if (sub === "clear") await handleClear(rest, deps);
    else if (sub === "classify") await handleClassify(rest, deps);
    else throw new CliUsageError(`unknown scenario-routing subcommand "${sub}"`, USAGE);
  });
}
