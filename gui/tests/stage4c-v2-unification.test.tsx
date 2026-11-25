import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import Integrations from "../src/pages/Integrations";
import Logs from "../src/pages/Logs";
import Providers from "../src/pages/Providers";
import { serveGuiFile } from "../../src/server/gui-static";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let savedGlobals: Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let root: Root | undefined;

async function flushTicks(rounds = 5): Promise<void> {
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

describe("Stage 4C /classic/ retirement and .ui-v2 unification", () => {
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

  test("Integrations, Providers, Logs, and Debug render inside .ui-v2 containers", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/config")) {
        return jsonOk({
          providers: [
            {
              name: "openai",
              type: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              enabled: true,
              models: ["gpt-5"],
            },
          ],
          defaultProvider: "openai",
        });
      }
      if (url.includes("/api/providers")) return jsonOk({ providers: [] });
      if (url.includes("/api/oauth/status")) return jsonOk({ providers: [] });
      if (url.includes("/api/oauth/accounts")) return jsonOk({ accounts: {} });
      if (url.includes("/api/provider-quotas")) return jsonOk({ quotas: {} });
      if (url.includes("/api/gateway-clients")) return jsonOk({ clients: [], summary: {} });
      if (url.includes("/api/native-integrations")) return jsonOk({ clients: [], history: [] });
      if (url.includes("/api/integrations")) return jsonOk({ clients: [] });
      if (url.includes("/api/logs")) return jsonOk({ logs: [], total: 0 });
      if (url.includes("/api/debug")) return jsonOk({ lines: [], inbound: [] });
      return jsonOk({});
    }) as typeof globalThis.fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Integrations apiBase="" machineApiBase="" connected />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(container.querySelector("section.integrations-page.ui-v2")).not.toBeNull();

    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Providers apiBase="" targetKey="local" targetLabel="Local" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(container.querySelector(".providers-page.ui-v2")).not.toBeNull();
    expect(container.querySelector(".providers-page.ui-v2 .pws-shell-container")).not.toBeNull();

    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Logs apiBase="" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(container.querySelector(".logs-page.ui-v2")).not.toBeNull();

    await act(async () => {
      root!.render(
        <LanguageProvider>
          <Debug apiBase="" />
        </LanguageProvider>,
      );
    });
    await flushTicks();
    expect(container.querySelector(".debug-v2.ui-v2")).not.toBeNull();
  });

  test("design theme bridge imports unified providers, connect, and logs v2 sheets", () => {
    const themeCss = readFileSync(join(import.meta.dir, "..", "src", "design", "theme.css"), "utf8");
    const providersCss = readFileSync(join(import.meta.dir, "..", "src", "design", "pages", "providers.css"), "utf8");
    const connectCss = readFileSync(join(import.meta.dir, "..", "src", "design", "pages", "connect.css"), "utf8");

    expect(themeCss).toContain('@import "./pages/connect.css" layer(bridge);');
    expect(themeCss).toContain('@import "./pages/logs.css" layer(bridge);');
    expect(themeCss).toContain('@import "./pages/providers.css" layer(bridge);');
    expect(providersCss).toContain(".providers-page.ui-v2");
    expect(providersCss).toContain(".ui-v2 .pws-shell-container");
    expect(connectCss).toContain(".integrations-page.ui-v2");
  });
});
