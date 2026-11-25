import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import ApiKeysListPanel from "../src/components/apikeys-workspace/ApiKeysListPanel";
import { ApiKeyBudgetCard } from "../src/components/apikeys-workspace/ApiKeyBudgetCard";
import { ModalDialog } from "../src/components/ui-v2/modal-dialog";
import { LanguageProvider } from "../src/i18n/provider";
import { uxT } from "../src/i18n/ux-overhaul-copy";

const GLOBALS = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;

beforeEach(() => {
  saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  win = new Window({ url: "http://localhost/" });
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
  win.close();
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]!);
    else Reflect.deleteProperty(globalThis, k);
  }
});

test("ModalDialog invokes showModal/fallback, respects dismissDisabled, closes on Escape/backdrop, and restores focus", async () => {
  let showModalCalls = 0;
  let closeCalls = 0;
  const proto = win.HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
  proto.showModal = function showModal(this: HTMLDialogElement) {
    showModalCalls += 1;
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    closeCalls += 1;
    this.removeAttribute("open");
  };

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);

  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <LanguageProvider>
        <button type="button" id="trigger-btn" onClick={() => setOpen(true)}>Open</button>
        {open && (
          <ModalDialog aria-label="Sample modal" dismissDisabled={disabled} onClose={() => setOpen(false)}>
            <input type="text" aria-label="Field" />
            <button type="button" onClick={() => setOpen(false)}>Done</button>
          </ModalDialog>
        )}
      </LanguageProvider>
    );
  }

  await act(async () => { root!.render(<Harness />); });
  const trigger = host.querySelector<HTMLButtonElement>("#trigger-btn")!;
  trigger.focus();
  expect(document.activeElement).toBe(trigger);

  await act(async () => { trigger.click(); });
  const dialog = host.querySelector<HTMLDialogElement>("dialog[role='dialog']")!;
  expect(dialog).not.toBeNull();
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(showModalCalls).toBe(1);
  expect(document.activeElement).toBe(host.querySelector("input"));

  await act(async () => {
    dialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector("dialog")).toBeNull();
  expect(closeCalls).toBe(1);
  expect(document.activeElement).toBe(trigger);

  // Fallback path without showModal and locked when dismissDisabled=true
  Reflect.deleteProperty(proto, "showModal");
  Reflect.deleteProperty(proto, "close");
  await act(async () => { root!.render(<Harness disabled />); });
  await act(async () => { host.querySelector<HTMLButtonElement>("#trigger-btn")!.click(); });
  const fallbackDialog = host.querySelector<HTMLDialogElement>("dialog")!;
  expect(fallbackDialog.hasAttribute("open")).toBe(true);

  await act(async () => {
    fallbackDialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    fallbackDialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
  });
  expect(host.querySelector("dialog")).not.toBeNull();

  await act(async () => { root!.render(<Harness disabled={false} />); });
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
  });
  expect(host.querySelector("dialog")).toBeNull();

  // Real pointer interaction on backdrop calls onClose once, and drag from card out does not close.
  let spyCloses = 0;
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ModalDialog aria-label="Pointer spy modal" onClose={() => { spyCloses += 1; }}>
          <button type="button">Inside</button>
        </ModalDialog>
      </LanguageProvider>,
    );
  });
  const spyDialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const spyCard = spyDialog.querySelector<HTMLElement>(".modal-card")!;
  const spyBackdrop = spyDialog.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  Object.defineProperty(spyCard, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 200, top: 100, right: 600, bottom: 400, width: 400, height: 300, x: 200, y: 100, toJSON() { return this; } }),
  });
  await act(async () => {
    spyBackdrop.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    spyBackdrop.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
    spyBackdrop.click();
  });
  expect(spyCloses).toBe(1);
  await act(async () => {
    spyCard.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, clientX: 250, clientY: 150 }));
    spyBackdrop.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
    spyBackdrop.click();
  });
  expect(spyCloses).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await act(async () => { spyBackdrop.click(); });
  expect(spyCloses).toBe(2);
});

test("ApiKeysListPanel renders inline quota bars scaled to peak budget usage and omits bars without limits", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ApiKeysListPanel
          keys={[
            {
              id: "k-high",
              name: "Prod Key",
              prefix: "epx_prod...",
              createdAt: "2026-10-01T00:00:00Z",
              rpmLimit: 100,
              budgetUsage: { rpmCurrent: 95, dailyRequestsUsed: 10, dailyTokensUsed: 50 },
            },
            {
              id: "k-none",
              name: "Unbounded Key",
              prefix: "epx_free...",
              createdAt: "2026-10-01T00:00:00Z",
            },
          ]}
          keysLoading={false}
          keysLoadFailed={false}
          apiBase="http://127.0.0.1:8787"
          onSelect={() => {}}
        />
      </LanguageProvider>,
    );
  });

  const rows = host.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  const fillHigh = rows[0]!.querySelector<HTMLElement>(".bg-danger");
  expect(fillHigh).not.toBeNull();
  expect(fillHigh!.style.width).toBe("95%");
  expect(rows[1]!.querySelector(".bg-accent, .bg-danger")).toBeNull();
});

test("ApiKeyBudgetCard toggles unsaved indicator badge when draft values diverge from saved limits", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ApiKeyBudgetCard
          entry={{
            id: "k-1",
            name: "Dev",
            prefix: "epx_dev...",
            createdAt: "2026-10-01T00:00:00Z",
            rpmLimit: 60,
          }}
          onSave={async () => true}
        />
      </LanguageProvider>,
    );
  });

  const unsavedText = uxT("en", "budget.unsaved");
  expect(host.textContent).not.toContain(unsavedText);

  const rpmInput = host.querySelector<HTMLInputElement>("#awi-budget-rpm")!;
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(rpmInput, "120");
    rpmInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain(unsavedText);

  await act(async () => {
    setter.call(rpmInput, "60");
    rpmInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  expect(host.textContent).not.toContain(unsavedText);
});
