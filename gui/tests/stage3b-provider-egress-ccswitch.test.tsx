import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { CcSwitchImportModal } from "../src/components/CcSwitchImportModal";
import { ProviderEgressAndKeychainSection } from "../src/components/provider-workspace/ProviderEgressAndKeychainSection";
import { LanguageProvider } from "../src/i18n/provider";
import { buildLogReplayCurl, type LogExportRecord } from "../src/lib/log-export";
import { buildPlaygroundCurl } from "../src/lib/playground-client";
import Home from "../src/pages/Home";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let savedGlobals: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let root: Root | undefined;

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

async function flushTicks(rounds = 3): Promise<void> {
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

describe("Stage 3B provider egress/keychain/historySlim, CC-Switch modal, and 10100 snippet fallback", () => {
  test("ProviderEgressAndKeychainSection renders antigravity TLS + proxy + keychain controls and canonical OpenAI historySlim", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/api/providers") && method === "GET") {
        return new Response(JSON.stringify([
          {
            name: "alpha",
            hasProxy: true,
            proxyLabel: "http://***@127.0.0.1:8888",
            noProxy: "localhost,.internal",
          },
          {
            name: "google-antigravity",
            hasProxy: false,
            tlsProfile: { profile: "antigravity-browser", status: "disabled" },
          },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/providers/keychain?name=alpha")) {
        return new Response(JSON.stringify({ name: "alpha", store: "plaintext", keychainAvailable: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/providers/keychain") && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/providers/egress") && method === "PUT") {
        return new Response(JSON.stringify({
          success: true,
          hasProxy: true,
          proxyLabel: "http://127.0.0.1:7890",
          noProxy: body?.noProxy ?? "127.0.0.1",
          ...(body?.tlsProfile ? { tlsProfile: { profile: "antigravity-browser", status: "pending" } } : {}),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/settings") && method === "GET") {
        return new Response(JSON.stringify({ upstreamHistorySlim: "off" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/settings") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true, upstreamHistorySlim: body?.upstreamHistorySlim ?? "off" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);

    // 1. Key-auth provider: proxy + noProxy + keychain Store, NO tlsProfile or historySlim.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={false}
            item={{
              name: "alpha",
              adapter: "openai-chat",
              baseUrl: "https://api.example.test/v1",
              authMode: "key",
              hasApiKey: true,
            }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(host.textContent).toContain("http://***@127.0.0.1:8888");
    expect(host.textContent).toContain("Move to Keychain");
    expect(host.textContent).not.toContain("Antigravity Browser TLS Profile");
    expect(host.textContent).not.toContain("Upstream History Slimming");

    const storeBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Move to Keychain"))!;
    await act(async () => { storeBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/providers/keychain") && c.method === "POST" && c.body?.action === "store")).toBe(true);

    // 2. google-antigravity: shows Antigravity Browser TLS Profile checkbox.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={false}
            item={{
              name: "google-antigravity",
              adapter: "google",
              baseUrl: "https://cloudcode-pa.googleapis.com",
              authMode: "oauth",
              googleMode: "cloud-code-assist",
            }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(host.textContent).toContain("Antigravity Browser TLS Profile");
    const tlsCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { tlsCheckbox.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.includes("/api/providers/egress?name=google-antigravity") && c.body?.tlsProfile === "antigravity-browser")).toBe(true);

    // 3. Canonical OpenAI: renders Upstream History Slimming control and sends PUT /api/settings.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={true}
            item={{
              name: "openai",
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              authMode: "forward",
            }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(host.textContent).toContain("Upstream History Slimming");
    const selectTrigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    await act(async () => { selectTrigger.click(); });
    await flushTicks();
    const codexOpt = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes("Codex slimming")) as HTMLElement | undefined;
    expect(codexOpt).toBeDefined();
    await act(async () => { codexOpt!.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/settings") && c.method === "PUT" && c.body?.upstreamHistorySlim === "codex")).toBe(true);
  });

  test("CcSwitchImportModal enforces explicit consent before applying and supports restore", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let journalActive = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/api/providers/cc-switch/preview")) {
        return new Response(JSON.stringify({
          available: true,
          keychainAvailable: true,
          defaultSources: [{ path: "/tmp/.cc-switch/providers.json", kind: "json" }],
          journalActive,
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
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/providers/cc-switch/apply")) {
        journalActive = true;
        return new Response(JSON.stringify({
          imported: 1,
          importedWithApiKeys: body?.includeApiKeys === false ? 0 : 1,
          storedInKeychain: body?.storeInKeychain === true ? 1 : 0,
          journalActive: true,
          providers: [{ name: "imported-claude", hasApiKey: true }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/providers/cc-switch/restore")) {
        journalActive = false;
        return new Response(JSON.stringify({ restored: 1, journalActive: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    let changedCount = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <CcSwitchImportModal apiBase="http://127.0.0.1:10100" onClose={() => undefined} onChanged={() => { changedCount += 1; }} />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    expect(host.textContent).toContain("imported-claude");
    expect(host.textContent).toContain("Key detected");
    const applyBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Import Selected (1)"))!;
    expect(applyBtn.disabled).toBe(true);

    // Enable Store in OS Keychain + explicit consent checkbox -> Apply sends includeApiKeys & storeInKeychain.
    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    // [0]=allowPrivateNetwork, [1]=row checkbox, [2]=includeApiKeys (default true), [3]=storeInKeychain, [4]=consent
    expect(checkboxes).toHaveLength(5);
    expect(checkboxes[2]!.checked).toBe(true);
    const keychainBox = checkboxes[3]!;
    const consentBox = checkboxes[checkboxes.length - 1]!;
    await act(async () => { keychainBox.click(); consentBox.click(); });
    await flushTicks();
    expect(applyBtn.disabled).toBe(false);

    await act(async () => { applyBtn.click(); });
    await flushTicks();
    const applyCall = calls.find(c => c.url.endsWith("/api/providers/cc-switch/apply"));
    expect(applyCall?.body?.consent).toBe(true);
    expect(applyCall?.body?.includeApiKeys).toBe(true);
    expect(applyCall?.body?.storeInKeychain).toBe(true);
    expect(applyCall?.body?.selectedProviders).toEqual(["imported-claude"]);
    expect(changedCount).toBe(1);

    // Journal became active -> Undo Last Import button appears and calls restore.
    const restoreBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Undo Last Import"))!;
    await act(async () => { restoreBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/providers/cc-switch/restore"))).toBe(true);
    expect(changedCount).toBe(2);

    // Verify sourcePath input edit also sends on Preview click.
    const pathInput = host.querySelector<HTMLInputElement>('input.input')!;
    await act(async () => { setInputValue(pathInput, "/tmp/custom.db"); });
    const previewBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Preview")!;
    await act(async () => { previewBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/providers/cc-switch/preview") && c.body?.sourcePath === "/tmp/custom.db")).toBe(true);
  });

  test("Stage 3C default fallback port is 10100 across Home quickstart, log-export curl, and playground-client", async () => {
    const sampleRecord: LogExportRecord = {
      id: "log-1",
      timestamp: Date.now(),
      method: "POST",
      path: "/v1/responses",
      inboundProtocol: "openai-responses",
      status: 200,
      model: "gpt-5",
      provider: "openai",
      requestBody: { model: "gpt-5", input: "hello" },
    };
    expect(buildLogReplayCurl(sampleRecord, "")).toContain("http://127.0.0.1:10100/v1/responses");
    expect(buildPlaygroundCurl("", "/v1/responses", { model: "gpt-5" })).toContain("http://127.0.0.1:10100/v1/responses");

    // When Home renders without endpointUrl, quickstart snippet defaults to 127.0.0.1:10100.
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Home
            apiBase="http://127.0.0.1:10100"
            endpointUrl=""
            navigate={() => undefined}
            onReloadCodex={() => undefined}
            reloadingCodex={false}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const quickstartBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Quickstart"))!;
    expect(quickstartBtn).toBeDefined();
    await act(async () => { quickstartBtn.click(); });
    await flushTicks();
    expect(host.textContent).toContain("http://127.0.0.1:10100/v1");
    expect(host.textContent).not.toContain("8787");
  });
});
