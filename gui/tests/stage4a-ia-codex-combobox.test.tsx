import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AllProviderAccountsHub } from "../src/components/AllProviderAccountsHub";
import { LanguageProvider } from "../src/i18n/provider";
import CodexIntegrationPage from "../src/pages/integrations/CodexIntegrationPage";
import GatewayClientsPage from "../src/pages/integrations/GatewayClientsPage";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let savedGlobals: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let root: Root | undefined;

async function flushTicks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  savedGlobals = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])) as typeof savedGlobals;
  prevFetch = globalThis.fetch;
  win = new Window({ url: "http://127.0.0.1:10100/" });
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

describe("Stage 4A Accounts hub, Route -> Codex controls, and GatewayClients Combobox", () => {
  test("AllProviderAccountsHub displays Codex + OAuth + API-Key pools, quotas, filters, and switches active accounts", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let antigravityActive = "agy-1";
    let keyActive = "k-1";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool" },
            "google-antigravity": { adapter: "google", authMode: "oauth" },
            alpha: { adapter: "openai-chat", authMode: "key", hasApiKey: true },
          },
        });
      }
      if (url.includes("/api/provider-quotas")) {
        return Response.json([
          {
            provider: "google-antigravity",
            source: "probe",
            updatedAt: Date.now(),
            quota: { fiveHourPercent: 80, updatedAt: Date.now() },
          },
        ]);
      }
      if (url.endsWith("/api/codex-auth/accounts")) {
        return Response.json({
          activeCodexAccountId: "cdx-1",
          accounts: [
            { id: "cdx-1", alias: "codex-main", plan: "pro", active: true, quota: { fiveHourPercent: 65, updatedAt: Date.now() } },
          ],
        });
      }
      if (url.includes("/api/oauth/accounts?provider=google-antigravity")) {
        return Response.json({
          activeAccountId: antigravityActive,
          accounts: [
            { id: "agy-1", alias: "agy-primary", plan: "ultra", active: antigravityActive === "agy-1", quota: { fiveHourPercent: 82, updatedAt: Date.now() } },
            { id: "agy-2", alias: "agy-backup", plan: "free", active: antigravityActive === "agy-2" },
          ],
        });
      }
      if (url.includes("/api/providers/keys?name=alpha")) {
        return Response.json({
          keys: [
            { id: "k-1", label: "Key A", masked: "sk-***a", active: keyActive === "k-1" },
            { id: "k-2", label: "Key B", masked: "sk-***b", active: keyActive === "k-2" },
          ],
        });
      }
      if (url.endsWith("/api/oauth/accounts/active") && method === "PUT") {
        antigravityActive = String(body?.accountId);
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/providers/keys/active") && method === "PUT") {
        keyActive = String(body?.id);
        return Response.json({ ok: true });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <AllProviderAccountsHub apiBase="http://127.0.0.1:10100" />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    expect(host.querySelector('[data-hub-provider="openai"]')).not.toBeNull();
    expect(host.querySelector('[data-hub-provider="google-antigravity"]')).not.toBeNull();
    expect(host.querySelector('[data-hub-provider="alpha"]')).not.toBeNull();
    expect(host.textContent).toContain("agy-primary");
    expect(host.textContent).toContain("Key B");

    // Switch OAuth active account.
    const agyCard = host.querySelector('[data-hub-provider="google-antigravity"]')!;
    const setActiveBtn = [...agyCard.querySelectorAll("button")].find(b => b.textContent === "Set active")!;
    await act(async () => { setActiveBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/oauth/accounts/active") && c.method === "PUT" && c.body?.accountId === "agy-2")).toBe(true);

    // Switch API key active.
    const alphaCard = host.querySelector('[data-hub-provider="alpha"]')!;
    const keyBtn = [...alphaCard.querySelectorAll("button")].find(b => b.textContent === "Set active")!;
    await act(async () => { keyBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/providers/keys/active") && c.method === "PUT" && c.body?.id === "k-2")).toBe(true);

    // Filter to API Keys hides OAuth/Codex cards.
    const keysFilter = [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("API Keys"))!;
    await act(async () => { keysFilter.click(); });
    expect(host.querySelector('[data-hub-provider="alpha"]')).not.toBeNull();
    expect(host.querySelector('[data-hub-provider="google-antigravity"]')).toBeNull();

    // Refresh quotas requests ?refresh=1.
    const refreshBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Refresh quotas")!;
    await act(async () => { refreshBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/provider-quotas?refresh=1"))).toBe(true);
  });

  test("CodexIntegrationPage exposes Pool/Direct selector and Codex switches on Route -> Codex", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let accountMode: "pool" | "direct" = "pool";
    let codexAutoStart = true;
    let codexDesktopAuthless = false;
    let codexConnected = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/api/native-integrations") && method === "GET") {
        return Response.json({
          clients: [{
            clientId: "codex",
            state: codexConnected ? "current" : "absent",
            installed: true,
            configPath: "/tmp/.codex/config.toml",
            desiredEnabled: codexConnected,
            disableBlocked: null,
          }],
        });
      }
      if (url.endsWith("/api/native-integrations/codex") && method === "PUT") {
        codexConnected = body?.enabled === true;
        return Response.json({
          ok: true,
          clientId: "codex",
          changed: true,
          state: codexConnected ? "current" : "absent",
          message: "updated",
          desiredEnabled: codexConnected,
        });
      }
      if (url.endsWith("/api/settings") && method === "GET") {
        return Response.json({ codexAutoStart, codexDesktopAuthless, codexAccountPickerEnabled: false });
      }
      if (url.endsWith("/api/settings") && method === "PUT") {
        if (typeof body?.codexAutoStart === "boolean") codexAutoStart = body.codexAutoStart;
        if (typeof body?.codexDesktopAuthless === "boolean") codexDesktopAuthless = body.codexDesktopAuthless;
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: {
              adapter: "openai-responses",
              authMode: "forward",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              codexAccountMode: accountMode,
            },
          },
        });
      }
      if (url.includes("/api/providers?name=openai") && method === "PATCH") {
        accountMode = body?.codexAccountMode as "pool" | "direct";
        return Response.json({ success: true, name: "openai", codexAccountMode: accountMode });
      }
      if (url.endsWith("/api/sync") && method === "POST") {
        return Response.json({ ok: true, status: "applied" });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <CodexIntegrationPage apiBase="http://127.0.0.1:10100" active />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const connectSwitch = host.querySelector('[aria-label="Apply"]') as HTMLButtonElement;
    expect(connectSwitch).not.toBeNull();
    expect(connectSwitch.getAttribute("aria-checked")).toBe("false");
    await act(async () => { connectSwitch.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/native-integrations/codex") && c.method === "PUT" && c.body?.enabled === true)).toBe(true);
    const disconnectSwitch = host.querySelector('[aria-label="Disable"]') as HTMLButtonElement;
    expect(disconnectSwitch?.getAttribute("aria-checked")).toBe("true");
    await act(async () => { disconnectSwitch.click(); });
    await flushTicks();
    const confirmBtn = [...host.querySelectorAll('dialog .modal-actions button')].find(b => b.textContent === "Disable") as HTMLButtonElement;
    expect(confirmBtn).toBeDefined();
    await act(async () => { confirmBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/native-integrations/codex") && c.method === "PUT" && c.body?.enabled === false)).toBe(true);

    const directRadio = [...host.querySelectorAll('[role="radio"]')].find(el => el.textContent?.includes("Direct")) as HTMLButtonElement;
    expect(directRadio.getAttribute("aria-checked")).toBe("false");
    await act(async () => { directRadio.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.includes("/api/providers?name=openai") && c.method === "PATCH")).toBe(false);
    const modeConfirmBtn = [...document.querySelectorAll("dialog .modal-actions button.btn-primary, dialog .modal-actions button")].at(-1) as HTMLButtonElement | undefined;
    expect(modeConfirmBtn).toBeDefined();
    await act(async () => { modeConfirmBtn!.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.includes("/api/providers?name=openai") && c.method === "PATCH" && c.body?.codexAccountMode === "direct")).toBe(true);
    expect(directRadio.getAttribute("aria-checked")).toBe("true");

    const desktopSwitch = host.querySelector('[aria-label="Desktop authless bridge"]') as HTMLButtonElement;
    await act(async () => { desktopSwitch.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/settings") && c.method === "PUT" && c.body?.codexDesktopAuthless === true)).toBe(true);
    expect(calls.some(c => c.url.endsWith("/api/sync") && c.method === "POST")).toBe(true);
  });

  test("GatewayClientsPage replaces raw model input with WAI-ARIA Combobox populated from /api/models", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/api/gateway-clients")) {
        return Response.json({
          clients: [
            {
              id: "antigravity",
              label: "Antigravity",
              state: "disconnected",
              files: [{ path: "~/.antigravity/settings.json", role: "user settings", exists: true }],
              overrides: [],
              notes: [],
              defaultModel: "gemini-3-pro",
            },
          ],
        });
      }
      if (url.endsWith("/api/models")) {
        return Response.json([{ id: "google-antigravity/gemini-3.8-flash" }, { id: "anthropic/claude-opus-4-5" }]);
      }
      if (url.endsWith("/api/gateway-clients/antigravity/connect") && method === "POST") {
        return Response.json({ ok: true, id: "antigravity", action: "connect", changed: true });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <GatewayClientsPage apiBase="http://127.0.0.1:10100" active />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const comboInput = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(comboInput).not.toBeNull();
    expect(comboInput.value).toBe("gemini-3-pro");

    await act(async () => { comboInput.focus(); });
    await flushTicks();
    const option = [...host.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes("google-antigravity/gemini-3.8-flash")) as HTMLElement | undefined;
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
    });
    await flushTicks();
    expect(comboInput.value).toBe("google-antigravity/gemini-3.8-flash");

    const connectBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Connect")!;
    await act(async () => { connectBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/gateway-clients/antigravity/connect") && c.body?.model === "google-antigravity/gemini-3.8-flash")).toBe(true);
  });

  test("AllProviderAccountsHub uses /api/provider-quotas reports, PUT /api/codex-auth/active, safe __main__/ordinal labels, and hideWhenCodexOnly", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let activeCodex: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: {
              adapter: "openai-responses",
              authMode: "forward",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              codexAccountMode: "pool",
            },
          },
        });
      }
      if (url.includes("/api/provider-quotas")) {
        return Response.json({ reports: [{ provider: "openai", status: "ok", windows: [{ id: "five_hour", label: "5h", remainingPercent: 80 }] }] });
      }
      if (url.endsWith("/api/codex-auth/accounts")) {
        return Response.json({
          accounts: [
            { id: "__main__", email: "Codex App login", logLabel: "main", plan: "plus" },
            { id: "acct_opaque_xyz", plan: "pro" },
          ],
        });
      }
      if (url.endsWith("/api/codex-auth/active") && method === "GET") {
        return Response.json({ activeCodexAccountId: activeCodex });
      }
      if (url.endsWith("/api/codex-auth/active") && method === "PUT") {
        activeCodex = (body?.accountId as string) ?? "__main__";
        return Response.json({ ok: true, activeCodexAccountId: activeCodex === "__main__" ? null : activeCodex });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <AllProviderAccountsHub apiBase="http://127.0.0.1:10100" />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    expect(host.textContent).toContain("Codex App");
    expect(host.textContent).toContain("Account 2");
    expect(host.textContent).not.toContain("__main__");
    expect(host.textContent).not.toContain("acct_opaque_xyz");

    const switchBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Set active")!;
    await act(async () => { switchBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/codex-auth/active") && c.method === "PUT" && c.body?.accountId === "acct_opaque_xyz")).toBe(true);

    // Switching back to __main__ preserves "__main__" string (never sends null).
    const backBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Set active")!;
    await act(async () => { backBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/codex-auth/active") && c.method === "PUT" && c.body?.accountId === "__main__")).toBe(true);

    // hideWhenCodexOnly suppresses standalone hub when only Codex exists.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <AllProviderAccountsHub apiBase="http://127.0.0.1:10100" hideWhenCodexOnly />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(host.querySelector('[data-hub-provider="openai"]')).toBeNull();
  });

  test("GatewayClientsPage filters disabled/superseded models and prioritizes antigravity/google/anthropic", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/gateway-clients")) {
        return Response.json({
          clients: [{ id: "antigravity", label: "Antigravity", state: "disconnected", files: [], overrides: [], notes: [] }],
        });
      }
      if (url.endsWith("/api/models")) {
        return Response.json({
          models: [
            { id: "openai/gpt-5", provider: "openai" },
            { id: "google-antigravity/disabled-m", provider: "google-antigravity", disabled: true },
            { id: "google-antigravity/superseded-m", provider: "google-antigravity", superseded: true },
            { id: "google-antigravity/gemini-3.8-pro", provider: "google-antigravity" },
            { id: "anthropic/claude-4-5", provider: "anthropic" },
          ],
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <GatewayClientsPage apiBase="http://127.0.0.1:10100" active />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const comboInput = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { comboInput.focus(); });
    await flushTicks();
    const options = [...host.querySelectorAll('[role="option"]')].map(el => el.textContent ?? "");
    expect(options.some(text => text.includes("disabled-m"))).toBe(false);
    expect(options.some(text => text.includes("superseded-m"))).toBe(false);
    const agyIdx = options.findIndex(text => text.includes("google-antigravity/gemini-3.8-pro"));
    const antIdx = options.findIndex(text => text.includes("anthropic/claude-4-5"));
    const oaiIdx = options.findIndex(text => text.includes("openai/gpt-5"));
    expect(agyIdx).toBeGreaterThanOrEqual(0);
    expect(agyIdx).toBeLessThan(antIdx);
    expect(antIdx).toBeLessThan(oaiIdx);
  });

  test("AllProviderAccountsHub handles keyed openai, preserves active account beyond index 5, sends quota=1, and blocks unsafe switches", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: { adapter: "openai-responses", authMode: "key", hasApiKey: true },
            "openai-codex": { adapter: "openai-responses", authMode: "forward", canonicalOpenAiForward: true, codexAccountMode: "pool" },
          },
        });
      }
      if (url.includes("/api/provider-quotas")) {
        return Response.json([]);
      }
      if (url.includes("/api/providers/keys?name=openai")) {
        return Response.json({ keys: [{ id: "key-1", label: "OpenAI API Key", active: true }] });
      }
      if (url.endsWith("/api/codex-auth/accounts")) {
        return Response.json({
          activeCodexAccountId: "c-7",
          accounts: [
            { id: "c-1", alias: "codex-1", mainAccountHardLock: { state: "blocked" } },
            { id: "c-2", alias: "codex-2", health: { reason: "validation_pending" } },
            { id: "c-3", alias: "codex-3" },
            { id: "c-4", alias: "codex-4" },
            { id: "c-5", alias: "codex-5" },
            { id: "c-6", alias: "codex-6" },
            { id: "c-7", alias: "codex-7-active", active: true, quota: { fiveHourPercent: 42, updatedAt: Date.now() } },
          ],
        });
      }
      if (url.endsWith("/api/codex-auth/active")) {
        return Response.json({ activeCodexAccountId: "c-7" });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <AllProviderAccountsHub apiBase="http://127.0.0.1:10100" />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    expect(requestedUrls.some(u => u.endsWith("/api/providers/keys?name=openai&quota=1"))).toBe(true);
    const keyedOpenAiCard = host.querySelector('[data-hub-provider="openai"]')!;
    expect(keyedOpenAiCard.textContent).toContain("OpenAI API Key");

    const codexCard = host.querySelector('[data-hub-provider="openai-codex"]')!;
    // Active account at index 6 stays rendered and supplies topQuota.
    expect(codexCard.textContent).toContain("codex-7-active");
    expect(codexCard.textContent).toContain("42%");
    // Hard-locked (c-1) and validation-pending (c-2) accounts have disabled switch buttons, while c-3 stays enabled.
    const switchButtons = [...codexCard.querySelectorAll("button")].filter(b => b.textContent === "Set active");
    expect(switchButtons[0]!.disabled).toBe(true);
    expect(switchButtons[1]!.disabled).toBe(true);
    expect(switchButtons[2]!.disabled).toBe(false);
  });

  test("CodexIntegrationPage mode switch confirmation cancel leaves accountMode unchanged", async () => {
    const patchCalls: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/providers?name=openai") && init?.method === "PATCH") {
        patchCalls.push(init.body);
        return Response.json({ success: true });
      }
      if (url.endsWith("/api/native-integrations")) {
        return Response.json({ clients: [{ clientId: "codex", state: "current", installed: true, desiredEnabled: true }] });
      }
      if (url.endsWith("/api/settings")) {
        return Response.json({ codexAutoStart: true, codexDesktopAuthless: false, codexAccountPickerEnabled: false });
      }
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: {
              adapter: "openai-responses",
              authMode: "forward",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              codexAccountMode: "pool",
            },
          },
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <CodexIntegrationPage apiBase="http://127.0.0.1:10100" active />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const directRadio = [...host.querySelectorAll('[role="radio"]')].find(el => el.textContent?.includes("Direct")) as HTMLButtonElement;
    await act(async () => { directRadio.click(); });
    await flushTicks();
    const cancelBtn = [...document.querySelectorAll("dialog .modal-actions button")].find(b => b.textContent === "Cancel") as HTMLButtonElement | undefined;
    expect(cancelBtn).toBeDefined();
    await act(async () => { cancelBtn!.click(); });
    await flushTicks();
    expect(patchCalls).toHaveLength(0);
    expect(directRadio.getAttribute("aria-checked")).toBe("false");
  });
});
