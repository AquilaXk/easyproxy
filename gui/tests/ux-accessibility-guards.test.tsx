import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Integrations from "../src/pages/Integrations";
import Startup from "../src/pages/Startup";
import Logs from "../src/pages/Logs";
import RequestPlaygroundModal from "../src/components/RequestPlaygroundModal";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let originalFetch: typeof globalThis.fetch;

function installLayoutStubs(targetWindow: Window): void {
  const proto = targetWindow.HTMLElement.prototype as unknown as HTMLElement;
  for (const [prop, val] of [["clientHeight", 800], ["clientWidth", 1200], ["offsetHeight", 800], ["offsetWidth", 1200], ["scrollHeight", 800]] as const) {
    Object.defineProperty(proto, prop, { configurable: true, get() { return val; } });
  }
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() { return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } }; },
  });
  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb([{ target, contentRect: { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } }, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(targetWindow, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  originalFetch = globalThis.fetch;
  saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  win = new Window({ url: "http://localhost/#logs" });
  win.localStorage.setItem("epx-lang", "en");
  for (const k of GLOBALS.filter(key => key !== "ResizeObserver")) {
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: k === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, k),
    });
  }
  installLayoutStubs(win);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  win.close();
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]!);
    else Reflect.deleteProperty(globalThis, k);
  }
});

test("Integrations syncMachine surfaces non-OK errors in a dismissible error Notice", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    if (path === "/api/machine/clients") return Response.json({ selectedClients: ["opencode"] });
    if (path === "/api/machine/sync" && init?.method === "POST") {
      return Response.json({ error: "sync offline" }, { status: 502 });
    }
    return Response.json({ clients: [], journals: [], keys: [], accounts: [], models: [] });
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  await act(async () => {
    root!.render(<LanguageProvider><Integrations apiBase="http://shared.invalid" machineApiBase="http://machine.invalid" connected /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 25));
  });

  const syncBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Sync now"))!;
  expect(syncBtn).toBeDefined();
  await act(async () => { syncBtn.click(); await new Promise(resolve => setTimeout(resolve, 20)); });

  const notice = host.querySelector<HTMLElement>(".notice-err")!;
  expect(notice).not.toBeNull();
  expect(notice.textContent).toContain("sync offline");

  const dismiss = notice.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { dismiss.click(); });
  expect(host.querySelector(".notice-err")).toBeNull();
});

test("Startup runMachineShim surfaces non-OK errors in a dismissible error Notice", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    if (path === "/api/machine/shim" && init?.method === "POST") {
      return Response.json({ error: "shim error" }, { status: 500 });
    }
    if (path === "/api/machine/shim") return Response.json({ installed: true, healthy: false });
    if (path === "/api/startup-health") {
      return Response.json({
        status: "protected", routingKind: "easyproxy-local", diagnosticStale: false,
        serviceInstalled: true, serviceSupported: true, serviceEnabled: true, serviceRunning: true,
        commands: { installService: "epx service install", repairService: "epx service repair", installShim: "epx shim install", restoreNative: "epx restore" },
      });
    }
    return Response.json({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  await act(async () => {
    root!.render(<LanguageProvider><Startup apiBase="http://shared.invalid" machineApiBase="http://machine.invalid" connected /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 25));
  });

  const repairBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Repair shim"))!;
  expect(repairBtn).toBeDefined();
  await act(async () => { repairBtn.click(); await new Promise(resolve => setTimeout(resolve, 20)); });

  const notices = [...host.querySelectorAll<HTMLElement>(".notice-err")];
  const shimNotice = notices.find(n => n.textContent?.includes("shim error"))!;
  expect(shimNotice).toBeDefined();
  await act(async () => { shimNotice.querySelector<HTMLButtonElement>("button")!.click(); });
  expect([...host.querySelectorAll(".notice-err")].some(n => n.textContent?.includes("shim error"))).toBe(false);
});

test("Logs table sets min height clamp and opens detail modal on Enter / Space on tr", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    if (path === "/api/logs") {
      return Response.json({
        logs: [{
          requestId: "req-kbd-1", timestamp: 1_700_000_000_000, model: "gpt-test", provider: "openai", status: 200,
          durationMs: 35, usageStatus: "reported", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          displayMetrics: { tokPerSecond: { kind: "unavailable", reason: "invalid_duration" }, cost: { kind: "unavailable", reason: "price_unmatched" } },
        }],
      });
    }
    return Response.json({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  await act(async () => {
    root!.render(<LanguageProvider><Logs apiBase="http://logs-kbd.invalid" active /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 35));
  });

  const wrap = host.querySelector<HTMLElement>(".logs-table-wrap")!;
  expect(wrap.className).toContain("min-h-[180px]");
  expect(wrap.className).toContain("max-h-[max(180px,calc(100dvh-300px))]");

  const row = host.querySelector<HTMLTableRowElement>("table.logs-table tbody tr[data-index]")!;
  expect(row.tabIndex).toBe(0);
  await act(async () => {
    row.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(host.querySelector("dialog")?.textContent).toContain("req-kbd-1");
});

test("RequestPlaygroundModal assigns descriptive turn aria-labels and stable turn keys on delete", async () => {
  globalThis.fetch = (async () => Response.json({ models: [] })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <RequestPlaygroundModal
          apiBase="http://pg.invalid"
          initialSeed={{ turns: [{ role: "user", content: "Turn A" }, { role: "assistant", content: "Turn B" }] }}
          onClose={() => {}}
        />
      </LanguageProvider>,
    );
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  const turnTextareas = host.querySelectorAll<HTMLTextAreaElement>("textarea.playground-turn-textarea");
  expect(turnTextareas).toHaveLength(2);
  expect(turnTextareas[0]!.getAttribute("aria-label")).toContain("#1");
  expect(turnTextareas[1]!.getAttribute("aria-label")).toContain("#2");

  const secondTextarea = turnTextareas[1]!;
  const removeButtons = [...host.querySelectorAll<HTMLButtonElement>(".playground-turn-head button")].filter((_, i) => i % 2 === 1);
  await act(async () => { removeButtons[0]!.click(); });

  const remaining = host.querySelectorAll<HTMLTextAreaElement>("textarea.playground-turn-textarea");
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toBe(secondTextarea);
  expect(remaining[0]!.value).toBe("Turn B");
});
