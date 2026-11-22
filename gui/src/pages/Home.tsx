import { useId, useRef, useState, type ReactNode } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { cachedNumberFormat } from "../intl-formatters";
import { buildQuickstartSnippet, type EndpointProtocol, type QuickstartLang } from "../lib/home-quickstart";
import type { Page } from "../app-routing";
import { IconCheck, IconChevron, IconCopy, IconRefresh } from "../icons";
import { formatProviderDisplayName } from "../provider-icons";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { recentFailures, type HomeLogRow } from "./home-failures";
import { startupChecklistStep } from "../startup-health-ui";
import { useStartupChecklist } from "../hooks/useStartupChecklist";
import { TelemetryProfileCard } from "../components/telemetry-profile-card";
import { readManagementHealth } from "../lib/proxy-health";
import { isDesktopShell } from "../lib/desktop-shell";
import { useGettingStartedHidden } from "../getting-started-visibility";

/*
 * Design system v2 landing page. It answers the two questions people open the dashboard
 * with — "is everything working?" and "what do I do next?" — and nothing else: settings
 * live in their own tier. Every figure comes from an endpoint another page already reads; the one
 * exception is the opt-in public profile card, which reads /api/telemetry/profile.
 */

interface HomeProps {
  apiBase: string;
  endpointUrl?: string;
  navigate: (page: Page, subPath?: string) => void;
  onReloadCodex: () => void;
  reloadingCodex: boolean;
  onOpenPlayground?: () => void;
}

interface UsageDay { requests?: number; totalTokens?: number }
interface UsageBody { summary?: { requests?: number; totalTokens?: number }; days?: UsageDay[] }
interface ConfigBody { defaultProvider?: string; providers?: Record<string, unknown> }
interface GuardrailsSummaryBody { outboundSecretGuard?: { mode?: "off" | "redact" | "block" } }
interface LogRow extends HomeLogRow { model?: string; provider?: string; errorCode?: string; upstreamError?: string }

const DAY_MS = 24 * 60 * 60 * 1000;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export default function Home({ apiBase, endpointUrl, navigate, onReloadCodex, reloadingCodex, onOpenPlayground }: HomeProps) {
  const { t, locale } = useI18n();
  const quickstartId = useId();
  const endpointCopy = useCopyFeedback<"endpoint" | "snippet">();
  const copyOutcome = endpointCopy.outcomeFor("endpoint");
  const snippetCopyOutcome = endpointCopy.outcomeFor("snippet");
  const [protocolMode, setProtocolMode] = useState<EndpointProtocol>("openai");
  const [quickstartOpen, setQuickstartOpen] = useState(false);
  const [snippetLang, setSnippetLang] = useState<QuickstartLang>("curl");
  const number = cachedNumberFormat(locale);
  const compact = cachedNumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });

  // The authenticated management health route: a hub's management ingress denies /healthz (#8506).
  const health = useKeyedClientResource(`app-health:${apiBase}/api/system/health`, [apiBase],
    signal => readManagementHealth(apiBase, "/api/system/health", signal), { pollMs: 30_000 });
  const usage = useKeyedClientResource(`home-usage:${apiBase}`, [apiBase],
    signal => getJson<UsageBody>(`${apiBase}/api/usage?range=7d`, signal), { pollMs: 60_000 });
  const config = useKeyedClientResource(`home-config:${apiBase}`, [apiBase],
    signal => getJson<ConfigBody>(`${apiBase}/api/config`, signal));
  const guardrails = useKeyedClientResource(`home-guardrails:${apiBase}`, [apiBase],
    signal => getJson<GuardrailsSummaryBody>(`${apiBase}/api/gateway-guardrails`, signal));
  const startup = useStartupChecklist(apiBase);
  // The 24-hour window is cut when the rows arrive, so render never reads the clock.
  const failureRead = useKeyedClientResource(`home-failures:${apiBase}`, [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/logs?limit=100`, { signal });
      if (!response.ok) throw new Error("logs unavailable");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("logs" in body) || !Array.isArray(body.logs)) throw new Error("logs unavailable");
      return recentFailures(body.logs as LogRow[], Date.now() - DAY_MS);
    },
    { pollMs: 30_000 });
  const failuresKnown = failureRead.error == null && failureRead.data !== undefined;
  const failures = failuresKnown ? failureRead.data ?? [] : [];

  const online = health.data != null;
  const providerCount = Object.keys(config.data?.providers ?? {}).length;
  const defaultProvider = config.data?.defaultProvider?.trim() || "";
  const rawEndpoint = endpointUrl?.trim() || "";
  const baseOrigin = rawEndpoint.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const endpoint = baseOrigin ? (protocolMode === "openai" ? `${baseOrigin}/v1` : baseOrigin) : "";
  const snippetEndpoint = endpoint || (protocolMode === "openai" ? "http://127.0.0.1:8787/v1" : "http://127.0.0.1:8787");
  const snippetCode = buildQuickstartSnippet(protocolMode, snippetLang, snippetEndpoint);
  const requests7d = usage.data?.summary?.requests ?? 0;
  const tokens7d = usage.data?.summary?.totalTokens ?? 0;
  const uptime = health.data?.uptime ?? null;
  const autostart = startupChecklistStep(startup.data);
  // The desktop app turns Start at Login on when it is installed and first opened
  // (desktop/src-tauri/src/first_run.rs), so its checklist has no such step.
  const desktopShell = isDesktopShell();
  const gettingStarted = useGettingStartedHidden();
  // "Undo" only follows a click on Hide in this visit; a card hidden earlier stays quiet.
  const [justHid, setJustHid] = useState(false);
  // Hide and Undo each remove the button that was clicked, so focus moves to the other one.
  const pendingFocus = useRef<"undo" | "hide" | null>(null);
  const focusWhenMounted = (target: "undo" | "hide") => (element: HTMLButtonElement | null) => {
    if (!element || pendingFocus.current !== target) return;
    pendingFocus.current = null;
    element.focus();
  };
  const hideChecklist = () => { pendingFocus.current = "undo"; setJustHid(true); gettingStarted.hide(); };
  const undoHide = () => { pendingFocus.current = "hide"; setJustHid(false); gettingStarted.show(); };
  // The Set up hub is the Checklist tab under Route; name it the way the sidebar does.
  const restorePlace = `${t("nav.connect")} → ${t("shellV2.pageChecklist")}`;

  const steps = [
    { key: "provider", done: providerCount > 0, title: t("shellV2.stepProvider"), hint: t("shellV2.stepProviderHint"), showHint: false, go: () => navigate("providers") },
    { key: "request", done: requests7d > 0, title: t("shellV2.stepFirstRequest"), hint: t("shellV2.stepFirstRequestHint"), showHint: false, go: () => navigate("integrations") },
    ...(desktopShell ? [] : [{
      key: "autostart",
      done: autostart.done,
      title: t(autostart.titleKey), hint: t(autostart.hintKey),
      // An unverified Desktop login still says where to check it.
      showHint: Boolean(startup.data) && autostart.desktop && autostart.done === undefined,
      go: () => autostart.subPath ? navigate("startup", autostart.subPath) : navigate("startup"),
    }]),
  ];
  const doneCount = steps.filter(step => step.done).length;
  const allDone = doneCount === steps.length;

  const headline = !online ? t("shellV2.homeDown")
    : !failuresKnown ? t("shellV2.homeErrorsUnavailable")
    : failures.length > 0 ? t("shellV2.homeErrorsToday", { count: number.format(failures.length) })
    : t("shellV2.homeOk");

  return (
    <div className="ui-v2 flex flex-col gap-6 font-sans text-fg">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-medium text-fg-subtle">{t("shellV2.navHome")}</span>
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative inline-flex size-3 shrink-0" aria-hidden>
              <span className={cn("relative size-3 rounded-full", !online ? "bg-danger" : !failuresKnown || failures.length ? "bg-warning" : "bg-success")} />
            </span>
            <h1 className="m-0 text-title font-semibold tracking-[-0.025em] text-balance">{headline}</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {guardrails.data?.outboundSecretGuard?.mode && (
            <button
              type="button"
              onClick={() => navigate("dashboard", "proxy-guardrails")}
              className="inline-flex h-[var(--epx-control-h)] cursor-pointer items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              {uxT(locale, "guardrails.homePill", {
                mode: uxT(
                  locale,
                  guardrails.data.outboundSecretGuard.mode === "redact"
                    ? "guardrails.modeRedact"
                    : guardrails.data.outboundSecretGuard.mode === "block"
                      ? "guardrails.modeBlock"
                      : "guardrails.modeOff",
                ),
              })}
            </button>
          )}
          {onOpenPlayground && (
            <Button variant="outline" onClick={onOpenPlayground}>
              {uxT(locale, "playground.open")}
            </Button>
          )}
          <Button variant="outline" onClick={onReloadCodex} disabled={reloadingCodex}>
            <span className={cn("inline-flex", reloadingCodex && "animate-spin")}><IconRefresh /></span>
            {t(reloadingCodex ? "dash.codexRestarting" : "dash.codexRestart")}
          </Button>
          <Button variant="primary" onClick={() => navigate("logs")}>{t("shellV2.openLogs")}</Button>
        </div>
      </header>

      <section aria-label={uxT(locale, "playground.endpoint")} className="endpoint-strip flex flex-col gap-2.5 rounded-card border border-line bg-surface px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            {endpoint && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 text-xs font-medium text-fg-subtle">{uxT(locale, "playground.endpoint")}</span>
                <div
                  role="group"
                  aria-label={uxT(locale, "home.protocolToggleAria")}
                  className="inline-flex items-center gap-0.5 rounded-[7px] bg-inset p-0.5 ring-1 ring-inset ring-line"
                >
                  {(["openai", "anthropic"] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={protocolMode === mode}
                      onClick={() => setProtocolMode(mode)}
                      className={cn(
                        "cursor-pointer rounded-[5px] px-2 py-0.5 text-xs font-medium transition-colors",
                        protocolMode === mode ? "bg-raised text-fg shadow-sm ring-1 ring-inset ring-line" : "text-fg-subtle hover:text-fg",
                      )}
                    >
                      {uxT(locale, mode === "openai" ? "home.protocolOpenAI" : "home.protocolAnthropic")}
                    </button>
                  ))}
                </div>
                <code className="truncate font-mono text-[13px] text-fg">{endpoint}</code>
                <button
                  type="button"
                  aria-label={uxT(locale, "cmd.copyEndpoint")}
                  aria-pressed={copyOutcome === "copied"}
                  data-copied={copyOutcome === "copied" ? "true" : undefined}
                  onClick={() => endpointCopy.copy(endpoint, "endpoint")}
                  className={cn(
                    "inline-flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-fg-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
                    copyOutcome === "copied" && "text-success hover:text-success",
                  )}
                >
                  {copyOutcome === "copied" ? <IconCheck size={14} strokeWidth={1.8} aria-hidden="true" /> : <IconCopy size={14} strokeWidth={1.8} aria-hidden="true" />}
                </button>
                <span role="status" aria-live="polite" className={cn("text-xs font-medium", copyOutcome === "unavailable" ? "text-warning" : "text-success")}>
                  {copyOutcome === "copied" ? uxT(locale, "playground.copied") : copyOutcome === "unavailable" ? uxT(locale, "playground.copyFailed") : ""}
                </span>
              </div>
            )}
            <button
              type="button"
              aria-expanded={quickstartOpen}
              aria-controls={quickstartId}
              onClick={() => setQuickstartOpen(open => !open)}
              className={cn(
                "inline-flex h-[var(--epx-control-h-sm)] cursor-pointer items-center gap-1 rounded-control border border-line bg-inset px-2.5 text-xs font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg",
                quickstartOpen && "border-line-strong bg-raised text-fg",
              )}
            >
              <span>{uxT(locale, "home.quickstart")}</span>
              <span className={cn("inline-flex transition-transform", quickstartOpen ? "rotate-90" : "")} aria-hidden>
                <IconChevron size={12} />
              </span>
            </button>
            {defaultProvider && (
              <button
                type="button"
                onClick={() => navigate("providers")}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-raised px-2.5 py-0.5 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:text-fg"
              >
                <span>{uxT(locale, "home.defaultRoute", { provider: formatProviderDisplayName(defaultProvider, t) })}</span>
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-fg-muted">
            <span>{t("shellV2.tileVersion")} <b className="font-semibold text-fg tabular-nums">{health.data?.version ? `v${health.data.version}` : "—"}</b></span>
            <button type="button" onClick={() => navigate("dashboard", "update")}
              className="cursor-pointer font-medium text-highlight hover:underline">{t("shellV2.checkUpdate")}</button>
          </div>
        </div>
        {quickstartOpen && (
          <div id={quickstartId} className="flex flex-col gap-2 border-t border-line pt-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="group"
                aria-label={uxT(locale, "home.quickstartLangAria")}
                className="inline-flex items-center gap-0.5 rounded-[7px] bg-inset p-0.5 ring-1 ring-inset ring-line"
              >
                {([
                  ["curl", "home.langCurl"],
                  ["python", "home.langPython"],
                  ["ts", "home.langTypeScript"],
                ] as const).map(([lang, key]) => (
                  <button
                    key={lang}
                    type="button"
                    aria-pressed={snippetLang === lang}
                    onClick={() => setSnippetLang(lang)}
                    className={cn(
                      "cursor-pointer rounded-[5px] px-2.5 py-0.5 text-xs font-medium transition-colors",
                      snippetLang === lang ? "bg-raised text-fg shadow-sm ring-1 ring-inset ring-line" : "text-fg-subtle hover:text-fg",
                    )}
                  >
                    {uxT(locale, key)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => endpointCopy.copy(snippetCode, "snippet")}
                  className="inline-flex h-[var(--epx-control-h-sm)] cursor-pointer items-center gap-1.5 rounded-control border border-line bg-inset px-2.5 text-xs font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  {snippetCopyOutcome === "copied" ? <IconCheck size={13} aria-hidden="true" /> : <IconCopy size={13} aria-hidden="true" />}
                  <span>{uxT(locale, snippetCopyOutcome === "copied" ? "playground.copied" : "home.copySnippet")}</span>
                </button>
              </div>
            </div>
            <pre className="m-0 overflow-x-auto rounded-control border border-line bg-inset p-3 font-mono text-xs leading-5 text-fg">
              <code>{snippetCode}</code>
            </pre>
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t("shellV2.tileProviders")} value={number.format(providerCount)} />
        <Stat label={t("shellV2.tileUptime")} value={online && uptime !== null ? t("shellV2.uptimeValue", { h: String(Math.floor(uptime / 3600)), m: String(Math.floor((uptime % 3600) / 60)) }) : "—"} />
        <Stat label={t("shellV2.tileRequests")} value={number.format(requests7d)} />
        <Stat label={t("shellV2.tileTokens")} value={compact.format(tokens7d)} />
      </section>

      <TelemetryProfileCard apiBase={apiBase} />

      {gettingStarted.hidden && justHid && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-5 py-3 text-[13px] text-fg-muted">
          <span>{t("gettingStarted.hiddenNote", { place: restorePlace })}</span>
          <button type="button" ref={focusWhenMounted("undo")} onClick={undoHide}
            className="cursor-pointer font-medium text-highlight hover:underline">{t("gettingStarted.undo")}</button>
        </div>
      )}

      <div className={cn("grid gap-4", !gettingStarted.hidden && "lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]")}>
        {!gettingStarted.hidden && <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[14px] font-semibold">{t("shellV2.checklistTitle")}</h2>
            <div className="flex items-baseline gap-3">
              <span className="text-[13px] text-fg-muted tabular-nums">{t("shellV2.checklistProgress", { done: String(doneCount), total: String(steps.length) })}</span>
              <button type="button" ref={focusWhenMounted("hide")} onClick={hideChecklist}
                aria-label={t("gettingStarted.hideLabel")} title={t("gettingStarted.hideHint", { place: restorePlace })}
                className="cursor-pointer text-[13px] font-medium text-fg-muted hover:text-fg hover:underline">{t("gettingStarted.hide")}</button>
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full origin-left rounded-full bg-accent transition-transform duration-[600ms] ease-soft"
              style={{ transform: `scaleX(${doneCount / steps.length})` }} />
          </div>
          {allDone ? (
            <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("shellV2.checklistAllDone")}</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {steps.map((step, index) => {
                const current = step.done === false && steps.findIndex(s => s.done === false) === index;
                return (
                  <li key={step.key} data-step={step.key}>
                    <button type="button" onClick={step.go}
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-3 rounded-control p-2.5 text-left transition-colors hover:bg-raised",
                        current && "bg-raised shadow-sm ring-1 ring-line",
                      )}>
                      <span className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                        step.done ? "bg-success text-on-accent" : current ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-muted",
                      )} aria-hidden>{step.done ? "✓" : index + 1}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn("text-[13px] leading-5", step.done ? "font-normal text-fg-subtle" : current ? "font-medium text-fg" : "font-medium text-fg-muted")}>{step.title}</span>
                        {(step.done === false || step.showHint) && <span className="text-[12px] leading-4 text-fg-muted">{step.hint}</span>}
                      </span>
                      {step.done === false && <span className="text-[13px] font-medium text-highlight opacity-0 transition-opacity group-hover:opacity-100">{t("shellV2.stepOpen")} →</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>}

        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[14px] font-semibold">{t("shellV2.recentErrors")}</h2>
            <button type="button" onClick={() => navigate("logs")}
              className="cursor-pointer text-[13px] font-medium text-highlight hover:underline">{t("shellV2.viewAll")}</button>
          </div>
          {!failuresKnown ? (
            <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("shellV2.homeErrorsUnavailable")}</p>
          ) : failures.length === 0 ? (
            <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("shellV2.noErrors")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {failures.slice(0, 4).map(row => (
                <li key={`${row.timestamp}:${row.model}`} className="flex items-baseline gap-2.5 rounded-control px-1 py-1.5 text-[13px]">
                  <span className="font-mono text-xs text-fg-subtle tabular-nums">
                    {new Date(row.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning tabular-nums">{row.status}</span>
                  <span className="min-w-0 flex-1 truncate">{row.provider} · {row.model}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

const STAT_UNIT_PATTERN = /(\d+)(\s*(?:시간|분|초|일|h|m|s|d))(?=\s|$)/gi;

function renderStatValue(value: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(STAT_UNIT_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) parts.push(value.slice(lastIndex, start));
    parts.push(<span key={`${start}-n`} className="font-semibold text-fg">{match[1]}</span>);
    parts.push(<span key={`${start}-u`} className="ml-[1px] text-[13px] font-normal text-fg-muted">{match[2]}</span>);
    lastIndex = start + match[0].length;
  }
  if (parts.length === 0) return value;
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return parts;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3.5">
      <span className="text-xs font-medium text-fg-subtle">{label}</span>
      <span className="truncate text-stat font-semibold tracking-[-0.02em] tabular-nums">{renderStatValue(value)}</span>
    </div>
  );
}
