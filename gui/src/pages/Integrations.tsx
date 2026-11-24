import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { navigateHash } from "../hash-routing";
import { canonicalHashPath } from "../app-routing";
import { useI18n } from "../i18n/shared";
import { uxT, type UxCopyKey } from "../i18n/ux-overhaul-copy";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import ClientMark from "../components/ClientMark";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { INTEGRATION_MARKS } from "../components/integration-marks";
import IntegrationsOverview from "./integrations/IntegrationsOverview";
import type { FileIntegrationClientId } from "./integrations/FileIntegrationPage";
import { FILE_CLIENTS, TABS, type IntegrationTab } from "./integrations/integration-tabs";

const ApiKeys = lazy(() => import("./ApiKeys"));
const Claude = lazy(() => import("./Claude"));
const ClaudeDesktop = lazy(() => import("./ClaudeDesktop"));
const Grok = lazy(() => import("./Grok"));
const CursorIntegrationPage = lazy(() => import("./integrations/CursorIntegrationPage"));
const GatewayClientsPage = lazy(() => import("./integrations/GatewayClientsPage"));
const AsideProfilesPage = lazy(() => import("./integrations/AsideProfilesPage"));
const HermesProfilesPage = lazy(() => import("./integrations/HermesProfilesPage"));
const LazyCodexRoleModels = lazy(() => import("./integrations/LazyCodexRoleModels"));
const EcosystemSyncPage = lazy(() => import("./integrations/EcosystemSyncPage"));
const FileIntegrationPage = lazy(() => import("./integrations/FileIntegrationPage"));

type IntegrationCategory = "all" | "core" | "cli" | "ide";

const CORE_INTEGRATION_IDS = new Set<string>(["overview", "keys", "sync"]);
const CLI_INTEGRATION_IDS = new Set<string>([
  "codex", "claude", "gemini", "opencode", "droid", "aider", "goose", "amp",
  "crush", "qwen", "kimi", "kilo", "hermes", "commandcode", "prime", "omo",
  "openclaw", "grok",
]);

const INTEGRATION_CATEGORIES: readonly { id: IntegrationCategory; copyKey: UxCopyKey }[] = [
  { id: "all", copyKey: "integrations.filterAll" },
  { id: "core", copyKey: "integrations.filterCore" },
  { id: "cli", copyKey: "integrations.filterCli" },
  { id: "ide", copyKey: "integrations.filterIde" },
];

function categoryOfTab(id: IntegrationTab): Exclude<IntegrationCategory, "all"> {
  if (CORE_INTEGRATION_IDS.has(id)) return "core";
  if (CLI_INTEGRATION_IDS.has(id)) return "cli";
  return "ide";
}

function readIntegrationTab(hash = window.location.hash): IntegrationTab {
  // Read the destination, not a legacy spelling the route hook is about to replace.
  const raw = canonicalHashPath(hash);
  // Claude Desktop keeps #claude/desktop; the rest of #claude/* is the Claude tab, whose
  // sub-tab is Claude's own business.
  if (raw === "claude/desktop") return "claudeDesktop";
  if (raw === "claude" || raw.startsWith("claude/")) return "claude";
  const match = TABS.find(tab => tab.hash === raw);
  return match?.id ?? "overview";
}

function tabDomId(tab: IntegrationTab): string {
  return `integrations-tab-${tab}`;
}

function panelDomId(tab: IntegrationTab): string {
  return `integrations-panel-${tab}`;
}

/*
 * The strip carries 18 tabs on one row, which is precisely where a mark earns
 * its place: the eye finds a logo faster than it reads the tenth label. Two
 * tabs have no client behind them -- `overview` is the page itself and `keys`
 * is a credential surface, not an integration -- so they stay text-only rather
 * than borrowing a mark that would imply a client.
 */
function tabMark(tab: IntegrationTab): string | null {
  if (tab === "overview" || tab === "keys" || tab === "sync") return null;
  return INTEGRATION_MARKS[tab] ?? null;
}

export default function Integrations({ apiBase, machineApiBase = apiBase, connected = false }: { apiBase: string; machineApiBase?: string; connected?: boolean }) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<IntegrationTab>(readIntegrationTab);
  const [category, setCategory] = useState<IntegrationCategory>("all");
  const [tabQuery, setTabQuery] = useState("");
  /*
   * Panels mount lazily and then STAY mounted, hidden, so a half-typed key or
   * an unsaved Grok selection survives a tab hop. Each mounted panel is gated
   * by `active`, which is what stops a hidden one from polling.
   */
  const [mounted, setMounted] = useState<ReadonlySet<IntegrationTab>>(
    () => new Set([readIntegrationTab()]),
  );
  const tabRefs = useRef<Map<IntegrationTab, HTMLButtonElement> | null>(null);
  const [machineClients, setMachineClients] = useState<string[]>([]);
  const [machineSyncing, setMachineSyncing] = useState(false);
  const [machineSyncError, setMachineSyncError] = useState<string | null>(null);
  if (tabRefs.current === null) tabRefs.current = new Map();

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void fetch(`${machineApiBase}/api/machine/clients`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then((value: { selectedClients?: unknown } | null) => {
        if (!controller.signal.aborted && Array.isArray(value?.selectedClients)) {
          setMachineClients(value.selectedClients.filter((item): item is string => typeof item === "string"));
        }
      }).catch(() => {});
    return () => controller.abort();
  }, [connected, machineApiBase]);

  const syncMachine = async () => {
    setMachineSyncing(true);
    setMachineSyncError(null);
    try {
      const response = await fetch(`${machineApiBase}/api/machine/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await readJsonOrThrow(response);
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : String(error);
      setMachineSyncError(`${t("connection.machineUnavailable")} (${detail})`);
    } finally { setMachineSyncing(false); }
  };

  /*
   * Every tab change goes through here, whether it came from a click or from
   * the browser's own history. Accumulating the mounted set in an effect
   * instead would run a second render pass after every switch for a value
   * both callers already know.
   */
  const activateTab = (next: IntegrationTab) => {
    setTab(next);
    setMounted(current => (current.has(next) ? current : new Set([...current, next])));
  };

  useEffect(() => {
    const syncFromHash = () => activateTab(readIntegrationTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  const selectTab = (next: IntegrationTab, moveFocus: boolean) => {
    const definition = TABS.find(candidate => candidate.id === next);
    if (!definition) return;
    navigateHash(definition.hash);
    activateTab(next);
    if (moveFocus) {
      window.requestAnimationFrame(() => {
        tabRefs.current!.get(next)?.focus({ preventScroll: true });
      });
    }
  };

  const normalizedTabQuery = tabQuery.trim().toLowerCase();
  const { visibleTabs, filterEmptyOtherClients } = useMemo(() => {
    const matched = TABS.filter((definition) => {
      if (category !== "all" && categoryOfTab(definition.id) !== category) return false;
      if (!normalizedTabQuery) return true;
      const localized = t(definition.labelKey).toLowerCase();
      return localized.includes(normalizedTabQuery) || definition.id.toLowerCase().includes(normalizedTabQuery);
    });
    const activeIncluded = matched.some((definition) => definition.id === tab);
    const tabs = activeIncluded
      ? matched
      : TABS.filter((definition) => definition.id === tab || matched.includes(definition));
    return {
      visibleTabs: tabs,
      filterEmptyOtherClients: normalizedTabQuery.length > 0 && matched.every((d) => d.id === tab) && !activeIncluded,
    };
  }, [category, normalizedTabQuery, t, tab]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = visibleTabs.findIndex(candidate => candidate.id === tab);
    if (index < 0 || visibleTabs.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % visibleTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = visibleTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(visibleTabs[nextIndex]!.id, true);
  };

  return (
    <section className="integrations-page">
      <div className="page-head">
        <h1>{t("nav.connect")}</h1>
      </div>
      <p className="page-sub">{t("connectV2.subtitle")}</p>
      {connected && (
        <section className="notice" aria-label={t("connection.clients.title")}>
          <strong>{t("connection.clients.title")}</strong>
          <span>{machineClients.length > 0 ? machineClients.join(", ") : t("connection.clients.none")}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={machineSyncing} onClick={() => void syncMachine()}>{t(machineSyncing ? "connection.clients.syncing" : "connection.clients.sync")}</button>
        </section>
      )}
      {connected && machineSyncError && (
        <Notice tone="err">
          <span>{machineSyncError}</span>{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMachineSyncError(null)}>
            {t("common.close")}
          </button>
        </Notice>
      )}

      <div className="connect-split-layout">
        <aside className="connect-rail">
          <div className="integrations-filter-bar">
            <input
              type="search"
              className="input integrations-filter-search"
              value={tabQuery}
              onChange={(event) => setTabQuery(event.target.value)}
              placeholder={uxT(locale, "integrations.searchPlaceholder")}
              aria-label={uxT(locale, "integrations.searchPlaceholder")}
            />
            <div className="integrations-filter-pills" role="group" aria-label={uxT(locale, "integrations.filterAria")}>
              {INTEGRATION_CATEGORIES.map((item) => {
                const selected = category === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`btn btn-sm ${selected ? "btn-primary" : "btn-ghost"}`}
                    aria-pressed={selected}
                    onClick={() => setCategory(item.id)}
                  >
                    {uxT(locale, item.copyKey)}
                  </button>
                );
              })}
            </div>
          </div>
          {filterEmptyOtherClients && (
            <p className="muted text-label integrations-filter-empty" role="status">
              {uxT(locale, "integrations.filterEmpty", { query: tabQuery.trim() })}
            </p>
          )}

          <div className="page-tabs connect-tabs" role="tablist" aria-label={t("integrations.tabsLabel")}>
            {visibleTabs.map(definition => (
              <Fragment key={definition.id}>
              <button
                ref={node => {
                  if (node) tabRefs.current!.set(definition.id, node);
                  else tabRefs.current!.delete(definition.id);
                }}
                type="button"
                role="tab"
                id={tabDomId(definition.id)}
                aria-selected={tab === definition.id}
                aria-controls={panelDomId(definition.id)}
                tabIndex={tab === definition.id ? 0 : -1}
                className={`page-tab${tab === definition.id ? " page-tab--active" : ""}`}
                onClick={() => selectTab(definition.id, true)}
                onKeyDown={handleTabKeyDown}
              >
                {definition.id !== "overview" && definition.id !== "keys" && definition.id !== "sync" && (
                  <ClientMark src={tabMark(definition.id)} label={t(definition.labelKey)} size={14} />
                )}
                {t(definition.labelKey)}
              </button>
              {/* The page-level tabs come first; a hairline sets them apart from the apps. */}
              {definition.id === "sync" && <span className="connect-tabs-divider" role="presentation" />}
              </Fragment>
            ))}
          </div>
        </aside>

        <div className="connect-workspace-pane">
          {TABS.map(definition => {
            if (!mounted.has(definition.id)) return null;
            const active = tab === definition.id;
            return (
              <div
                key={definition.id}
                role="tabpanel"
                id={panelDomId(definition.id)}
                aria-labelledby={tabDomId(definition.id)}
                hidden={!active}
              >
                {definition.id === "overview" && (
                  <IntegrationsOverview apiBase={apiBase} active={active} />
                )}
                <Suspense fallback={<DataSurfaceSkeleton label={t("common.loading")} rows={4} />}>
                {definition.id === "keys" && <ApiKeys apiBase={apiBase} active={active} />}
                {definition.id === "sync" && <EcosystemSyncPage apiBase={apiBase} active={active} />}
                {definition.id === "codex" && (
                  <section className="integration-native-page" aria-labelledby="codex-integration-title">
                    <h3 id="codex-integration-title">{t("integrations.codex.title")}</h3>
                    <p>{t("integrations.codex.body")}</p>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => navigateHash("startup")}
                    >
                      {t("integrations.codex.openService")}
                    </button>
                  </section>
                )}
                {definition.id === "grok" && <Grok apiBase={apiBase} active={active} />}
                {definition.id === "claude" && <Claude apiBase={apiBase} active={active} embedded />}
                {definition.id === "claudeDesktop" && (
                  // claude-page scopes Desktop's status-bar styles; embedded drops the page head.
                  <div className="claude-page claude-page--embedded">
                    <ClaudeDesktop key={apiBase} apiBase={apiBase} active={active} />
                  </div>
                )}
                {definition.id === "cursor" && <CursorIntegrationPage apiBase={apiBase} active={active} />}
                {definition.id === "antigravity" && <GatewayClientsPage apiBase={apiBase} active={active} />}
                {FILE_CLIENTS.has(definition.id as FileIntegrationClientId) && (
                  definition.id === "aside" ? <AsideProfilesPage apiBase={apiBase} active={active} />
                  : definition.id === "hermes" ? <HermesProfilesPage apiBase={apiBase} active={active} /> : <FileIntegrationPage
                    apiBase={apiBase}
                    client={definition.id as FileIntegrationClientId}
                    active={active}
                  />
                )}
                {/* Shown only when LazyCodex is detected, so a Pi-based omo install sees nothing new here. */}
                {definition.id === "omo" && <LazyCodexRoleModels apiBase={apiBase} active={active} />}
                </Suspense>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
