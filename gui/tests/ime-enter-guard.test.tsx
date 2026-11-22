import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { LoginHint } from "../src/components/login-url-block";
import { isImeComposing } from "../src/lib/ime";

const GLOBALS = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
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

function enterEvent(opts: { isComposing?: boolean; keyCode?: number }) {
  const event = new win.KeyboardEvent("keydown", {
    key: "Enter",
    isComposing: opts.isComposing ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (opts.keyCode !== undefined && event.keyCode !== opts.keyCode) {
    Object.defineProperty(event, "keyCode", { configurable: true, value: opts.keyCode });
  }
  return event;
}

test("isImeComposing detects nativeEvent.isComposing and Safari keyCode 229", () => {
  expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 }, keyCode: 13 })).toBe(false);
  expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 }, keyCode: 13 })).toBe(true);
  expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 }, keyCode: 13 })).toBe(true);
  expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
});

test("LoginHint paste input ignores Enter during IME composition (isComposing or keyCode 229)", async () => {
  let submits = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <LoginHint
          hint={{ url: "https://example.test/oauth" }}
          paste={{
            value: "http://127.0.0.1:4321?code=ok",
            busy: false,
            message: "",
            ok: true,
            onChange: () => {},
            onSubmit: () => { submits += 1; },
          }}
        />
      </LanguageProvider>,
    );
  });

  const input = host.querySelector<HTMLInputElement>(".login-hint-paste-row input")!;
  expect(input).not.toBeNull();

  await act(async () => {
    input.dispatchEvent(enterEvent({ isComposing: true }) as unknown as Event);
  });
  expect(submits).toBe(0);

  await act(async () => {
    input.dispatchEvent(enterEvent({ isComposing: false, keyCode: 229 }) as unknown as Event);
  });
  expect(submits).toBe(0);

  await act(async () => {
    input.dispatchEvent(enterEvent({ isComposing: false, keyCode: 13 }) as unknown as Event);
  });
  expect(submits).toBe(1);
});
