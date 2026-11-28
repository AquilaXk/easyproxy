/** @jsxImportSource react */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { barWidth, buildQuotaRows, isQuotaExhausted, isQuotaWarn, maxQuotaUtilisation } from "../src/components/QuotaBars";
import { keyedLintFindings, lintPromptLayer } from "../src/components/codex-set/prompt-lint";
import { useAccountProbe } from "../src/hooks/useAccountProbe";
import { LanguageProvider } from "../src/i18n/provider";
import Integrations from "../src/pages/Integrations";
import Home from "../src/pages/Home";

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    HTMLElement: { configurable: true, value: win.HTMLElement },
  });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  originalFetch = globalThis.fetch;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

test("lintPromptLayer and keyedLintFindings sort spanless findings deterministically without NaN keys", () => {
  const big = ["sk", "1234567890abcdefghij"].join("-") + "\n" + "x".repeat(40_000);
  const findings = lintPromptLayer(big);
  expect(findings.length).toBeGreaterThanOrEqual(2);
  const keyed = keyedLintFindings(findings);
  expect(new Set(keyed.map(entry => entry.key)).size).toBe(keyed.length);

  const duplicateKeyed = keyedLintFindings([
    { level: "warn", rule: "secret", messageKey: "codexSet.lint.secret" },
    { level: "warn", rule: "secret", messageKey: "codexSet.lint.secret" },
  ]);
  expect(new Set(duplicateKeyed.map(entry => entry.key)).size).toBe(2);
});

test("QuotaBars math and row sorting guard NaN/Infinity cleanly", () => {
  expect(maxQuotaUtilisation({
    updatedAt: 1,
    fiveHourPercent: Number.NaN,
    weeklyPercent: 42,
    monthlyPercent: Number.POSITIVE_INFINITY,
  })).toBe(42);
  expect(isQuotaExhausted(Number.NaN)).toBe(false);
  expect(isQuotaWarn(Number.NaN, 80)).toBe(false);
  expect(barWidth(Number.NaN)).toBe(0);
  expect(barWidth(Number.POSITIVE_INFINITY)).toBe(0);

  const t = ((key: string) => key) as Parameters<typeof buildQuotaRows>[2];
  const rows = buildQuotaRows({
    updatedAt: 1,
    customWindows: [{ label: "Alpha", percent: 10 }, { label: "Beta", percent: 20 }],
  }, null, t);
  expect(rows.map(row => row.label)).toEqual(["Alpha", "Beta"]);
});

test("useAccountProbe discards stale target A results after switching apiBase", async () => {
  let releaseTargetA!: (resp: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://a.local/")) {
        return new Promise<Response>(resolve => { releaseTargetA = resolve; });
      }
      return Response.json({ results: [] });
    },
  });

  const latest: Array<{ probeOne: (id: string) => Promise<void>; entries: Record<string, unknown>; busy: boolean }> = [];
  function ProbeHarness({ apiBase }: { apiBase: string }) {
    const ctrl = useAccountProbe(apiBase, "google-antigravity");
    latest.push({ probeOne: ctrl.probeOne, entries: ctrl.entries, busy: ctrl.busy });
    return <div data-busy={String(ctrl.busy)} data-count={Object.keys(ctrl.entries).length} />;
  }

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<ProbeHarness apiBase="http://a.local" />);
  });
  let pendingProbe!: Promise<void>;
  await act(async () => {
    pendingProbe = latest.at(-1)!.probeOne("acct-1");
  });
  expect((host.firstElementChild as HTMLElement).getAttribute("data-busy")).toBe("true");

  await act(async () => {
    root!.render(<ProbeHarness apiBase="http://b.local" />);
  });
  expect((host.firstElementChild as HTMLElement).getAttribute("data-busy")).toBe("false");
  expect((host.firstElementChild as HTMLElement).getAttribute("data-count")).toBe("0");

  await act(async () => {
    releaseTargetA(Response.json({
      results: [{ accountId: "acct-1", status: "ok", httpStatus: 200, reason: null, message: null }],
    }));
    await pendingProbe;
  });
  expect((host.firstElementChild as HTMLElement).getAttribute("data-count")).toBe("0");
});

test("Home assigns unique React keys when duplicate timestamp+model+status failures occur", async () => {
  const duplicateRows = [
    { timestamp: "2026-11-28T00:00:00Z", status: 429, model: "gpt-5", provider: "codex" },
    { timestamp: "2026-11-28T00:00:00Z", status: 429, model: "gpt-5", provider: "codex" },
  ];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/logs") return Response.json({ entries: duplicateRows });
      if (url.pathname === "/api/system/health") return Response.json({ status: "ok", version: "1.0.0" });
      if (url.pathname === "/api/providers") return Response.json([]);
      if (url.pathname === "/api/settings") return Response.json({});
      if (url.pathname === "/api/telemetry/profile") return Response.json({ connected: false });
      return Response.json({});
    },
  });

  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(host);
      root.render(
        <LanguageProvider>
          <Home apiBase="" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} />
        </LanguageProvider>,
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });
    expect(errors.join("\n")).not.toContain("same key");
  } finally {
    errSpy.mockRestore();
  }
});

test("Integrations isolates panel state across apiBase switches", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({ selectedClients: [], grok: false, clients: [] }),
  });

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Integrations apiBase="http://a.local" machineApiBase="http://a.local" connected />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const firstPanel = host.querySelector('[role="tabpanel"]');
  expect(firstPanel).not.toBeNull();

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Integrations apiBase="http://b.local" machineApiBase="http://b.local" connected />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const secondPanel = host.querySelector('[role="tabpanel"]');
  expect(secondPanel).not.toBeNull();
  // Re-keyed tabpanel unmounts target A's DOM node and creates a fresh node for target B.
  expect(secondPanel).not.toBe(firstPanel);
});
