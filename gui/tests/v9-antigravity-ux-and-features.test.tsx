import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  hasApiCredential,
  installApiAuthFetch,
  resetApiAuthFetchForTests,
  retryApiSessionPrompt,
} from "../src/api";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { hashBelongsToPage, resolveAppHashChange, VALID_PAGES } from "../src/app-routing";
import { LogAttemptWaterfall } from "../src/components/LogAttemptWaterfall";
import RequestPlaygroundModal from "../src/components/RequestPlaygroundModal";
import { SidebarNav } from "../src/components/sidebar-nav";
import { LOCALES, type TFn } from "../src/i18n/shared";
import { getLoadedDict } from "../src/i18n/runtime-catalogs";
import { LanguageProvider } from "../src/i18n/provider";
import { uxOverhaulCopyKo } from "../src/i18n/slices/ko";
import { buildCommandPaletteEntries } from "../src/lib/command-palette";
import { MAX_CURL_IMPORT_BYTES, parseCurlToPlaygroundRequest } from "../src/lib/curl-import";
import {
  countBudgetWarningKeys,
  countRecentRateLimitOrBlockLogs,
  useGatewayAlerts,
} from "../src/lib/gateway-alerts";
import { computeWaterfallLayout } from "../src/lib/log-attempt-waterfall";
import { managementHealthAuthStatus, readManagementHealth } from "../src/lib/proxy-health";
import { clearPendingApiKeyCreateFocusForTests, requestApiKeyCreateFocus } from "../src/lib/quick-action-signals";
import Home from "../src/pages/Home";
import Tray from "../src/pages/Tray";
import { TrayTotalsCard } from "../src/pages/tray/TrayUsage";
import type { CompanionSettings } from "../src/pages/usage-companion-utils";

const GLOBALS = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "CustomEvent",
  "Event",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let savedGlobals: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let root: Root | undefined;

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
}

beforeEach(() => {
  savedGlobals = Object.fromEntries(
    GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  ) as typeof savedGlobals;
  prevFetch = globalThis.fetch;
  win = new Window({ url: "http://127.0.0.1:8787/" });
  win.localStorage.setItem("epx-lang", "en");
  for (const k of GLOBALS) {
    const val = k === "IS_REACT_ACT_ENVIRONMENT"
      ? true
      : k === "requestAnimationFrame" || k === "cancelAnimationFrame"
        ? (win[k] as (...args: never[]) => unknown).bind(win)
        : Reflect.get(win, k);
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: val });
  }
  clearClientResourceStoresForTests();
  clearPendingApiKeyCreateFocusForTests();
  resetApiAuthFetchForTests();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = prevFetch;
  clearClientResourceStoresForTests();
  clearPendingApiKeyCreateFocusForTests();
  resetApiAuthFetchForTests();
  win.close();
  for (const k of GLOBALS) {
    const desc = savedGlobals[k];
    if (desc) Object.defineProperty(globalThis, k, desc);
    else Reflect.deleteProperty(globalThis, k);
  }
});

describe("Antigravity v9 UX polish, session recovery, tray & gateway features", () => {
  test("⌘K command palette routes deep:guardrails to dashboard/proxy-guardrails and SidebarNav does not truncate empty-query pages", async () => {
    const navigatedHashes: string[] = [];
    const entries = buildCommandPaletteEntries({
      locale: "en",
      t: ((k: string) => k) as TFn,
      pageLabel: p => p,
      pageAvailable: () => true,
      onNavigate: () => {},
      onNavigateHash: h => navigatedHashes.push(h),
    });

    const guardrailsEntry = entries.find(e => e.key === "deep:guardrails");
    expect(guardrailsEntry).toBeDefined();
    expect(guardrailsEntry!.context).toBe("nav.dashboard");
    guardrailsEntry!.onSelect();
    expect(navigatedHashes).toEqual(["dashboard/proxy-guardrails"]);

    expect(hashBelongsToPage("dashboard/proxy-guardrails", "dashboard")).toBe(true);
    expect(resolveAppHashChange("dashboard/proxy-guardrails")).toEqual({ page: "dashboard", replaceTo: null });

    const fallbackEntries = buildCommandPaletteEntries({
      locale: "en",
      t: ((k: string) => k) as TFn,
      pageLabel: p => p,
      pageAvailable: p => p !== "dashboard",
      onNavigate: () => {},
      onNavigateHash: h => navigatedHashes.push(h),
    });
    const fallbackGuardrails = fallbackEntries.find(e => e.key === "deep:guardrails");
    expect(fallbackGuardrails?.context).toBe("nav.providers");
    fallbackGuardrails?.onSelect();
    expect(navigatedHashes).toEqual(["dashboard/proxy-guardrails", "providers"]);

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <SidebarNav
          activeGroupId="home"
          pageLabel={p => `label:${p}`}
          pageAvailable={() => true}
          onNavigate={() => {}}
          onReveal={() => {}}
          desktopShell={false}
          t={((k: string) => k) as TFn}
          locale="en"
        />,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>(".nav-search-open")!;
    await act(async () => {
      trigger.click();
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const renderedPages = Array.from(host.querySelectorAll('[role="listbox"] [role="option"] .nav-item-label'))
      .map(el => el.textContent ?? "");
    expect(renderedPages.length).toBeGreaterThanOrEqual(VALID_PAGES.size);
  });

  test("retryApiSessionPrompt clears promptCancelled after dismissal and Home shows Authentication required with recovery action", async () => {
    const meta = win.document.createElement("meta");
    meta.name = "easyproxy-management-auth-required";
    meta.content = "1";
    win.document.head.append(meta);

    let promptCalls = 0;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/") || url.endsWith("/easyproxy-session")) {
        return new Response("<html><head></head><body></body></html>", { status: 200 });
      }
      if (url.includes("/api/combos")) {
        const headers = new Headers(init?.headers);
        return headers.get("X-EasyProxy-API-Key") === "admin-secret"
          ? Response.json({ combos: [] })
          : Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.includes("/api/system/health")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.includes("/api/logs")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({});
    }) as typeof fetch;
    globalThis.fetch = mockFetch;
    win.fetch = mockFetch as unknown as typeof win.fetch;

    resetApiAuthFetchForTests(async (verify) => {
      promptCalls += 1;
      if (promptCalls === 1) return null; // simulate first dismissal
      const status = await verify("admin-secret", false);
      return status === "accepted" ? "admin-secret" : null;
    });
    installApiAuthFetch();

    const firstAttempt = await retryApiSessionPrompt("shared");
    expect(firstAttempt).toBe(false);
    expect(hasApiCredential("shared")).toBe(false);

    const secondAttempt = await retryApiSessionPrompt("shared");
    expect(secondAttempt).toBe(true);
    expect(hasApiCredential("shared")).toBe(true);
    expect(promptCalls).toBe(2);

    // Home displays Authentication required (not Proxy is not answering) and triggers onRequestAuth on click.
    const health401 = await readManagementHealth("http://127.0.0.1:8787", "/api/system/health", new AbortController().signal);
    expect(health401).toEqual({ version: null, uptime: null });
    expect(managementHealthAuthStatus(health401)).toBe(401);

    let authRequested = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Home
            apiBase="http://127.0.0.1:8787"
            navigate={() => {}}
            onReloadCodex={() => {}}
            reloadingCodex={false}
            sessionReady={false}
            onRequestAuth={() => { authRequested += 1; }}
          />
        </LanguageProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 25));
    });

    expect(host.textContent).toContain("Authentication required");
    expect(host.textContent).not.toContain("The proxy is not answering");
    const enterTokenBtn = Array.from(host.querySelectorAll("button"))
      .find(b => b.textContent?.includes("Enter Admin Token"));
    expect(enterTokenBtn).toBeDefined();
    await act(async () => { enterTokenBtn!.click(); });
    expect(authRequested).toBe(1);
  });

  test("Tray syncs epx-theme on mount & storage event, toggles single-column totals grid, and renders empty provider state", async () => {
    win.localStorage.setItem("epx-theme", "dark");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/companion/settings")) {
        return Response.json({
          settings: {
            showAccounts: true,
            showToday: false,
            showCost: false,
            showChart: false,
            showModels: false,
            models: null,
            hiddenProviders: [],
            chartStyle: "bars",
            chartHours: 24,
          },
        });
      }
      if (url.includes("/api/config")) return Response.json({ providers: {} });
      if (url.includes("/api/usage")) return Response.json({ summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, requests: 0 }, models: [] });
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Tray resolveApiBase={async () => "http://127.0.0.1:8787"} />
        </LanguageProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 35));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(host.querySelector(".tray-totals-grid--single")).not.toBeNull();
    expect(host.querySelector(".tray-missing")?.textContent).toBe("No providers connected yet");

    // Storage sync -> light and then system (clears attribute)
    await act(async () => {
      win.localStorage.setItem("epx-theme", "light");
      win.dispatchEvent(new win.StorageEvent("storage", { key: "epx-theme", newValue: "light" }) as unknown as Event);
    });
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => {
      win.localStorage.setItem("epx-theme", "system");
      win.dispatchEvent(new win.StorageEvent("storage", { key: "epx-theme", newValue: "system" }) as unknown as Event);
    });
    expect(document.documentElement.dataset.theme).toBeUndefined();

    // Also verify two-column totals grid omits --single when showToday is true
    const twoColHost = document.createElement("div");
    document.body.append(twoColHost);
    const twoColRoot = createRoot(twoColHost);
    const settingsTwoCol = {
      showToday: true,
      showCost: false,
      showChart: false,
      showModels: false,
      showAccounts: true,
      hiddenProviders: [],
      chartStyle: "bars",
      chartHours: 24,
    } as unknown as CompanionSettings;
    await act(async () => {
      twoColRoot.render(
        <TrayTotalsCard
          usage={[null, null]}
          settings={settingsTwoCol}
          locale="en"
          t={((k: string) => k) as TFn}
        />,
      );
    });
    expect(twoColHost.querySelector(".tray-totals-grid")?.classList.contains("tray-totals-grid--single")).toBe(false);
    await act(async () => { twoColRoot.unmount(); });
  });

  test("parseCurlToPlaygroundRequest validates limits fail-closed and extracts Chat/Responses/Messages payloads", () => {
    expect(MAX_CURL_IMPORT_BYTES).toBe(65_536);
    expect(parseCurlToPlaygroundRequest("   ")).toEqual({ ok: false, errorCode: "empty" });
    expect(parseCurlToPlaygroundRequest(`curl -d '${"a".repeat(70_000)}'`)).toEqual({ ok: false, errorCode: "too_large" });
    expect(parseCurlToPlaygroundRequest("wget https://example.com")).toEqual({ ok: false, errorCode: "not_curl" });
    expect(parseCurlToPlaygroundRequest("curl 'unterminated")).toEqual({ ok: false, errorCode: "unterminated_quote" });

    // Excessive JSON nesting (> 32) fails closed
    const nested = `${'{"a":'.repeat(40)}1${"}".repeat(40)}`;
    expect(parseCurlToPlaygroundRequest(`curl https://127.0.0.1:8787/v1/chat/completions -d '${nested}'`)).toEqual({
      ok: false,
      errorCode: "invalid_json",
    });

    const chatCmd = [
      "curl https://127.0.0.1:8787/v1/chat/completions \\",
      "  -H 'Content-Type: application/json' \\",
      `  --data-raw '{"model":"openai/gpt-5","temperature":0.4,"max_tokens":512,"stream":false,"messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"First q"},{"role":"assistant","content":"First a"},{"role":"user","content":"Follow up"}]}'`,
    ].join("\n");
    const parsedChat = parseCurlToPlaygroundRequest(chatCmd);
    expect(parsedChat).toEqual({
      ok: true,
      value: {
        endpoint: "/v1/chat/completions",
        stream: false,
        seed: {
          endpoint: "/v1/chat/completions",
          model: "openai/gpt-5",
          systemPrompt: "Be concise.",
          turns: [
            { role: "user", content: "First q" },
            { role: "assistant", content: "First a" },
          ],
          userPrompt: "Follow up",
          temperature: 0.4,
          maxTokens: 512,
        },
      },
    });

    const respCmd = `curl -X POST https://127.0.0.1:8787/v1/responses --json '{"model":"openai/gpt-5.3-codex","instructions":"Sys","input":"Ping","max_output_tokens":200,"reasoning":{"effort":"high"}}'`;
    const parsedResp = parseCurlToPlaygroundRequest(respCmd);
    expect(parsedResp.ok).toBe(true);
    if (parsedResp.ok) {
      expect(parsedResp.value.endpoint).toBe("/v1/responses");
      expect(parsedResp.value.seed.systemPrompt).toBe("Sys");
      expect(parsedResp.value.seed.userPrompt).toBe("Ping");
      expect(parsedResp.value.seed.maxTokens).toBe(200);
      expect(parsedResp.value.seed.effort).toBe("high");
    }

    const msgCmd = `curl https://127.0.0.1:8787/v1/messages -d '{"model":"anthropic/claude-sonnet-4","system":[{"type":"text","text":"Helpful"}],"messages":[{"role":"user","content":[{"type":"text","text":"Hello Claude"}]}]}'`;
    const parsedMsg = parseCurlToPlaygroundRequest(msgCmd);
    expect(parsedMsg.ok).toBe(true);
    if (parsedMsg.ok) {
      expect(parsedMsg.value.endpoint).toBe("/v1/messages");
      expect(parsedMsg.value.seed.systemPrompt).toBe("Helpful");
      expect(parsedMsg.value.seed.userPrompt).toBe("Hello Claude");
    }
  });

  test("RequestPlaygroundModal supports Import cURL, Compare A/B Delta Summary Bar, Copy Response, and Copy B cURL", async () => {
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedTexts.push(text);
        },
      },
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/models")) {
        return Response.json({ data: [{ id: "model-alpha" }, { id: "model-beta" }] });
      }
      const body = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
      if (body.model === "model-alpha") {
        await new Promise(resolve => setTimeout(resolve, 5));
        return Response.json({
          choices: [{ message: { content: "Answer from A" } }],
          usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
        });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      return Response.json({
        choices: [{ message: { content: "Answer from B" } }],
        usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
      });
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <RequestPlaygroundModal apiBase="http://127.0.0.1:8787" onClose={() => {}} />
        </LanguageProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    // Import cURL panel opens, rejects bad command, applies valid command
    const importToggle = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Import cURL")!;
    await act(async () => { importToggle.click(); });
    const importArea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Import cURL"]')!;
    await act(async () => { setInputValue(importArea, "wget https://invalid.test"); });
    const applyBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Apply to playground")!;
    await act(async () => { applyBtn.click(); });
    expect(host.textContent).toContain("Could not extract a valid JSON request");

    await act(async () => {
      setInputValue(importArea, `curl https://127.0.0.1:8787/v1/chat/completions -d '{"model":"model-alpha","messages":[{"role":"user","content":"Benchmark prompt"}]}'`);
    });
    await act(async () => { applyBtn.click(); });
    expect(host.querySelector('textarea[aria-label="Import cURL"]')).toBeNull();

    // Switch to A/B Compare, set Model B to model-beta, uncheck stream so JSON responses finish fast, and run
    const compareBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "A/B Compare")!;
    await act(async () => { compareBtn.click(); });
    const comboboxInputs = host.querySelectorAll<HTMLInputElement>('input[role="combobox"]');
    expect(comboboxInputs.length).toBeGreaterThanOrEqual(2);
    await act(async () => { setInputValue(comboboxInputs[1]!, "model-beta"); });
    const streamToggle = host.querySelector<HTMLInputElement>(".playground-stream-toggle input[type='checkbox']")!;
    if (streamToggle.checked) await act(async () => { streamToggle.click(); });

    const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submitBtn.click();
      await new Promise(resolve => setTimeout(resolve, 60));
    });

    const deltaBar = host.querySelector(".playground-ab-delta");
    expect(deltaBar).not.toBeNull();
    expect(deltaBar!.textContent).toContain("Total Δ:");
    expect(deltaBar!.textContent).toContain("Tokens Δ:");

    // Copy B cURL button exists and copies Lane B model
    const copyCurlBBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Copy B cURL")!;
    await act(async () => { copyCurlBBtn.click(); });
    expect(copiedTexts.at(-1)).toContain("model-beta");

    // Per-lane Copy Response buttons exist and copy lane text
    const copyRespBtns = Array.from(host.querySelectorAll("button")).filter(b => b.textContent === "Copy Response");
    expect(copyRespBtns).toHaveLength(2);
    await act(async () => { copyRespBtns[0]!.click(); });
    expect(copiedTexts.at(-1)).toBe("Answer from A");
    await act(async () => { copyRespBtns[1]!.click(); });
    expect(copiedTexts.at(-1)).toBe("Answer from B");
  });

  test("LogAttemptWaterfall computes proportional TTFT/decode splits, handles missing TTFT fallback, and marks 429/5xx tones", async () => {
    const layout = computeWaterfallLayout(
      [
        { ordinal: 2, provider: "anthropic", model: "claude-sonnet-4", status: 200, durationMs: 300, firstOutputMs: 90 },
        { ordinal: 1, provider: "openai", model: "gpt-5", status: 429, durationMs: 100 },
      ],
      400,
    );
    expect(layout.scaleMs).toBe(400);
    expect(layout.rows[0]!.attempt.ordinal).toBe(1);
    expect(layout.rows[0]!.metrics.tone).toBe("warn");
    expect(layout.rows[0]!.metrics.hasTtftSplit).toBe(false);
    expect(layout.rows[0]!.metrics.offsetPct).toBe(0);
    expect(layout.rows[0]!.metrics.widthPct).toBe(25);

    expect(layout.rows[1]!.metrics.tone).toBe("ok");
    expect(layout.rows[1]!.metrics.hasTtftSplit).toBe(true);
    expect(layout.rows[1]!.metrics.ttftPct).toBe(30);
    expect(layout.rows[1]!.metrics.decodePct).toBe(70);
    expect(layout.rows[1]!.metrics.offsetPct).toBe(25);
    expect(layout.rows[1]!.metrics.widthPct).toBe(75);

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LogAttemptWaterfall
          attempts={layout.rows.map(r => r.attempt)}
          totalDurationMs={400}
          locale="en"
          t={((k: string) => k) as TFn}
        />,
      );
    });
    expect(host.querySelectorAll(".log-waterfall-row")).toHaveLength(2);
    expect(host.querySelectorAll(".log-waterfall-seg--full")).toHaveLength(1);
    expect(host.querySelectorAll(".log-waterfall-seg--ttft")).toHaveLength(1);
    expect(host.querySelectorAll(".log-waterfall-seg--decode")).toHaveLength(1);
    expect(host.querySelector(".log-waterfall-status--warn")?.textContent).toBe("429");
  });

  test("gateway-alerts counts >=80% cost keys and recent 429/secret guard logs, gates on ready, and SidebarNav pills jump directly", async () => {
    expect(countBudgetWarningKeys([
      { dailyCostLimitUsd: 10, budgetUsage: { dailyCostUsdUsed: 7.99 } },
      { dailyCostLimitUsd: 10, budgetUsage: { dailyCostUsdUsed: 8 } },
      { dailyCostLimitUsd: 5, budgetUsage: { dailyCostUsdUsed: 5.5 } },
      { dailyCostLimitUsd: 0, budgetUsage: { dailyCostUsdUsed: 100 } },
    ])).toBe(2);

    expect(countRecentRateLimitOrBlockLogs([
      { status: 200 },
      { status: 429 },
      { status: 400, errorCode: "outbound_secret_guard" },
      { status: 500, failureCause: "rate-limit" },
    ])).toBe(3);

    let fetchCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCount += 1;
      const url = String(input);
      if (url.includes("/api/keys")) {
        return Response.json({ keys: [{ dailyCostLimitUsd: 10, budgetUsage: { dailyCostUsdUsed: 9 } }] });
      }
      if (url.includes("/api/logs")) {
        return Response.json({ logs: [{ status: 429 }, { status: 400, errorCode: "outbound_secret_guard" }] });
      }
      return Response.json({});
    }) as typeof fetch;

    const jumped: string[] = [];
    function AlertHarness({ ready }: { ready: boolean }) {
      const alerts = useGatewayAlerts({ apiBase: "http://127.0.0.1:8787", ready });
      return (
        <SidebarNav
          activeGroupId="home"
          pageLabel={p => p}
          pageAvailable={() => true}
          onNavigate={() => {}}
          onNavigateHash={h => jumped.push(h)}
          onReveal={() => {}}
          desktopShell={false}
          t={((k: string) => k) as TFn}
          locale="en"
          alerts={alerts}
        />
      );
    }

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);

    await act(async () => {
      root!.render(<AlertHarness ready={false} />);
      await new Promise(resolve => setTimeout(resolve, 15));
    });
    expect(fetchCount).toBe(0);
    expect(host.querySelectorAll(".nav-alert-pill")).toHaveLength(0);

    await act(async () => {
      root!.render(<AlertHarness ready />);
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    expect(fetchCount).toBe(2);
    const warnPill = host.querySelector<HTMLButtonElement>('[data-alert-target="connect"]')!;
    const errPill = host.querySelector<HTMLButtonElement>('[data-alert-target="usage-logs"]')!;
    expect(warnPill.textContent).toBe("1");
    expect(errPill.textContent).toBe("2");

    await act(async () => {
      warnPill.click();
      errPill.click();
    });
    expect(jumped).toEqual(["integrations/keys", "logs"]);
  });

  test("Antigravity CSS tokens, 216px layout density, logs tok/s container visibility, drawer motion, and 11-locale parity hold", async () => {
    const stylesCss = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const titlebarCss = readFileSync(new URL("../src/components/app-titlebar.css", import.meta.url), "utf8");
    const logsCss = readFileSync(new URL("../src/design/pages/logs.css", import.meta.url), "utf8");
    const playgroundCss = readFileSync(new URL("../src/components/request-playground.css", import.meta.url), "utf8");

    expect(stylesCss).toContain("grid-template-columns: 216px 1fr;");
    expect(titlebarCss).toContain("width: 216px;");
    expect(stylesCss).toContain(".modal-actions { display: flex; justify-content: flex-end;");
    expect(stylesCss).not.toContain(".modal-actions .btn { flex: 1; }");
    expect(stylesCss).toContain("border-radius: 6px;");
    expect(playgroundCss).toContain("border-radius: 6px;");
    expect(playgroundCss).toContain("--epx-success-soft");
    expect(playgroundCss).toContain("--epx-danger-soft");

    // 880px keeps tok/s column visible (for 1100x720 desktop shell); narrower 720px hides it.
    const rule880 = logsCss.slice(logsCss.indexOf("@container (max-width: 880px)"), logsCss.indexOf("@container (max-width: 720px)"));
    expect(rule880).toContain("logs-col-effort");
    expect(rule880).not.toContain("logs-col-rate {\n    display: none");
    expect(logsCss).toContain("@container (max-width: 720px)");
    expect(logsCss).toContain("@keyframes epx-drawer-slide-in");
    expect(logsCss).toContain("@media (prefers-reduced-motion: reduce)");

    // quick-action signals: requestApiKeyCreateFocus arms focus request consumed by ApiKeysWorkspace
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    const { default: ApiKeysWorkspace } = await import("../src/components/apikeys-workspace/ApiKeysWorkspace");
    const akHost = document.createElement("div");
    document.body.append(akHost);
    requestApiKeyCreateFocus();
    const { createRoot } = await import("react-dom/client");
    const akRoot = createRoot(akHost);
    await act(async () => {
      akRoot.render(
        <LanguageProvider>
          <ApiKeysWorkspace
            keys={[]}
            apiBase="http://127.0.0.1:8787"
            active
            keysLoading={false}
            keysLoadFailed={false}
            endpoints={{
              baseUrl: "http://127.0.0.1:8787",
              responses: "http://127.0.0.1:8787/v1/responses",
              chatCompletions: "http://127.0.0.1:8787/v1/chat/completions",
              messages: "http://127.0.0.1:8787/v1/messages",
              models: "http://127.0.0.1:8787/v1/models",
              geminiModels: "http://127.0.0.1:8787/v1beta/models",
            }}
            claudeCodeEnabled={false}
            authMatrix={[]}
            localeTag="en-US"
            newName=""
            creating={false}
            newKey={null}
            copied={false}
            filteredModels={[]}
            modelsLoading={false}
            modelsLoadFailed={false}
            modelCount={0}
            hasModelData
            modelQuery=""
            copiedModelId={null}
            modelTests={{}}
            canTestModels={false}
            onNewNameChange={() => {}}
            onCreate={() => {}}
            onDismissNewKey={() => {}}
            onCopyKey={() => {}}
            onDelete={async () => true}
            onRename={async () => true}
            onModelQueryChange={() => {}}
            onCopyModelId={() => {}}
            onTestModel={() => {}}
            onRetryModels={() => {}}
            sourceLabel={() => "provider"}
            protocolLabel={() => "openai"}
          />
        </LanguageProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const renderedKeyName = akHost.querySelector<HTMLInputElement>("#api-key-name");
    expect(renderedKeyName).not.toBeNull();
    expect(document.activeElement).toBe(renderedKeyName);
    await act(async () => { akRoot.unmount(); });

    // 11-locale parity for all new ux.* keys + natural polite Korean endings in ko slice
    const enDict = getLoadedDict("en");
    const newUxKeys = [
      "ux.cmd.createApiKey",
      "ux.cmd.themeLight",
      "ux.cmd.themeDark",
      "ux.cmd.themeSystem",
      "ux.auth.requiredTitle",
      "ux.auth.sessionRequiredBanner",
      "ux.auth.enterAdminToken",
      "ux.tray.noProviders",
      "ux.playground.importCurl",
      "ux.playground.importCurlPlaceholder",
      "ux.playground.importCurlApply",
      "ux.playground.importCurlErrEmpty",
      "ux.playground.importCurlErrTooLarge",
      "ux.playground.importCurlErrInvalid",
      "ux.playground.copyResponse",
      "ux.playground.copyCurlB",
      "ux.playground.deltaTtft",
      "ux.playground.deltaTotal",
      "ux.playground.deltaTokSec",
      "ux.playground.deltaTokens",
      "ux.playground.deltaWinnerA",
      "ux.playground.deltaWinnerB",
      "ux.playground.deltaHigherA",
      "ux.playground.deltaHigherB",
      "ux.playground.deltaTie",
      "ux.logs.waterfall.title",
      "ux.logs.waterfall.ttftLegend",
      "ux.logs.waterfall.decodeLegend",
      "ux.logs.waterfall.errorLegend",
      "ux.logs.waterfall.attemptLabel",
      "ux.alerts.budgetWarning",
      "ux.alerts.recentBlocks",
    ] as const;

    const sharedMetricKeys = new Set<string>([
      "ux.playground.deltaTtft",
      "ux.playground.deltaTotal",
      "ux.playground.deltaTokSec",
      "ux.playground.deltaTokens",
      "ux.playground.deltaHigherA",
      "ux.playground.deltaHigherB",
    ]);
    for (const loc of LOCALES) {
      const dict = getLoadedDict(loc.code);
      for (const k of newUxKeys) {
        const val = dict[k];
        expect(typeof val).toBe("string");
        expect(val.length).toBeGreaterThan(0);
        if (loc.code !== "en" && !sharedMetricKeys.has(k)) {
          expect(val).not.toBe(enDict[k]);
        }
      }
    }

    expect(uxOverhaulCopyKo["ux.playground.subtitle"]).toMatch(/다\.$/);
    expect(uxOverhaulCopyKo["ux.auth.sessionRequiredBanner"]).toMatch(/다\.$/);
  });
});
