import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { AllProviderAccountsHub } from "../src/components/AllProviderAccountsHub";
import { CcSwitchImportModal } from "../src/components/CcSwitchImportModal";
import GatewayGuardrailsPanel from "../src/components/GatewayGuardrailsPanel";
import { Combobox } from "../src/components/ui-v2/combobox";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import Integrations from "../src/pages/Integrations";
import Logs from "../src/pages/Logs";
import Providers from "../src/pages/Providers";
import { serveGuiFile } from "../../src/server/gui-static";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let savedGlobals: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let root: Root | undefined;

async function flushTicks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function jsonOk(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installLayoutStubs(targetWindow: Window): void {
  const proto = targetWindow.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
        toJSON() { return this; },
      };
    },
  });
  Object.defineProperty(targetWindow, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class ResizeObserverStub {
      #cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
      observe(target: Element) {
        this.#cb(
          [{
            target,
            contentRect: {
              x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
              toJSON() { return this; },
            },
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  });
}

function assertBridgeControlsHaveNoUiV2Ancestor(rootEl: Element): void {
  const controls = rootEl.querySelectorAll(".btn, .switch, .page-tab, .select-trigger, .link-btn, .pws-filter-btn, .pws-detail-tab");
  for (const el of controls) {
    expect(el.closest(".ui-v2")).toBeNull();
  }
}

beforeEach(() => {
  savedGlobals = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])) as typeof savedGlobals;
  prevFetch = globalThis.fetch;
  win = new Window({ url: "http://127.0.0.1:10100/" });
  win.localStorage.setItem("epx-lang", "en");
  installLayoutStubs(win);
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
  clearClientResourceStoresForTests();
  globalThis.fetch = prevFetch;
  win.close();
  for (const k of GLOBALS) {
    const desc = savedGlobals[k];
    if (desc) Object.defineProperty(globalThis, k, desc);
    else Reflect.deleteProperty(globalThis, k);
  }
});

describe("Stage 4C /classic/ retirement and bridge/.ui-v2 layer boundary", () => {
  test("serveGuiFile retires /classic/ routes and static classic assets", () => {
    const guiDist = mkdtempSync(join(tmpdir(), "epx-stage4c-static-"));
    try {
      mkdirSync(join(guiDist, "assets"), { recursive: true });
      mkdirSync(join(guiDist, "classic", "assets"), { recursive: true });
      writeFileSync(join(guiDist, "index.html"), "<!doctype html><html><head><title>v2</title></head><body></body></html>");
      writeFileSync(join(guiDist, "classic", "index.html"), "<!doctype html><html><head><title>classic</title></head><body></body></html>");
      writeFileSync(join(guiDist, "classic", "assets", "main-AbCd1234.js"), "console.log('classic');");

      for (const path of ["/classic", "/classic/", "/classic/providers"]) {
        const res = serveGuiFile(path, guiDist);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(308);
        expect(res!.headers.get("Location")).toBe("/");
        expect(res!.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(serveGuiFile("/classic/index.html", guiDist)).toBeNull();
      expect(serveGuiFile("/classic/assets/main-AbCd1234.js", guiDist)).toBeNull();
    } finally {
      rmSync(guiDist, { recursive: true, force: true });
    }
  });

  test("Integrations, Providers, Logs, Debug, and AllProviderAccountsHub render bridge surfaces without .ui-v2 ancestors on .btn/.switch controls", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/config")) {
        return jsonOk({
          providers: {
            openai: {
              adapter: "openai-responses",
              authMode: "forward",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              codexAccountMode: "pool",
              models: ["gpt-5"],
            },
          },
          defaultProvider: "openai",
        });
      }
      if (url.includes("/api/codex-auth/accounts")) {
        return jsonOk({
          activeCodexAccountId: "cdx-1",
          accounts: [
            { id: "cdx-1", alias: "codex-main", plan: "pro", active: true },
            { id: "cdx-2", alias: "codex-backup", plan: "plus", active: false },
          ],
        });
      }
      if (url.includes("/api/providers/cc-switch/preview")) {
        return jsonOk({
          available: true,
          keychainAvailable: true,
          defaultSources: [{ path: "/tmp/.cc-switch/providers.json", kind: "json" }],
          journalActive: false,
          discovered: 1,
          eligible: 1,
          conflicts: 0,
          conflictNames: [],
          invalid: 0,
          invalidReasons: {},
          providers: [{
            name: "imported-claude",
            sourceId: "c1",
            appType: "claude",
            adapter: "anthropic",
            baseUrl: "https://relay.example.com/v1",
            defaultModel: "claude-sonnet-4-5",
            hasApiKey: true,
          }],
        });
      }
      if (url.includes("/api/providers")) return jsonOk([{ name: "openai", hasProxy: false }]);
      if (url.includes("/api/gateway-guardrails")) {
        return jsonOk({
          outboundSecretGuard: { mode: "redact" },
          toolOutputCompression: { enabled: true, minChars: 12000, headChars: 4000, tailChars: 4000, stripAnsi: true },
          stats: { scannedRequests: 0, secretDetections: 0, secretBlocks: 0, compressedToolOutputs: 0, savedChars: 0 },
        });
      }
      if (url.includes("/api/oauth/status")) return jsonOk({ providers: [] });
      if (url.includes("/api/oauth/accounts")) return jsonOk({ accounts: [] });
      if (url.includes("/api/provider-quotas")) return jsonOk([]);
      if (url.includes("/api/gateway-clients")) return jsonOk({ clients: [], summary: {} });
      if (url.includes("/api/native-integrations")) {
        return jsonOk({
          clients: [{
            clientId: "codex",
            state: "current",
            installed: true,
            configPath: "/tmp/.codex/config.toml",
            desiredEnabled: true,
            disableBlocked: null,
          }],
        });
      }
      if (url.includes("/api/integrations")) return jsonOk({ clients: [] });
      if (url.includes("/api/settings")) {
        return jsonOk({ codexAutoStart: true, codexDesktopAuthless: false, codexAccountPickerEnabled: false });
      }
      if (url.includes("/api/logs")) {
        return jsonOk({
          logs: [{
            requestId: "req-1",
            timestamp: 1_700_000_000_000,
            model: "gpt-5",
            provider: "openai",
            status: 200,
            durationMs: 42,
            usageStatus: "reported",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }],
          total: 1,
        });
      }
      if (url.includes("/api/debug/logs") || url.includes("/api/debug/usage-logs") || url.includes("/api/debug/injection-logs")) {
        return jsonOk([]);
      }
      if (url.includes("/api/debug")) {
        return jsonOk({
          enabled: true,
          usage: false,
          injection: false,
          claude: false,
          runtimeOverride: {},
          env: { debug: true, usage: false, injection: false, claude: false },
        });
      }
      return jsonOk({});
    }) as typeof globalThis.fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // 1. Integrations + CodexIntegrationPage
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Integrations apiBase="" machineApiBase="" connected />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const integrationsPage = container.querySelector("section.integrations-page");
    expect(integrationsPage).not.toBeNull();
    expect(integrationsPage!.classList.contains("ui-v2")).toBe(false);
    expect(container.querySelectorAll("section.integrations-page .btn").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("section.integrations-page .page-tab").length).toBeGreaterThan(0);
    assertBridgeControlsHaveNoUiV2Ancestor(container);

    const codexTab = container.querySelector<HTMLButtonElement>("#integrations-tab-codex")!;
    expect(codexTab).not.toBeNull();
    await act(async () => { codexTab.click(); });
    await flushTicks();
    const codexPage = container.querySelector("section.integration-native-page");
    expect(codexPage).not.toBeNull();
    expect(codexPage!.classList.contains("ui-v2")).toBe(false);
    expect(codexPage!.querySelectorAll(".switch").length).toBeGreaterThanOrEqual(4);
    expect(codexPage!.querySelectorAll(".btn").length).toBeGreaterThanOrEqual(2);
    const codexRadios = codexPage!.querySelectorAll('[role="radio"]');
    expect(codexRadios.length).toBe(2);
    for (const radio of codexRadios) {
      expect(radio.closest(".ui-v2")).not.toBeNull();
    }
    const codexBordered = codexPage!.querySelectorAll(".border, .border-t");
    expect(codexBordered.length).toBeGreaterThanOrEqual(5);
    for (const el of codexBordered) {
      expect(el.classList.contains("border-solid")).toBe(true);
    }
    assertBridgeControlsHaveNoUiV2Ancestor(container);

    // 2. Providers + ProviderWorkspaceShell + ProviderDetails/ProviderSettings
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Providers apiBase="" targetKey="local" targetLabel="Local" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const providersPage = container.querySelector(".providers-page");
    expect(providersPage).not.toBeNull();
    expect(providersPage!.classList.contains("ui-v2")).toBe(false);
    const pwsShell = container.querySelector(".providers-page .pws-shell-container");
    expect(pwsShell).not.toBeNull();
    expect(pwsShell!.closest(".ui-v2")).toBeNull();
    expect(providersPage!.querySelectorAll(".btn").length).toBeGreaterThan(0);
    expect(providersPage!.querySelectorAll(".pws-filter-btn").length).toBeGreaterThan(0);
    const openaiRailRow = providersPage!.querySelector<HTMLButtonElement>(".providers-workspace-rail-row");
    expect(openaiRailRow).not.toBeNull();
    await act(async () => { openaiRailRow!.click(); });
    await flushTicks();
    expect(providersPage!.querySelectorAll(".pws-detail-tab").length).toBeGreaterThan(0);
    const settingsTab = [...providersPage!.querySelectorAll<HTMLButtonElement>(".pws-detail-tab")]
      .find(tab => tab.id.endsWith("-settings") || /settings/i.test(tab.textContent ?? ""));
    expect(settingsTab).toBeDefined();
    await act(async () => { settingsTab!.click(); });
    await flushTicks();
    const egressBordered = providersPage!.querySelectorAll('section[aria-labelledby="pwi-egress-title"] .border-t');
    expect(egressBordered.length).toBeGreaterThan(0);
    for (const el of egressBordered) {
      expect(el.classList.contains("border-solid")).toBe(true);
    }
    assertBridgeControlsHaveNoUiV2Ancestor(container);

    // 3. Logs + LogDetailDialog + LogsFilterBar
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Logs apiBase="" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const logsPage = container.querySelector(".logs-page");
    expect(logsPage).not.toBeNull();
    expect(logsPage!.classList.contains("ui-v2")).toBe(false);
    expect(container.querySelector("#logs-tab-logs")?.classList.contains("ui-v2")).toBe(true);
    expect(container.querySelector(".logs-table")?.classList.contains("ui-v2")).toBe(true);
    const detailBtn = container.querySelector<HTMLButtonElement>(".log-detail-btn");
    expect(detailBtn).not.toBeNull();
    expect(detailBtn!.classList.contains("ui-v2")).toBe(true);
    const durationGroup = container.querySelector('.logs-filter-container [role="group"]');
    expect(durationGroup).not.toBeNull();
    expect(durationGroup!.classList.contains("ui-v2")).toBe(true);
    expect(durationGroup!.classList.contains("border-solid")).toBe(true);

    await act(async () => { detailBtn!.click(); });
    await flushTicks();
    const drawer = container.querySelector(".modal-overlay.log-detail-drawer");
    expect(drawer).not.toBeNull();
    expect(drawer!.classList.contains("ui-v2")).toBe(false);
    expect(drawer!.querySelectorAll(".btn").length).toBeGreaterThan(0);
    assertBridgeControlsHaveNoUiV2Ancestor(container);

    // 4. Debug
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Debug apiBase="" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const debugPage = container.querySelector(".debug-v2");
    expect(debugPage).not.toBeNull();
    expect(debugPage!.classList.contains("ui-v2")).toBe(false);
    expect(debugPage!.querySelectorAll(".switch").length).toBeGreaterThanOrEqual(4);
    assertBridgeControlsHaveNoUiV2Ancestor(container);

    // 5. AllProviderAccountsHub
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <AllProviderAccountsHub apiBase="" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const hubSection = container.querySelector('section[aria-labelledby="accounts-hub-title"]');
    expect(hubSection).not.toBeNull();
    expect(hubSection!.classList.contains("ui-v2")).toBe(false);
    expect(hubSection!.classList.contains("border-solid")).toBe(true);
    expect(hubSection!.querySelectorAll(".btn").length).toBeGreaterThanOrEqual(2);
    expect(hubSection!.querySelectorAll(".link-btn").length).toBeGreaterThanOrEqual(1);
    const segmentedFilter = [...hubSection!.querySelectorAll("div")].find(
      el => [...el.children].filter(child => child.matches("button[aria-pressed]")).length === 3,
    );
    expect(segmentedFilter).toBeDefined();
    expect(segmentedFilter!.classList.contains("ui-v2")).toBe(true);
    const hubCard = hubSection!.querySelector('article[data-hub-provider="openai"]');
    expect(hubCard?.classList.contains("border-solid")).toBe(true);
    const hubBordered = hubSection!.querySelectorAll(".border, .border-t");
    expect(hubBordered.length).toBeGreaterThanOrEqual(2);
    for (const el of hubBordered) {
      expect(el.classList.contains("border-solid")).toBe(true);
    }
    assertBridgeControlsHaveNoUiV2Ancestor(container);

    // 6. CcSwitchImportModal, GatewayGuardrailsPanel, and Combobox outside .ui-v2
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <div>
            <CcSwitchImportModal apiBase="" onClose={() => {}} onChanged={() => {}} />
            <GatewayGuardrailsPanel apiBase="" />
            <Combobox value="" onChange={() => {}} options={["gpt-5", "claude-sonnet-4-5"]} aria-label="Model picker" />
          </div>
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const ccModal = container.querySelector<HTMLDialogElement>("dialog.modal-overlay");
    expect(ccModal).not.toBeNull();
    expect(ccModal!.classList.contains("ui-v2")).toBe(false);
    expect(ccModal!.querySelector(".modal-backdrop-dismiss")).not.toBeNull();
    expect(ccModal!.querySelector(".modal-card")).not.toBeNull();
    expect(container.querySelector(".modal-backdrop")).toBeNull();
    const comboInput = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(comboInput).not.toBeNull();
    await act(async () => { comboInput.focus(); });
    await flushTicks();
    const listbox = container.querySelector<HTMLElement>('ul[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox!.classList.contains("border-solid")).toBe(true);
    expect(listbox!.classList.contains("border-line-strong")).toBe(true);
    expect(listbox!.classList.contains("bg-raised")).toBe(true);
    expect(listbox!.classList.contains("rounded-panel")).toBe(true);
    for (const el of container.querySelectorAll(".border, .border-t, .border-b")) {
      if (!el.closest(".ui-v2")) {
        expect(el.classList.contains("border-solid")).toBe(true);
      }
    }
    assertBridgeControlsHaveNoUiV2Ancestor(container);
  });

  test("design theme bridge imports unified providers, connect, and logs sheets without .ui-v2 selector guards", () => {
    const themeCss = readFileSync(join(import.meta.dir, "..", "src", "design", "theme.css"), "utf8");
    const providersCss = readFileSync(join(import.meta.dir, "..", "src", "design", "pages", "providers.css"), "utf8");
    const connectCss = readFileSync(join(import.meta.dir, "..", "src", "design", "pages", "connect.css"), "utf8");
    const comboboxTsx = readFileSync(join(import.meta.dir, "..", "src", "components", "ui-v2", "combobox.tsx"), "utf8");

    expect(themeCss).toContain('@import "./pages/connect.css" layer(bridge);');
    expect(themeCss).toContain('@import "./pages/logs.css" layer(bridge);');
    expect(themeCss).toContain('@import "./pages/providers.css" layer(bridge);');
    expect(providersCss).toContain(".providers-page .page-head");
    expect(providersCss).toContain(".pws-shell-container");
    expect(providersCss).not.toContain(".ui-v2");
    expect(connectCss).toContain(".integrations-page .page-head > h1");
    expect(connectCss).not.toContain(".ui-v2");
    expect(comboboxTsx).not.toContain("--epx-border-strong");
    expect(comboboxTsx).not.toContain("--epx-radius-md");
    expect(comboboxTsx).not.toContain("--epx-radius-sm");
    expect(comboboxTsx).not.toContain("--epx-surface-elevated");
    expect(comboboxTsx).not.toContain("--epx-surface-hover");
  });
});
