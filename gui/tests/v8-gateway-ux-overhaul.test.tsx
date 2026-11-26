import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import ApiKeysListPanel from "../src/components/apikeys-workspace/ApiKeysListPanel";
import { ApiKeyBudgetCard, type ApiKeyBudgetPatch } from "../src/components/apikeys-workspace/ApiKeyBudgetCard";
import GatewayGuardrailsPanel from "../src/components/GatewayGuardrailsPanel";
import RequestPlaygroundModal from "../src/components/RequestPlaygroundModal";
import { Combobox } from "../src/components/ui-v2/combobox";
import { UsageLatencyPanel } from "../src/components/v2-usage/usage-latency-panel";
import { LanguageProvider } from "../src/i18n/provider";
import { Switch } from "../src/ui";
import {
  buildLogReplayCurl,
  playgroundEndpointForLog,
  playgroundSeedFromLog,
  serializeLogsCsv,
  serializeLogsJsonl,
  type LogExportRecord,
} from "../src/lib/log-export";
import { buildPlaygroundPayload } from "../src/lib/playground-client";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let savedGlobals: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let root: Root | undefined;

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

beforeEach(() => {
  savedGlobals = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])) as typeof savedGlobals;
  prevFetch = globalThis.fetch;
  win = new Window({ url: "http://127.0.0.1:8787/" });
  win.localStorage.setItem("epx-lang", "en");
  for (const k of GLOBALS) {
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, k),
    });
  }
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = prevFetch;
  win.close();
  for (const k of GLOBALS) {
    const desc = savedGlobals[k];
    if (desc) Object.defineProperty(globalThis, k, desc);
    else Reflect.deleteProperty(globalThis, k);
  }
});

describe("Antigravity v8 gateway UX & polish", () => {
  test("Combobox filters, selects via keyboard, and prevents Escape from bubbling to parent window while open", async () => {
    let parentEscapes = 0;
    const onParentKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") parentEscapes += 1;
    };
    win.addEventListener("keydown", onParentKey as unknown as EventListener);

    function Harness() {
      const [val, setVal] = useState("");
      return <Combobox value={val} onChange={setVal} options={["openai/gpt-5", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"]} aria-label="Model picker" />;
    }

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => { root!.render(<LanguageProvider><Harness /></LanguageProvider>); });

    const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { input.focus(); });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(3);

    await act(async () => {
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(parentEscapes).toBe(0);

    await act(async () => {
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    expect(parentEscapes).toBe(1);

    await act(async () => {
      setInputValue(input, "gemini");
    });
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => {
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    expect(input.value).toBe("google/gemini-2.5-pro");
    win.removeEventListener("keydown", onParentKey as unknown as EventListener);
  });

  test("log-export maps protocol endpoints, prevents CSV formula injection, and builds POSIX cURL", () => {
    const trace = (inbound: "responses" | "messages") => ({
      v: 1,
      inbound,
      mode: "native",
      requestPath: [inbound, inbound],
      responsePath: [inbound, inbound],
      reasonCodes: [],
      contractVersion: "1",
    });
    expect(playgroundEndpointForLog({ protocolTrace: trace("responses") })).toBe("/v1/responses");
    expect(playgroundEndpointForLog({ inboundProtocol: "responses" })).toBe("/v1/responses");
    expect(playgroundEndpointForLog({ inboundProtocol: "openai-responses" })).toBe("/v1/responses");
    expect(playgroundEndpointForLog({ protocolTrace: trace("messages") })).toBe("/v1/messages");
    expect(playgroundEndpointForLog({ inboundProtocol: "messages" })).toBe("/v1/messages");
    expect(playgroundEndpointForLog({ inboundProtocol: "anthropic-messages" })).toBe("/v1/messages");
    expect(playgroundEndpointForLog({ inboundProtocol: "openai-chat" })).toBe("/v1/chat/completions");

    const sample: LogExportRecord = {
      requestId: "req-1",
      timestamp: Date.UTC(2026, 10, 22, 12, 0, 0),
      model: "=CMD|' /C calc'!A0",
      provider: "+openai",
      client: "codex",
      inboundProtocol: "openai-responses",
      requestedEffort: "high",
      requestedServiceTier: "fast",
      status: 200,
      durationMs: 420,
      firstOutputMs: 95,
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165, cacheReadInputTokens: 30 },
    };

    const csv = serializeLogsCsv([sample]);
    expect(csv).toContain(`"'=CMD|' /C calc'!A0"`);
    expect(csv).toContain(`"'+openai"`);
    expect(csv).toContain(",120,45,30,165,");

    const jsonl = serializeLogsJsonl([sample, { ...sample, requestId: "req-2" }], 1);
    expect(jsonl.trim().split("\n")).toHaveLength(1);

    const seed = playgroundSeedFromLog(sample);
    expect(seed).toEqual({
      endpoint: "/v1/responses",
      model: "=CMD|' /C calc'!A0",
      effort: "high",
      serviceTier: "fast",
    });

    const curl = buildLogReplayCurl({ ...sample, model: "o'clock" }, "http://127.0.0.1:8787/");
    expect(curl).toContain("'http://127.0.0.1:8787/v1/responses'");
    expect(curl).toContain('Authorization: Bearer $EASYPROXY_API_KEY');
    expect(curl).toContain(`o'"'"'clock`);
  });

  test("RequestPlaygroundModal supports multi-turn messages, parameters, Combobox Escape guard, and split token telemetry", async () => {
    let closed = 0;
    let lastPayload: Record<string, unknown> | null = null;
    const encoder = new TextEncoder();

    const multi = buildPlaygroundPayload("/v1/responses", "gpt-5", "sys", "final", true, 512, {
      temperature: 0.4,
      effort: "high",
      turns: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "next" }],
    });
    expect(multi.temperature).toBe(0.4);
    expect(multi.reasoning).toEqual({ effort: "high" });
    expect(Array.isArray(multi.input)).toBe(true);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: "anthropic/claude-sonnet-4" }, { id: "openai/gpt-5" }] });
      }
      lastPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":18}}}\n\n'));
          ctrl.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"text":"Hi!"}}\n\n'));
          ctrl.enqueue(encoder.encode('data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'));
          ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
          ctrl.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <RequestPlaygroundModal
            apiBase="http://127.0.0.1:8787"
            initialSeed={{ endpoint: "/v1/messages", model: "anthropic/claude-sonnet-4" }}
            onClose={() => { closed += 1; }}
          />
        </LanguageProvider>,
      );
      await new Promise(r => setTimeout(r, 15));
    });

    const modelCombo = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { modelCombo.focus(); });
    expect(modelCombo.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      modelCombo.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    expect(modelCombo.getAttribute("aria-expanded")).toBe("false");
    expect(closed).toBe(0);

    const mainPrompt = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { setInputValue(mainPrompt, "First question"); });
    const addTurnBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("+ Add turn"))!;
    await act(async () => { addTurnBtn.click(); });
    const textareas = host.querySelectorAll<HTMLTextAreaElement>("textarea");
    expect(textareas).toHaveLength(3);
    await act(async () => { setInputValue(textareas[1]!, "Earlier reply"); });
    await act(async () => { setInputValue(textareas[2]!, "Follow up"); });

    const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submitBtn.click();
      await new Promise(r => setTimeout(r, 30));
    });

    expect(lastPayload?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Earlier reply" },
      { role: "user", content: "Follow up" },
    ]);
    expect(host.querySelector(".playground-telemetry")?.textContent).toContain("In 18 / Out 7 tok");
  });

  test("ApiKeyBudgetCard validates USD caps, toggles provider/model scopes, and ApiKeysListPanel renders scope badges", async () => {
    const patches: ApiKeyBudgetPatch[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ApiKeyBudgetCard
            entry={{
              id: "k-1",
              name: "Scoped Key",
              prefix: "epx_scoped...",
              createdAt: "2026-10-01T00:00:00Z",
              dailyCostLimitUsd: 10,
              allowedProviders: ["openai"],
              allowedModels: ["gpt-5"],
              budgetUsage: { rpmCurrent: 1, dailyRequestsUsed: 2, dailyTokensUsed: 500, dailyCostUsdUsed: 8.5 },
            }}
            availableProviders={["anthropic", "openai"]}
            availableModels={["anthropic/claude-sonnet-4", "gpt-5"]}
            onSave={async (_id, patch) => {
              patches.push(patch);
              return true;
            }}
          />
          <ApiKeysListPanel
            keys={[{
              id: "k-1",
              name: "Scoped Key",
              prefix: "epx_scoped...",
              createdAt: "2026-10-01T00:00:00Z",
              dailyCostLimitUsd: 10,
              allowedProviders: ["openai", "anthropic"],
              allowedModels: ["gpt-5"],
              budgetUsage: { rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0, dailyCostUsdUsed: 9.2 },
              usage: { requests7d: 5, totalRequests: 5 },
            }]}
            keysLoading={false}
            keysLoadFailed={false}
            apiBase="http://127.0.0.1:8787"
            busy={false}
            onSelect={() => {}}
          />
        </LanguageProvider>,
      );
    });

    expect(host.textContent).toContain("$10/d");
    expect(host.textContent).toContain("2 providers");
    expect(host.textContent).toContain("1 models");
    expect(host.querySelector<HTMLElement>(".bg-danger")!.style.width).toBe("92%");

    const costInput = host.querySelector<HTMLInputElement>("#awi-budget-daily-cost")!;
    await act(async () => { setInputValue(costInput, "0"); });
    const saveBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Save budgets")!;
    await act(async () => { saveBtn.click(); });
    expect(patches).toHaveLength(0);
    expect(host.textContent).toContain("USD amount");

    await act(async () => { setInputValue(costInput, "12.5"); });
    const anthropicPill = host.querySelector<HTMLButtonElement>('button[data-provider="anthropic"]')!;
    await act(async () => { anthropicPill.click(); });
    const modelsArea = host.querySelector<HTMLTextAreaElement>("#awi-budget-allowed-models")!;
    await act(async () => { setInputValue(modelsArea, "gpt-5, openai/gpt-5.3-codex"); });
    await act(async () => { saveBtn.click(); });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      rpmLimit: null,
      maxDailyRequests: null,
      dailyTokenLimit: null,
      dailyCostLimitUsd: 12.5,
      allowedProviders: ["anthropic", "openai"],
      allowedModels: ["gpt-5", "openai/gpt-5.3-codex"],
    });
  });

  test("ApiKeyBudgetCard Combobox preserves prefix drafts while typing and commits custom models when availableModels is empty", async () => {
    const patches: ApiKeyBudgetPatch[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ApiKeyBudgetCard
            entry={{ id: "k-2", name: "Draft Key", prefix: "epx_draft...", createdAt: "2026-10-01T00:00:00Z" }}
            availableProviders={[]}
            availableModels={["gpt-5", "gpt-5-mini"]}
            onSave={async (_id, patch) => {
              patches.push(patch);
              return true;
            }}
          />
        </LanguageProvider>,
      );
    });

    const combo = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(combo).not.toBeNull();
    // Selecting an autocomplete candidate with ArrowDown + Enter must commit ONLY the selected option (never double-adding the stale partial prefix).
    await act(async () => { combo.focus(); setInputValue(combo, "gpt"); });
    await act(async () => {
      combo.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    await act(async () => {
      combo.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    expect(combo.value).toBe("");
    expect(host.querySelector<HTMLTextAreaElement>("#awi-budget-allowed-models")!.value).toBe("gpt-5-mini");
    await act(async () => {
      setInputValue(host.querySelector<HTMLTextAreaElement>("#awi-budget-allowed-models")!, "");
    });

    // Typing exact prefix "gpt-5" must NOT auto-commit and wipe input before finishing "gpt-5-mini".
    await act(async () => { setInputValue(combo, "gpt-5"); });
    expect(combo.value).toBe("gpt-5");
    await act(async () => { setInputValue(combo, "gpt-5-mini"); });
    expect(combo.value).toBe("gpt-5-mini");
    const addBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Add")!;
    await act(async () => { addBtn.click(); });
    expect(combo.value).toBe("");
    expect(host.querySelector<HTMLTextAreaElement>("#awi-budget-allowed-models")!.value).toContain("gpt-5-mini");

    // Empty availableModels still renders Combobox and permits custom model entry.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ApiKeyBudgetCard
            entry={{ id: "k-3", name: "Custom Key", prefix: "epx_custom...", createdAt: "2026-10-01T00:00:00Z" }}
            availableProviders={[]}
            availableModels={[]}
            onSave={async (_id, patch) => {
              patches.push(patch);
              return true;
            }}
          />
        </LanguageProvider>,
      );
    });
    const customCombo = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(customCombo).not.toBeNull();
    await act(async () => { setInputValue(customCombo, "custom/my-model"); });
    const addBtn2 = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Add")!;
    await act(async () => { addBtn2.click(); });
    expect(host.querySelector<HTMLTextAreaElement>("#awi-budget-allowed-models")!.value).toContain("custom/my-model");
  });

  test("GatewayGuardrailsPanel runs Dry-run simulation and displays redacted/compressed preview", async () => {
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/gateway-guardrails/dry-run")) {
        postedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Response.json({
          blocked: false,
          limitExceeded: false,
          matches: 1,
          redactions: 1,
          findings: ["openai-api-key"],
          compressedItems: 0,
          originalChars: 32,
          outputChars: 18,
          savedChars: 14,
          previewText: "token=[REDACTED:openai-api-key]",
        });
      }
      return Response.json({
        outboundSecretGuard: { mode: "redact" },
        toolOutputCompression: { enabled: true, minChars: 12000, headChars: 4000, tailChars: 4000, stripAnsi: true },
        stats: { scannedRequests: 3, secretDetections: 1, secretBlocks: 0, compressedToolOutputs: 0, savedChars: 0 },
      });
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(<LanguageProvider><GatewayGuardrailsPanel apiBase="http://127.0.0.1:8787" /></LanguageProvider>);
      await new Promise(r => setTimeout(r, 15));
    });

    const dryRunInput = host.querySelector<HTMLTextAreaElement>("#guardrails-dryrun-input")!;
    await act(async () => { setInputValue(dryRunInput, "token=sk-test-secret-value"); });
    const runBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Run test")!;
    await act(async () => {
      runBtn.click();
      await new Promise(r => setTimeout(r, 15));
    });

    expect(postedBody?.text).toBe("token=sk-test-secret-value");
    expect(host.textContent).toContain("Redacted");
    expect(host.textContent).toContain("openai-api-key");
    expect(host.textContent).toContain("token=[REDACTED:openai-api-key]");
  });

  test("UsageLatencyPanel renders P50/P95 latency, TTFT, fallback rate, and Switch localizes fallback aria-label", async () => {
    let fetchedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrl = String(input);
      return Response.json({
        totalRequests: 120,
        fallbackRate: 0.05,
        durationMs: { p50: 420, p95: 1850, sampleCount: 120 },
        firstOutputMs: { p50: 140, p95: 380, sampleCount: 100, coverage: 0.83 },
        breakdown: [
          { provider: "openai", model: "gpt-5", requests: 90, successRate: 0.98, p50DurationMs: 390 },
        ],
      });
    }) as unknown as typeof fetch;

    win.localStorage.setItem("epx-lang", "ko");
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <UsageLatencyPanel apiBase="" locale="ko" />
          <Switch on={true} onClick={() => {}} />
        </LanguageProvider>,
      );
      await new Promise(r => setTimeout(r, 15));
    });

    expect(fetchedUrl).toBe("/api/routing-analytics");

    expect(host.textContent).toContain("420ms");
    expect(host.textContent).toContain("1.85");
    expect(host.textContent).toContain("140ms");
    expect(host.textContent).toContain("5.0%");
    expect(host.textContent).toContain("98.0%");
    const sw = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(sw.getAttribute("aria-label")).toBe("켜짐");
  });

  test("GatewayGuardrailsPanel preserves unsaved edits across locale switches", async () => {
    let loadCalls = 0;
    globalThis.fetch = (async () => {
      loadCalls += 1;
      return Response.json({
        outboundSecretGuard: { mode: "redact" },
        toolOutputCompression: { enabled: true, minChars: 12000, headChars: 4000, tailChars: 4000, stripAnsi: false },
        stats: { scannedRequests: 0, secretDetections: 0, secretBlocks: 0, compressedToolOutputs: 0, savedChars: 0 },
      });
    }) as unknown as typeof fetch;

    const { useI18n } = await import("../src/i18n/shared");
    function LocaleBridge() {
      const { setLocale } = useI18n();
      return <button type="button" data-test="switch-locale-ko" onClick={() => setLocale("ko")} />;
    }

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <LocaleBridge />
          <GatewayGuardrailsPanel apiBase="http://127.0.0.1:8787" />
        </LanguageProvider>,
      );
      await new Promise(r => setTimeout(r, 15));
    });
    expect(loadCalls).toBe(1);

    const minCharsInput = host.querySelector<HTMLInputElement>("#guardrails-min-chars")!;
    await act(async () => { setInputValue(minCharsInput, "25000"); });
    expect(minCharsInput.value).toBe("25000");

    // Switching UI locale must not re-fetch or hydrate over unsaved edits.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-test="switch-locale-ko"]')!.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });
    expect(loadCalls).toBe(1);
    expect(host.querySelector<HTMLInputElement>("#guardrails-min-chars")!.value).toBe("25000");
  });

  test("GatewayGuardrailsPanel ignores hidden invalid compression drafts when disabled and surfaces PUT error messages", async () => {
    let putBodies: Array<Record<string, unknown>> = [];
    let failNextPut = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/gateway-guardrails") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        putBodies.push(body);
        if (failNextPut) {
          return Response.json({ error: "custom guardrail error" }, { status: 400 });
        }
        return Response.json({
          ...body,
          stats: { scannedRequests: 0, secretDetections: 0, secretBlocks: 0, compressedToolOutputs: 0, savedChars: 0 },
        });
      }
      return Response.json({
        outboundSecretGuard: { mode: "redact" },
        toolOutputCompression: { enabled: true, minChars: 12000, headChars: 4000, tailChars: 4000, stripAnsi: false },
        stats: { scannedRequests: 0, secretDetections: 0, secretBlocks: 0, compressedToolOutputs: 0, savedChars: 0 },
      });
    }) as unknown as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(<LanguageProvider><GatewayGuardrailsPanel apiBase="http://127.0.0.1:8787" /></LanguageProvider>);
      await new Promise(r => setTimeout(r, 15));
    });

    const minCharsInput = host.querySelector<HTMLInputElement>("#guardrails-min-chars")!;
    await act(async () => { setInputValue(minCharsInput, "10"); });

    // Disable tool output compression so hidden invalid minChars must fall back cleanly on save.
    const switches = [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    await act(async () => { switches[0]!.click(); });
    expect(host.querySelector("#guardrails-min-chars")).toBeNull();

    const saveBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Save guardrails")!;
    await act(async () => {
      saveBtn.click();
      await new Promise(r => setTimeout(r, 15));
    });

    expect(putBodies).toHaveLength(1);
    expect(putBodies[0]!.toolOutputCompression).toEqual({
      enabled: false,
      minChars: 12000,
      headChars: 4000,
      tailChars: 4000,
      stripAnsi: false,
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Gateway guardrails saved.");

    failNextPut = true;
    await act(async () => {
      saveBtn.click();
      await new Promise(r => setTimeout(r, 15));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("custom guardrail error");
  });
});
