import * as z from "zod/v4";
import {
  MAX_LONG_CONTEXT_THRESHOLD_TOKENS,
  MAX_THINK_BUDGET_THRESHOLD,
  MIN_LONG_CONTEXT_THRESHOLD_TOKENS,
  MIN_THINK_BUDGET_THRESHOLD,
  SCENARIO_KINDS,
} from "../../routing/scenario";

const MAX_MATCH_MODELS = 64;
const MAX_SELECTOR_LENGTH = 256;

const scenarioKindSchema = z.enum(SCENARIO_KINDS);

const scenarioRoutesSchema = z.object({
  longContext: z.string().trim().min(1).max(MAX_SELECTOR_LENGTH).optional(),
  think: z.string().trim().min(1).max(MAX_SELECTOR_LENGTH).optional(),
  background: z.string().trim().min(1).max(MAX_SELECTOR_LENGTH).optional(),
  webSearch: z.string().trim().min(1).max(MAX_SELECTOR_LENGTH).optional(),
}).strict();

export const scenarioRoutingSchema = z.object({
  enabled: z.boolean(),
  precedence: z.array(scenarioKindSchema)
    .max(SCENARIO_KINDS.length)
    .refine(list => new Set(list).size === list.length, "precedence must not repeat scenarios")
    .optional(),
  longContextThresholdTokens: z.number()
    .int()
    .min(MIN_LONG_CONTEXT_THRESHOLD_TOKENS)
    .max(MAX_LONG_CONTEXT_THRESHOLD_TOKENS)
    .optional(),
  thinkBudgetThreshold: z.number()
    .int()
    .min(MIN_THINK_BUDGET_THRESHOLD)
    .max(MAX_THINK_BUDGET_THRESHOLD)
    .optional(),
  routes: scenarioRoutesSchema,
  matchModels: z.array(z.string().trim().min(1).max(MAX_SELECTOR_LENGTH))
    .max(MAX_MATCH_MODELS)
    .refine(list => new Set(list).size === list.length, "matchModels must not contain duplicates")
    .optional(),
  overrideExplicitRoutes: z.boolean().optional(),
}).strict().refine(
  value => !value.enabled || Object.values(value.routes).some(target => typeof target === "string" && target.length > 0),
  { message: "scenarioRouting with enabled: true requires at least one configured route target" },
);

export function scenarioRoutingConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  const parsed = scenarioRoutingSchema.safeParse(value);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "invalid scenarioRouting configuration";
}
