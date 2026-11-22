import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { ko } from "../src/i18n/ko";
import { LanguageProvider } from "../src/i18n/provider";
import { preloadLocaleCatalog, resetRuntimeCatalogsForTests, type Dict } from "../src/i18n/runtime-catalogs";
import { useT } from "../src/i18n/shared";

const domGlobals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof domGlobals)[number];

let previousDom: Record<DomGlobal, PropertyDescriptor | undefined>;
let testWindow: Window;
let mountedRoot: Root | null = null;

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function SampleLabel() {
  const t = useT();
  return <span data-testid="label">{t("nav.dashboard")}</span>;
}

beforeEach(() => {
  previousDom = Object.fromEntries(
    domGlobals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  ) as typeof previousDom;

  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  testWindow.localStorage.setItem("epx-lang", "ko");
});

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => { mountedRoot?.unmount(); });
    mountedRoot = null;
  }
  resetRuntimeCatalogsForTests(null);
  for (const k of domGlobals) restoreOwnProperty(globalThis, k, previousDom[k]);
  await testWindow.happyDOM?.close?.();
});

describe("LanguageProvider async catalog race", () => {
  test("renders when preloaded catalog settles after initial null render before effect mount", async () => {
    const deferred = Promise.withResolvers<Dict>();
    resetRuntimeCatalogsForTests(() => deferred.promise);

    // Mirrors main.tsx starting preloadLocaleCatalog before React renders.
    const preload = preloadLocaleCatalog("ko");
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");

    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <SampleLabel />
        </LanguageProvider>,
      );
      expect(host.textContent).toBe("");
      deferred.resolve(ko);
      await preload;
    });

    expect(host.querySelector('[data-testid="label"]')?.textContent).toBe(ko["nav.dashboard"]);
  });

  test("falls back to English catalog when non-English chunk fails to load", async () => {
    resetRuntimeCatalogsForTests(async (locale) => {
      if (locale === "ko") throw new Error("chunk failed");
      return en;
    });

    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");

    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <SampleLabel />
        </LanguageProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(host.querySelector('[data-testid="label"]')?.textContent).toBe(en["nav.dashboard"]);
  });
});
