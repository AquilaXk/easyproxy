import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useI18n } from "../src/i18n/shared";
import { uxT } from "../src/i18n/ux-overhaul-copy";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { UsageTokenMixPanel } from "../src/components/v2-usage/usage-token-mix";
import { UsageModelsTable, UsageProvidersTable } from "../src/components/v2-usage/usage-breakdown";
import type { UsageModel, UsageProvider, UsageSummaryTotals } from "../src/components/v2-usage/usage-model";
import GatewayGuardrailsPanel from "../src/components/GatewayGuardrailsPanel";
import { ScenarioRoutingPanel } from "../src/components/ScenarioRoutingPanel";
import { ContextInspectorPanel } from "../src/components/ContextInspectorPanel";
import { LogsTelemetryStrip } from "../src/components/v2-logs/logs-telemetry-strip";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#usage" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function UsageHarness({
  summary,
  models,
  providers,
}: {
  summary: UsageSummaryTotals;
  models: UsageModel[];
  providers: UsageProvider[];
}) {
  const { locale, t } = useI18n();
  return (
    <div>
      <UsageTokenMixPanel summary={summary} locale={locale} t={t} />
      <UsageModelsTable
        models={models}
        totalModels={models.length}
        modelQuery=""
        onModelQuery={() => {}}
        locale={locale}
        t={t}
      />
      <UsageProvidersTable providers={providers} models={models} locale={locale} t={t} />
    </div>
  );
}

describe("Gateway token efficiency & v2 UX surfaces", () => {
  test("UsageTokenMixPanel separates cache hits from the active input/output bar and renders hit rate + net USD savings", async () => {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;

    const summary: UsageSummaryTotals = {
      requests: 12,
      measuredRequests: 12,
      estimatedRequests: 0,
      unreportedRequests: 0,
      unsupportedRequests: 0,
      inputTokens: 1_040_000, // 1,000,000 cache read + 10,000 cache write + 30,000 uncached = 40,000 active prompt
      outputTokens: 40_000,
      reasoningOutputTokens: 12_000,
      cachedInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 10_000,
      totalTokens: 1_080_000,
      cacheHitRate: 1_000_000 / 1_040_000,
      estimatedCacheSavingsUsd: 2.65,
    };

    try {
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <UsageHarness summary={summary} models={[]} providers={[]} />
          </LanguageProvider>,
        );
      });

      const section = host.querySelector('section[aria-labelledby="usage-token-mix-title"]')!;
      expect(section).toBeTruthy();
      expect(section.textContent).toContain("Token mix & cache efficiency");
      expect(section.textContent).toContain("Hit rate 96%");
      expect(section.textContent).toContain("Saved ~$2.65");
      expect(section.textContent).toContain("incl. 12K reasoning");

      // Active prompt (30K uncached + 10K cache write = 40K, 50%) == Output (40K, 50%),
      // with distinct color-matched bar segments for uncached input, cache write, and output!
      const barImg = section.querySelector('[role="img"]')!;
      expect(barImg.getAttribute("aria-label")).toContain("Uncached input 30K, Cache writes 10K, Generated output 40K");
      const barSegments = section.querySelectorAll('[role="img"] > span');
      expect(barSegments).toHaveLength(3);
      expect((barSegments[0] as HTMLElement).getAttribute("data-part")).toBe("uncached-input");
      expect((barSegments[0] as HTMLElement).style.width).toBe("37.5%");
      expect((barSegments[1] as HTMLElement).getAttribute("data-part")).toBe("cache-write");
      expect((barSegments[1] as HTMLElement).style.width).toBe("12.5%");
      expect((barSegments[2] as HTMLElement).getAttribute("data-part")).toBe("output");
      expect((barSegments[2] as HTMLElement).style.width).toBe("50%");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("UsageModelsTable and UsageProvidersTable expose keyboard-scrollable regions, aria-sort on active header only, and provider cache columns", async () => {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;

    const models: UsageModel[] = [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        requests: 5,
        measuredRequests: 5,
        estimatedRequests: 0,
        unreportedRequests: 0,
        unsupportedRequests: 0,
        inputTokens: 80_000,
        outputTokens: 20_000,
        totalTokens: 100_000,
        shareRatio: 0.8,
        estimatedCostUsd: 0.45,
        pricedRequests: 5,
        unpricedRequests: 0,
        cacheReadInputTokens: 60_000,
        cacheHitRate: 0.75,
        cacheObservedInputTokens: 80_000,
        cacheObservedRequests: 5,
      },
      {
        provider: "openai",
        model: "gpt-5",
        requests: 20,
        measuredRequests: 20,
        estimatedRequests: 0,
        unreportedRequests: 0,
        unsupportedRequests: 0,
        inputTokens: 15_000,
        outputTokens: 10_000,
        totalTokens: 25_000,
        shareRatio: 0.2,
        estimatedCostUsd: 1.9,
        pricedRequests: 20,
        unpricedRequests: 0,
        cacheReadInputTokens: 5_000,
        cacheHitRate: 0.33,
        cacheObservedInputTokens: 15_000,
        cacheObservedRequests: 20,
      },
    ];

    const providers: UsageProvider[] = [
      {
        provider: "anthropic",
        requests: 5,
        measuredRequests: 5,
        estimatedRequests: 0,
        unreportedRequests: 0,
        unsupportedRequests: 0,
        inputTokens: 80_000,
        outputTokens: 20_000,
        totalTokens: 100_000,
        shareRatio: 0.8,
        estimatedCostUsd: 0.45,
        pricedRequests: 5,
        unpricedRequests: 0,
        cacheReadInputTokens: 60_000,
        cacheHitRate: 0.75,
      },
    ];

    const summary: UsageSummaryTotals = {
      requests: 25,
      measuredRequests: 25,
      estimatedRequests: 0,
      unreportedRequests: 0,
      unsupportedRequests: 0,
      inputTokens: 95_000,
      outputTokens: 30_000,
      totalTokens: 125_000,
    };

    try {
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <UsageHarness summary={summary} models={models} providers={providers} />
          </LanguageProvider>,
        );
      });

      const regions = host.querySelectorAll('.tbl-wrap[tabindex="0"][role="region"]');
      expect(regions.length).toBeGreaterThanOrEqual(2);

      const modelsTable = host.querySelector("table.usage-models-tbl")!;
      // Default sort is Tokens descending -> claude-sonnet-4-5 first, only one th has aria-sort.
      const sortedHeadersInitial = modelsTable.querySelectorAll("th[aria-sort]");
      expect(sortedHeadersInitial).toHaveLength(1);
      expect(sortedHeadersInitial[0]!.getAttribute("aria-sort")).toBe("descending");
      expect(modelsTable.querySelectorAll("tbody tr")[0]!.textContent).toContain("claude-sonnet-4-5");

      // Click Requests sort button -> descending puts gpt-5 (20 reqs) first, second click toggles ascending!
      const reqSortBtn = [...modelsTable.querySelectorAll("th button")]
        .find(b => b.textContent?.trim() === "Requests") as HTMLButtonElement;
      expect(reqSortBtn).toBeTruthy();
      expect(reqSortBtn.hasAttribute("aria-sort")).toBe(false);

      await act(async () => { reqSortBtn.click(); });
      const activeAfterFirst = modelsTable.querySelectorAll("th[aria-sort]");
      expect(activeAfterFirst).toHaveLength(1);
      expect(activeAfterFirst[0]!.getAttribute("aria-sort")).toBe("descending");
      expect(modelsTable.querySelectorAll("tbody tr")[0]!.textContent).toContain("gpt-5");

      await act(async () => { reqSortBtn.click(); });
      expect(modelsTable.querySelector("th[aria-sort]")!.getAttribute("aria-sort")).toBe("ascending");
      expect(modelsTable.querySelectorAll("tbody tr")[0]!.textContent).toContain("claude-sonnet-4-5");

      // Screen-reader status announcer updated cleanly
      const statusRegions = [...host.querySelectorAll('[role="status"]')].map(el => el.textContent);
      expect(statusRegions.some(txt => txt?.includes("Sorted by Requests"))).toBe(true);

      // Providers table renders Cache hits and Hit rate columns
      const providersSection = host.querySelector('section[aria-labelledby="usage-providers-title"]')!;
      expect(providersSection.textContent).toContain("60K");
      expect(providersSection.textContent).toContain("75%");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("GatewayGuardrailsPanel surfaces 6-stat telemetry, JSON/dedup options, sample loaders, and duplicatePass dry-run", async () => {
    const dryRunBodies: Array<Record<string, unknown>> = [];
    const putBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/gateway-guardrails/dry-run") && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        dryRunBodies.push(parsed);
        return Response.json({
          blocked: false,
          limitExceeded: false,
          matches: 0,
          redactions: 0,
          findings: [],
          compressedItems: 0,
          compactedJsonItems: 1,
          deduplicatedItems: parsed.duplicatePass ? 1 : 0,
          originalChars: 2400,
          outputChars: 900,
          savedChars: 1500,
          estimatedSavedTokens: 375,
          previewText: "[easyproxy deduplicated tool output: identical to call_id=call_dryrun_1]",
          contextInspection: {
            model: "claude-sonnet-4-6",
            usedTokens: 12_000,
            contextWindowTokens: 200_000,
            cache: {
              wireFormat: "anthropic-messages",
              explicitBreakpoints: 1,
              cacheablePrefixTokens: 10_000,
              cacheablePrefixShare: 10_000 / 12_000,
              breakeven: {
                prefixTokens: 10_000,
                writeTtl: "1h",
                economicsAvailable: true,
                writePremiumUsd: 0.03,
                perHitSavingsUsd: 0.027,
                breakevenFollowUpHits: 3 / 2.7,
                breakevenHitCount: 2,
                warmRefreshCostUsd: 0.003,
                missPenaltyUsd: 0.0030015,
                activeExpectedSavingsUsd: 0.051,
                idleExpectedSavingsUsd: -0.003,
                worthwhileActive: true,
                worthwhileIdle: false,
              },
            },
          },
        });
      }
      if (url.endsWith("/api/gateway-guardrails") && init?.method === "PUT") {
        const parsed = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        putBodies.push(parsed);
        return Response.json({
          ...parsed,
          stats: {
            scannedRequests: 10,
            secretDetections: 1,
            secretBlocks: 0,
            compressedToolOutputs: 3,
            compactedJsonOutputs: 4,
            deduplicatedToolOutputs: 2,
            savedChars: 16_000,
            estimatedSavedTokens: 4_000,
          },
        });
      }
      return Response.json({
        outboundSecretGuard: { mode: "redact" },
        toolOutputCompression: {
          enabled: true,
          minChars: 12000,
          headChars: 4000,
          tailChars: 4000,
          stripAnsi: true,
          compactJson: false,
          deduplicateIdentical: false,
          dedupMinChars: 1024,
        },
        stats: {
          scannedRequests: 10,
          secretDetections: 1,
          secretBlocks: 0,
          compressedToolOutputs: 3,
          compactedJsonOutputs: 4,
          deduplicatedToolOutputs: 2,
          savedChars: 16_000,
          estimatedSavedTokens: 4_000,
        },
      });
    }) as typeof fetch;

    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;

    try {
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <GatewayGuardrailsPanel apiBase="http://127.0.0.1:8787" />
          </LanguageProvider>,
        );
        await new Promise(r => setTimeout(r, 15));
      });

      // 6-stat bar sums compacted(4) + deduplicated(2) = 6 JSON/Dedup hits and ~4,000 saved tokens
      expect(host.textContent).toContain("JSON / Dedup hits");
      expect(host.textContent).toContain("Est. tokens saved");
      expect(host.textContent).toContain("~4,000");

      // Re-enable compactJson + deduplicateIdentical and reset dedupMinChars to 512 so dry-run overrides disk false/1024 values!
      const switches = [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
      await act(async () => {
        switches[2]!.click();
        switches[3]!.click();
      });
      const dedupMinInput = host.querySelector<HTMLInputElement>("#guardrails-dedup-min-chars")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
        setter.call(dedupMinInput, "512");
        dedupMinInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
        dedupMinInput.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
      });

      // Load JSON sample, enable duplicatePass checkbox, and run dry-run
      const sampleJsonBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Load JSON sample")!;
      await act(async () => { sampleJsonBtn.click(); });

      const dupCheckbox = [...host.querySelectorAll<HTMLInputElement>('section[aria-labelledby="guardrails-dryrun-title"] input[type="checkbox"]')][0]!;
      await act(async () => { dupCheckbox.click(); });

      const runBtn = host.querySelector<HTMLButtonElement>('section[aria-labelledby="guardrails-dryrun-title"] button')!;
      expect(runBtn.textContent).toBe("Run test");
      await act(async () => {
        runBtn.click();
        await new Promise(r => setTimeout(r, 15));
      });

      expect(dryRunBodies).toHaveLength(1);
      expect(dryRunBodies[0]!.duplicatePass).toBe(true);
      expect(dryRunBodies[0]!.toolOutputCompression).toMatchObject({
        compactJson: true,
        deduplicateIdentical: true,
        dedupMinChars: 512,
      });
      expect(host.textContent).toContain("Saved 1,500 chars (~375 tokens, 63%)");
      const dryRunBreakeven = host.querySelector('[data-dryrun-breakeven="true"]');
      expect(dryRunBreakeven).not.toBeNull();
      expect(dryRunBreakeven!.textContent).toContain("anthropic-messages");
      expect(dryRunBreakeven!.textContent).toContain("Cache breakeven (1h)");
      expect(dryRunBreakeven!.textContent).toContain("Break-even: 2 follow-up hits");
      expect(dryRunBreakeven!.textContent).toContain("Worthwhile");
      expect(dryRunBreakeven!.textContent).toContain("Write +$0.0300 · Hit -$0.0270 · Expected (active/idle): $0.0510 / -$0.0030");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("ScenarioRoutingPanel skips fetch while hidden, preserves unsaved edits across locale switches, recovers from mid-probe tab hide, and preserves extra fields on PUT", async () => {
    let getCalls = 0;
    const putBodies: Array<Record<string, unknown>> = [];
    let deleteCalls = 0;
    const classifyBodies: Array<Record<string, unknown>> = [];
    let classifyGate: Promise<void> | null = null;
    let abortedClassify = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/routing/scenario") && (!init?.method || init.method === "GET")) {
        getCalls += 1;
        return Response.json({
          scenarioRouting: {
            enabled: true,
            precedence: ["think", "background"],
            thinkBudgetThreshold: 2048,
            matchModels: ["gpt-5"],
            routes: { background: "openai/gpt-5-mini" },
          },
        });
      }
      if (url.endsWith("/api/routing/scenario") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        putBodies.push(body);
        return Response.json({ success: true, scenarioRouting: body.scenarioRouting });
      }
      if (url.endsWith("/api/routing/scenario") && init?.method === "DELETE") {
        deleteCalls += 1;
        return Response.json({ success: true, scenarioRouting: null });
      }
      if (url.endsWith("/api/routing/scenario/classify") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        classifyBodies.push(body);
        if (classifyGate) await classifyGate;
        if (init?.signal?.aborted) {
          abortedClassify += 1;
          throw new Error("aborted");
        }
        return Response.json({
          active: true,
          matched: "background",
          targetSelector: "openai/gpt-5-mini",
          resolvedTarget: { provider: "openai", model: "gpt-5-mini", routeKind: "provider" },
          classification: {
            matched: "background",
            matchedScenarios: ["background"],
            estimatedTokens: 42,
            signals: { background: true, longContext: false, webSearch: false, think: false },
            truncated: false,
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    function LocaleHarness({ active }: { active: boolean }) {
      const { setLocale } = useI18n();
      return (
        <div>
          <button type="button" data-test-ko onClick={() => setLocale("ko")}>KO</button>
          <button type="button" data-test-en onClick={() => setLocale("en")}>EN</button>
          <ScenarioRoutingPanel
            apiBase="http://127.0.0.1:8787"
            active={active}
            routeSuggestions={["openai/gpt-5-mini", "anthropic/claude-opus-4-6"]}
          />
        </div>
      );
    }

    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;

    try {
      // 1. Hidden mount issues ZERO network requests
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <LocaleHarness active={false} />
          </LanguageProvider>,
        );
      });
      await act(async () => { await new Promise(r => setTimeout(r, 15)); });
      expect(getCalls).toBe(0);

      // 2. Becoming active fetches config
      await act(async () => {
        root.render(
          <LanguageProvider>
            <LocaleHarness active={true} />
          </LanguageProvider>,
        );
      });
      await act(async () => { await new Promise(r => setTimeout(r, 15)); });
      expect(getCalls).toBe(1);

      // 3. Edit webSearch route, switch locale en -> ko -> en without saving: unsaved draft is preserved and no extra GET fires!
      const routeInputs = [...host.querySelectorAll<HTMLInputElement>('input[type="text"]')];
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
        setter.call(routeInputs[2]!, "anthropic/claude-haiku-4-5");
        routeInputs[2]!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
        routeInputs[2]!.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>("[data-test-ko]")!.click();
        await new Promise(r => setTimeout(r, 15));
      });
      expect(getCalls).toBe(1);
      expect(host.querySelectorAll<HTMLInputElement>('input[type="text"]')[2]!.value).toBe("anthropic/claude-haiku-4-5");
      await act(async () => {
        host.querySelector<HTMLButtonElement>("[data-test-en]")!.click();
        await new Promise(r => setTimeout(r, 15));
      });

      // 4. Toggle enabled off -> back on before saving -> preserves precedence, thinkBudgetThreshold, matchModels + edited route
      const enableSwitch = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
      await act(async () => { enableSwitch.click(); });
      await act(async () => { enableSwitch.click(); });

      const saveBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Save scenario routes")!;
      await act(async () => {
        saveBtn.click();
        await new Promise(r => setTimeout(r, 15));
      });
      expect(putBodies).toHaveLength(1);
      expect(putBodies[0]!.scenarioRouting).toEqual({
        enabled: true,
        longContextThresholdTokens: 60000,
        precedence: ["think", "background"],
        thinkBudgetThreshold: 2048,
        matchModels: ["gpt-5"],
        routes: { background: "openai/gpt-5-mini", webSearch: "anthropic/claude-haiku-4-5" },
      });

      // 5. Start in-flight classify probe, hide tab (`active=false`), resolve gate, re-show (`active=true`) -> aborts & never locks button disabled
      let releaseClassify!: () => void;
      classifyGate = new Promise<void>(r => { releaseClassify = r; });
      const probeBtnInitial = [...host.querySelectorAll("button")].find(b => b.textContent === "Classify sample")!;
      await act(async () => { probeBtnInitial.click(); });
      expect(probeBtnInitial.disabled).toBe(true);

      await act(async () => {
        root.render(
          <LanguageProvider>
            <LocaleHarness active={false} />
          </LanguageProvider>,
        );
      });
      releaseClassify();
      classifyGate = null;
      await act(async () => { await new Promise(r => setTimeout(r, 15)); });
      expect(abortedClassify).toBe(1);

      await act(async () => {
        root.render(
          <LanguageProvider>
            <LocaleHarness active={true} />
          </LanguageProvider>,
        );
        await new Promise(r => setTimeout(r, 15));
      });

      // Probe button is enabled again and completes cleanly
      const probeBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Classify sample")!;
      expect(probeBtn.disabled).toBe(false);
      await act(async () => {
        probeBtn.click();
        await new Promise(r => setTimeout(r, 15));
      });
      expect(classifyBodies.length).toBeGreaterThanOrEqual(2);
      expect(host.textContent).toContain("openai/gpt-5-mini (~42 tokens)");

      // Reset clears scenario routing
      const resetBtn = [...host.querySelectorAll("button")].find(b => b.textContent === "Reset")!;
      await act(async () => {
        resetBtn.click();
        await new Promise(r => setTimeout(r, 15));
      });
      expect(deleteCalls).toBe(1);
      expect(host.querySelectorAll("datalist")).toHaveLength(0);
      expect(host.querySelectorAll('[role="combobox"]').length).toBeGreaterThanOrEqual(4);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("UsageProvidersTable expands inline constituent models and ContextInspectorPanel + LogsTelemetryStrip render token/cache composition", async () => {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;

    const models: UsageModel[] = [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        requests: 8,
        measuredRequests: 8,
        reportedRequests: 8,
        estimatedRequests: 0,
        totalTokens: 120_000,
        inputTokens: 110_000,
        outputTokens: 10_000,
        cacheReadInputTokens: 95_000,
        cacheObservedInputTokens: 110_000,
        cacheHitRate: 95_000 / 110_000,
        estimatedCostUsd: 0.42,
        estimatedCacheSavingsUsd: 0.24,
        pricedRequests: 8,
        unpricedRequests: 0,
        shareRatio: 0.75,
      },
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        requests: 4,
        measuredRequests: 4,
        reportedRequests: 4,
        estimatedRequests: 0,
        totalTokens: 40_000,
        inputTokens: 36_000,
        outputTokens: 4_000,
        cacheReadInputTokens: 28_000,
        cacheObservedInputTokens: 36_000,
        cacheHitRate: 28_000 / 36_000,
        estimatedCostUsd: 0.05,
        estimatedCacheSavingsUsd: 0.02,
        pricedRequests: 4,
        unpricedRequests: 0,
        shareRatio: 0.25,
      },
    ];
    const providers: UsageProvider[] = [
      {
        provider: "anthropic",
        requests: 12,
        measuredRequests: 12,
        reportedRequests: 12,
        estimatedRequests: 0,
        totalTokens: 160_000,
        cacheReadInputTokens: 123_000,
        cacheObservedInputTokens: 146_000,
        cacheHitRate: 123_000 / 146_000,
        estimatedCostUsd: 0.47,
        estimatedCacheSavingsUsd: 0.26,
        pricedRequests: 12,
        unpricedRequests: 0,
        shareRatio: 1,
      },
    ];

    function InspectorAndDrilldownHarness() {
      const { locale, t } = useI18n();
      return (
        <div>
          <UsageProvidersTable providers={providers} models={models} locale={locale} t={t} />
          <ContextInspectorPanel />
          <LogsTelemetryStrip
            locale={locale}
            logs={[
              {
                cacheProvenance: "observed",
                usage: { inputTokens: 50_000, outputTokens: 2_000, cacheReadInputTokens: 40_000, totalTokens: 52_000 },
                displayMetrics: { cost: { kind: "value", estimate: { cost: { total: 0.12 }, netCacheSavingsUsd: 0.09 } } },
              },
            ]}
          />
        </div>
      );
    }

    try {
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <InspectorAndDrilldownHarness />
          </LanguageProvider>,
        );
      });

      expect(host.querySelectorAll(".usage-provider-child-row")).toHaveLength(0);
      const expandBtn = host.querySelector<HTMLButtonElement>('[data-provider-expand="anthropic"]');
      expect(expandBtn).not.toBeNull();
      expect(expandBtn?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        expandBtn!.click();
      });
      expect(expandBtn?.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelectorAll(".usage-provider-child-row")).toHaveLength(2);
      expect(host.textContent).toContain("Saved ~$0.2600");

      // ContextInspectorPanel renders 128 occupied Fit cells by default, switches to Window mode,
      // filters contributors by clicked category, opens bounded entry previews, and loads Responses samples.
      const inspectorBreakeven = host.querySelector('[data-inspector-breakeven="true"]');
      expect(inspectorBreakeven).not.toBeNull();
      expect(inspectorBreakeven!.textContent).toContain("Cache breakeven (1h)");
      expect(inspectorBreakeven!.textContent).toContain("Break-even: 2 follow-up hits");
      expect(host.querySelectorAll(".ctx-inspector-cell")).toHaveLength(128);
      expect(host.querySelectorAll(".ctx-inspector-cell.ctx-swatch--free")).toHaveLength(0);

      const windowModeBtn = host.querySelector<HTMLButtonElement>('[data-inspector-mode="window"]');
      expect(windowModeBtn).not.toBeNull();
      await act(async () => {
        windowModeBtn!.click();
      });
      expect(windowModeBtn?.getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelectorAll(".ctx-inspector-cell.ctx-swatch--free").length).toBeGreaterThan(100);

      const mcpCategoryBtn = host.querySelector<HTMLButtonElement>('[data-inspector-category="mcp"]');
      expect(mcpCategoryBtn).not.toBeNull();
      await act(async () => {
        mcpCategoryBtn!.click();
      });
      expect(mcpCategoryBtn?.getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain("mcp__github__search_code");
      expect(host.textContent).not.toContain("tool_result:toolu_01A");

      const previewEntryBtn = host.querySelector<HTMLButtonElement>("[data-inspector-entry]");
      expect(previewEntryBtn).not.toBeNull();
      await act(async () => {
        previewEntryBtn!.click();
      });
      expect(previewEntryBtn?.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector("pre")?.textContent).toContain("mcp__github__search_code");

      expect(host.textContent).toContain("MCP tools");
      expect(host.textContent).toContain("80%");
      expect(host.textContent).toContain("~$0.0900");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("Logs responsive drawer layout avoids phantom colSpan tracks, mid-word model wrapping, TTFT clipping, and below-fold token bar", () => {
    const logsSource = readFileSync(new URL("../src/pages/Logs.tsx", import.meta.url), "utf8");
    const logsCss = readFileSync(new URL("../src/design/pages/logs.css", import.meta.url), "utf8");

    // Virtual spacer cells must not use colSpan > visible @container columns in table-layout: fixed.
    expect(logsSource).not.toMatch(/colSpan=\{[^}]+\}[^>]*logs-virtual-spacer/);
    // Model label uses single-line ellipsis truncation instead of mid-character break-words.
    expect(logsSource).toContain("truncate font-mono text-[13px] text-fg\">{servedModelLabel(log)}");
    // .logs-model-primary must not carry @layer utilities items-center/gap-* that override @layer bridge @container rules.
    const modelPrimaryMatch = logsSource.match(/className="([^"]*logs-model-primary[^"]*)"/);
    expect(modelPrimaryMatch).not.toBeNull();
    expect(modelPrimaryMatch![1]).not.toContain("items-center");
    expect(modelPrimaryMatch![1]).not.toMatch(/\bgap-/);
    // Token efficiency bar & raw usage sit directly below Basic section in the detail drawer.
    const basicIdx = logsSource.indexOf('aria-labelledby="log-detail-basic"');
    const usageIdx = logsSource.indexOf('aria-labelledby="log-detail-usage"');
    const routeIdx = logsSource.indexOf('aria-labelledby="log-detail-route"');
    expect(basicIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeGreaterThan(basicIdx);
    expect(routeIdx).toBeGreaterThan(usageIdx);

    // Duration column stays wide enough for "TTFT 320ms" / "TTFT 9999ms" in both wide and @container<=880px layouts.
    expect(logsCss).toContain("col.logs-col-duration { width: 108px; }");
    expect(logsCss).toContain(".logs-page .logs-model-primary { flex-wrap: wrap; align-items: center; gap: 2px 6px; }");
    const rule880 = logsCss.slice(logsCss.indexOf("@container (max-width: 880px)"), logsCss.indexOf("@container (max-width: 720px)"));
    expect(rule880).toContain("col.logs-col-duration { width: 96px; }");
    expect(rule880).toContain(".logs-model-primary { flex-direction: column; flex-wrap: nowrap; align-items: flex-start; gap: 2px; }");

    // Every locale's ux.logs.ttftCompact must stay <= 12 chars at 9999ms so 96px col.logs-col-duration never clips.
    for (const loc of ["de", "en", "fr", "ja", "ko", "pt", "ru", "tr", "vi", "zh", "zh-TW"] as const) {
      const rendered = uxT(loc, "logs.ttftCompact", { ms: 9999 });
      expect(rendered.length).toBeLessThanOrEqual(12);
    }
  });

  test("GatewayGuardrailsPanel scrolls #gateway-context-inspector into view after details::details-content transition settles", async () => {
    globalThis.fetch = (async () => Response.json({
      outboundSecretGuard: { mode: "redact" },
      toolOutputCompression: { enabled: true, minChars: 12000, headChars: 4000, tailChars: 4000, stripAnsi: true },
      stats: { scannedRequests: 0, secretDetections: 0, secretBlocks: 0, compressedToolOutputs: 0, compactedJsonOutputs: 0, deduplicatedToolOutputs: 0, savedChars: 0, estimatedSavedTokens: 0 },
    })) as unknown as typeof fetch;

    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <GatewayGuardrailsPanel apiBase="http://127.0.0.1:43123" />
          </LanguageProvider>,
        );
        await new Promise(r => setTimeout(r, 20));
      });
      const details = host.querySelector<HTMLDetailsElement>("#gateway-context-inspector");
      expect(details).not.toBeNull();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });

      let expanded = false;
      const scrollCalls: unknown[] = [];
      details!.getBoundingClientRect = () => ({
        top: 636,
        bottom: expanded ? 1567 : 674,
        left: 0,
        right: 900,
        width: 900,
        height: expanded ? 931 : 38,
        x: 0,
        y: 636,
        toJSON: () => ({}),
      });
      details!.scrollIntoView = (arg?: unknown) => {
        scrollCalls.push(arg);
      };

      // Simulate t=0ms open while ::details-content is still at block-size:0 (bottom 674 <= 1000),
      // followed by transition completion before the 220ms post-transition check.
      await act(async () => {
        details!.open = true;
        details!.dispatchEvent(new testWindow.Event("toggle"));
      });
      expect(scrollCalls.length).toBe(0);

      expanded = true;
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 250));
      });
      expect(scrollCalls).toEqual([{ block: "start" }]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("GatewayGuardrailsPanel forwards selected cacheTtl to ContextInspectorPanel writeTtl", async () => {
    globalThis.fetch = (async () => Response.json({
      outboundSecretGuard: { mode: "redact" },
      toolOutputCompression: { enabled: true, minChars: 12000, headChars: 4000, tailChars: 4000, stripAnsi: true },
      promptCacheInjection: { enabled: true, ttl: "1h", stripVolatileSystemTimestamps: true },
      supportsPromptCacheInjection: true,
      stats: { scannedRequests: 0, secretDetections: 0, secretBlocks: 0, compressedToolOutputs: 0, compactedJsonOutputs: 0, deduplicatedToolOutputs: 0, savedChars: 0, estimatedSavedTokens: 0 },
    })) as unknown as typeof fetch;

    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(host);
        root.render(
          <LanguageProvider>
            <GatewayGuardrailsPanel apiBase="http://127.0.0.1:43123" />
          </LanguageProvider>,
        );
        await new Promise(r => setTimeout(r, 30));
      });
      const details = host.querySelector<HTMLDetailsElement>("#gateway-context-inspector");
      expect(details).not.toBeNull();
      expect(details!.textContent).toContain("(1h)");

      const trigger = host.querySelector<HTMLButtonElement>("#guardrails-cache-ttl");
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger!.click();
        await new Promise(r => setTimeout(r, 10));
      });
      const opt5m = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .find(opt => opt.textContent?.trim() === "5m");
      expect(opt5m).toBeDefined();
      await act(async () => {
        opt5m!.click();
        await new Promise(r => setTimeout(r, 20));
      });
      expect(details!.textContent).toContain("(5m)");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
