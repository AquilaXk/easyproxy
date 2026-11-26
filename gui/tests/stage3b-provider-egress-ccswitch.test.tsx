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
    const modalDialog = host.querySelector<HTMLDialogElement>("dialog.modal-overlay");
    expect(modalDialog).not.toBeNull();
    expect(modalDialog!.hasAttribute("open")).toBe(true);
    expect(modalDialog!.getAttribute("aria-labelledby")).toBe("cc-switch-modal-title");
    expect(modalDialog!.querySelector(".modal-backdrop-dismiss")).not.toBeNull();
    const modalCard = modalDialog!.querySelector<HTMLElement>(".modal-card");
    expect(modalCard).not.toBeNull();
    expect(modalCard!.style.maxWidth).toBe("760px");
    expect(modalCard!.classList.contains("flex")).toBe(true);
    expect(modalCard!.classList.contains("flex-col")).toBe(true);
    expect(modalCard!.classList.contains("overflow-hidden")).toBe(true);
    const modalHead = modalCard!.querySelector<HTMLElement>(".modal-head");
    const modalActions = modalCard!.querySelector<HTMLElement>(".modal-actions");
    const scrollBody = modalCard!.querySelector<HTMLElement>(".overflow-y-auto.flex-1");
    expect(modalHead).not.toBeNull();
    expect(modalHead!.classList.contains("shrink-0")).toBe(true);
    expect(modalActions).not.toBeNull();
    expect(modalActions!.classList.contains("shrink-0")).toBe(true);
    expect(scrollBody).not.toBeNull();
    expect(modalCard!.querySelector("table.tbl")).not.toBeNull();
    expect(modalCard!.querySelector("table.tbl thead th.sticky")).not.toBeNull();
    expect(modalCard!.querySelector("table.tbl td.break-all")?.textContent).toBe("https://relay.example.com/v1");
    expect(host.querySelector(".modal-backdrop")).toBeNull();
    expect(host.querySelector(".modal-body")).toBeNull();
    expect(host.querySelector(".modal-foot")).toBeNull();
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
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Imported 1 provider(s) (1 with API key).");

    // Journal became active -> Undo Last Import button appears and calls restore.
    const restoreBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Undo Last Import"))!;
    await act(async () => { restoreBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/providers/cc-switch/restore"))).toBe(true);
    expect(changedCount).toBe(2);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Rolled back import (1 change(s)).");

    // Verify sourcePath input edit also sends on Preview click.
    const pathInput = host.querySelector<HTMLInputElement>('input.input')!;
    await act(async () => { setInputValue(pathInput, "/tmp/custom.db"); });
    const previewBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Preview")!;
    await act(async () => { previewBtn.click(); });
    await flushTicks();
    expect(calls.some(c => c.url.endsWith("/api/providers/cc-switch/preview") && c.body?.sourcePath === "/tmp/custom.db")).toBe(true);
  });

  test("CcSwitchImportModal closes on backdrop click and Escape when idle, and blocks dismiss while applying", async () => {
    let resolveApply!: (value: Response) => void;
    const applyPending = new Promise<Response>(resolve => { resolveApply = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/providers/cc-switch/preview")) {
        return new Response(JSON.stringify({
          available: true,
          keychainAvailable: false,
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
            hasApiKey: false,
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/providers/cc-switch/apply")) {
        return applyPending;
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    let closeCount = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <CcSwitchImportModal apiBase="http://127.0.0.1:10100" onClose={() => { closeCount += 1; }} onChanged={() => undefined} />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const dialog = host.querySelector<HTMLDialogElement>("dialog.modal-overlay")!;
    const backdropBtn = dialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
    expect(dialog).not.toBeNull();
    expect(backdropBtn).not.toBeNull();

    // Idle state: backdrop click, pointer-outside click (single invocation), & Escape dismiss the modal;
    // drag starting inside .modal-card and releasing on backdrop must NOT dismiss.
    await act(async () => { backdropBtn.click(); });
    expect(closeCount).toBe(1);

    const card = dialog.querySelector<HTMLElement>(".modal-card")!;
    Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 260, top: 64, right: 1020, bottom: 700, width: 760, height: 636, x: 260, y: 64, toJSON() { return this; } }),
    });
    await act(async () => {
      backdropBtn.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }));
      backdropBtn.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, clientX: 20, clientY: 20 }));
      backdropBtn.click();
    });
    expect(closeCount).toBe(2);

    await act(async () => {
      card.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 200 }));
      backdropBtn.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, clientX: 20, clientY: 20 }));
      backdropBtn.click();
    });
    expect(closeCount).toBe(2);

    await act(async () => {
      dialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(closeCount).toBe(3);

    // Start apply (in flight): backdrop, Escape, and Close buttons must stay blocked.
    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const consentBox = checkboxes[checkboxes.length - 1]!;
    await act(async () => { consentBox.click(); });
    await flushTicks();
    const applyBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Import Selected (1)"))!;
    await act(async () => { applyBtn.click(); });

    expect(backdropBtn.disabled).toBe(true);
    await act(async () => { backdropBtn.click(); });
    await act(async () => {
      dialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(closeCount).toBe(3);

    resolveApply(new Response(JSON.stringify({
      imported: 1,
      importedWithApiKeys: 0,
      journalActive: true,
      providers: [{ name: "imported-claude", hasApiKey: false }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await flushTicks();

    expect(backdropBtn.disabled).toBe(false);
    await act(async () => { backdropBtn.click(); });
    expect(closeCount).toBe(4);
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

  test("ProviderEgressAndKeychainSection resets local state across providers and rolls back tlsEnabled on save failure", async () => {
    let failPut = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/providers") && method === "GET") {
        return Response.json([
          { name: "alpha", hasProxy: true, proxyLabel: "http://127.0.0.1:8888", noProxy: "localhost" },
          { name: "beta", hasProxy: false, noProxy: "" },
          { name: "google-antigravity", hasProxy: false, tlsProfile: { profile: "antigravity-browser", status: "disabled" } },
        ]);
      }
      if (url.includes("/api/providers/keychain")) {
        return Response.json({ name: "alpha", store: "plaintext", keychainAvailable: true });
      }
      if (url.includes("/api/providers/egress") && method === "PUT") {
        if (failPut) return Response.json({ error: "egress rejected" }, { status: 400 });
        return Response.json({ success: true, hasProxy: false, tlsProfile: { profile: "antigravity-browser", status: "pending" } });
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
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={false}
            item={{ name: "alpha", adapter: "openai-chat", baseUrl: "https://api.example.test/v1", authMode: "key", hasApiKey: true, hasProxy: true, proxyLabel: "http://127.0.0.1:8888", noProxy: "localhost" }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    const proxyInput = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    const noProxyInput = host.querySelectorAll<HTMLInputElement>('input.input')[1]!;
    await act(async () => {
      setInputValue(proxyInput, "http://127.0.0.1:9999");
      setInputValue(noProxyInput, "localhost, .corp.internal");
    });
    expect(proxyInput.value).toBe("http://127.0.0.1:9999");
    expect(noProxyInput.value).toBe("localhost, .corp.internal");

    // Re-rendering the same provider with fresh object references must not overwrite unsaved drafts.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={false}
            item={{ name: "alpha", adapter: "openai-chat", baseUrl: "https://api.example.test/v1", authMode: "key", hasApiKey: true, hasProxy: true, proxyLabel: "http://127.0.0.1:8888", noProxy: ["localhost"] }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(noProxyInput.value).toBe("localhost, .corp.internal");

    // Switching to another provider must clear stale draft proxy/noProxy state even without unmounting.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={false}
            item={{ name: "beta", adapter: "openai-chat", baseUrl: "https://api.beta.test/v1", authMode: "key", hasApiKey: true, hasProxy: false }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(host.textContent).not.toContain("http://127.0.0.1:8888");

    // Switch to google-antigravity and fail PUT /api/providers/egress -> tlsEnabled checkbox rolls back cleanly.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            isCanonicalOpenAi={false}
            item={{ name: "google-antigravity", adapter: "google", baseUrl: "https://cloudcode-pa.googleapis.com", authMode: "oauth", googleMode: "cloud-code-assist" }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    failPut = true;
    const tlsBox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(tlsBox.checked).toBe(false);
    await act(async () => { tlsBox.click(); });
    await flushTicks();
    expect(tlsBox.checked).toBe(false);
    expect(host.textContent).toContain("egress rejected");
  });

  test("CcSwitchImportModal invalidates preview/consent when sourcePath or allowPrivateNetwork changes and keeps selection on locale change", async () => {
    let previewCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/providers/cc-switch/preview")) {
        previewCalls += 1;
        return Response.json({
          available: true,
          keychainAvailable: false,
          defaultSources: [{ path: "/tmp/.cc-switch/providers.json", kind: "json" }],
          journalActive: false,
          discovered: 2,
          eligible: 2,
          conflicts: 0,
          conflictNames: [],
          invalid: 0,
          invalidReasons: {},
          providers: [
            { name: "p-one", sourceId: "1", appType: "claude", adapter: "anthropic", baseUrl: "https://a.example.com/v1" },
            { name: "p-two", sourceId: "2", appType: "openai", adapter: "openai-chat", baseUrl: "https://b.example.com/v1" },
          ],
        });
      }
      return Response.json({});
    }) as typeof fetch;

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
          <CcSwitchImportModal apiBase="http://127.0.0.1:10100" onClose={() => undefined} onChanged={() => undefined} />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(previewCalls).toBe(1);

    // Uncheck p-two and check consent, then switch locale: preview MUST NOT re-run and selection stays intact.
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => {
      boxes[2]!.click(); // p-two row checkbox
      boxes[boxes.length - 1]!.click(); // consent checkbox
    });
    expect(boxes[boxes.length - 1]!.checked).toBe(true);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-test="switch-locale-ko"]')!.click();
    });
    await flushTicks();
    expect(previewCalls).toBe(1);
    const koBoxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(koBoxes[1]!.checked).toBe(true);
    expect(koBoxes[2]!.checked).toBe(false);
    expect(koBoxes[koBoxes.length - 1]!.checked).toBe(true);

    // Editing sourcePath clears preview & consent so stale approval cannot apply to another source.
    const sourceInput = host.querySelector<HTMLInputElement>('input.input')!;
    await act(async () => { setInputValue(sourceInput, "/tmp/other.json"); });
    expect(host.querySelector("table.tbl")).toBeNull();
    expect([...host.querySelectorAll("button")].find(b => b.disabled && b.classList.contains("btn-primary"))).toBeDefined();

    // Re-preview, check consent again, then toggle allowPrivateNetwork -> preview & consent clear again.
    const previewBtn = [...host.querySelectorAll("button")].find(b => b.className === "btn")!;
    await act(async () => { previewBtn.click(); });
    await flushTicks();
    expect(previewCalls).toBe(2);
    const afterBoxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => { afterBoxes[afterBoxes.length - 1]!.click(); });
    expect(afterBoxes[afterBoxes.length - 1]!.checked).toBe(true);
    await act(async () => { afterBoxes[0]!.click(); }); // toggle allowPrivateNetwork
    expect(host.querySelector("table.tbl")).toBeNull();
  });

  test("ProviderEgressAndKeychainSection drops stale keychain store response after provider switch", async () => {
    let releaseKeychainPost!: (res: Response) => void;
    let refreshCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/providers")) {
        return Response.json([
          { name: "alpha", hasProxy: false },
          { name: "beta", hasProxy: false },
        ]);
      }
      if (url.includes("/api/providers/keychain?name=alpha")) {
        return Response.json({ name: "alpha", store: "plaintext", keychainAvailable: true });
      }
      if (url.includes("/api/providers/keychain?name=beta")) {
        return Response.json({ name: "beta", store: "keychain", keychainAvailable: true });
      }
      if (url.endsWith("/api/providers/keychain") && method === "POST") {
        return await new Promise<Response>(resolve => {
          releaseKeychainPost = resolve;
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
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            item={{ name: "alpha", authMode: "key", adapter: "openai" } as never}
            isCanonicalOpenAi={false}
            onRefreshConfig={() => { refreshCalls += 1; }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const storeBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Keychain"))!;
    await act(async () => { storeBtn.click(); });
    expect(typeof releaseKeychainPost).toBe("function");

    // Switch provider while POST is still in flight.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            item={{ name: "beta", authMode: "key", adapter: "openai" } as never}
            isCanonicalOpenAi={false}
            onRefreshConfig={() => { refreshCalls += 1; }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    await act(async () => {
      releaseKeychainPost(Response.json({ ok: true }));
    });
    await flushTicks();

    expect(refreshCalls).toBe(0);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain("Credentials moved to OS Keychain");
  });

  test("CcSwitchImportModal triggers preview when pressing Enter in sourcePath input", async () => {
    let previewCalls = 0;
    let lastPreviewPath = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/providers/cc-switch/preview") && init?.method === "POST") {
        previewCalls += 1;
        lastPreviewPath = String((JSON.parse(String(init.body ?? "{}")) as { sourcePath?: string }).sourcePath ?? "");
        return Response.json({
          sourcePath: lastPreviewPath || "/tmp/cc.json",
          allowPrivateNetwork: false,
          providers: [],
          totalFound: 0,
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
          <CcSwitchImportModal apiBase="http://127.0.0.1:10100" onClose={() => undefined} onChanged={() => undefined} />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(previewCalls).toBe(1);

    const sourceInput = host.querySelector<HTMLInputElement>("input.input")!;
    await act(async () => {
      setInputValue(sourceInput, "/tmp/enter-preview.json");
    });
    await act(async () => {
      sourceInput.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushTicks();

    expect(previewCalls).toBe(2);
    expect(lastPreviewPath).toBe("/tmp/enter-preview.json");
  });

  test("ProviderEgressAndKeychainSection drops late loadLiveDetails snapshot after provider switch", async () => {
    let releaseAlphaReload!: (res: Response) => void;
    let alphaKeychainGets = 0;
    let refreshCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/providers")) {
        return Response.json([
          { name: "alpha", hasProxy: false },
          { name: "beta", hasProxy: false },
        ]);
      }
      if (url.includes("/api/providers/keychain?name=alpha")) {
        alphaKeychainGets += 1;
        if (alphaKeychainGets === 1) {
          return Response.json({ name: "alpha", store: "plaintext", keychainAvailable: true });
        }
        return await new Promise<Response>(resolve => {
          releaseAlphaReload = resolve;
        });
      }
      if (url.includes("/api/providers/keychain?name=beta")) {
        return Response.json({ name: "beta", store: "keychain", keychainAvailable: true });
      }
      if (url.endsWith("/api/providers/keychain") && method === "POST") {
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
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            item={{ name: "alpha", authMode: "key", adapter: "openai" } as never}
            isCanonicalOpenAi={false}
            onRefreshConfig={() => { refreshCalls += 1; }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();

    const storeBtn = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Keychain"))!;
    await act(async () => { storeBtn.click(); });
    await flushTicks();
    expect(typeof releaseAlphaReload).toBe("function");

    // Switch to beta while alpha's post-save loadLiveDetails is still pending.
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ProviderEgressAndKeychainSection
            apiBase="http://127.0.0.1:10100"
            item={{ name: "beta", authMode: "key", adapter: "openai" } as never}
            isCanonicalOpenAi={false}
            onRefreshConfig={() => { refreshCalls += 1; }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(host.textContent).toContain("OS Keychain");

    await act(async () => {
      releaseAlphaReload(Response.json({ name: "alpha", store: "plaintext", keychainAvailable: true }));
    });
    await flushTicks();

    expect(refreshCalls).toBe(0);
    expect(host.textContent).toContain("OS Keychain");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  test("ProviderEgressAndKeychainSection decouples TLS/Clear actions from drafts, protects dirty edits from mount snapshot, and localizes badges", async () => {
    const putBodies: Array<Record<string, unknown>> = [];
    let releaseMountSnapshot: ((res: Response) => void) | undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      if (url.endsWith("/api/providers") && method === "GET") {
        return await new Promise<Response>(resolve => {
          releaseMountSnapshot = resolve;
        });
      }
      if (url.includes("/api/providers/egress") && method === "PUT") {
        putBodies.push(body ?? {});
        if (Object.hasOwn(body ?? {}, "proxy") && body?.proxy === null) {
          return Response.json({
            success: true,
            hasProxy: false,
            noProxy: "server.kept",
            tlsProfile: { profile: "antigravity-browser", status: "pending" },
          });
        }
        return Response.json({
          success: true,
          hasProxy: true,
          proxyLabel: "http://127.0.0.1:7890",
          noProxy: "server.kept",
          tlsProfile: {
            profile: "antigravity-browser",
            status: body?.tlsProfile ? "active" : "disabled",
          },
        });
      }
      return Response.json({});
    }) as typeof fetch;

    win.localStorage.setItem("epx-lang", "ko");
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);

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
              hasProxy: true,
              proxyLabel: "http://127.0.0.1:7890",
              noProxy: "initial.local",
              tlsProfile: { profile: "antigravity-browser", status: "disabled" },
            }}
          />
        </LanguageProvider>,
      );
    });
    await flushTicks(2);

    // Localized Korean badge for disabled tlsStatus rather than raw "disabled".
    expect(host.textContent).toContain("비활성");
    expect(host.textContent).not.toContain("disabled");

    const inputs = [...host.querySelectorAll<HTMLInputElement>('input.input')];
    const proxyInput = inputs[0]!;
    const noProxyInput = inputs[1]!;

    // Type invalid proxy draft + noProxy edit BEFORE slow mount snapshot arrives.
    await act(async () => {
      setInputValue(proxyInput, "not-a-valid-proxy");
      setInputValue(noProxyInput, "*.edited.corp");
    });

    // Delayed mount snapshot resolves -> must NOT overwrite dirty noProxyInput.
    await act(async () => {
      releaseMountSnapshot!(Response.json([
        {
          name: "google-antigravity",
          hasProxy: true,
          proxyLabel: "http://127.0.0.1:7890",
          noProxy: "server.stale",
          tlsProfile: { profile: "antigravity-browser", status: "disabled" },
        },
      ]));
    });
    await flushTicks();
    expect(noProxyInput.value).toBe("*.edited.corp");

    // Toggle TLS checkbox -> must send ONLY { tlsProfile } and keep drafts intact.
    const tlsCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { tlsCheckbox.click(); });
    await flushTicks();
    expect(putBodies[0]).toEqual({ tlsProfile: "antigravity-browser" });
    expect(proxyInput.value).toBe("not-a-valid-proxy");
    expect(noProxyInput.value).toBe("*.edited.corp");
    expect(host.textContent).toContain("활성");

    // Clear proxy -> must send ONLY { proxy: null }, keep unsaved noProxyInput, and sync reset tlsStatus ("pending").
    const clearBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "프록시 지우기")!;
    await act(async () => { clearBtn.click(); });
    await flushTicks();
    expect(putBodies[1]).toEqual({ proxy: null });
    expect(proxyInput.value).toBe("");
    expect(noProxyInput.value).toBe("*.edited.corp");
    expect(host.textContent).toContain("대기 중");
  });
});
