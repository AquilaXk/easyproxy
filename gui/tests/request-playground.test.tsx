import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n";
import RequestPlaygroundModal from "../src/components/RequestPlaygroundModal";
import { buildPlaygroundCurl, buildPlaygroundPayload } from "../src/lib/playground-client";

const DOM_GLOBALS = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof DOM_GLOBALS)[number];

let prevDescriptors: Record<DomGlobal, PropertyDescriptor | undefined>;
let prevFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLDivElement;
let root: Root | null = null;

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  prevDescriptors = Object.fromEntries(DOM_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)])) as typeof prevDescriptors;
  prevFetch = globalThis.fetch;
  win = new Window({ url: "http://127.0.0.1:8787/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    HTMLElement: { configurable: true, value: win.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  host = win.document.createElement("div");
  win.document.body.appendChild(host);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => { r.unmount(); });
  }
  host.remove();
  globalThis.fetch = prevFetch;
  for (const k of DOM_GLOBALS) restoreOwnProperty(globalThis, k, prevDescriptors[k]);
});

describe("RequestPlaygroundModal", () => {
  test("builds payloads and shell-escaped cURL commands per endpoint", () => {
    const chatPayload = buildPlaygroundPayload("/v1/chat/completions", "gpt-5.3-codex", "be terse", "hi'all", true);
    expect(chatPayload).toEqual({
      model: "gpt-5.3-codex",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi'all" },
      ],
      stream: true,
    });
    const curl = buildPlaygroundCurl("http://127.0.0.1:8787", "/v1/responses", {
      model: "gpt-5.3-codex",
      input: "hi'all",
      stream: false,
    });
    expect(curl).toContain("'http://127.0.0.1:8787/v1/responses'");
    expect(curl).toContain("hi'\"'\"'all");
  });

  test("streams SSE deltas, computes TTFT/status telemetry, and closes on Escape", async () => {
    let closed = 0;
    const encoder = new TextEncoder();
    let copiedText = "";
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copiedText = text; } },
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.3-codex" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <RequestPlaygroundModal apiBase="http://127.0.0.1:8787" onClose={() => { closed += 1; }} />
        </LanguageProvider>,
      );
    });

    const promptArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(promptArea, "Say hi");
      promptArea.dispatchEvent(new win.Event("input", { bubbles: true }));
    });

    const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submitBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(host.querySelector(".playground-output")?.textContent).toBe("Hello world");
    expect(host.querySelector(".playground-telemetry")?.textContent).toContain("HTTP 200");
    expect(host.querySelector(".playground-telemetry")?.textContent).toContain("TTFT");

    const copyBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Copy cURL"))!;
    await act(async () => {
      copyBtn.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(copiedText).toContain("/v1/chat/completions");
    expect(copiedText).toContain("Say hi");

    await act(async () => {
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
  });

  test("supports optional maxTokens payloads and side-by-side A/B compare execution", async () => {
    expect(buildPlaygroundPayload("/v1/chat/completions", "gpt-5.3-codex", "", "hi", false, 512)).toEqual({
      model: "gpt-5.3-codex",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 512,
    });
    expect(buildPlaygroundPayload("/v1/responses", "gpt-5.3-codex", "", "hi", false, 256)).toEqual({
      model: "gpt-5.3-codex",
      input: "hi",
      stream: false,
      max_output_tokens: 256,
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-alpha" }, { id: "model-beta" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      return new Response(JSON.stringify({
        choices: [{ message: { content: `reply:${parsed.model}` } }],
        usage: { completion_tokens: 25 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <RequestPlaygroundModal apiBase="http://127.0.0.1:8787" onClose={() => {}} />
        </LanguageProvider>,
      );
      await new Promise((r) => setTimeout(r, 15));
    });

    expect(host.querySelector("dialog.playground-native-dialog")).not.toBeNull();
    const compareBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("A/B Compare"))!;
    await act(async () => {
      compareBtn.click();
    });

    const promptArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(promptArea, "Compare speed");
      promptArea.dispatchEvent(new win.Event("input", { bubbles: true }));
    });

    const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submitBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const outputs = Array.from(host.querySelectorAll(".playground-output")).map((el) => el.textContent);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toContain("reply:");
    expect(outputs[1]).toContain("reply:");
    expect(host.querySelector(".playground-telemetry")?.textContent).toContain("25 tok");
  });

  test("Escape inside an open Select menu closes only the Select without closing Playground", async () => {
    let closed = 0;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <RequestPlaygroundModal apiBase="http://127.0.0.1:8787" onClose={() => { closed += 1; }} />
        </LanguageProvider>,
      );
      await new Promise((r) => setTimeout(r, 15));
    });

    const selectBtn = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    expect(selectBtn).not.toBeNull();
    await act(async () => { selectBtn.click(); });
    expect(selectBtn.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      const escEvent = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      selectBtn.dispatchEvent(escEvent);
    });
    expect(selectBtn.getAttribute("aria-expanded")).toBe("false");
    expect(closed).toBe(0);

    await act(async () => {
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(1);
  });
});
