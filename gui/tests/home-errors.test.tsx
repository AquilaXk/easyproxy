import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Home from "../src/pages/Home";

const names = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;

beforeEach(() => {
  saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("epx-lang", "en");
  for (const name of names.filter(value => value !== "fetch")) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, name) });
  }
  clearClientResourceStoresForTests();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  win.close();
  for (const name of names) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function renderWithLogs(logsResponse: Response): Promise<HTMLElement> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/logs")) return logsResponse.clone();
    if (url.includes("/healthz")) return Response.json({ version: "test", uptime: 1 });
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Home apiBase="http://home-errors-test" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  return host;
}

test("a failed logs read does not claim there were no errors", async () => {
  const host = await renderWithLogs(Response.json({ error: "unavailable" }, { status: 503 }));
  expect(host.textContent).toContain("Recent errors unavailable");
  expect(host.textContent).not.toContain("No failed requests in the last 24 hours.");
  expect(host.textContent).not.toContain("Everything is running");
});

test("a malformed logs response is unknown while a valid empty list is healthy", async () => {
  const host = await renderWithLogs(Response.json({}));
  expect(host.textContent).toContain("Recent errors unavailable");
  await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  const valid = await renderWithLogs(Response.json({ logs: [] }));
  expect(valid.textContent).toContain("No failed requests in the last 24 hours.");
  expect(valid.textContent).toContain("Everything is running");
});

test("Home requests 100 logs, shows Providers stat tile, and shares /api/system/health resource", async () => {
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.includes("/api/logs")) return Response.json({ logs: [] });
    if (url.includes("/api/system/health")) return Response.json({ status: "ok", version: "2.1.0", uptime: 3600 });
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Home apiBase="http://home-compact-test" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(seenUrls.some(u => u.includes("/api/logs?limit=100"))).toBe(true);
  expect(seenUrls.some(u => u.includes("/api/logs?limit=500"))).toBe(false);
  expect(host.textContent).toContain("Providers");
});

test("Home renders Gateway Endpoint Strip, default route pill, unit-split uptime text, and accessible non-disabling copy feedback", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/logs")) return Response.json({ logs: [] });
    if (url.includes("/api/system/health")) return Response.json({ status: "ok", version: "2.1.0", uptime: 7260 });
    if (url.includes("/api/config")) return Response.json({ defaultProvider: "openai", providers: { openai: {} } });
    return Response.json({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Home
          apiBase="http://home-endpoint-test"
          endpointUrl="http://127.0.0.1:19191/v1"
          navigate={() => {}}
          onReloadCodex={() => {}}
          reloadingCodex={false}
        />
      </LanguageProvider>,
    );
    await new Promise(resolve => setTimeout(resolve, 25));
  });

  expect(host.textContent).toContain("http://127.0.0.1:19191/v1");
  expect(host.textContent).toContain("Default: OpenAI");
  expect(host.textContent).toContain("v2.1.0");
  expect(host.textContent).toContain("2h 1m");

  const copyBtn = host.querySelector('button[aria-label="Copy Proxy Endpoint URL"]') as HTMLButtonElement | null;
  expect(copyBtn).not.toBeNull();
  const statusEl = copyBtn!.nextElementSibling as HTMLElement | null;
  expect(statusEl?.getAttribute("role")).toBe("status");
  expect(statusEl?.textContent).toBe("");

  await act(async () => {
    copyBtn!.click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  expect(copied).toBe("http://127.0.0.1:19191/v1");
  expect(copyBtn!.disabled).toBe(false);
  expect(copyBtn!.dataset.copied).toBe("true");
  expect(copyBtn!.getAttribute("aria-pressed")).toBe("true");
  expect(statusEl?.textContent).toBe("Copied");
});

test("Home toggles OpenAI (/v1) vs Anthropic root URL and updates Quickstart SDK snippets", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/logs")) return Response.json({ logs: [] });
    if (url.includes("/api/system/health")) return Response.json({ status: "ok", version: "2.1.0", uptime: 60 });
    return Response.json({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Home
          apiBase="http://home-quickstart-test"
          endpointUrl="http://127.0.0.1:19191/v1"
          navigate={() => {}}
          onReloadCodex={() => {}}
          reloadingCodex={false}
        />
      </LanguageProvider>,
    );
    await new Promise(resolve => setTimeout(resolve, 25));
  });

  const protocolGroup = host.querySelector('[role="group"][aria-label="Endpoint format"]')!;
  const [openAiBtn, anthropicBtn] = [...protocolGroup.querySelectorAll<HTMLButtonElement>("button")];
  expect(openAiBtn?.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("http://127.0.0.1:19191/v1");

  await act(async () => { anthropicBtn!.click(); });
  expect(anthropicBtn?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".endpoint-strip code")?.textContent).toBe("http://127.0.0.1:19191");

  const quickstartBtn = host.querySelector<HTMLButtonElement>('button[aria-expanded][aria-controls]')!;
  expect(quickstartBtn.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { quickstartBtn.click(); });
  expect(quickstartBtn.getAttribute("aria-expanded")).toBe("true");

  const snippetPre = host.querySelector(".endpoint-strip pre");
  expect(snippetPre?.textContent).toContain("http://127.0.0.1:19191/v1/messages");

  const langGroup = host.querySelector('[role="group"][aria-label="SDK language"]')!;
  const [, pythonBtn, tsBtn] = [...langGroup.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () => {
    openAiBtn!.click();
    pythonBtn!.click();
  });
  expect(snippetPre?.textContent).toContain('base_url="http://127.0.0.1:19191/v1"');

  await act(async () => { tsBtn!.click(); });
  expect(snippetPre?.textContent).toContain('baseURL: "http://127.0.0.1:19191/v1"');
});
