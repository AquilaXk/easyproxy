/** @jsxImportSource react */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const account: CodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  isMain: false,
  paused: false,
  priority: 0,
  autoSwitchThresholdOverride: null,
  hasCredential: true,
  quota: { resetCredits: 4, updatedAt: 1 },
  quotaAutoRefresh: {
    fiveHourAvailable: false,
    weeklyAvailable: false,
    fiveHourEnabled: false,
    weeklyEnabled: false,
  },
};

function makeController(): CodexAccountPoolController {
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
      account,
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
  };
}

let mockCredits: Array<{ granted_at: string; expires_at: string | null }> = [];

beforeEach(() => {
  mockCredits = [];
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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits") {
        return Response.json({ credits: mockCredits });
      }
      if (url.pathname === "/api/codex-auth/active") {
        return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      }
      if (url.pathname === "/api/settings") {
        return Response.json({ codexQuotaAutoRefresh: {} });
      }
      return Response.json({});
    },
  });
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

async function mountAndOpenResetModal() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="" controller={makeController()} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const resetBtn = host.querySelector('button[aria-label="4 reset credit(s)"]') as HTMLButtonElement | null;
  expect(resetBtn).not.toBeNull();
  await act(async () => { resetBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

test("orders same-granted credits by expires_at FEFO, skips expired credits, defends against NaN, and avoids duplicate React keys", async () => {
  const now = Date.now();
  const futureDays = (days: number) => new Date(now + days * 86_400_000).toISOString();
  const pastIso = new Date(now - 3_600_000).toISOString();
  const sameGrant = "2026-10-15T00:00:00Z";
  const twinGrant = "2026-11-10T00:00:00Z";
  const twinExpiry = futureDays(25);

  mockCredits = [
    { granted_at: "2026-09-01T00:00:00Z", expires_at: pastIso }, // expired -> filtered out
    { granted_at: sameGrant, expires_at: null },
    { granted_at: sameGrant, expires_at: futureDays(14) },
    { granted_at: "not-a-date", expires_at: "also-bad" },
    { granted_at: sameGrant, expires_at: futureDays(3) },
    { granted_at: twinGrant, expires_at: twinExpiry },
    { granted_at: twinGrant, expires_at: twinExpiry },
    { granted_at: "bad-1", expires_at: "2026-02-30T00:00:00Z" },
    { granted_at: "still-bad", expires_at: null },
  ];

  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    await mountAndOpenResetModal();
  } finally {
    errSpy.mockRestore();
  }

  expect(errors.join("\n")).not.toContain("same key");
  const items = [...host.querySelectorAll<HTMLElement>(".credit-list .credit-item")];
  expect(items).toHaveLength(8);

  // First item must be the oldest active grant with the soonest expiry (3d left, not 14d or No expiry).
  expect(items[0]!.textContent).toContain("Next to use");
  expect(items[0]!.textContent).toContain("3d left");
  expect(items[1]!.textContent).toContain("14d left");
  expect(items[2]!.textContent).toContain("No expiry");
  // Twin credits both appear after sameGrant.
  expect(items[3]!.textContent).toContain("25d left");
  expect(items[4]!.textContent).toContain("25d left");
  // Malformed non-null expires_at must omit expiry instead of claiming "No expiry", and reject JSC Date.parse quirks.
  expect(items[5]!.textContent).not.toContain("No expiry");
  expect(items[6]!.textContent).not.toContain("No expiry");
  expect(items[6]!.textContent).not.toContain("2001");
  expect(items[6]!.textContent).not.toContain("Mar 2, 2026");
  // Genuine expires_at: null keeps "No expiry".
  expect(items[7]!.textContent).toContain("No expiry");
  // Unparseable dates sort last and never display "NaN" or "Invalid Date".
  expect(host.querySelector(".modal-card")?.textContent).not.toContain("NaN");
  expect(host.querySelector(".modal-card")?.textContent).not.toContain("Invalid Date");
});

test("stale reset-credit lookup from a closed account does not overwrite a newly opened modal", async () => {
  const futureDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const mainAccount: CodexAccountEntry = {
    id: "__main__",
    email: "main@example.test",
    isMain: true,
    paused: false,
    priority: 0,
    hasCredential: true,
    quota: { resetCredits: 1, updatedAt: 1 },
    quotaAutoRefresh: {
      fiveHourAvailable: false,
      weeklyAvailable: false,
      fiveHourEnabled: false,
      weeklyEnabled: false,
    },
  };
  const controller = makeController();
  controller.accounts = [mainAccount, account];

  let releaseMain!: (resp: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits") {
        const accountId = url.searchParams.get("accountId");
        if (accountId === "__main__") {
          return new Promise<Response>(resolve => { releaseMain = resolve; });
        }
        return Response.json({
          credits: [{ granted_at: "2026-11-20T00:00:00Z", expires_at: futureDays(12) }],
        });
      }
      if (url.pathname === "/api/codex-auth/active") {
        return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      }
      if (url.pathname === "/api/settings") {
        return Response.json({ codexQuotaAutoRefresh: {} });
      }
      return Response.json({});
    },
  });

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="" controller={controller} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  const mainBtn = host.querySelector('button[aria-label="1 reset credit(s)"]') as HTMLButtonElement;
  const poolBtn = host.querySelector('button[aria-label="4 reset credit(s)"]') as HTMLButtonElement;
  expect(mainBtn).not.toBeNull();
  expect(poolBtn).not.toBeNull();

  // Open main modal (slow fetch held), close it, then open pool modal (fast fetch settles).
  await act(async () => { mainBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); });
  await act(async () => { poolBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(host.querySelector(".modal-card")?.textContent).toContain("(12d left)");

  // Resolve slow main fetch with different expiry; pool modal must keep its own credit list.
  await act(async () => {
    releaseMain(Response.json({
      credits: [{ granted_at: "2026-11-01T00:00:00Z", expires_at: futureDays(2) }],
    }));
    await new Promise(r => setTimeout(r, 20));
  });
  expect(host.querySelector(".modal-card")?.textContent).toContain("(12d left)");
  expect(host.querySelector(".modal-card")?.textContent).not.toContain("(2d left)");
});

test("switching targetKey clears creditDetailsLoading and discards in-flight reset-credit responses", async () => {
  const futureDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const controller = makeController();
  let releaseTargetA!: (resp: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits") {
        if (url.origin === "http://target-a.local") {
          return new Promise<Response>(resolve => { releaseTargetA = resolve; });
        }
        return Response.json({
          credits: [{ granted_at: "2026-11-22T00:00:00Z", expires_at: futureDays(9) }],
        });
      }
      if (url.pathname === "/api/codex-auth/active") {
        return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      }
      if (url.pathname === "/api/settings") {
        return Response.json({ codexQuotaAutoRefresh: {} });
      }
      return Response.json({});
    },
  });

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

  const btnA = host.querySelector('button[aria-label="4 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { btnA.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  expect(host.querySelector(".modal-card")).not.toBeNull();
  expect(host.querySelector(".modal-card")?.textContent).toContain("Loading");

  // Switch targetKey while target-a's fetch is still pending.
  await act(async () => {
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="http://target-b.local" targetKey="target-b" controller={controller} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(host.querySelector(".modal-card")).toBeNull();

  // Resolve target-a's stale fetch after target switch.
  await act(async () => {
    releaseTargetA(Response.json({
      credits: [{ granted_at: "2026-11-01T00:00:00Z", expires_at: futureDays(2) }],
    }));
    await new Promise(r => setTimeout(r, 20));
  });

  // Open target-b modal: it must load target-b cleanly and not show stuck Loading or target-a's 2d credit.
  const btnB = host.querySelector('button[aria-label="4 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { btnB.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(host.querySelector(".modal-card")?.textContent).toContain("(9d left)");
  expect(host.querySelector(".modal-card")?.textContent).not.toContain("(2d left)");
  expect(host.querySelector(".modal-card")?.textContent).not.toContain("Loading");
});
