import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { EpxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { clearKeyCooldowns, getKeyCooldownUntil } from "../../src/providers/key-failover";
import { bindWorkflowBudgetConfig } from "../../src/lib/workflow-budget-config";
import * as proxyEnv from "../../src/lib/proxy-env";
import { classifyUpstreamCondition, isShortOpenRouterInFlightBudget402 } from "../../src/lib/upstream-condition";
import { deriveRequestFailureAttribution } from "../../src/lib/request-failure-attribution";
import { causeForRecoveryKind } from "../../src/lib/request-failure-model";
import { clearComboSelectionState, clearComboTargetCooldowns, comboFailureCooldownScope, isComboTargetInCooldown } from "../../src/combos";
import { hasOutboundFlexServiceTier, isFlexUnavailableRefusal } from "../../src/server/responses/adapter-terminal-recovery";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";

const originalFetch = globalThis.fetch;
const originalHome = process.env.EASYPROXY_HOME;
let testDir = "";
let releaseSpendHome: (() => void) | undefined;
const inactiveFetch = (() => { throw new Error("No active in-memory fixture"); }) as typeof fetch;
let fixtureFetch = inactiveFetch;
let configuredFetch: ReturnType<typeof spyOn> | undefined;

interface CapturedSend {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function captureUpstream(handler: (index: number, url: string, body: Record<string, unknown>) => Response): CapturedSend[] {
  const sends: CapturedSend[] = [];
  fixtureFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sends.push({ url, headers, body });
    return handler(sends.length, url, body);
  }) as typeof fetch;
  globalThis.fetch = fixtureFetch;
  return sends;
}

function passthroughConfig(): EpxConfig {
  return {
    defaultProvider: "openai-apikey",
    providers: {
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "test-key-flex-1",
        apiKeyPoolStrategy: "fill-first",
        apiKeyPool: [
          { id: "k1", key: "test-key-flex-1" },
          { id: "k2", key: "test-key-flex-2" },
        ],
        models: ["gpt-5.4"],
        transientRetryOn5xx: { enabled: true, attempts: 3 },
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fixtureFetch(input, init),
      },
      "openai-chat-flex": {
        adapter: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "test-key-chat-1",
        apiKeyPoolStrategy: "fill-first",
        apiKeyPool: [
          { id: "c1", key: "test-key-chat-1" },
          { id: "c2", key: "test-key-chat-2" },
        ],
        models: ["gpt-5.4"],
        chatServiceTier: true,
        supportsServiceTier: true,
        transientRetryOn5xx: { enabled: true, attempts: 3 },
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fixtureFetch(input, init),
      },
      openrouter: {
        adapter: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "key",
        apiKey: "test-or-key",
        models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4.6"],
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fixtureFetch(input, init),
      },
      backup: {
        adapter: "openai-responses",
        baseUrl: "https://backup.example.test/v1",
        authMode: "key",
        apiKey: "test-backup-key",
        models: ["gpt-5.4"],
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fixtureFetch(input, init),
      },
    },
    combos: {
      "or-short-402": {
        strategy: "ordered",
        targets: [
          { provider: "openrouter", model: "openai/gpt-5.4" },
          { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
        ],
      },
    },
  } as EpxConfig;
}

function responsesReq(model: string, extraBody: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      store: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
      ...extraBody,
    }),
  });
}

function responsesOk(id = "resp-ok"): Response {
  return Response.json({
    id,
    object: "response",
    status: "completed",
    model: "gpt-5.4",
    output: [{
      type: "message",
      id: "msg-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  });
}

function chatOk(): Response {
  return Response.json({
    id: "chatcmpl-ok",
    object: "chat.completion",
    model: "gpt-5.4",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
}

beforeEach(() => {
  resetWorkflowBudgetsForTest();
  clearKeyCooldowns();
  clearComboTargetCooldowns("or-short-402");
  clearComboSelectionState("or-short-402");
  testDir = mkdtempSync(join(tmpdir(), "epx-phase1c-flex-402-"));
  process.env.EASYPROXY_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  fixtureFetch = inactiveFetch;
  configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => fixtureFetch(input, init));
});

afterEach(() => {
  try {
    releaseSpendHome?.();
  } finally {
    releaseSpendHome = undefined;
    fixtureFetch = inactiveFetch;
    configuredFetch?.mockRestore();
    configuredFetch = undefined;
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
    resetWorkflowBudgetsForTest();
    bindWorkflowBudgetConfig(null);
    clearKeyCooldowns();
    clearComboTargetCooldowns("or-short-402");
  clearComboSelectionState("or-short-402");
  }
});

describe("Phase 1-C flex_unavailable downgrade & telemetry", () => {
  test("telemetry contract classifies flex-tier-downgrade as transient upstream-declined", () => {
    const budget = createResponsesSendBudget({
      options: {},
      req: new Request("http://localhost/v1/responses"),
      logCtx: { model: "", provider: "" },
    });
    expect(budget.recoveryClassFor("flex-tier-downgrade")).toBe("transient");
    expect(causeForRecoveryKind("flex-tier-downgrade")).toBe("upstream-declined");
    expect(deriveRequestFailureAttribution({
      status: 503,
      terminalStatus: "failed",
      recoveryKinds: ["flex-tier-downgrade"],
    })).toEqual({ stage: "protocol-prelude", cause: "upstream-declined" });
    expect(deriveRequestFailureAttribution({
      status: 429,
      terminalStatus: "failed",
      recoveryKinds: ["flex-tier-downgrade"],
    })).toEqual({ stage: "protocol-prelude", cause: "upstream-declined" });
  });

  test("passthrough 503 service_tier_capacity_exceeded immediately drops service_tier=flex without burning 503 retries", async () => {
    const sends = captureUpstream(index => index === 1
      ? Response.json({
        error: {
          code: "service_tier_capacity_exceeded",
          type: "server_error",
          message: "Flex service tier capacity exceeded",
        },
      }, { status: 503 })
      : responsesOk());

    const cfg = passthroughConfig();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("openai-apikey/gpt-5.4", { service_tier: "flex" }),
      cfg,
      logCtx,
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(sends).toHaveLength(2);
    expect(sends[0]?.body.service_tier).toBe("flex");
    expect(sends[1]?.body.service_tier).toBeUndefined();
    expect(sends[0]?.headers.get("authorization")).toBe("Bearer test-key-flex-1");
    expect(sends[1]?.headers.get("authorization")).toBe("Bearer test-key-flex-1");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["flex-tier-downgrade"]);
    expect(getKeyCooldownUntil("openai-apikey", "k1")).toBeNull();
  });

  test("adapter 429 flex_unavailable resends once at standard tier without cooling the key", async () => {
    const sends = captureUpstream(index => index === 1
      ? Response.json({
        error: {
          code: "flex_unavailable",
          type: "rate_limit_error",
          message: "Flex processing unavailable",
        },
      }, { status: 429, headers: { "retry-after": "30" } })
      : chatOk());

    const cfg = passthroughConfig();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("openai-chat-flex/gpt-5.4", { service_tier: "flex" }),
      cfg,
      logCtx,
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(sends).toHaveLength(2);
    expect(sends[0]?.body.service_tier).toBe("flex");
    expect(sends[1]?.body.service_tier).toBeUndefined();
    expect(sends[0]?.headers.get("authorization")).toBe("Bearer test-key-chat-1");
    expect(sends[1]?.headers.get("authorization")).toBe("Bearer test-key-chat-1");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["flex-tier-downgrade"]);
    expect(getKeyCooldownUntil("openai-chat-flex", "c1")).toBeNull();
  });

  test("ignores spoofed flex_unavailable when request did not send top-level service_tier=flex", async () => {
    expect(hasOutboundFlexServiceTier(JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: 'literal "service_tier":"flex" text' }],
    }))).toBe(false);

    const sends = captureUpstream(() => Response.json({
      error: { code: "flex_unavailable", message: "Flex tier unavailable" },
    }, { status: 429 }));

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("openai-apikey/gpt-5.4", { service_tier: "priority" }),
      passthroughConfig(),
      logCtx,
    );
    await response.text();

    expect(response.status).toBe(429);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.service_tier).toBe("priority");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).not.toContain("flex-tier-downgrade");
  });

  test("fails closed on oversized refusal body and respects one-send budget cap", async () => {
    const hugeBody = "x".repeat(70 * 1024);
    const bodyRefusal = await isFlexUnavailableRefusal(
      new Response(hugeBody, { status: 503 }),
      JSON.stringify({ service_tier: "flex" }),
      undefined,
      false,
    );
    expect(bodyRefusal).toBe(false);

    const sends = captureUpstream(() => Response.json({
      error: { code: "flex_unavailable", message: "Flex unavailable" },
    }, { status: 503 }));

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1,
      baseSendAllowance: 1,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    }, "flex-budget-one");
    const response = await handleResponses(
      responsesReq("openai-apikey/gpt-5.4", { service_tier: "flex" }),
      passthroughConfig(),
      logCtx,
      { sendBudget: budget },
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("flex_unavailable");
    expect(sends).toHaveLength(1);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).not.toContain("flex-tier-downgrade");
  });
});

describe("Phase 1-C short OpenRouter openrouter_in_flight_budget 402 separation", () => {
  test("treats only Retry-After <= 60s openrouter_in_flight_budget 402 as rate_limited / target-scoped", () => {
    expect(isShortOpenRouterInFlightBudget402({
      status: 402,
      code: "openrouter_in_flight_budget",
      retryAfter: "5",
    })).toBe(true);
    expect(isShortOpenRouterInFlightBudget402({
      status: 402,
      code: "openrouter_in_flight_budget",
      retryAfter: "60",
    })).toBe(true);
    expect(isShortOpenRouterInFlightBudget402({
      status: 402,
      code: "openrouter_in_flight_budget",
      retryAfter: "61",
    })).toBe(false);
    expect(isShortOpenRouterInFlightBudget402({
      status: 402,
      code: "openrouter_in_flight_budget",
    })).toBe(false);
    expect(isShortOpenRouterInFlightBudget402({
      status: 402,
      code: "insufficient_quota",
      retryAfter: "5",
    })).toBe(false);

    expect(classifyUpstreamCondition({
      status: 402,
      code: "openrouter_in_flight_budget",
      retryAfter: "5",
    })).toBe("rate_limited");
    expect(classifyUpstreamCondition({
      status: 402,
      code: "openrouter_in_flight_budget",
      retryAfter: "120",
    })).toBe("billing_exhausted");

    expect(comboFailureCooldownScope(402, "In-flight budget reached", {
      code: "openrouter_in_flight_budget",
      retryAfter: "5",
    })).toBe("target");
    expect(comboFailureCooldownScope(402, "In-flight budget reached", {
      code: "openrouter_in_flight_budget",
      retryAfter: "120",
    })).toBe("provider");
    expect(comboFailureCooldownScope(402, "Payment required", {
      code: "insufficient_credits",
      retryAfter: "5",
    })).toBe("provider");
  });

  test("direct OpenRouter short 402 sets causeHint=rate-limit while keeping HTTP 402", async () => {
    captureUpstream(() => Response.json({
      error: {
        code: "openrouter_in_flight_budget",
        message: "Temporary in-flight spend limit exceeded",
      },
    }, { status: 402, headers: { "retry-after": "5" } }));

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("openrouter/openai/gpt-5.4"),
      passthroughConfig(),
      logCtx,
    );
    await response.text();

    expect(response.status).toBe(402);
    expect(logCtx.causeHint).toBe("rate-limit");
    expect(deriveRequestFailureAttribution({
      status: 402,
      terminalStatus: "failed",
      causeHint: logCtx.causeHint,
    })).toEqual({ stage: "protocol-prelude", cause: "rate-limit" });
  });

  test("combo short openrouter_in_flight_budget 402 cools only failing target and keeps sibling model on openrouter eligible", async () => {
    const sends = captureUpstream((_index, _url, body) => {
      if (body.model === "openai/gpt-5.4") {
        return Response.json({
          error: {
            code: "openrouter_in_flight_budget",
            message: "Too much concurrent pending spend on this model route",
          },
        }, { status: 402, headers: { "retry-after": "5" } });
      }
      return responsesOk("resp-sibling-model");
    });

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("combo/or-short-402"),
      passthroughConfig(),
      logCtx,
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(sends.map(s => s.body.model)).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-4.6"]);
    expect(isComboTargetInCooldown("or-short-402", { provider: "openrouter", model: "openai/gpt-5.4" })).toBe(true);
    expect(isComboTargetInCooldown("or-short-402", { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" })).toBe(false);
  });

  test("combo long or un-headed openrouter 402 still cools the whole provider", async () => {
    captureUpstream(() => Response.json({
      error: {
        code: "openrouter_in_flight_budget",
        message: "Long or non-transient billing block",
      },
    }, { status: 402, headers: { "retry-after": "120" } }));

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("combo/or-short-402"),
      passthroughConfig(),
      logCtx,
    );
    await response.text();

    expect(response.status).toBe(402);
    expect(isComboTargetInCooldown("or-short-402", { provider: "openrouter", model: "openai/gpt-5.4" })).toBe(true);
    expect(isComboTargetInCooldown("or-short-402", { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" })).toBe(true);
  });

  test("combo and passthrough recognize root openrouter_in_flight_budget even when nested error.code is numeric 402 or '402'", async () => {
    for (const nestedCode of [402, "402"] as const) {
      clearComboTargetCooldowns();
      const sends = captureUpstream((_index, _url, body) => {
        if (body.model === "openai/gpt-5.4") {
          return Response.json({
            code: "openrouter_in_flight_budget",
            error: {
              code: nestedCode,
              message: "Temporary in-flight spend limit exceeded",
            },
          }, { status: 402, headers: { "retry-after": "5" } });
        }
        return responsesOk(`resp-after-${String(nestedCode)}`);
      });

      const directLogCtx: RequestLogContext = { model: "", provider: "" };
      const directResp = await handleResponses(
        responsesReq("openrouter/openai/gpt-5.4"),
        passthroughConfig(),
        directLogCtx,
      );
      await directResp.text();
      expect(directResp.status).toBe(402);
      expect(directLogCtx.causeHint).toBe("rate-limit");

      const comboLogCtx: RequestLogContext = { model: "", provider: "" };
      const comboResp = await handleResponses(
        responsesReq("combo/or-short-402"),
        passthroughConfig(),
        comboLogCtx,
      );
      await comboResp.text();
      expect(comboResp.status).toBe(200);
      expect(sends.filter(s => s.body.model === "anthropic/claude-sonnet-4.6")).toHaveLength(1);
      expect(isComboTargetInCooldown("or-short-402", { provider: "openrouter", model: "openai/gpt-5.4" })).toBe(true);
      expect(isComboTargetInCooldown("or-short-402", { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" })).toBe(false);
    }
  });

  test("adapter flex_unavailable preserves original upstream refusal when send budget prevents resend", async () => {
    const sends = captureUpstream(() => Response.json({
      error: { code: "flex_unavailable", message: "Flex lane capacity temporarily exceeded" },
    }, { status: 429 }));

    const cfg = passthroughConfig();
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1,
      baseSendAllowance: 1,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    }, "adapter-flex-budget-one");

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("openai-chat-flex/gpt-5.4", { service_tier: "flex" }),
      cfg,
      logCtx,
      { sendBudget: budget },
    );
    const body = await response.text();
    expect(sends).toHaveLength(1);
    expect(response.status).toBe(429);
    expect(body).toContain("Flex lane capacity temporarily exceeded");
    expect(body).not.toContain("request_send_budget_exhausted");
  });

  test("adapter combo flex_unavailable preserves upstream 429 when transientRetryOn5xx.attempts=1 blocks resend", async () => {
    const sends = captureUpstream((_index, url, body) => {
      if (url.includes("api.openai.com")) {
        expect(body.service_tier).toBe("flex");
        return Response.json({
          error: { code: "flex_unavailable", message: "Flex lane capacity temporarily exceeded" },
        }, { status: 429 });
      }
      return responsesOk("ok-backup");
    });

    const cfg = passthroughConfig();
    cfg.providers["openai-chat-flex"]!.transientRetryOn5xx = { enabled: true, attempts: 1 };
    cfg.combos = {
      ...cfg.combos,
      "chat-flex-combo": {
        targets: [
          { provider: "openai-chat-flex", model: "gpt-5.4" },
          { provider: "backup", model: "gpt-5.4" },
        ],
      },
    };

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("combo/chat-flex-combo", { service_tier: "flex" }),
      cfg,
      logCtx,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("ok-backup");
    // Child 1 sent only once with flex, then combo hopped cleanly to backup.
    expect(sends.filter(s => s.url.includes("api.openai.com"))).toHaveLength(1);
    expect(sends.some(s => s.url.includes("backup.example.test"))).toBe(true);
  });

  test("adapter single-target 503 flex_unavailable preserves upstream 503 when transientRetryOn5xx.attempts=1 blocks resend", async () => {
    const sends = captureUpstream(() => Response.json({
      error: { code: "service_tier_capacity_exceeded", message: "Flex pool exhausted upstream" },
    }, { status: 503 }));

    const cfg = passthroughConfig();
    cfg.providers["openai-chat-flex"]!.transientRetryOn5xx = { enabled: true, attempts: 1 };

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      responsesReq("openai-chat-flex/gpt-5.4", { service_tier: "flex" }),
      cfg,
      logCtx,
    );
    const body = await response.text();
    expect(sends).toHaveLength(1);
    expect(response.status).toBe(503);
    expect(body).toContain("Flex pool exhausted upstream");
    expect(body).not.toContain("request_send_budget_exhausted");
  });
});
