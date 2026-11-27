import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as boundedBody from "../../../src/lib/bounded-body";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import { clearRequestLogsForTests, type RequestLogContext } from "../../../src/server/request-log";
import * as inferenceContext from "../../../src/server/inference/context";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { resetSharedSpendLedgerForTest } from "../../../src/lib/spend-reservation-ledger";
import { buildAnthropicMessagesPassthroughRequest } from "../../../src/adapters/anthropic/passthrough";
import { allowlistAnthropicBetas, logDroppedAnthropicBetas } from "../../../src/adapters/anthropic/beta-allowlist";
import {
  DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS,
  MAX_ANTHROPIC_THINKING_BUDGET,
  MIN_ANTHROPIC_THINKING_BUDGET,
  rectifyAnthropicThinkingBudgetOnError,
  rectifyAnthropicThinkingBudgetPreRequest,
  shouldRectifyAnthropicThinkingBudgetError,
} from "../../../src/adapters/anthropic/thinking-rectifier";
import {
  normalizeInboundAnthropicUsageLimit,
  parseAnthropicSlowModeHeaders,
} from "../../../src/adapters/anthropic/slow-mode";
import { anthropicRateLimitHeaders } from "../../../src/server/anthropic-rate-limit-headers";
import {
  anthropicSlowFallbackFor,
  clearAllAnthropicSlowFallbackState,
} from "../../../src/oauth/anthropic-slow-fallback";
import {
  anthropicRoutingFor,
  clearAnthropicAccountPoolState,
  forgetAnthropicFailoverQuorum,
  getAnthropicAccountHealthSnapshot,
  getEligibleAnthropicAccounts,
} from "../../../src/oauth/anthropic-routing";
import { anthropicRatePolicyFor, classifyAnthropic429 } from "../../../src/oauth/anthropic-rate-limit-policy";
import {
  clearAccountQuotaCache,
  resetProviderQuotaReconcileStateForTests,
} from "../../../src/providers/quota";
import {
  clearGenericFailoverHealth,
  hasEligibleGenericOAuthFailoverTarget,
  rotateGenericOAuthAccountOnRefusal,
} from "../../../src/oauth/generic-account-failover";
import { clearResponseStateForTests } from "../../../src/responses/state";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import { handleClaudeMessages } from "../../../src/server/claude-messages";
import { handleResponses } from "../../../src/server/responses";
import { clearKeyCooldowns } from "../../../src/providers/api-key-cooldowns";
import {
  rotateProviderTransportOnAnthropicBilling,
  rotateProviderTransportOnCreditOrBudget,
} from "../../../src/providers/key-failover";
import { resolveOpenCodeGoTransport } from "../../../src/providers/opencode-go-transport";
import { resolveProviderTransport } from "../../../src/providers/xai-transport";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import {
  isCreditOrBudgetExhaustedRefusal,
  isSpendingCapacityThrottleText,
  readCreditOrBudgetExhaustedResponse,
} from "../../../src/lib/credit-budget-refusal";
import { comboFailureDecision } from "../../../src/combos/failover";
import type { EpxConfig, EpxProviderConfig } from "../../../src/types";

let originalHome: string | undefined;
let tempHome: string | undefined;
let releaseSpend: (() => void) | undefined;
let servers: Array<{ stop(closeActiveConnections?: boolean): unknown }> = [];

beforeEach(() => {
  originalHome = process.env.EASYPROXY_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "epx-anthropic-regressions-"));
  process.env.EASYPROXY_HOME = tempHome;
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearAllAnthropicSlowFallbackState();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearGenericFailoverHealth();
  clearResponseStateForTests();
  clearRequestLogsForTests();
  clearKeyCooldowns();
  resetSharedSpendLedgerForTest();
  releaseSpend = acquireOwnedSpendHome();
});

afterEach(async () => {
  for (const s of servers) {
    try {
      await Promise.resolve(s.stop(true));
    } catch {
      // Ignore already-stopped server during cleanup.
    }
  }
  servers = [];
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearAllAnthropicSlowFallbackState();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearGenericFailoverHealth();
  clearResponseStateForTests();
  clearRequestLogsForTests();
  clearKeyCooldowns();
  try {
    releaseSpend?.();
  } finally {
    releaseSpend = undefined;
    if (originalHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = originalHome;
    if (tempHome) removeTreeWithRetry(tempHome);
    tempHome = undefined;
  }
});

const syntheticAccessToken = (index: number) => `synthetic-anthropic-access-${index}`;
const bearerAccess = (index: number) => ["Bearer", syntheticAccessToken(index)].join(" ");

async function seedAnthropicOAuthAccounts(count = 2): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await saveCredential("anthropic", {
      access: `synthetic-anthropic-access-${i}`,
      refresh: `synthetic-anthropic-refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `synthetic-account-${i}`,
    });
  }
  const ids = getAccountSet("anthropic")!.accounts.map(a => a.id);
  await setActiveAccount("anthropic", ids[0]!);
  return ids;
}

function makeAnthropicMsg(text = "ok"): Record<string, unknown> {
  return {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 4 },
  };
}

function makeProviderConfig(
  fetchImpl: typeof fetch,
  overrides: Partial<EpxProviderConfig> = {},
): EpxConfig {
  const provider: EpxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    models: ["claude-sonnet-4-5"],
    fetch: fetchImpl,
    ...overrides,
  };
  return {
    port: 0,
    defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: true, strategy: "round-robin" },
    protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
    providers: { anthropic: provider },
  };
}

describe("Defect 4: promptCacheInjection.ttl=1h promotion without 5m downgrade", () => {
  test("promotes TTL-less caller breakpoints to 1h on compatible passthrough when config omits cacheRetention", () => {
    const source = {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [{
        name: "lookup",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      }],
      messages: [
        { role: "user", content: [{ type: "text", text: "turn", cache_control: { type: "ephemeral" } }] },
      ],
    };

    const compatible = {
      baseUrl: "https://compatible-proxy.example.com",
      authMode: "key" as const,
      apiKey: "sk-compat-synthetic",
    };

    const promoted = buildAnthropicMessagesPassthroughRequest(
      compatible,
      "claude-sonnet-4-5",
      source,
      { promptCacheInjection: { enabled: true, ttl: "1h" } },
    ).wireBody;

    expect((promoted.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect((promoted.tools as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(
      ((promoted.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>)[0]!
        .cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" });

    // Explicit operator cacheRetention: "short" takes precedence over promptCacheInjection.ttl: "1h".
    const shortExplicit = buildAnthropicMessagesPassthroughRequest(
      compatible,
      "claude-sonnet-4-5",
      source,
      { cacheRetention: "short", promptCacheInjection: { enabled: true, ttl: "1h" } },
    ).wireBody;
    expect((shortExplicit.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: "ephemeral",
    });

    // If caller pinned an explicit 5m breakpoint anywhere, preserve it to avoid invalid 5m->1h ordering.
    const pinned5m = {
      ...source,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "pinned", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
      ],
    };
    const untouched = buildAnthropicMessagesPassthroughRequest(
      compatible,
      "claude-sonnet-4-5",
      pinned5m,
      { promptCacheInjection: { enabled: true, ttl: "1h" } },
    ).wireBody;
    expect((untouched.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("caller-forward /v1/messages promotes TTL-less breakpoints to 1h when promptCacheInjection.ttl is 1h", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        captured.push(await req.json() as Record<string, unknown>);
        return Response.json(makeAnthropicMsg("forward-1h"));
      },
    });
    servers.push(upstream);

    const config: EpxConfig = {
      port: 0,
      defaultProvider: "anthropic",
      promptCacheInjection: { enabled: true, ttl: "1h" },
      claudeCode: { anthropicBaseUrl: upstream.url.toString().replace(/\/$/, "") },
      providers: {},
    };
    saveConfig(config);

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-caller",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        ],
      }),
    });

    const res = await handleClaudeMessages(req, config, {});
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect((captured[0]!.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(
      ((captured[0]!.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>)[0]!
        .cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("Defect 5 & P0-A: allowed_warning, Slow Mode, Grace & Overage", () => {
  test("parses slow/grace/overage headers, normalizes allowed_warning, and validates inbound anthropic-usage-limit", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-slow-offer": "treatment",
      "anthropic-ratelimit-unified-slow-status": "active",
      "anthropic-ratelimit-unified-slow-retry-after": "4.5",
      "anthropic-ratelimit-unified-slow-max-wait": "30",
      "anthropic-ratelimit-unified-slow-budget-utilization": "0.625",
      "anthropic-ratelimit-unified-slow-budget-reset": "1767225600",
      "anthropic-ratelimit-unified-overage-status": "allowed_warning",
      "anthropic-ratelimit-unified-overage-in-use": "true",
      "anthropic-ratelimit-unified-grace-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-grace-7d-utilization": "0.18",
      "anthropic-ratelimit-unified-representative-claim": "slow",
    });

    const signal = parseAnthropicSlowModeHeaders(headers);
    expect(signal).toMatchObject({
      offer: "treatment",
      status: "active",
      retryAfterMs: 4500,
      maxWaitMs: 30_000,
      budgetUtilization: 0.625,
      budgetResetAtSec: 1767225600,
      overageStatus: "allowed_warning",
      overageInUse: true,
      overageAllowed: true,
      unifiedLimitClaim: true,
      graceUtilization: { fiveHour: 0.42, sevenDay: 0.18 },
    });

    const wireHeaders = anthropicRateLimitHeaders(headers);
    expect(wireHeaders["anthropic-ratelimit-unified-status"]).toBe("allowed_warning");
    expect(wireHeaders["anthropic-ratelimit-unified-overage-status"]).toBe("allowed_warning");
    expect(wireHeaders["anthropic-ratelimit-unified-overage-in-use"]).toBe("true");
    expect(wireHeaders["anthropic-ratelimit-unified-slow-offer"]).toBe("treatment");
    expect(wireHeaders["anthropic-ratelimit-unified-slow-status"]).toBe("active");
    expect(wireHeaders["anthropic-ratelimit-unified-representative-claim"]).toBe("slow");

    // 429 with allowed_warning and NO Retry-After is classified as transient-rate, not unknown/quota.
    expect(classifyAnthropic429(new Headers({ "anthropic-ratelimit-unified-status": "allowed_warning" }))).toBe(
      "transient-rate",
    );
    expect(
      classifyAnthropic429(new Headers({ "anthropic-ratelimit-unified-slow-status": "slot_busy" }), Date.now(), {
        sentSlow: true,
      }),
    ).toBe("transient-rate");

    expect(normalizeInboundAnthropicUsageLimit(" SLOW ")).toBe("slow");
    expect(normalizeInboundAnthropicUsageLimit("fast")).toBeUndefined();
    expect(normalizeInboundAnthropicUsageLimit("x".repeat(200))).toBeUndefined();
  });

  test("429 allowed_warning without Retry-After detours to sibling OAuth account and preserves allowed_warning header", async () => {
    const ids = await seedAnthropicOAuthAccounts(2);
    const seenAuths: string[] = [];
    const config = makeProviderConfig(async (_input, init) => {
      const h = new Headers(init?.headers);
      const auth = h.get("authorization") ?? "";
      seenAuths.push(auth);
      if (auth === bearerAccess(0)) {
        return Response.json(
          { type: "error", error: { type: "rate_limit_error", message: "warning rate threshold" } },
          { status: 429, headers: { "anthropic-ratelimit-unified-status": "allowed_warning" } },
        );
      }
      return Response.json(makeAnthropicMsg("recovered-on-sibling"), {
        headers: {
          "anthropic-ratelimit-unified-status": "allowed_warning",
          "anthropic-ratelimit-unified-overage-status": "allowed_warning",
        },
      });
    });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await handleClaudeMessages(req, config, {});
    expect(res.status).toBe(200);
    const json = await res.json() as { content: Array<{ text: string }> };
    expect(json.content[0]!.text).toBe("recovered-on-sibling");
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed_warning");
    expect(res.headers.get("anthropic-ratelimit-unified-overage-status")).toBe("allowed_warning");
    // Same-account brief pause on account 0 retries once on 0, then detours cleanly to account 1.
    expect(seenAuths.some(a => a.includes("synthetic-anthropic-access-0"))).toBe(true);
    expect(seenAuths.some(a => a.includes("synthetic-anthropic-access-1"))).toBe(true);
    // Transient allowed_warning 429 records transient rate pause (detour grace), not hard shared-quota cooldown.
    expect(anthropicRatePolicyFor("anthropic").anthropicRatePausedRecently(ids[0]!)).toBe(true);
    expect(getAnthropicAccountHealthSnapshot(ids[0]!)).toBeNull();
  });

  test("caller-forward normalizes inbound anthropic-usage-limit: slow and drops non-slow values", async () => {
    const capturedHeaders: Array<string | null> = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedHeaders.push(req.headers.get("anthropic-usage-limit"));
        return Response.json(makeAnthropicMsg("slow-forwarded"));
      },
    });
    servers.push(upstream);

    const config: EpxConfig = {
      port: 0,
      defaultProvider: "anthropic",
      claudeCode: { anthropicBaseUrl: upstream.url.toString().replace(/\/$/, "") },
      providers: {},
    };
    saveConfig(config);

    const resSlow = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-ant-caller",
          "anthropic-version": "2023-06-01",
          "anthropic-usage-limit": "  SLOW  ",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      }),
      config,
      {},
    );
    expect(resSlow.status).toBe(200);

    const resInvalid = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-ant-caller",
          "anthropic-version": "2023-06-01",
          "anthropic-usage-limit": "fast",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      }),
      config,
      {},
    );
    expect(resInvalid.status).toBe(200);

    expect(capturedHeaders).toEqual(["slow", null]);
  });

  test("opt-in 5h-only slowFallback rescues exhausted OAuth pool and skips 7d or control accounts", async () => {
    const [acc0, acc1] = await seedAnthropicOAuthAccounts(2);
    const routing = anthropicRoutingFor("anthropic");
    const futureReset = Math.floor((Date.now() + 600_000) / 1000);
    const fiveHourOnlyHeaders = new Headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(futureReset),
      "retry-after": "120",
    });

    const slowDisabledConfig = makeProviderConfig(async () => Response.json(makeAnthropicMsg()));
    slowDisabledConfig.anthropicAccountPool = { enabled: true, strategy: "round-robin", slowFallback: false };

    const slowEnabledConfig = makeProviderConfig(async (_input, init) => {
      const h = new Headers(init?.headers);
      sentSlowHeaders.push(h.get("anthropic-usage-limit"));
      return Response.json(makeAnthropicMsg("slow-lane-ok"), {
        headers: { "anthropic-ratelimit-unified-slow-offer": "treatment", "anthropic-ratelimit-unified-slow-status": "active" },
      });
    });
    slowEnabledConfig.anthropicAccountPool = { enabled: true, strategy: "round-robin", slowFallback: true };
    const sentSlowHeaders: Array<string | null> = [];

    // Exhaust both accounts with 5h-only 429 holds.
    routing.recordAnthropicAccountRefusal(slowEnabledConfig, acc0!, 429, "120", Date.now(), fiveHourOnlyHeaders);
    routing.recordAnthropicAccountRefusal(slowEnabledConfig, acc1!, 429, "120", Date.now(), fiveHourOnlyHeaders);

    expect(getEligibleAnthropicAccounts(Date.now(), "claude-sonnet-4-5")).toEqual([]);
    expect(routing.getSlowFallbackEligibleAccounts(slowDisabledConfig, Date.now(), "claude-sonnet-4-5")).toEqual([]);
    expect(routing.getSlowFallbackEligibleAccounts(slowEnabledConfig, Date.now(), "claude-sonnet-4-5")).toHaveLength(2);

    // Mark acc0 as control arm -> excluded from slow fallback; only acc1 remains eligible.
    anthropicSlowFallbackFor("anthropic").recordSlowHeaders(
      acc0!,
      new Headers({ "anthropic-ratelimit-unified-slow-offer": "control" }),
    );
    expect(routing.getSlowFallbackEligibleAccounts(slowEnabledConfig, Date.now(), "claude-sonnet-4-5")).toEqual([acc1!]);
    expect(routing.pickSlowFallbackAccount(slowEnabledConfig, Date.now(), null, "claude-sonnet-4-5")).toBe(acc1!);

    // Full /v1/responses flow picks the slow-eligible fallback account and sends `anthropic-usage-limit: slow`.
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", input: "say hi", stream: false }),
      }),
      slowEnabledConfig,
      {} as RequestLogContext,
    );
    expect(response.status).toBe(200);
    expect(sentSlowHeaders).toEqual(["slow"]);

    // Weekly (7d) rejection disqualifies even with slowFallback: true.
    routing.recordAnthropicAccountRefusal(
      slowEnabledConfig,
      acc1!,
      429,
      "120",
      Date.now(),
      new Headers({
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-7d-status": "rejected",
      }),
    );
    expect(routing.getSlowFallbackEligibleAccounts(slowEnabledConfig, Date.now(), "claude-sonnet-4-5")).toEqual([]);
  });
});

describe("Defect 6 & P0-B: credits_required and multi-provider billing vs capacity discrimination", () => {
  test("discriminates credit/prepaid/budget exhaustion from spending capacity throttles and plain validation prose", async () => {
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 400,
      code: "credits_required",
      type: "permission_error",
      message: "Usage credits are required for this model",
    })).toBe(true);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 402,
      code: "usage_pricing_required",
      message: "Prepaid balance has been used up",
    })).toBe(true);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 422,
      code: "budget_exceeded",
      message: "Budget has been exceeded!",
    })).toBe(true);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 403,
      message: "You hit your monthly spending cap for this project",
    })).toBe(true);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 402,
      message: "You exceeded your current credits balance",
    })).toBe(true);

    // Must exclude spending-capacity throttles, plain 400 validation prose, and non-matching extensions.
    expect(isSpendingCapacityThrottleText("Rate limited due to spending capacity window")).toBe(true);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 429,
      message: "Temporary limit on spending capacity, please retry shortly",
    })).toBe(false);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 400,
      message: "Invalid field: mentions monthly spending cap in user schema description",
    })).toBe(false);
    expect(isCreditOrBudgetExhaustedRefusal({
      status: 400,
      code: "USAGE_PRICING_REQUIRED_CHANGEABLE",
      message: "Plan upgrade is editable",
    })).toBe(false);

    // Response body reader bounds check & non-JSON rejection.
    const litellm422 = Response.json({ error: { code: "budget_exceeded", message: "Budget has been exceeded!" } }, { status: 422 });
    expect(await readCreditOrBudgetExhaustedResponse(litellm422)).toBe(true);
    const html422 = new Response("<html>Budget has been exceeded</html>", { status: 422, headers: { "content-type": "text/html" } });
    expect(await readCreditOrBudgetExhaustedResponse(html422)).toBe(false);

    // Combo failover decision uses the normalized verdict.
    expect(comboFailureDecision(422, "Budget has been exceeded!", { code: "budget_exceeded" })).toBe("hop");
    expect(comboFailureDecision(400, "Invalid tool arg referencing prepaid balance")).toBe("stop");
  });

  test("Anthropic OAuth rotates away from sibling on credits_required refusal", async () => {
    const [acc0, acc1] = await seedAnthropicOAuthAccounts(2);
    const seenAuths: string[] = [];
    const config = makeProviderConfig(async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenAuths.push(auth);
      if (auth === bearerAccess(0)) {
        return Response.json(
          {
            type: "error",
            error: {
              type: "permission_error",
              code: "credits_required",
              message: "Usage credits are required for this model",
            },
          },
          { status: 402 },
        );
      }
      return Response.json(makeAnthropicMsg("sibling-served"));
    });

    const res = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      config,
      {},
    );

    expect(res.status).toBe(200);
    const json = await res.json() as { content: Array<{ text: string }> };
    expect(json.content[0]!.text).toBe("sibling-served");
    expect(seenAuths).toEqual([bearerAccess(0), bearerAccess(1)]);
    expect(getAnthropicAccountHealthSnapshot(acc0!)?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(getAnthropicAccountHealthSnapshot(acc1!)).toBeNull();
  });
});

describe("Defect 7 & P2-B: Anthropic beta allowlist 2026 synchronization", () => {
  test("preserves mid-conversation-output-config-2026-07-01 and 2026 SDK betas while dropping unknown betas", () => {
    const expected2026Betas = [
      "mid-conversation-output-config-2026-07-01",
      "output-300k-2026-03-24",
      "compact-2026-01-12",
      "compact-2026-09-04",
      "mid-conversation-system-clear-at-2026-08-21",
      "mcp-client-2025-11-20",
      "mcp-client-2026-09-15",
      "mcp-tunnels-2026-06-22",
      "task-budgets-2026-03-13",
      "cache-diagnosis-2026-04-07",
      "message-threads-2026-08-12",
      "agent-memory-2026-07-22",
      "dreaming-2026-04-21",
      "managed-agents-2026-04-01",
    ];
    const requested = [...expected2026Betas, "anonymous-mystery-beta-2099-01-01"];
    const result = allowlistAnthropicBetas(requested.join(","), "first-party", { observedNativeClient: true });
    expect(result.betas).toEqual(expected2026Betas);
    expect(result.dropped).toBe(true);
    expect(result.droppedUnrecognized).toBe(1);

    // Mid-conversation output config survives on observed native Anthropic clients.
    expect(allowlistAnthropicBetas("mid-conversation-output-config-2026-07-01", "first-party", { observedNativeClient: true }).betas).toEqual([
      "mid-conversation-output-config-2026-07-01",
    ]);

    const warnings: string[] = [];
    logDroppedAnthropicBetas(result, line => warnings.push(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("anonymous-mystery-beta-2099-01-01".length > 0 ? "unnamed" : "");
  });
});

describe("P1-D(c): Anthropic thinking.budget_tokens pre-rectifier and reactive HTTP 400 recovery", () => {
  test("unit rectification enforces >=1024 and max_tokens > budget_tokens while skipping adaptive and disabled", () => {
    const adaptive = { model: "claude-opus-4-6", max_tokens: 512, thinking: { type: "adaptive" } };
    expect(rectifyAnthropicThinkingBudgetPreRequest(adaptive)).toEqual({ body: adaptive, applied: false });

    const disabled = { model: "claude-sonnet-4-5", max_tokens: 512, thinking: { type: "disabled" } };
    expect(rectifyAnthropicThinkingBudgetPreRequest(disabled)).toEqual({ body: disabled, applied: false });

    const tooLow = {
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 256 },
    };
    const rectifiedLow = rectifyAnthropicThinkingBudgetPreRequest(tooLow, { modelMaxOutputTokens: 16_000 });
    expect(rectifiedLow.applied).toBe(true);
    expect(rectifiedLow.body.thinking.budget_tokens).toBe(MIN_ANTHROPIC_THINKING_BUDGET);
    expect(rectifiedLow.body.max_tokens).toBeGreaterThan(MIN_ANTHROPIC_THINKING_BUDGET);
    expect(rectifiedLow.body.max_tokens).toBeLessThanOrEqual(16_000);

    expect(shouldRectifyAnthropicThinkingBudgetError(
      "thinking.budget_tokens: Input should be greater than or equal to 1024",
    )).toBe(true);
    expect(shouldRectifyAnthropicThinkingBudgetError(
      "max_tokens must be greater than thinking.budget_tokens",
    )).toBe(true);
    expect(shouldRectifyAnthropicThinkingBudgetError("unrelated validation error")).toBe(false);

    const errRectified = rectifyAnthropicThinkingBudgetOnError({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 128 },
    });
    expect(errRectified.applied).toBe(true);
    expect(errRectified.body.thinking).toEqual({ type: "enabled", budget_tokens: MAX_ANTHROPIC_THINKING_BUDGET });
    expect(errRectified.body.max_tokens).toBe(DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS);
  });

  test("passthrough keeps unflagged payloads verbatim and pre-rectifies only when thinkingBudgetRectifier is enabled", () => {
    const malformed = {
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 0 },
      messages: [{ role: "user", content: "think" }],
    };

    const untouched = buildAnthropicMessagesPassthroughRequest(
      { baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "sk-ant-test", thinkingBudgetRectifier: false },
      "claude-sonnet-4-5",
      malformed,
    ).wireBody;
    expect(untouched.thinking).toEqual({ type: "enabled", budget_tokens: 0 });
    expect(untouched.max_tokens).toBe(512);

    const fixed = buildAnthropicMessagesPassthroughRequest(
      { baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "sk-ant-test", thinkingBudgetRectifier: true },
      "claude-sonnet-4-5",
      malformed,
    ).wireBody;
    expect(fixed.thinking).toEqual({ type: "enabled", budget_tokens: MIN_ANTHROPIC_THINKING_BUDGET });
    expect(Number(fixed.max_tokens)).toBeGreaterThan(MIN_ANTHROPIC_THINKING_BUDGET);
  });

  test("managed native /v1/messages retries once with rectified budget_tokens=32000 & max_tokens=64000 on 400 error", async () => {
    const sentBodies: Array<Record<string, unknown>> = [];
    const config: EpxConfig = {
      port: 0,
      defaultProvider: "anth",
      protocols: { rollout: { managedMessagesNative: true } },
      providers: {
        anth: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "sk-ant-synthetic",
          models: ["claude-sonnet-4-5"],
          fetch: (async (_input, init) => {
            const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
            sentBodies.push(parsed);
            if (sentBodies.length === 1) {
              return Response.json(
                {
                  type: "error",
                  error: {
                    type: "invalid_request_error",
                    message: "max_tokens must be greater than thinking.budget_tokens",
                  },
                },
                { status: 400 },
              );
            }
            return Response.json(makeAnthropicMsg("rectified-ok"));
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };

    const res = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "anth/claude-sonnet-4-5",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 4096 },
          messages: [{ role: "user", content: "solve" }],
        }),
      }),
      config,
      {},
    );

    expect(res.status).toBe(200);
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]!.thinking).toEqual({
      type: "enabled",
      budget_tokens: MAX_ANTHROPIC_THINKING_BUDGET,
    });
    expect(sentBodies[1]!.max_tokens).toBe(DEFAULT_ANTHROPIC_RECTIFIED_MAX_TOKENS);
  });

  test("generic OAuth billing cooldown excludes multi-family account across all model families", async () => {
    await saveCredential("google-antigravity", {
      access: "synthetic-ag-access-0",
      refresh: "synthetic-ag-refresh-0",
      expires: Date.now() + 3_600_000,
      accountId: "ag-synthetic-0",
      email: "ag0@example.test",
    });
    await saveCredential("google-antigravity", {
      access: "synthetic-ag-access-1",
      refresh: "synthetic-ag-refresh-1",
      expires: Date.now() + 3_600_000,
      accountId: "ag-synthetic-1",
      email: "ag1@example.test",
    });
    const agAccounts = getAccountSet("google-antigravity")!.accounts.map(a => a.id);
    expect(agAccounts).toHaveLength(2);
    const ag0 = agAccounts[0]!;
    const ag1 = agAccounts[1]!;
    await setActiveAccount("google-antigravity", ag0);

    const agConfig: EpxConfig = {
      port: 0,
      providers: {
        "google-antigravity": {
          adapter: "google-antigravity",
          baseUrl: "https://cloudcode-pa.googleapis.com",
          authMode: "oauth",
          oauthAccountFailover: { enabled: true },
        },
      },
    };

    const now = Date.now();
    const rotated = rotateGenericOAuthAccountOnRefusal(
      agConfig,
      "google-antigravity",
      ag0,
      "billing",
      null,
      now,
      "claude-opus-4-6",
    );
    expect(rotated).toBe(ag1);
    expect(hasEligibleGenericOAuthFailoverTarget("google-antigravity", ag1, now + 100, "claude-opus-4-6")).toBe(false);
    expect(hasEligibleGenericOAuthFailoverTarget("google-antigravity", ag1, now + 100, "gemini-2.5-pro")).toBe(false);
    expect(rotateGenericOAuthAccountOnRefusal(
      agConfig,
      "google-antigravity",
      ag1,
      "rate",
      "30",
      now + 100,
      "gemini-2.5-pro",
    )).toBeNull();
  });

  test("slow-fallback 429 slot_busy detours to sibling slow account and handles short single-account backoff without 409", async () => {
    const [acc0, acc1] = await seedAnthropicOAuthAccounts(2);
    const routing = anthropicRoutingFor("anthropic");
    const futureReset = Math.floor((Date.now() + 600_000) / 1000);
    const fiveHourOnlyHeaders = new Headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(futureReset),
      "retry-after": "120",
    });

    const seenAuths: string[] = [];
    const seenSlow: Array<string | null> = [];
    const config = makeProviderConfig(async (_input, init) => {
      const h = new Headers(init?.headers);
      const auth = h.get("authorization") ?? "";
      seenAuths.push(auth);
      seenSlow.push(h.get("anthropic-usage-limit"));
      if (auth === bearerAccess(0)) {
        return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slot busy" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-slow-offer": "treatment",
            "anthropic-ratelimit-unified-slow-status": "slot_busy",
          },
        });
      }
      return Response.json(makeAnthropicMsg("sibling-slow-ok"));
    });
    config.anthropicAccountPool = { enabled: true, strategy: "round-robin", slowFallback: true };

    routing.recordAnthropicAccountRefusal(config, acc0!, 429, "120", Date.now(), fiveHourOnlyHeaders);
    routing.recordAnthropicAccountRefusal(config, acc1!, 429, "120", Date.now(), fiveHourOnlyHeaders);

    const detourRes = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      }),
      config,
      {},
    );
    expect(detourRes.status).toBe(200);
    expect(seenAuths).toEqual([bearerAccess(0), bearerAccess(1)]);
    expect(seenSlow).toEqual(["slow", "slow"]);

    // Single slow account with short slow-retry-after=0.5 waits past slotBusyUntil and succeeds without 409.
    clearAnthropicAccountPoolState();
    clearAllAnthropicSlowFallbackState();
    forgetAnthropicFailoverQuorum();
    const [solo] = await seedAnthropicOAuthAccounts(1);
    let soloCalls = 0;
    const soloConfig = makeProviderConfig(async () => {
      soloCalls++;
      if (soloCalls === 1) {
        return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "brief slot busy" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-slow-offer": "treatment",
            "anthropic-ratelimit-unified-slow-status": "slot_busy",
            "anthropic-ratelimit-unified-slow-retry-after": "0.5",
          },
        });
      }
      return Response.json(makeAnthropicMsg("solo-slow-recovered"));
    });
    soloConfig.anthropicAccountPool = { enabled: true, strategy: "round-robin", slowFallback: true };
    anthropicRoutingFor("anthropic").recordAnthropicAccountRefusal(soloConfig, solo!, 429, "120", Date.now(), fiveHourOnlyHeaders);

    const soloRes = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      }),
      soloConfig,
      {},
    );
    expect(soloRes.status).toBe(200);
    expect(soloCalls).toBe(2);
  });

  test("managed native /v1/messages bounds 400 thinking-rectifier error preview at 64 KiB and honors abort signal", async () => {
    let sentCount = 0;
    let tailChunkPulled = false;
    let streamCancelled = false;
    const config: EpxConfig = {
      port: 0,
      defaultProvider: "anth",
      protocols: { rollout: { managedMessagesNative: true } },
      providers: {
        anth: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "sk-ant-synthetic",
          models: ["claude-sonnet-4-5"],
          fetch: (async () => {
            sentCount += 1;
            const chunks = [
              new TextEncoder().encode("x".repeat(32 * 1024)),
              new TextEncoder().encode("y".repeat(40 * 1024)),
              new TextEncoder().encode("z".repeat(16 * 1024)),
              new TextEncoder().encode("w".repeat(16 * 1024)),
              new TextEncoder().encode("max_tokens must be greater than thinking.budget_tokens"),
            ];
            return new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  const next = chunks.shift();
                  if (!next) {
                    controller.close();
                    return;
                  }
                  if (chunks.length === 0) tailChunkPulled = true;
                  controller.enqueue(next);
                },
                cancel() {
                  streamCancelled = true;
                },
              }, { highWaterMark: 0 }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };

    const oversizedRes = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "anth/claude-sonnet-4-5",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 4096 },
          messages: [{ role: "user", content: "solve" }],
        }),
      }),
      config,
      {},
    );
    expect(oversizedRes.status).toBe(400);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sentCount).toBe(1);
    expect(streamCancelled).toBe(true);
    expect(tailChunkPulled).toBe(false);

    // Client abort while reading the 400 thinking-rectifier error preview stops cleanly with 499.
    const abortCtrl = new AbortController();
    let abortStreamCancelled = false;
    const abortConfig: EpxConfig = {
      ...config,
      providers: {
        anth: {
          ...config.providers.anth!,
          fetch: (async () => new Response(
            new ReadableStream<Uint8Array>({
              start() {
                queueMicrotask(() => abortCtrl.abort(new Error("client stopped")));
              },
              cancel() {
                abortStreamCancelled = true;
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    const abortRes = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "anth/claude-sonnet-4-5",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 4096 },
          messages: [{ role: "user", content: "solve" }],
        }),
        signal: abortCtrl.signal,
      }),
      abortConfig,
      {},
    );
    expect(abortRes.status).toBe(499);
    expect(abortStreamCancelled).toBe(true);

    // Non-thinking 400 error reuses the bounded preview without reading the response body twice
    // while still preserving bodyText classification (e.g., context-overflow detection).
    const boundSpy = spyOn(boundedBody, "readBoundedResponseBody");
    try {
      const overflow400Cfg: EpxConfig = {
        ...config,
        providers: {
          anth: {
            ...config.providers.anth!,
            fetch: (async () => Response.json(
              { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } },
              { status: 400 },
            )) as typeof fetch,
          } as EpxProviderConfig & { fetch: typeof fetch },
        },
      };
      const overflowRes = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "anth/claude-sonnet-4-5",
            max_tokens: 2048,
            messages: [{ role: "user", content: "solve" }],
          }),
        }),
        overflow400Cfg,
        {},
      );
      expect(overflowRes.status).toBe(400);
      expect(await overflowRes.text()).toContain("prompt is too long");
      const messagesNativeReads = boundSpy.mock.calls.filter(([, opts]) => opts?.totalTimeoutMs === undefined);
      expect(messagesNativeReads).toHaveLength(1);
    } finally {
      boundSpy.mockRestore();
    }
  });

  test("shared billing/credit key-rotation helper enforces adapter and apiKeyTransport consistency", () => {
    const anthCfg: EpxConfig = {
      port: 0,
      providers: {
        anth: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "sk-a",
          apiKeyTransport: "x-api-key",
          apiKeySelectionRevision: "rev-1",
          apiKeyPool: [
            { id: "k1", key: "sk-a" },
            { id: "k2", key: "sk-b" },
          ],
        },
        chat: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-c1",
          apiKeySelectionRevision: "rev-1",
          apiKeyPool: [
            { id: "c1", key: "sk-c1" },
            { id: "c2", key: "sk-c2" },
          ],
        },
      },
    };

    saveConfig(anthCfg);

    // Concurrent apiKeyTransport mutation fences out credit/budget rotation just like Anthropic billing.
    const routedAnth = {
      ...routedProviderConfig("anth", anthCfg.providers.anth!),
      _apiKeyAttempt: { entryId: "k1", reference: "sk-a", revision: "rev-1" },
    };
    anthCfg.providers.anth!.apiKeyTransport = "bearer";
    saveConfig(anthCfg);
    expect(rotateProviderTransportOnCreditOrBudget(anthCfg, "anth", routedAnth)).toBeNull();
    expect(rotateProviderTransportOnAnthropicBilling(anthCfg, "anth", routedAnth)).toBeNull();

    // Adapter fence stays intact for rotateProviderTransportOnAnthropicBilling while multi-provider rotates.
    const routedChat = {
      ...routedProviderConfig("chat", anthCfg.providers.chat!),
      _apiKeyAttempt: { entryId: "c1", reference: "sk-c1", revision: "rev-1" },
    };
    expect(rotateProviderTransportOnAnthropicBilling(anthCfg, "chat", routedChat)).toBeNull();
    const rotatedChat = rotateProviderTransportOnCreditOrBudget(anthCfg, "chat", routedChat);
    expect(rotatedChat?.apiKey).toBe("sk-c2");
  });

  test("adapter-dispatch, adapter-key-pool-recovery, and chat-native handle 400 credit vs validation and 401 rotation consistently", async () => {
    // 1. Non-Anthropic key pool: 429 same-target retry -> 400 credits_required -> rotates to key-2!
    const seenAuth400Credit: string[] = [];
    const cfg400Credit: EpxConfig = {
      port: 0,
      defaultProvider: "poolchat",
      providers: {
        poolchat: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-key-1",
          retryOn429: { enabled: true, attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false },
          apiKeyPool: [
            { id: "k1", key: "sk-key-1" },
            { id: "k2", key: "sk-key-2" },
          ],
          models: ["gpt-5"],
          fetch: (async (_input, init) => {
            const auth = new Headers(init?.headers).get("authorization") ?? "";
            seenAuth400Credit.push(auth);
            if (seenAuth400Credit.length === 1) {
              return Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, { status: 429 });
            }
            if (auth === "Bearer sk-key-1") {
              return Response.json(
                { error: { code: "credits_required", message: "Usage credits are required for this model" } },
                { status: 400 },
              );
            }
            return Response.json({
              id: "resp-1",
              object: "chat.completion",
              model: "gpt-5",
              choices: [{ index: 0, message: { role: "assistant", content: "ok-after-credit-400" }, finish_reason: "stop" }],
            });
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    saveConfig(cfg400Credit);
    const creditRes = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "poolchat/gpt-5", input: "hello" }),
      }),
      cfg400Credit,
      {},
    );
    expect(creditRes.status).toBe(200);
    expect(seenAuth400Credit).toEqual(["Bearer sk-key-1", "Bearer sk-key-1", "Bearer sk-key-2"]);

    // 2. Non-Anthropic key pool: 429 -> key-2 (recoverApiKeyPool429) -> 400 credits_required -> rotates to key-3!
    clearKeyCooldowns();
    const seenAuth429To400: string[] = [];
    const cfg429To400: EpxConfig = {
      port: 0,
      defaultProvider: "pool3",
      providers: {
        pool3: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-p-1",
          apiKeyPool: [
            { id: "p1", key: "sk-p-1" },
            { id: "p2", key: "sk-p-2" },
            { id: "p3", key: "sk-p-3" },
          ],
          models: ["gpt-5"],
          fetch: (async (_input, init) => {
            const auth = new Headers(init?.headers).get("authorization") ?? "";
            seenAuth429To400.push(auth);
            if (auth === "Bearer sk-p-1") {
              return Response.json({ error: { message: "rate limited" } }, { status: 429 });
            }
            if (auth === "Bearer sk-p-2") {
              return Response.json(
                { error: { code: "credits_required", message: "Usage credits are required" } },
                { status: 400 },
              );
            }
            return Response.json({
              id: "resp-2",
              object: "chat.completion",
              model: "gpt-5",
              choices: [{ index: 0, message: { role: "assistant", content: "ok-on-p3" }, finish_reason: "stop" }],
            });
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    saveConfig(cfg429To400);
    const res429To400 = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pool3/gpt-5", input: "hello" }),
      }),
      cfg429To400,
      {},
    );
    expect(res429To400.status).toBe(200);
    expect(seenAuth429To400).toEqual(["Bearer sk-p-1", "Bearer sk-p-2", "Bearer sk-p-3"]);

    // 3. Plain 400 validation error after 429 retry does NOT rotate keys!
    clearKeyCooldowns();
    const seenAuthValidation400: string[] = [];
    const cfgPlain400: EpxConfig = {
      port: 0,
      defaultProvider: "poolplain",
      providers: {
        poolplain: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-v-1",
          retryOn429: { enabled: true, attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false },
          apiKeyPool: [
            { id: "v1", key: "sk-v-1" },
            { id: "v2", key: "sk-v-2" },
          ],
          models: ["gpt-5"],
          fetch: (async (_input, init) => {
            const auth = new Headers(init?.headers).get("authorization") ?? "";
            seenAuthValidation400.push(auth);
            if (seenAuthValidation400.length === 1) {
              return Response.json({ error: { message: "rate limited" } }, { status: 429 });
            }
            return Response.json({ error: { message: "invalid temperature value" } }, { status: 400 });
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    saveConfig(cfgPlain400);
    const plain400Res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "poolplain/gpt-5", input: "hello" }),
      }),
      cfgPlain400,
      {},
    );
    expect(plain400Res.status).toBe(400);
    expect(seenAuthValidation400).toEqual(["Bearer sk-v-1", "Bearer sk-v-1"]);

    // 4. Native chat distributed key pool rotates cleanly on 401 without retryAfter/as-never issues.
    clearKeyCooldowns();
    const seenChatAuths: string[] = [];
    const chatNativeCfg: EpxConfig = {
      port: 0,
      defaultProvider: "chatpool",
      protocols: { rollout: { managedChatNative: true } },
      providers: {
        chatpool: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-chat-1",
          requestPacing: { enabled: true, keySelection: "round-robin" },
          apiKeyPool: [
            { id: "c1", key: "sk-chat-1" },
            { id: "c2", key: "sk-chat-2" },
          ],
          models: ["gpt-5"],
          fetch: (async (_input, init) => {
            const auth = new Headers(init?.headers).get("authorization") ?? "";
            seenChatAuths.push(auth);
            if (auth === "Bearer sk-chat-1") {
              return Response.json({ error: { message: "revoked key" } }, { status: 401, headers: { "retry-after": "5" } });
            }
            return Response.json({
              id: "chatcmpl-ok",
              object: "chat.completion",
              model: "gpt-5",
              choices: [{ index: 0, message: { role: "assistant", content: "native-chat-ok" }, finish_reason: "stop" }],
            });
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    saveConfig(chatNativeCfg);
    const chatRes = await handleChatCompletions(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatpool/gpt-5", messages: [{ role: "user", content: "hi" }] }),
      }),
      chatNativeCfg,
      {},
    );
    expect(chatRes.status).toBe(200);
    expect(seenChatAuths).toEqual(["Bearer sk-chat-1", "Bearer sk-chat-2"]);

    // 5. Runtime-derived affinity headers (opencode-go x-opencode-session, xai x-grok-conv-id) do not block credit rotation,
    //    while explicit persisted header mutations still revoke rotation.
    clearKeyCooldowns();
    const affinityCfg: EpxConfig = {
      port: 0,
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/go/v1",
          authMode: "key",
          apiKey: "sk-go-1",
          apiKeySelectionRevision: "rev-go",
          apiKeyPool: [
            { id: "g1", key: "sk-go-1" },
            { id: "g2", key: "sk-go-2" },
          ],
        },
        xai: {
          adapter: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "sk-xai-1",
          apiKeySelectionRevision: "rev-xai",
          apiKeyPool: [
            { id: "x1", key: "sk-xai-1" },
            { id: "x2", key: "sk-xai-2" },
          ],
        },
      },
    };
    saveConfig(affinityCfg);
    const goStart = {
      ...routedProviderConfig("opencode-go", affinityCfg.providers["opencode-go"]),
      _apiKeyAttempt: { entryId: "g1", reference: "sk-go-1", revision: "rev-go" },
    };
    const goRouted = resolveOpenCodeGoTransport(goStart, "lane-abc", goStart);
    const goRotated = rotateProviderTransportOnCreditOrBudget(affinityCfg, "opencode-go", goRouted);
    expect(goRotated?.apiKey).toBe("sk-go-2");
    expect(goRotated?.headers?.["x-opencode-session"]).toBe(goRouted.headers?.["x-opencode-session"]);

    const xaiStart = {
      ...routedProviderConfig("xai", affinityCfg.providers.xai),
      _apiKeyAttempt: { entryId: "x1", reference: "sk-xai-1", revision: "rev-xai" },
    };
    const xaiRouted = resolveProviderTransport("xai", xaiStart, "cache-key-1");
    const xaiRotated = rotateProviderTransportOnCreditOrBudget(affinityCfg, "xai", xaiRouted, {
      promptCacheKey: "cache-key-1",
    });
    expect(xaiRotated?.apiKey).toBe("sk-xai-2");
    expect(xaiRotated?.headers?.["x-grok-conv-id"]).toBe(xaiRouted.headers?.["x-grok-conv-id"]);

    // Persisted header edit on xai still revokes credit/budget rotation.
    clearKeyCooldowns();
    const xaiAfterEditStart = {
      ...routedProviderConfig("xai", affinityCfg.providers.xai),
      _apiKeyAttempt: { entryId: "x1", reference: "sk-xai-1", revision: "rev-xai" },
    };
    const xaiEditedRouted = resolveProviderTransport("xai", xaiAfterEditStart, "cache-key-1");
    affinityCfg.providers.xai!.headers = { "x-org-account": "other" };
    saveConfig(affinityCfg);
    expect(rotateProviderTransportOnCreditOrBudget(affinityCfg, "xai", xaiEditedRouted)).toBeNull();
  });

  test("native /v1/messages preserves upstream 400 budget_tokens error without retry or 429 conversion when send budget is exhausted", async () => {
    // 1. OAuth mode with physical send budget = 1 (exhausted on initial send)
    await seedAnthropicOAuthAccounts(1);
    let oauthCalls = 0;
    const oauthBudget = createRequestExecutionBudget({
      maxTotalModelSends: 1,
      baseSendAllowance: 1,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    });
    const budgetSpy = spyOn(inferenceContext, "createInferenceSendBudget").mockReturnValue(oauthBudget);
    try {
      const oauthCfg = makeProviderConfig(async () => {
        oauthCalls += 1;
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "max_tokens must be greater than thinking.budget_tokens",
            },
          },
          { status: 400 },
        );
      });
      oauthCfg.protocols = { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } };
      saveConfig(oauthCfg);

      const oauthRes = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-5",
            max_tokens: 2048,
            thinking: { type: "enabled", budget_tokens: 4096 },
            messages: [{ role: "user", content: "solve" }],
          }),
        }),
        oauthCfg,
        {},
      );
      expect(oauthRes.status).toBe(400);
      expect(oauthCalls).toBe(1);
      const oauthText = await oauthRes.text();
      expect(oauthText).toContain("invalid_request_error");
      expect(oauthText).not.toContain("send_budget_exhausted");
    } finally {
      budgetSpy.mockRestore();
    }

    // 2. API-key mode with billing recovery consuming maxTotalModelSends before 400 budget_tokens refusal
    clearKeyCooldowns();
    let keyCalls = 0;
    const keyBudget = createRequestExecutionBudget({
      maxTotalModelSends: 2,
      baseSendAllowance: 2,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    });
    const keyBudgetSpy = spyOn(inferenceContext, "createInferenceSendBudget").mockReturnValue(keyBudget);
    try {
      const keyCfg: EpxConfig = {
        port: 0,
        defaultProvider: "anthkey",
        protocols: { rollout: { managedMessagesNative: true } },
        providers: {
          anthkey: {
            adapter: "anthropic",
            baseUrl: "https://api.anthropic.com",
            authMode: "key",
            apiKey: "sk-ant-k1",
            apiKeyPool: [
              { id: "k1", key: "sk-ant-k1" },
              { id: "k2", key: "sk-ant-k2" },
            ],
            models: ["claude-sonnet-4-5"],
            fetch: (async (_input, init) => {
              keyCalls += 1;
              const apiKey = new Headers(init?.headers).get("x-api-key");
              if (apiKey === "sk-ant-k1") {
                return Response.json(
                  { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
                  { status: 400 },
                );
              }
              return Response.json(
                { type: "error", error: { type: "invalid_request_error", message: "max_tokens must be greater than thinking.budget_tokens" } },
                { status: 400 },
              );
            }) as typeof fetch,
          } as EpxProviderConfig & { fetch: typeof fetch },
        },
      };
      saveConfig(keyCfg);

      const keyRes = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "anthkey/claude-sonnet-4-5",
            max_tokens: 2048,
            thinking: { type: "enabled", budget_tokens: 4096 },
            messages: [{ role: "user", content: "solve" }],
          }),
        }),
        keyCfg,
        {},
      );
      expect(keyRes.status).toBe(400);
      expect(keyCalls).toBe(2);
      const keyText = await keyRes.text();
      expect(keyText).toContain("invalid_request_error");
      expect(keyText).not.toContain("send_budget_exhausted");
    } finally {
      keyBudgetSpy.mockRestore();
    }

    // 3. API-key mode with physical send budget = 1 (exhausted on 1st send without billing recovery)
    let singleCalls = 0;
    const singleBudget = createRequestExecutionBudget({
      maxTotalModelSends: 1,
      baseSendAllowance: 1,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    });
    const singleBudgetSpy = spyOn(inferenceContext, "createInferenceSendBudget").mockReturnValue(singleBudget);
    try {
      const singleCfg: EpxConfig = {
        port: 0,
        defaultProvider: "anthsingle",
        protocols: { rollout: { managedMessagesNative: true } },
        providers: {
          anthsingle: {
            adapter: "anthropic",
            baseUrl: "https://api.anthropic.com",
            authMode: "key",
            apiKey: "sk-ant-single",
            models: ["claude-sonnet-4-5"],
            fetch: (async () => {
              singleCalls += 1;
              return Response.json(
                { type: "error", error: { type: "invalid_request_error", message: "max_tokens must be greater than thinking.budget_tokens" } },
                { status: 400 },
              );
            }) as typeof fetch,
          } as EpxProviderConfig & { fetch: typeof fetch },
        },
      };
      saveConfig(singleCfg);
      const singleRes = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "anthsingle/claude-sonnet-4-5",
            max_tokens: 2048,
            thinking: { type: "enabled", budget_tokens: 4096 },
            messages: [{ role: "user", content: "solve" }],
          }),
        }),
        singleCfg,
        {},
      );
      expect(singleRes.status).toBe(400);
      expect(singleCalls).toBe(1);
      const singleText = await singleRes.text();
      expect(singleText).toContain("invalid_request_error");
      expect(singleText).not.toContain("send_budget_exhausted");
    } finally {
      singleBudgetSpy.mockRestore();
    }
  });

  test("passthrough credit/budget 400/402/403/422 key rotation records key-401 rather than key-429", async () => {
    clearKeyCooldowns();
    clearRequestLogsForTests();
    const seenKeys: string[] = [];
    const ptCfg: EpxConfig = {
      port: 0,
      defaultProvider: "ptpool",
      providers: {
        ptpool: {
          adapter: "openai-responses",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-pt-1",
          apiKeyPool: [
            { id: "p1", key: "sk-pt-1" },
            { id: "p2", key: "sk-pt-2" },
          ],
          models: ["gpt-5"],
          fetch: (async (_input, init) => {
            const auth = new Headers(init?.headers).get("authorization") ?? "";
            seenKeys.push(auth);
            if (auth === "Bearer sk-pt-1") {
              return Response.json(
                { error: { code: "credits_required", message: "Usage credits are required" } },
                { status: 402 },
              );
            }
            return Response.json({
              id: "resp_pt_ok",
              object: "response",
              status: "completed",
              model: "gpt-5",
              output: [{
                id: "msg_pt",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "pt-ok", annotations: [] }],
              }],
            });
          }) as typeof fetch,
        } as EpxProviderConfig & { fetch: typeof fetch },
      },
    };
    saveConfig(ptCfg);

    const requestId = `pt-credit-${crypto.randomUUID()}`;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const ptRes = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ptpool/gpt-5", input: "hello" }),
      }),
      ptCfg,
      logCtx,
      { requestId, start: Date.now() },
    );
    expect(ptRes.status).toBe(200);
    expect(seenKeys).toEqual(["Bearer sk-pt-1", "Bearer sk-pt-2"]);
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[1]?.recoveryKinds).toEqual(["key-401"]);
    expect(logCtx.attempts?.[1]?.recoveryKinds).not.toContain("key-429");
  });
});
