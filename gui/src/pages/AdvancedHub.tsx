import { useDeferredValue, useEffect, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import { getLoadedDict, isLocaleLoaded, preloadLocaleCatalog, type Dict } from "../i18n/runtime-catalogs";
import type { Page } from "../app-routing";
import { IconActivity, IconBot, IconClaude, IconCodex, IconHardDrive, IconHistory, IconList, IconSearch, IconServer, IconShuffle, IconStar, IconTerminal } from "../icons";
import { HubCard } from "@/components/ui-v2/hub-card";

/*
 * The "Fine-tuning" tier: every advanced surface as one searchable grid. A card names the
 * setting in plain words, keeps the original term underneath, says when you would change
 * it, and opens the page that owns it. Nothing is configured here.
 */

interface AdvancedHubProps {
  navigate: (page: Page, subPath?: string) => void;
  onSwitchClassic?: () => void;
}

interface Entry {
  id: string;
  title: TKey;
  when: TKey;
  /**
   * The line under the title: a product name used in docs and the CLI, kept as is (`name`), or
   * a descriptive phrase from the copy table (`key`).
   */
  term: { name: string } | { key: TKey };
  Icon: typeof IconBot;
  page: Page;
  subPath?: string;
  /** Labels of the settings this page holds, so a search for one of them finds its card. */
  finds?: readonly TKey[];
  /** Untranslated product words people type in any language (sidecar, fallback, …). */
  words?: readonly string[];
}

const ENTRIES: readonly Entry[] = [
  { id: "subagents", title: "shellV2.advSubagents", when: "shellV2.advSubagentsWhen", term: { name: "Subagents" }, Icon: IconBot, page: "subagents",
    finds: ["dash.injectionLabel", "dash.multiAgent"], words: ["delegation", "agents"] },
  { id: "advisor", title: "shellV2.advAdvisor", when: "shellV2.advAdvisorWhen", term: { name: "Advisor" }, Icon: IconStar, page: "advisor",
    finds: ["nav.advisor", "advisor.policy", "proxyV2.consentTitle"], words: ["consult", "preflight"] },
  { id: "proxy", title: "shellV2.advProxy", when: "shellV2.advProxyWhen", term: { key: "proxyV2.advTermProxy" }, Icon: IconActivity, page: "dashboard",
    finds: [
      "dash.webSearchSidecar", "dash.visionSidecar", "dash.shadowCallIntercept", "compactionRouting.title",
      "memoryModels.title", "fallback.title", "dash.syncModels", "dash.codexAutoStart", "dash.codexDesktopAuthless",
      "dash.effortCapLabel", "nativeReasoningRetention.title", "reasoningRetention.title", "dash.checkUpdate",
      "proxyV2.secGuardrails", "proxyV2.secTelemetry", "proxyV2.telemetryToggleLabel",
    ],
    words: ["web search", "vision", "shadow", "fallback", "reasoning", "update", "sync", "telemetry", "privacy", "guardrails", "secret guard", "dlp", "compression"] },
  { id: "routing", title: "shellV2.advRouting", when: "shellV2.advRoutingWhen", term: { key: "proxyV2.advTermRouting" }, Icon: IconShuffle, page: "models", subPath: "routing" },
  { id: "prompt", title: "shellV2.advPrompt", when: "shellV2.advPromptWhen", term: { key: "proxyV2.advTermPrompt" }, Icon: IconTerminal, page: "codex-set", subPath: "prompt" },
  { id: "claude", title: "shellV2.advClaude", when: "shellV2.advClaudeWhen", term: { name: "Claude Code" }, Icon: IconClaude, page: "claude", subPath: "code" },
  { id: "providers", title: "shellV2.advProviders", when: "shellV2.advProvidersWhen", term: { key: "proxyV2.advTermProviders" }, Icon: IconServer, page: "providers" },
  { id: "storage", title: "shellV2.advStorage", when: "shellV2.advStorageWhen", term: { key: "proxyV2.advTermStorage" }, Icon: IconHardDrive, page: "storage" },
  { id: "diagnostics", title: "shellV2.advDiagnostics", when: "shellV2.advDiagnosticsWhen", term: { key: "logs.tabDebug" }, Icon: IconList, page: "logs", subPath: "debug" },
  { id: "desktop", title: "shellV2.advDesktopCompat", when: "shellV2.advDesktopCompatWhen", term: { key: "proxyV2.advTermDesktop" }, Icon: IconCodex, page: "codex-set", subPath: "desktop" },
];

/** The English term stays searchable in every language: it is what docs and the CLI say. */
function englishTerm(entry: Entry, enDict?: Partial<Dict>): string {
  return "name" in entry.term ? entry.term.name : (enDict?.[entry.term.key] ?? "");
}

export default function AdvancedHub({ navigate, onSwitchClassic }: AdvancedHubProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const termText = (entry: Entry) => "name" in entry.term ? entry.term.name : t(entry.term.key);
  const [enDict, setEnDict] = useState<Partial<Dict> | undefined>(() => (isLocaleLoaded("en") ? getLoadedDict("en") : undefined));
  const needle = useDeferredValue(query.trim().toLowerCase());
  useEffect(() => {
    if (!needle || enDict) return;
    let cancelled = false;
    void preloadLocaleCatalog("en").then((loaded) => {
      if (!cancelled) setEnDict(loaded);
    });
    return () => { cancelled = true; };
  }, [needle, enDict]);
  const shown = ENTRIES.filter(entry => !needle
    || [t(entry.title), t(entry.when), termText(entry), englishTerm(entry, enDict), ...(entry.finds ?? []).map(key => t(key)), ...(entry.words ?? [])]
      .some(text => text.toLowerCase().includes(needle)));

  return (
    <div className="ui-v2 flex flex-col gap-6 font-sans text-fg">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="m-0 text-title font-semibold tracking-[-0.025em]">{t("shellV2.pageAllSettings")}</h1>
          <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("shellV2.advancedIntro")}</p>
        </div>
        <label className="relative flex w-full items-center sm:w-72">
          <span className="pointer-events-none absolute left-3 text-fg-subtle [&_svg]:size-4"><IconSearch aria-hidden /></span>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("shellV2.advancedSearch")}
            aria-label={t("shellV2.advancedSearch")}
            className="h-[var(--epx-control-h)] w-full rounded-control bg-surface pr-3 pl-9 text-sm text-fg ring-1 ring-line outline-none ring-inset placeholder:text-fg-subtle focus:ring-2 focus:ring-highlight"
          />
        </label>
      </header>
      {needle && (
        <p className="m-0 -mt-3 text-[13px] text-fg-muted" role="status">{t("proxyV2.hubCount", { count: shown.length })}</p>
      )}
      {shown.length === 0 ? (
        <p className="m-0 rounded-card bg-surface p-6 text-center text-[13px] text-fg-muted">{t("shellV2.advancedEmpty")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map(entry => (
            <HubCard
              key={entry.id}
              icon={<entry.Icon aria-hidden />}
              title={t(entry.title)}
              body={t(entry.when)}
              onOpen={() => navigate(entry.page, entry.subPath)}
              openLabel={t("shellV2.stepOpen")}
            />
          ))}
        </div>
      )}
      {onSwitchClassic && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-control bg-inset text-fg-muted [&_svg]:size-4">
              <IconHistory aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fg">{t("shellV2.uiClassic")}</span>
              <span className="text-xs text-fg-muted">{t("shellV2.uiClassicHint")}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onSwitchClassic}
            aria-label={t("shellV2.uiClassic")}
            className="inline-flex h-[var(--epx-control-h-sm)] shrink-0 cursor-pointer items-center gap-1.5 rounded-control border border-line-strong bg-raised px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight"
          >
            {t("shellV2.uiClassic")}
          </button>
        </div>
      )}
    </div>
  );
}
