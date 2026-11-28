/** @jsxImportSource react */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexAccountPool from "../src/components/CodexAccountPool";
import { redeemResetCredit } from "../src/components/codex-account-pool-handlers";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { useAnthropicResetGrants } from "../src/hooks/useAnthropicResetGrants";
import { LanguageProvider } from "../src/i18n/provider";
import ApiKeys from "../src/pages/ApiKeys";
import type { TFn } from "../src/i18n";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const t: TFn = ((key: string, vars?: Record<string, string | number>) => {
  if (!vars) return key;
  return `${key}:${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}`;
}) as TFn;

const poolAccount: CodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  isMain: false,
  paused: false,
  priority: 0,
  autoSwitchThresholdOverride: null,
  hasCredential: true,
  quota: { resetCredits: 3, updatedAt: 1 },
  quotaAutoRefresh: {
    fiveHourAvailable: false,
    weeklyAvailable: false,
    fiveHourEnabled: false,
    weeklyEnabled: false,
  },
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [
      {
        id: "main",
        email: "main@example.test",
        isMain: true,
        paused: false,
        priority: 0,
        hasCredential: true,
        quota: null,
        quotaAutoRefresh: {
          fiveHourAvailable: false,
          weeklyAvailable: false,
          fiveHourEnabled: false,
          weeklyEnabled: false,
        },
      },
      poolAccount,
    ],
    activeId: null,
    loadState: "ready",
    switchingId: null,
    pauseUpdatingId: null,
    priorityUpdatingId: null,
    autoSwitchUpdatingId: null,
    creditsAfterLimitUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    activePinnedId: null,
    refreshing: false,
    refreshFailed: false,
    initialLoading: false,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    setAccountPriority: async () => ({ ok: true }),
    setAccountAutoSwitchThreshold: async () => ({ ok: true }),
    setAccountCreditsAfterLimit: async () => ({ ok: true }),
    setAllCreditsAfterLimit: async () => ({ ok: true }),
    pauseExhaustedAccounts: async () => ({ ok: true, pausedCount: 0 }),
    saveAlias: async () => ({ ok: true }),
    removeAccount: async () => ({ ok: false, reason: "request" }),
    syncAfterAccountAdded: async () => ({ ok: true }),
    pauseRefresh: () => ({ __brand: "codex-pool-pause" }) as never,
    resumeRefresh: () => {},
    subscribeLoadObserver: () => () => {},
    readLastThreshold: () => undefined,
    readLastActive: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
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
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

test("redeemResetCredit attaches operationId, marks 5xx/network uncertain, and honors shouldLoad", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let mode: "ok" | "503" = "503";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (mode === "503") return Response.json({ error: "busy" }, { status: 503 });
      return Response.json({ code: "reset", remaining: 2 });
    },
  });

  let loads = 0;
  const failed = await redeemResetCredit("", "pool-1", t, async () => {
    loads += 1;
    return true;
  }, { operationId: "11111111-1111-4111-8111-111111111111", shouldLoad: () => false });
  expect(failed.ok).toBe(false);
  expect(failed.uncertain).toBe(true);
  expect(bodies[0]?.operationId).toBe("11111111-1111-4111-8111-111111111111");

  mode = "ok";
  const stale = await redeemResetCredit("", "pool-1", t, async () => {
    loads += 1;
    return true;
  }, { shouldLoad: () => false });
  expect(stale.ok).toBe(true);
  expect(loads).toBe(0);
  expect(typeof bodies[1]?.operationId).toBe("string");
  expect(String(bodies[1]?.operationId).length).toBeGreaterThan(20);
});

test("reset modal locks Use 1 Credit while loading, locks Cancel while redeeming, and reuses operationId across 5xx retry", async () => {
  let releaseCredits!: (resp: Response) => void;
  let releaseConsume!: (resp: Response) => void;
  const postedOpIds: string[] = [];
  let consumeCalls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits") {
        return new Promise<Response>(resolve => { releaseCredits = resolve; });
      }
      if (url.pathname === "/api/codex-auth/reset-credits/consume") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { operationId?: string };
        if (body.operationId) postedOpIds.push(body.operationId);
        consumeCalls += 1;
        if (consumeCalls === 1) return Response.json({ error: "transient" }, { status: 502 });
        return new Promise<Response>(resolve => { releaseConsume = resolve; });
      }
      if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      if (url.pathname === "/api/settings") return Response.json({ codexQuotaAutoRefresh: {} });
      return Response.json({});
    },
  });

  const controller = makeController();
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="http://target-a.local" targetKey="target-a" controller={controller} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  const openBtn = host.querySelector('button[aria-label="3 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { openBtn.click(); });

  const useOneBtnLoading = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(b => b.textContent?.includes("Use 1 Credit"));
  expect(useOneBtnLoading?.disabled).toBe(true);

  await act(async () => {
    releaseCredits(Response.json({ credits: [] }));
    await new Promise(r => setTimeout(r, 20));
  });
  const useOneBtn = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(b => b.textContent?.includes("Use 1 Credit"))!;
  expect(useOneBtn.disabled).toBe(false);

  await act(async () => { useOneBtn.click(); });
  // First consume returns 502 uncertain; modal remains on confirm screen so retry keeps the same operationId.
  const confirmBtn = [...host.querySelectorAll<HTMLButtonElement>(".modal-actions button.btn-primary")][0]!;
  await act(async () => { confirmBtn.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(postedOpIds).toHaveLength(1);

  // Retry while second POST is held in flight: Cancel and backdrop must be disabled, and same operationId reused.
  const confirmBtn2 = [...host.querySelectorAll<HTMLButtonElement>(".modal-actions button.btn-primary")][0]!;
  await act(async () => { confirmBtn2.click(); });
  const cancelBtn = [...host.querySelectorAll<HTMLButtonElement>(".modal-actions button.btn-ghost")][0]!;
  const backdropBtn = host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  expect(cancelBtn.disabled).toBe(true);
  expect(backdropBtn.disabled).toBe(true);
  expect(postedOpIds).toHaveLength(2);
  expect(postedOpIds[1]).toBe(postedOpIds[0]);

  // Switch target while target-a's redeem POST is in flight; stale settlement must not load or toast on target-b.
  let loadCount = 0;
  const controllerB = makeController({ load: async () => { loadCount += 1; return true; } });
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="http://target-b.local" targetKey="target-b" controller={controllerB} />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    releaseConsume(Response.json({ code: "reset", remaining: 2 }));
    await new Promise(r => setTimeout(r, 20));
  });
  expect(loadCount).toBe(0);
  expect(host.textContent).not.toContain("2 left");
});

test("useAnthropicResetGrants ignores stale refresh settled after apiBase switch", async () => {
  let releaseTargetA!: (resp: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://a.local/")) {
        return new Promise<Response>(resolve => { releaseTargetA = resolve; });
      }
      return Response.json({
        eligible: true,
        ineligibleReason: null,
        journalAvailable: true,
        unresolved: null,
        grants: [],
      });
    },
  });

  const captured: Array<{ apiBase: string; refresh: (id: string) => Promise<void>; entries: Record<string, unknown> }> = [];
  function Harness({ apiBase }: { apiBase: string }) {
    const ctrl = useAnthropicResetGrants({ apiBase, accountIds: ["acct-1"], enabled: true });
    captured.push({ apiBase, refresh: ctrl.refresh, entries: ctrl.entries });
    return <div data-status={ctrl.entries["acct-1"]?.status ?? "none"} />;
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(host);
      root.render(<Harness apiBase="http://a.local" />);
    });
    const staleRefreshA = captured.at(-1)!.refresh;
    await act(async () => {
      root!.render(<Harness apiBase="http://b.local" />);
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
      // Fire stale closure bound to a.local; must not overwrite b.local namespace or re-render error.
      const pending = staleRefreshA("acct-1");
      releaseTargetA(Response.json({ eligible: true, ineligibleReason: null, journalAvailable: true, unresolved: null, grants: [] }));
      await pending;
      await new Promise(r => setTimeout(r, 10));
    });
    expect(captured.at(-1)!.apiBase).toBe("http://b.local");
    expect((host.firstElementChild as HTMLElement | null)?.getAttribute("data-status")).toBe("ready");
  } finally {
    errSpy.mockRestore();
  }
});

test("CodexAccountPool aborts in-flight reset-credits detail fetch when target switches or modal closes", async () => {
  const creditSignals: AbortSignal[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits") {
        if (init?.signal) creditSignals.push(init.signal);
        return new Promise<Response>(() => {});
      }
      if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      if (url.pathname === "/api/settings") return Response.json({ codexQuotaAutoRefresh: {} });
      return Response.json({});
    },
  });

  const controller = makeController();
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="http://target-a.local" targetKey="target-a" controller={controller} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  const openBtn = host.querySelector('button[aria-label="3 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { openBtn.click(); });
  expect(creditSignals).toHaveLength(1);
  expect(creditSignals[0]!.aborted).toBe(false);

  // Closing the modal must abort the pending detail fetch.
  const closeBtn = host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  await act(async () => { closeBtn.click(); });
  expect(creditSignals[0]!.aborted).toBe(true);

  // Re-open and switch targets while detail fetch is pending: target switch must abort too.
  await act(async () => { openBtn.click(); });
  expect(creditSignals).toHaveLength(2);
  expect(creditSignals[1]!.aborted).toBe(false);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="http://target-b.local" targetKey="target-b" controller={makeController()} />
      </LanguageProvider>,
    );
  });
  expect(creditSignals[1]!.aborted).toBe(true);
});

test("ApiKeys validPendingRotation blocks bad-1, bad-9999, calendar overflow, 24:00:00, and >128B timestamps in cache and wire payloads", async () => {
  const authMatrix = [
    { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  ];
  const makeKeysEntry = (name: string, pendingRotation: unknown) => ({
    id: "k1",
    name,
    prefix: "epx_data_12345678...",
    createdAt: "2026-01-15T12:00:00.000Z",
    pendingRotation,
    usage: { requests7d: 0, totalRequests: 0 },
  });
  const seedCache = (apiBase: string, name: string, pendingRotation: unknown) => {
    win.sessionStorage.setItem(
      `epx.apikeys.list.v2:${apiBase}`,
      JSON.stringify({
        __epxCachedAt: Date.now(),
        data: {
          keys: [makeKeysEntry(name, pendingRotation)],
          endpoints: {
            baseUrl: `${apiBase}/v1`,
            responses: `${apiBase}/v1/responses`,
            chatCompletions: `${apiBase}/v1/chat/completions`,
            messages: `${apiBase}/v1/messages`,
            models: `${apiBase}/v1/models`,
          },
          claudeCodeEnabled: true,
          authMatrix,
        },
      }),
    );
  };

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return Response.json({ data: [] });
      return new Promise<Response>(() => {});
    },
  });

  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);

  const validBase = "http://keys-valid.local";
  seedCache(validBase, "cached-valid-key", {
    id: "rot-valid",
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:10:00.000Z",
  });
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ApiKeys apiBase={validBase} />
      </LanguageProvider>,
    );
  });
  expect(host.textContent).toContain("cached-valid-key");
  const openBtn = host.querySelector<HTMLButtonElement>("button.awi-keylist-name");
  expect(openBtn).not.toBeNull();
  await act(async () => { openBtn!.click(); });
  expect(host.textContent).toContain("Rotation is pending.");
  expect(host.textContent).toContain("Overlap expires:");

  const poisonedRotations = [
    { id: "r1", createdAt: "2026-08-28T00:00:00.000Z", expiresAt: "bad-1" },
    { id: "r2", createdAt: "2026-08-28T00:00:00.000Z", expiresAt: "bad-9999" },
    { id: "r3", createdAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-02-30T00:00:00Z" },
    { id: "r4", createdAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-09-09T24:00:00Z" },
    { id: "r5", createdAt: "2026-08-28T00:00:00.000Z", expiresAt: `2026-08-28T00:00:00.${"0".repeat(150)}Z` },
    { id: "r6", createdAt: "bad-1", expiresAt: "2026-08-28T00:10:00.000Z" },
    { id: "r7", createdAt: "bad-9999", expiresAt: "2026-08-28T00:10:00.000Z" },
    { id: "r8", createdAt: "2026-02-30T00:00:00Z", expiresAt: "2026-08-28T00:10:00.000Z" },
  ];

  for (const [index, pendingRotation] of poisonedRotations.entries()) {
    const base = `http://keys-bad-${index}.local`;
    seedCache(base, `poisoned-cached-key-${index}`, pendingRotation);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ApiKeys apiBase={base} />
        </LanguageProvider>,
      );
    });
    expect(host.textContent).not.toContain(`poisoned-cached-key-${index}`);
    expect(host.textContent).not.toContain("Rotation is pending.");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  }

  // Wire /api/keys payload with malformed pendingRotation must also fail closed across all invalid forms.
  for (const [index, pendingRotation] of poisonedRotations.entries()) {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/models")) return Response.json({ data: [] });
        if (url.endsWith("/api/keys")) {
          return Response.json({
            authMatrix,
            keys: [makeKeysEntry(`poisoned-wire-key-${index}`, pendingRotation)],
          });
        }
        return Response.json({});
      },
    });
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <ApiKeys apiBase={`http://keys-wire-bad-${index}.local`} />
        </LanguageProvider>,
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(host.textContent).not.toContain(`poisoned-wire-key-${index}`);
    expect(host.textContent).not.toContain("Rotation is pending.");
    expect(host.textContent).toContain("Could not load API keys.");
  }
});
