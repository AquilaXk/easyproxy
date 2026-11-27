/**
 * The Grok reset-coupon surface on xAI account rows.
 *
 * These cases exist because the dangerous paths here are the quiet ones: a
 * replayed *failure* arrives as HTTP 200, a rejected redemption request may
 * still be executing upstream, and a per-row retry used to cancel every sibling
 * read.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import { useGrokResetCoupons, type GrokResetCouponController } from "../src/hooks/useGrokResetCoupons";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];
let testApiBase: string;
let testSequence = 0;
const HOLD_STORAGE_KEY = "epx.grok-coupon-holds.v1";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ITEM: WorkspaceItem = {
  name: "xai",
  adapter: "xai",
  baseUrl: "https://api.x.ai",
  authMode: "oauth",
};

type CouponRow = { tokenId: string; validityStart: string; validityEnd: string };

type Harness = {
  coupons: Map<string, CouponRow[]>;
  readStatus: Map<string, number>;
  reads: string[];
  consumes: Array<{ accountId: string; tokenId: string; operationId: string }>;
  consumeReply: () => Promise<Response>;
  holdReads: boolean;
  releaseRead: Array<() => void>;
  inFlight: number;
  peakInFlight: number;
};

let harness: Harness;

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/grok/reset-coupons/consume")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { accountId: string; tokenId: string; operationId: string };
      harness.consumes.push(body);
      return harness.consumeReply();
    }
    if (url.includes("/api/grok/reset-coupons")) {
      const accountId = new URL(url, "http://proxy").searchParams.get("accountId") ?? "";
      harness.reads.push(accountId);
      harness.inFlight += 1;
      harness.peakInFlight = Math.max(harness.peakInFlight, harness.inFlight);
      if (harness.holdReads) {
        await new Promise<void>(resolve => harness.releaseRead.push(resolve));
      }
      harness.inFlight -= 1;
      const status = harness.readStatus.get(accountId) ?? 200;
      if (status !== 200) return json({ error: { code: status === 401 ? "auth_failed" : "upstream_error" } }, status);
      return json({ accountId, tokens: harness.coupons.get(accountId) ?? [], remaining: 0 });
    }
    return json({});
  }) as typeof fetch;
}

async function mountPanel(accounts: Array<Record<string, unknown>>, apiBase = testApiBase): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const handlers = {
    onLogin: async () => {},
    onLogout: async () => {},
    onReauth: async () => {},
    onSwitchAccount: async () => {},
    onSwitchApiKey: async () => {},
    onRemoveAccount: async () => {},
    onRemoveApiKey: async () => {},
    onAddApiKey: async () => {},
    onEditAlias: async () => {},
  } as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase={apiBase}
          oauth={{ loggedIn: true }}
          accounts={accounts as never}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

function badges(host: ParentNode): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-grok-coupon-badge]")];
}

function dialogText(host: ParentNode): string {
  return host.querySelector(".modal-card")?.textContent ?? "";
}

function buttonWithText(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(button => (button.textContent ?? "").includes(text));
  if (!found) throw new Error(`no dialog button matching ${text}; saw: ${dialogText(host)}`);
  return found;
}

async function openDialog(host: HTMLElement, index = 0): Promise<void> {
  await act(async () => { badges(host)[index].click(); await flush(); });
}

async function tryRedeemFromDialog(host: HTMLElement): Promise<void> {
  const redeem = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(button => (button.textContent ?? "").includes("Use 1 coupon"));
  if (redeem) {
    await act(async () => { redeem.click(); await flush(); });
    await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  } else {
    expect(dialogText(host)).toContain("outcome is unknown");
    expect([...host.querySelectorAll(".modal-card button")].some(button => (button.textContent ?? "").includes("Use coupon"))).toBe(false);
  }
}

const ACCOUNT = (id: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@example.com`, active: false, ...extra,
});

const COUPON = (tokenId: string, endDays: number): CouponRow => ({
  tokenId,
  validityStart: new Date(Date.now() - 86_400_000).toISOString(),
  validityEnd: new Date(Date.now() + endDays * 86_400_000).toISOString(),
});

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testApiBase = `http://proxy-${++testSequence}`;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  harness = {
    coupons: new Map(),
    readStatus: new Map(),
    reads: [],
    consumes: [],
    consumeReply: async () => json({ success: true, code: "redeemed", replayed: false }),
    holdReads: false,
    releaseRead: [],
    inFlight: 0,
    peakInFlight: 0,
  };
  installFetch();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoots = [];
});

afterEach(async () => {
  for (const release of harness.releaseRead) release();
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

test("each signed-in xAI row badges its own coupon count, and a reauth row is never read", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 20), COUPON("restok_a2", 5)]);
  harness.coupons.set("acct-b", []);
  const host = await mountPanel([ACCOUNT("acct-a"), ACCOUNT("acct-b"), ACCOUNT("acct-c", { needsReauth: true })]);

  expect(badges(host).map(badge => badge.dataset.grokCouponBadge)).toEqual(["2", "0"]);
  expect(harness.reads.sort()).toEqual(["acct-a", "acct-b"]);
});

test("a failed read badges the row as an error and the dialog separates auth from upstream", async () => {
  harness.readStatus.set("acct-a", 502);
  harness.readStatus.set("acct-b", 401);
  const host = await mountPanel([ACCOUNT("acct-a"), ACCOUNT("acct-b")]);

  expect(badges(host).map(badge => badge.dataset.grokCouponBadge)).toEqual(["error", "error"]);

  await openDialog(host, 0);
  expect(dialogText(host)).toContain("Could not read reset coupons");
  expect(harness.reads.filter(id => id === "acct-a").length).toBe(2);
  await act(async () => { buttonWithText(host, "Try again").click(); await flush(); });
  expect(harness.reads.filter(id => id === "acct-a").length).toBe(3);
});

test("redeeming spends the nearest-expiry coupon with a client-minted UUIDv4", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_far", 30), COUPON("restok_near", 2)]);
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(harness.consumes.length).toBe(1);
  expect(harness.consumes[0].tokenId).toBe("restok_near");
  expect(harness.consumes[0].accountId).toBe("acct-a");
  expect(harness.consumes[0].operationId).toMatch(UUID_V4);
  expect(dialogText(host)).toContain("Coupon redeemed");
});

test("a replayed failure is reported as a failure, never as a completed reset", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ code: "fetch_resets_failed", replayed: true, tokenId: "restok_a1" });
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  const alert = host.querySelector('.modal-card [role="alert"]')?.textContent ?? "";
  expect(alert).toContain("Redemption failed");
  expect(dialogText(host)).not.toContain("Coupon redeemed");
});

test("a 409 identity mismatch clears the held operation id", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ error: { code: "operation_id_owned_by_another_account" } }, 409);
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(dialogText(host)).toContain("belongs to another account");

  await act(async () => { buttonWithText(host, "Cancel").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(harness.consumes.length).toBe(2);
  expect(harness.consumes[1].operationId).not.toBe(harness.consumes[0].operationId);
  expect(harness.consumes[1].operationId).toMatch(UUID_V4);
});

test("ledger capacity gets its own retryable message", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ error: { code: "capacity" } }, 503);
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(dialogText(host)).toContain("journal is full");
});

test("a transport-rejected redemption stops posting, re-reads the account, and offers no retry", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => { throw new TypeError("connection reset after request dispatch"); };
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(dialogText(host)).toContain("outcome is unknown");
  expect(harness.reads.filter(id => id === "acct-a").length).toBe(3);
  expect([...host.querySelectorAll(".modal-card button")].some(b => (b.textContent ?? "").includes("Use coupon"))).toBe(false);

  harness.coupons.set("acct-a", []);
  await act(async () => { buttonWithText(host, "Re-read account").click(); await flush(); });
  expect(harness.consumes.length).toBe(1);
  expect(dialogText(host)).toContain("original redemption remains unconfirmed");
  expect(dialogText(host)).not.toContain("redemption went through");
  await act(async () => { buttonWithText(host, "Close").click(); await flush(); });
  await openDialog(host);
  expect(dialogText(host)).toContain("outcome is unknown");
  expect([...host.querySelectorAll(".modal-card button")].some(b => (b.textContent ?? "").includes("Use 1 coupon"))).toBe(false);
});

for (const [code, status] of [["attempt_unresolved", 502], ["redeem_failed", 502], ["attempt_in_progress", 409], ["attempt_reconcile_failed", 502], ["operation_state_changed", 409], ["attempt_mark_failed", 502], ["operation_token_mismatch", 409], ["ledger_unavailable", 503], ["missing_code", 200]] as const) {
  test(`a returned ${code} stays unknown across dialog close and reopen`, async () => {
    harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
    harness.consumeReply = async () => json(code === "missing_code" ? { success: true } : { operationId: harness.consumes.at(-1)?.operationId, error: { code } }, status);
    const host = await mountPanel([ACCOUNT("acct-a")]);
    await openDialog(host);
    await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
    await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
    expect(dialogText(host)).toContain("outcome is unknown");
    const held = harness.consumes[0].operationId;
    await act(async () => { buttonWithText(host, "Close").click(); await flush(); });
    await openDialog(host);
    expect(dialogText(host)).toContain("outcome is unknown");
    await act(async () => { buttonWithText(host, "Re-read account").click(); await flush(); });
    expect(harness.consumes).toHaveLength(1);
    expect(harness.consumes[0].operationId).toBe(held);
    expect([...host.querySelectorAll(".modal-card button")].some(b => (b.textContent ?? "").includes("Use coupon"))).toBe(false);
  });
}

test("closing and reopening during dispatch cannot post a new operation", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  const finishers: Array<(response: Response) => void> = [];
  harness.consumeReply = () => new Promise(resolve => { finishers.push(resolve); });
  const host = await mountPanel([ACCOUNT("acct-a")]);
  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  try {
    await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); await flush(); });
    await openDialog(host);
    await tryRedeemFromDialog(host);
    expect(harness.consumes).toHaveLength(1);
  } finally {
    await act(async () => { for (const finish of finishers) finish(json({ code: "redeemed" })); await flush(); });
  }
});

for (const code of ["redeemed", "coupon_unavailable"] as const) {
  test(`a reopened pending modal clears uncertainty immediately after ${code}`, async () => {
    harness.coupons.set("acct-a", [COUPON("restok_a1", 10), COUPON("restok_a2", 20)]);
    let finish!: (response: Response) => void;
    harness.consumeReply = () => new Promise(resolve => { finish = resolve; });
    const host = await mountPanel([ACCOUNT("acct-a")]);
    await openDialog(host);
    await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
    await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); await flush(); });
    await openDialog(host);
    await tryRedeemFromDialog(host);
    expect(harness.consumes).toHaveLength(1);
    expect(dialogText(host)).toContain("outcome is unknown");
    try {
      await act(async () => {
        if (code === "redeemed") harness.coupons.set("acct-a", [COUPON("restok_a2", 20)]);
        finish(code === "redeemed" ? json({ code }) : json({ error: { code } }, 409));
        await flush();
      });
      expect(dialogText(host)).not.toContain("outcome is unknown");
      expect(buttonWithText(host, "Use 1 coupon").disabled).toBe(false);
      harness.consumeReply = async () => json({ code: "redeemed" });
      await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
      await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
      expect(harness.consumes).toHaveLength(2);
      expect(harness.consumes[1].operationId).not.toBe(harness.consumes[0].operationId);
      if (code === "redeemed") expect(harness.consumes[1].tokenId).toBe("restok_a2");
    } finally {
      await act(async () => { finish(json({ code: "redeemed" })); await flush(); });
    }
  });
}

for (const code of ["redeemed", "coupon_unavailable"] as const) {
  test(`a definitive ${code} retires the attempt before its refresh GET completes`, async () => {
    harness.coupons.set("acct-a", [COUPON("restok_a1", 10), COUPON("restok_a2", 20)]);
    let finish!: (response: Response) => void;
    harness.consumeReply = () => new Promise(resolve => { finish = resolve; });
    const host = await mountPanel([ACCOUNT("acct-a")]);
    await openDialog(host);
    await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
    await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); await flush(); });
    harness.holdReads = true;
    try {
      await act(async () => { finish(json({ code, replayed: code !== "redeemed" })); await flush(); });
      expect(harness.releaseRead).toHaveLength(1);
      await openDialog(host);
      // Opening the dialog dispatches a fresh read while the earlier post-redeem read stays held.
      expect(harness.releaseRead).toHaveLength(2);
      await act(async () => { harness.releaseRead.pop()!(); await flush(); });
      await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
      await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
      expect(dialogText(host)).toContain("outcome is unknown");
      expect(harness.consumes).toHaveLength(2);
      expect(harness.consumes[1].operationId).not.toBe(harness.consumes[0].operationId);
      await act(async () => { harness.holdReads = false; harness.releaseRead.shift()!(); await flush(); });
      // Finishing the older GET must not retire the newer pending redemption.
      await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); await flush(); });
      await openDialog(host);
      await tryRedeemFromDialog(host);
      expect(harness.consumes).toHaveLength(2);
      expect(dialogText(host)).toContain("outcome is unknown");
      await act(async () => { finish(json({ code: "redeemed" })); await flush(); });
    } finally {
      await act(async () => {
        finish(json({ code: "redeemed" }));
        harness.holdReads = false;
        for (const release of harness.releaseRead.splice(0)) release();
        await flush();
      });
    }
    expect(dialogText(host)).not.toContain("outcome is unknown");
  });
}

for (const code of ["coupon_unavailable", "auth_failed", "fetch_resets_failed"]) {
  test(`a definitive ${code} releases a speculative pending hold`, async () => {
    harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
    let finish!: (response: Response) => void;
    harness.consumeReply = () => new Promise(resolve => { finish = resolve; });
    const host = await mountPanel([ACCOUNT("acct-a")]);
    await openDialog(host);
    await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
    await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); await flush(); });
    await openDialog(host);
    await tryRedeemFromDialog(host);
    expect(harness.consumes).toHaveLength(1);
    expect(dialogText(host)).toContain("outcome is unknown");
    await act(async () => { finish(json({ error: { code } }, code === "fetch_resets_failed" ? 502 : 409)); await flush(); });
    expect(dialogText(host)).not.toContain("outcome is unknown");
    await act(async () => { host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); await flush(); });
    await openDialog(host);
    expect(dialogText(host)).not.toContain("outcome is unknown");
    expect(buttonWithText(host, "Use 1 coupon").disabled).toBe(false);
    harness.consumeReply = async () => json({ code: "redeemed" });
    await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
    await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
    expect(harness.consumes).toHaveLength(2);
    expect(harness.consumes[1].operationId).not.toBe(harness.consumes[0].operationId);
  });
}

test("one row's retry does not cancel another row's in-flight read", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.coupons.set("acct-b", [COUPON("restok_b1", 10), COUPON("restok_b2", 12)]);
  harness.holdReads = true;
  const host = await mountPanel([ACCOUNT("acct-a"), ACCOUNT("acct-b")]);

  // Row A settles first, then retries while row B is still in flight.
  await act(async () => { harness.releaseRead.shift()?.(); await flush(); });
  await openDialog(host, 0);
  const retry = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(button => (button.textContent ?? "").includes("Try again"));
  if (retry) await act(async () => { retry.click(); await flush(); });

  harness.holdReads = false;
  await act(async () => { for (const release of harness.releaseRead.splice(0)) release(); await flush(); });

  const bBadge = badges(host)[1];
  expect(bBadge.dataset.grokCouponBadge).toBe("2");
});

test("no more than three coupon reads are in flight at once", async () => {
  harness.holdReads = true;
  for (const id of ["a", "b", "c", "d", "e"]) harness.coupons.set(`acct-${id}`, [COUPON(`restok_${id}`, 9)]);
  const host = await mountPanel(["a", "b", "c", "d", "e"].map(id => ACCOUNT(`acct-${id}`)));

  expect(harness.peakInFlight).toBeLessThanOrEqual(3);

  harness.holdReads = false;
  await act(async () => {
    for (let round = 0; round < 5; round += 1) {
      for (const release of harness.releaseRead.splice(0)) release();
      await flush();
    }
  });
  expect(badges(host).map(badge => badge.dataset.grokCouponBadge)).toEqual(["1", "1", "1", "1", "1"]);
  expect(harness.peakInFlight).toBeLessThanOrEqual(3);
});


// Direct controllers exercise admission even when the UI hides the redeem button.
async function mountController(apiBase = testApiBase, accountId = "acct-a") {
  const seen: { current: GrokResetCouponController | null } = { current: null };
  function Probe() {
    const controller = useGrokResetCoupons({ apiBase, accountIds: [accountId], enabled: true });
    useLayoutEffect(() => { seen.current = controller; }, [controller]);
    return null;
  }
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host as unknown as HTMLElement);
  mountedRoots.push(root);
  await act(async () => { root.render(<Probe />); await flush(); });
  return {
    get current() { return seen.current!; },
    async unmount() {
      await act(async () => { root.unmount(); await flush(); });
      mountedRoots.splice(mountedRoots.indexOf(root), 1);
    },
  };
}

const attempt = (tokenId = "restok_a1") => ({ tokenId, operationId: crypto.randomUUID() });

async function redeemController(controller: Awaited<ReturnType<typeof mountController>>, request = attempt(), accountId = "acct-a") {
  let outcome!: Awaited<ReturnType<GrokResetCouponController["redeem"]>>;
  await act(async () => { outcome = await controller.current.redeem(accountId, request); await flush(); });
  return outcome;
}

for (const code of ["attempt_unresolved", "attempt_in_progress", "attempt_reconcile_failed", "operation_state_changed", "redeem_failed", "attempt_mark_failed", "operation_token_mismatch", "ledger_unavailable"]) {
  test(`an unresolved 200 ${code} preserves the original operation`, async () => {
    const controller = await mountController();
    const request = attempt();
    harness.consumeReply = async () => json({ code, operationId: request.operationId });
    expect((await redeemController(controller, request)).uncertain).toBe(true);
    expect((await redeemController(controller)).operationId).toBe(request.operationId);
    expect(harness.consumes).toHaveLength(1);
  });
}

for (const code of [null, 17, {}, " "]) {
  test(`a malformed 200 code ${JSON.stringify(code)} holds across remount`, async () => {
    const controller = await mountController();
    const request = attempt();
    harness.consumeReply = async () => json({ code });
    await redeemController(controller, request);
    await controller.unmount();
    const remounted = await mountController();
    expect(remounted.current.uncertain["acct-a"]).toEqual(request);
    expect((await redeemController(remounted)).operationId).toBe(request.operationId);
    expect(harness.consumes).toHaveLength(1);
  });
}

test("remount during dispatch retains the hold written before POST", async () => {
  const controller = await mountController();
  const request = attempt();
  let finish!: (response: Response) => void;
  let storedBeforePost: unknown;
  harness.consumeReply = () => {
    storedBeforePost = JSON.parse(testWindow.sessionStorage.getItem(HOLD_STORAGE_KEY) ?? "{}")[`${testApiBase}\u0000acct-a`];
    return new Promise(resolve => { finish = resolve; });
  };
  let pending!: ReturnType<GrokResetCouponController["redeem"]>;
  await act(async () => { pending = controller.current.redeem("acct-a", request); await flush(); });
  try {
    await controller.unmount();
    const remounted = await mountController();
    expect(remounted.current.uncertain["acct-a"]).toEqual(request);
    expect(storedBeforePost).toEqual(request);
    expect((await redeemController(remounted)).operationId).toBe(request.operationId);
    expect(harness.consumes).toHaveLength(1);
  } finally {
    await act(async () => { finish(json({ code: "redeemed" })); await pending; await flush(); });
  }
});

for (const storageDenied of [false, true]) {
  test(`an unresolved hold survives remount with storage ${storageDenied ? "denied" : "available"}`, async () => {
    if (storageDenied) Object.defineProperty(testWindow, "sessionStorage", {
      configurable: true, get() { throw new Error("storage denied"); },
    });
    const controller = await mountController();
    const request = attempt();
    harness.consumeReply = async () => json({ error: { code: "attempt_unresolved" } }, 502);
    await redeemController(controller, request);
    await controller.unmount();
    const remounted = await mountController();
    expect(remounted.current.uncertain["acct-a"]).toEqual(request);
    expect((await redeemController(remounted)).operationId).toBe(request.operationId);
    expect(harness.consumes).toHaveLength(1);
  });
}

test("holds are isolated by API base and account", async () => {
  const controller = await mountController();
  const request = attempt();
  harness.consumeReply = async () => json({ error: { code: "attempt_unresolved" } }, 502);
  await redeemController(controller, request);
  await controller.unmount();
  const remounted = await mountController();
  const otherApi = await mountController(`${testApiBase}/other`);
  const otherAccount = await mountController(testApiBase, "acct-b");
  expect(remounted.current.uncertain["acct-a"]).toEqual(request);
  expect(otherApi.current.uncertain["acct-a"]).toBeUndefined();
  expect(otherAccount.current.uncertain["acct-b"]).toBeUndefined();
  harness.consumeReply = async () => json({ code: "redeemed" });
  expect((await redeemController(otherApi)).ok).toBe(true);
  expect((await redeemController(otherAccount, attempt("restok_b1"), "acct-b")).ok).toBe(true);
  expect((await redeemController(remounted)).operationId).toBe(request.operationId);
  expect(harness.consumes).toHaveLength(3);
});

for (const code of ["redeemed", "coupon_unavailable"]) {
  test(`late definitive ${code} clears the remounted hold and admits one fresh POST`, async () => {
    const controller = await mountController();
    const request = attempt();
    let finish!: (response: Response) => void;
    harness.consumeReply = () => new Promise(resolve => { finish = resolve; });
    let pending!: ReturnType<GrokResetCouponController["redeem"]>;
    await act(async () => { pending = controller.current.redeem("acct-a", request); await flush(); });
    try {
      await controller.unmount();
      const remounted = await mountController();
      expect(remounted.current.uncertain["acct-a"]).toEqual(request);
      expect((await redeemController(remounted)).operationId).toBe(request.operationId);
      expect(harness.consumes).toHaveLength(1);
      await act(async () => { finish(code === "redeemed" ? json({ code }) : json({ error: { code } }, 409)); await pending; await flush(); });
      expect(remounted.current.uncertain["acct-a"]).toBeUndefined();
      expect(JSON.parse(testWindow.sessionStorage.getItem(HOLD_STORAGE_KEY) ?? "{}")[`${testApiBase}\u0000acct-a`]).toBeUndefined();
      harness.consumeReply = async () => json({ code: "redeemed" });
      const next = attempt();
      expect((await redeemController(remounted, next)).ok).toBe(true);
      expect(harness.consumes).toHaveLength(2);
      expect(harness.consumes[1].operationId).toBe(next.operationId);
      expect(next.operationId).not.toBe(request.operationId);
    } finally {
      await act(async () => { finish(json({ code: "redeemed" })); await flush(); });
    }
  });
}

test("#6897 a different persisted hold never replaces a live unresolved hold", async () => {
  const controller = await mountController();
  const live = attempt();
  const stale = attempt("restok_a2");
  harness.consumeReply = async () => json({ operationId: live.operationId, error: { code: "attempt_unresolved" } }, 502);
  expect((await redeemController(controller, live)).uncertain).toBe(true);
  await controller.unmount();
  testWindow.sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify({ [`${testApiBase}\u0000acct-a`]: stale }));
  const remounted = await mountController();
  expect(remounted.current.uncertain["acct-a"]).toEqual(live);
  expect((await redeemController(remounted)).operationId).toBe(live.operationId);
  expect(harness.consumes).toHaveLength(1);
});

test("#6897 a different persisted hold cannot replace a pending hold or survive its definitive clear", async () => {
  const controller = await mountController();
  const pendingAttempt = attempt();
  const stale = attempt("restok_a2");
  let finish!: (response: Response) => void;
  harness.consumeReply = () => new Promise(resolve => { finish = resolve; });
  let pending!: ReturnType<GrokResetCouponController["redeem"]>;
  await act(async () => { pending = controller.current.redeem("acct-a", pendingAttempt); await flush(); });
  try {
    await controller.unmount();
    testWindow.sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify({ [`${testApiBase}\u0000acct-a`]: stale }));
    const remounted = await mountController();
    expect(remounted.current.uncertain["acct-a"]).toEqual(pendingAttempt);
    await act(async () => { finish(json({ code: "redeemed" })); await pending; await flush(); });
    expect(remounted.current.uncertain["acct-a"]).toBeUndefined();
    expect(JSON.parse(testWindow.sessionStorage.getItem(HOLD_STORAGE_KEY) ?? "{}")[`${testApiBase}\u0000acct-a`]).toBeUndefined();
  } finally {
    await act(async () => { finish(json({ code: "redeemed" })); await flush(); });
  }
});

test("#6897 capacity anchored to the operation stays unknown; a 200 ledger refusal code holds", async () => {
  const controller = await mountController();
  const anchored = attempt();
  harness.consumeReply = async () => json({ operationId: anchored.operationId, error: { code: "capacity" } }, 503);
  expect((await redeemController(controller, anchored)).uncertain).toBe(true);
  const other = await mountController(testApiBase, "acct-b");
  const replayed = attempt();
  harness.consumeReply = async () => json({ code: "ledger_unavailable", replayed: true });
  expect((await redeemController(other, replayed, "acct-b")).uncertain).toBe(true);
  expect(harness.consumes).toHaveLength(2);
});

for (const code of ["future_uncertain_code", "Redeemed"]) {
  test(`#6897 an unrecognized 200 code ${code} keeps the hold`, async () => {
    const controller = await mountController();
    const request = attempt();
    harness.consumeReply = async () => json({ code, replayed: true });
    expect((await redeemController(controller, request)).uncertain).toBe(true);
    expect((await redeemController(controller)).operationId).toBe(request.operationId);
    expect(harness.consumes).toHaveLength(1);
  });
}

for (const hold of [
  { tokenId: "", operationId: crypto.randomUUID() },
  { tokenId: "restok_a1", operationId: "not-a-uuid" },
  { tokenId: "restok_a1", operationId: "00000000-0000-1000-8000-000000000000" },
]) {
  test(`invalid hydrated hold ${JSON.stringify(hold)} permits a fresh operation`, async () => {
    testWindow.sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify({ [`${testApiBase}\u0000acct-a`]: hold }));
    const controller = await mountController();
    expect(controller.current.uncertain["acct-a"]).toBeUndefined();
    expect((await redeemController(controller)).ok).toBe(true);
    expect(harness.consumes).toHaveLength(1);
  });
}

test("a valid persisted UUIDv4 hold refuses a new POST", async () => {
  const request = attempt();
  testWindow.sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify({ [`${testApiBase}\u0000acct-a`]: request }));
  const controller = await mountController();
  expect(controller.current.uncertain["acct-a"]).toEqual(request);
  expect((await redeemController(controller)).operationId).toBe(request.operationId);
  expect(harness.consumes).toHaveLength(0);
});

test("GUI filters out expired, future, and malformed coupons and keeps FEFO stable with multiple unbounded coupons", async () => {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  harness.coupons.set("acct-a", [
    { tokenId: "unbounded-1", validityStart: iso(-86_400_000), validityEnd: "" },
    { tokenId: "expired", validityStart: iso(-10 * 86_400_000), validityEnd: iso(-60_000) },
    { tokenId: "future", validityStart: iso(3_600_000), validityEnd: iso(2 * 86_400_000) },
    { tokenId: "bad-start", validityStart: "invalid", validityEnd: iso(86_400_000) },
    { tokenId: "bad-end", validityStart: iso(-86_400_000), validityEnd: "invalid" },
    { tokenId: "unbounded-2", validityStart: "", validityEnd: "" },
    { tokenId: "active-far", validityStart: iso(-86_400_000), validityEnd: iso(15 * 86_400_000) },
    { tokenId: "active-near", validityStart: iso(-86_400_000), validityEnd: iso(3 * 86_400_000) },
  ]);
  const host = await mountPanel([ACCOUNT("acct-a")]);
  expect(badges(host)[0]!.dataset.grokCouponBadge).toBe("4");

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(harness.consumes).toHaveLength(1);
  expect(harness.consumes[0]!.tokenId).toBe("active-near");
});

test("opening the Grok coupon modal re-reads the account and holds spending until the fresh list lands", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_stale", 10), COUPON("restok_next", 20)]);
  const host = await mountPanel([ACCOUNT("acct-a")]);
  expect(badges(host)[0]!.dataset.grokCouponBadge).toBe("2");

  // Simulate coupon change between initial render and clicking the badge.
  harness.coupons.set("acct-a", [COUPON("restok_next", 20), COUPON("restok_urgent", 1)]);
  harness.holdReads = true;
  await openDialog(host);
  expect(harness.releaseRead).toHaveLength(1);
  expect(buttonWithText(host, "Use 1 coupon").disabled).toBe(true);

  await act(async () => {
    harness.holdReads = false;
    harness.releaseRead.shift()!();
    await flush();
  });
  expect(buttonWithText(host, "Use 1 coupon").disabled).toBe(false);

  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(harness.consumes).toHaveLength(1);
  expect(harness.consumes[0]!.tokenId).toBe("restok_urgent");
});

test("confirming Grok coupon cancels back to list if a refresh removes or supersedes the target coupon", async () => {
  const { GrokCouponBadge, GrokResetCouponModal } = await import("../src/components/provider-workspace/GrokResetCoupons");
  const { useT } = await import("../src/i18n/shared");
  const { createRoot } = await import("react-dom/client");
  harness.coupons.set("acct-a", [COUPON("restok_first", 10), COUPON("restok_later", 20)]);

  let liveController!: GrokResetCouponController;
  function StaleConfirmHarness() {
    const t = useT();
    const controller = useGrokResetCoupons({ apiBase: testApiBase, accountIds: ["acct-a"], enabled: true });
    useLayoutEffect(() => { liveController = controller; }, [controller]);
    return (
      <>
        <GrokCouponBadge entry={controller.entries["acct-a"]} t={t} onClick={() => {}} />
        <GrokResetCouponModal
          accountId="acct-a"
          accountLabel="acct-a@example.com"
          entry={controller.entries["acct-a"]}
          controller={controller}
          onClose={() => {}}
        />
      </>
    );
  }

  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const root = createRoot(host as unknown as HTMLElement);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<LanguageProvider><StaleConfirmHarness /></LanguageProvider>);
    await flush();
  });

  await act(async () => { buttonWithText(host as unknown as HTMLElement, "Use 1 coupon").click(); await flush(); });
  expect(dialogText(host)).toContain("Use reset coupon?");

  // Background refresh lands with a nearer-expiry coupon, invalidating the pending confirmation.
  harness.coupons.set("acct-a", [COUPON("restok_even_sooner", 2), COUPON("restok_first", 10)]);
  await act(async () => { await liveController.refresh("acct-a", { keepSnapshot: true }); await flush(); });

  expect(dialogText(host)).not.toContain("Use reset coupon?");
  expect(dialogText(host)).toContain("Available coupons changed. Review the updated order before redeeming.");
  expect(harness.consumes).toHaveLength(0);

  await act(async () => { buttonWithText(host as unknown as HTMLElement, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host as unknown as HTMLElement, "Use coupon").click(); await flush(); });
  expect(harness.consumes).toHaveLength(1);
  expect(harness.consumes[0]!.tokenId).toBe("restok_even_sooner");

  // Confirming when refresh removes every coupon returns to empty list with noneAvailable.
  await act(async () => { buttonWithText(host as unknown as HTMLElement, "Use 1 coupon").click(); await flush(); });
  expect(dialogText(host)).toContain("Use reset coupon?");
  harness.coupons.set("acct-a", []);
  await act(async () => { await liveController.refresh("acct-a", { keepSnapshot: true }); await flush(); });
  expect(dialogText(host)).not.toContain("Use reset coupon?");
  expect(dialogText(host)).toContain("No reset coupons are available to redeem.");
});

test("coupon_unavailable refusal closes confirm view, refreshes list, and renders specific warning", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_gone", 5)]);
  harness.consumeReply = async () => json({ error: { code: "coupon_unavailable" } }, 409);
  const host = await mountPanel([ACCOUNT("acct-a")]);
  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  expect(dialogText(host)).toContain("Use reset coupon?");

  harness.coupons.set("acct-a", []);
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(dialogText(host)).not.toContain("Use reset coupon?");
  expect(dialogText(host)).toContain("no longer available");
  expect(dialogText(host)).toContain("This account has no reset coupons.");
});

test("operation_id_owned_by_another_account allows direct retry from confirm view with a new UUIDv4", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ error: { code: "operation_id_owned_by_another_account" } }, 409);
  const host = await mountPanel([ACCOUNT("acct-a")]);
  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(dialogText(host)).toContain("belongs to another account");

  harness.consumeReply = async () => json({ success: true, code: "redeemed", replayed: false });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(harness.consumes).toHaveLength(2);
  expect(harness.consumes[1]!.operationId).toMatch(UUID_V4);
  expect(harness.consumes[1]!.operationId).not.toBe(harness.consumes[0]!.operationId);
  expect(dialogText(host)).toContain("Coupon redeemed");
  expect(dialogText(host)).not.toContain("cannot generate a redemption ID");
});

test("switching apiBase isolates Grok coupon entries and retires queued reads from the prior server", async () => {
  const { createRoot } = await import("react-dom/client");
  const baseFetch = globalThis.fetch;
  const readUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/grok/reset-coupons") && !url.includes("/consume")) {
      readUrls.push(url);
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  try {
    harness.coupons.set("acct-1", [COUPON("restok_s1", 4)]);
    harness.coupons.set("acct-2", [COUPON("restok_s2", 5)]);
    harness.coupons.set("acct-3", [COUPON("restok_s3", 6)]);
    harness.coupons.set("acct-4", [COUPON("restok_s4", 7)]);

    let latest!: GrokResetCouponController;
    function Harness({ apiBase }: { apiBase: string }) {
      const controller = useGrokResetCoupons({
        apiBase,
        accountIds: ["acct-1", "acct-2", "acct-3", "acct-4"],
        enabled: true,
      });
      useLayoutEffect(() => { latest = controller; }, [controller]);
      return null;
    }

    const host = testWindow.document.createElement("div");
    const root = createRoot(host as unknown as HTMLElement);
    mountedRoots.push(root);

    await act(async () => {
      root.render(<Harness apiBase="http://server-a.local" />);
      await flush();
    });
    expect(latest.entries["acct-1"]?.status).toBe("ready");

    // Hold server-a reads with >3 accounts so acct-4 waits in gate.waiting, then switch apiBase.
    harness.holdReads = true;
    await act(async () => {
      void latest.refresh("acct-1");
      void latest.refresh("acct-2");
      void latest.refresh("acct-3");
      void latest.refresh("acct-4");
      await flush();
    });
    const readsBeforeSwitch = readUrls.filter(u => u.startsWith("http://server-a.local")).length;
    expect(readsBeforeSwitch).toBe(7); // 4 initial + 3 active queued; acct-4 is waiting

    const serverBCoupon = COUPON("restok_b1", 12);
    harness.coupons.set("acct-1", [serverBCoupon]);
    await act(async () => {
      root.render(<Harness apiBase="http://server-b.local" />);
    });
    // Immediately after switch (before server-b reads finish), server-a's ready snapshot is gone.
    expect(latest.entries).toEqual({});

    await act(async () => {
      harness.holdReads = false;
      while (harness.releaseRead.length > 0) harness.releaseRead.shift()!();
      await flush();
    });

    // Server-a's queued acct-4 never sent a late fetch, and server-b shows only server-b coupons.
    expect(readUrls.filter(u => u.startsWith("http://server-a.local"))).toHaveLength(readsBeforeSwitch);
    expect(latest.entries["acct-1"]).toEqual({
      status: "ready",
      coupons: [serverBCoupon],
    });
  } finally {
    globalThis.fetch = baseFetch;
  }
});

test("duplicate Grok coupon entries render without duplicate React key warnings", async () => {
  const dup = COUPON("restok_dup", 6);
  harness.coupons.set("acct-a", [dup, { ...dup }]);
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    const host = await mountPanel([ACCOUNT("acct-a")]);
    await openDialog(host);
    expect(host.querySelectorAll(".credit-list .credit-item")).toHaveLength(2);
  } finally {
    errSpy.mockRestore();
  }
  expect(errors.join("\n")).not.toContain("same key");
});

test("startConfirm refuses locally expired coupon and triggers refresh instead of opening confirm view", async () => {
  const t0 = Date.parse("2026-11-28T00:00:00Z");
  let fakeNow = t0;
  const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
  try {
    harness.coupons.set("acct-a", [{
      tokenId: "restok_expiring",
      validityStart: "2026-01-01T00:00:00Z",
      validityEnd: new Date(t0 + 60_000).toISOString(),
    }]);
    const host = await mountPanel([ACCOUNT("acct-a")]);
    await openDialog(host);

    // Advance wall clock past validityEnd while dialog stays open.
    fakeNow = t0 + 61_000;
    harness.coupons.set("acct-a", []);
    await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });

    expect(dialogText(host)).not.toContain("Use reset coupon?");
    expect(dialogText(host)).toContain("no longer available");
    expect(harness.consumes).toHaveLength(0);
  } finally {
    nowSpy.mockRestore();
  }
});

test("late settled redeem after apiBase switch never fires stale GET or wipes new server entries", async () => {
  const { createRoot } = await import("react-dom/client");
  const baseFetch = globalThis.fetch;
  const readUrls: string[] = [];
  let finishRedeem!: (response: Response) => void;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/grok/reset-coupons") && !url.includes("/consume")) {
      readUrls.push(url);
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  try {
    const serverACoupon = COUPON("restok_a_old", 4);
    const serverBCoupon = COUPON("restok_b_new", 9);
    harness.coupons.set("acct-1", [serverACoupon]);
    harness.consumeReply = () => new Promise(resolve => { finishRedeem = resolve; });

    let latest!: GrokResetCouponController;
    function Harness({ apiBase }: { apiBase: string }) {
      const controller = useGrokResetCoupons({
        apiBase,
        accountIds: ["acct-1"],
        enabled: true,
      });
      useLayoutEffect(() => { latest = controller; }, [controller]);
      return null;
    }

    const host = testWindow.document.createElement("div");
    const root = createRoot(host as unknown as HTMLElement);
    mountedRoots.push(root);

    await act(async () => {
      root.render(<Harness apiBase="http://server-a.local" />);
      await flush();
    });
    expect(latest.entries["acct-1"]).toEqual({ status: "ready", coupons: [serverACoupon] });

    const req = attempt("restok_a_old");
    let pendingRedeem!: ReturnType<GrokResetCouponController["redeem"]>;
    await act(async () => {
      pendingRedeem = latest.redeem("acct-1", req);
      await flush();
    });

    const readsBeforeSwitch = readUrls.filter(u => u.startsWith("http://server-a.local")).length;
    harness.coupons.set("acct-1", [serverBCoupon]);
    await act(async () => {
      root.render(<Harness apiBase="http://server-b.local" />);
      await flush();
    });
    expect(latest.entries["acct-1"]).toEqual({ status: "ready", coupons: [serverBCoupon] });

    await act(async () => {
      finishRedeem(json({ code: "redeemed" }));
      await pendingRedeem;
      await flush();
    });

    expect(readUrls.filter(u => u.startsWith("http://server-a.local"))).toHaveLength(readsBeforeSwitch);
    expect(latest.entries["acct-1"]).toEqual({ status: "ready", coupons: [serverBCoupon] });
  } finally {
    globalThis.fetch = baseFetch;
  }
});
