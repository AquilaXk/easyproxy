import { useCallback, useEffect, useMemo, useState } from "react";
import { readJsonIfOk } from "../fetch-json";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { formatProviderDisplayName } from "../provider-icons";
import { openProviderAccounts } from "../protocol-deep-links";
import { oauthAccountDisplayLabel } from "../provider-workspace/auth";
import { accountSwitchRequest, maskEmail, type TraySwitchKind } from "../pages/tray-data";
import type { AccountQuota } from "../codex-quota-utils";
import { accountQuotaFromReport, freshQuotaReportsFromResponse, type ProviderQuotaReportView } from "../provider-workspace/report";
import { oauthCredentialSlot } from "../../../src/oauth/credential-siblings";
import { ProviderIcon } from "./provider-workspace/ProviderRail";
import QuotaBars from "./QuotaBars";
import { cn } from "../lib/utils";

type HubFilter = "all" | "oauth" | "keys";

interface HubProviderConfig {
  adapter?: string;
  authMode?: string;
  disabled?: boolean;
  hasApiKey?: boolean;
  codexAccountMode?: "pool" | "direct";
}

interface HubAccountRow {
  id: string;
  alias?: string;
  accountLabel?: string;
  maskedLabel?: string;
  labelFallback?: string;
  active: boolean;
  plan?: string | null;
  quota?: AccountQuota | null;
  paused?: boolean;
  needsReauth?: boolean;
}

interface HubProviderCard {
  name: string;
  kind: "codex" | "oauth" | "keys";
  slot: string;
  codexAccountMode?: "pool" | "direct";
  quotaReport?: ProviderQuotaReportView;
  accounts: HubAccountRow[];
}

async function fetchAllProviderHubData(
  apiBase: string,
  refreshQuotas: boolean,
  codexAppLabel: string,
  signal?: AbortSignal,
): Promise<HubProviderCard[]> {
  try {
    const [configRes, quotasRes] = await Promise.all([
      fetch(`${apiBase}/api/config`, signal ? { signal } : undefined),
      fetch(`${apiBase}/api/provider-quotas${refreshQuotas ? "?refresh=1" : ""}`, signal ? { signal } : undefined),
    ]);
    const configJson = await readJsonIfOk<{ providers?: Record<string, HubProviderConfig> }>(configRes);
    const quotasJson = await readJsonIfOk<unknown>(quotasRes);
    const rawReports = quotasJson && typeof quotasJson === "object" && !Array.isArray(quotasJson) && "reports" in quotasJson
      ? (quotasJson as { reports?: unknown }).reports
      : quotasJson;
    const quotaMap = rawReports ? freshQuotaReportsFromResponse(rawReports) : {};
    const providersObj = configJson?.providers;
    if (!providersObj || typeof providersObj !== "object" || Array.isArray(providersObj)) return [];

    const entries = Object.entries(providersObj).filter(([, row]) => row && row.disabled !== true);
    const cards = await Promise.all(entries.map(async ([name, row]): Promise<HubProviderCard | null> => {
      const slot = oauthCredentialSlot(name);
      if (name === "openai" && row.authMode === "forward") {
        const [accountsRes, activeRes] = await Promise.all([
          fetch(`${apiBase}/api/codex-auth/accounts`, signal ? { signal } : undefined).catch(() => null),
          fetch(`${apiBase}/api/codex-auth/active`, signal ? { signal } : undefined).catch(() => null),
        ]);
        const body = accountsRes ? await readJsonIfOk<{ accounts?: Array<Record<string, unknown>>; activeCodexAccountId?: string | null }>(accountsRes) : null;
        const activeBody = activeRes ? await readJsonIfOk<{ activeCodexAccountId?: string | null }>(activeRes) : null;
        const rows = Array.isArray(body?.accounts) ? body.accounts : [];
        const activeId = activeBody?.activeCodexAccountId !== undefined
          ? (activeBody.activeCodexAccountId ?? "__main__")
          : body?.activeCodexAccountId;
        return {
          name,
          kind: "codex",
          slot: "openai",
          codexAccountMode: row.codexAccountMode === "direct" ? "direct" : "pool",
          quotaReport: quotaMap[name],
          accounts: rows.slice(0, 6).map((acc, idx) => {
            const id = String(acc.id ?? idx);
            const active = activeId ? id === activeId : acc.active === true;
            const cleanText = (value: unknown): string | undefined => {
              if (typeof value !== "string") return undefined;
              const trimmed = value.trim();
              return trimmed && trimmed !== "__main__" ? trimmed : undefined;
            };
            const rawEmail = typeof acc.email === "string" && acc.email.includes("@") ? maskEmail(acc.email) : undefined;
            const alias = cleanText(acc.alias);
            const explicitLabel = cleanText(acc.label);
            return {
              id,
              alias,
              accountLabel: cleanText(acc.accountLabel),
              maskedLabel: cleanText(acc.maskedLabel) ?? rawEmail,
              labelFallback: id === "__main__" ? (alias ?? explicitLabel ?? rawEmail ?? codexAppLabel) : explicitLabel,
              active,
              plan: typeof acc.plan === "string" ? acc.plan : null,
              quota: (acc.quota && typeof acc.quota === "object") ? acc.quota as AccountQuota : null,
              paused: acc.paused === true,
              needsReauth: acc.needsReauth === true,
            };
          }),
        };
      }
      if (row.authMode === "oauth") {
        const res = await fetch(
          `${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(slot)}&quota=1`,
          signal ? { signal } : undefined,
        ).catch(() => null);
        const body = res ? await readJsonIfOk<{ accounts?: Array<Record<string, unknown>>; activeAccountId?: string }>(res) : null;
        const rows = Array.isArray(body?.accounts) ? body.accounts : [];
        const activeId = body?.activeAccountId;
        return {
          name,
          kind: "oauth",
          slot,
          quotaReport: quotaMap[name] ?? quotaMap[slot],
          accounts: rows.map((acc, idx) => {
            const id = String(acc.id ?? idx);
            const active = activeId ? id === activeId : acc.active === true;
            return {
              id,
              alias: typeof acc.alias === "string" ? acc.alias : undefined,
              accountLabel: typeof acc.accountLabel === "string" ? acc.accountLabel : undefined,
              maskedLabel: typeof acc.maskedLabel === "string" ? acc.maskedLabel : undefined,
              active,
              plan: typeof acc.plan === "string" ? acc.plan : null,
              quota: (acc.quota && typeof acc.quota === "object") ? acc.quota as AccountQuota : null,
              paused: acc.paused === true,
              needsReauth: acc.needsReauth === true,
            };
          }),
        };
      }
      if (row.hasApiKey === true && row.authMode !== "forward") {
        const res = await fetch(
          `${apiBase}/api/providers/keys?name=${encodeURIComponent(name)}`,
          signal ? { signal } : undefined,
        ).catch(() => null);
        const body = res ? await readJsonIfOk<{ keys?: Array<Record<string, unknown>> }>(res) : null;
        const rows = Array.isArray(body?.keys) ? body.keys : [];
        return {
          name,
          kind: "keys",
          slot: name,
          quotaReport: quotaMap[name],
          accounts: rows.map((k, idx) => {
            const label = typeof k.label === "string" && k.label.trim() ? k.label.trim() : undefined;
            const masked = typeof k.masked === "string" && k.masked.trim() ? k.masked.trim() : undefined;
            return {
              id: String(k.id ?? idx),
              alias: label,
              maskedLabel: masked,
              labelFallback: label ?? masked,
              active: k.active === true,
              quota: (k.quota && typeof k.quota === "object") ? k.quota as AccountQuota : null,
              paused: Boolean(k.disabled || k.pauseDetails),
            };
          }),
        };
      }
      return null;
    }));
    return cards.filter((card): card is HubProviderCard => card !== null);
  } catch {
    return [];
  }
}

export function AllProviderAccountsHub({ apiBase, hideWhenCodexOnly = false }: { apiBase: string; hideWhenCodexOnly?: boolean }) {
  const { t, locale } = useI18n();
  const [cards, setCards] = useState<HubProviderCard[]>([]);
  const [filter, setFilter] = useState<HubFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const codexAppLabel = t("codexAuth.codexApp");

  const reload = useCallback(async (refreshQuotas = false, signal?: AbortSignal) => {
    setRefreshing(refreshQuotas);
    try {
      const next = await fetchAllProviderHubData(apiBase, refreshQuotas, codexAppLabel, signal);
      if (!signal?.aborted) setCards(next);
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, [apiBase, codexAppLabel]);

  useEffect(() => {
    const ac = new AbortController();
    fetchAllProviderHubData(apiBase, false, codexAppLabel, ac.signal)
      .then(next => {
        if (!ac.signal.aborted) setCards(next);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [apiBase, codexAppLabel]);

  const counts = useMemo(() => ({
    all: cards.length,
    oauth: cards.filter(c => c.kind === "oauth" || c.kind === "codex").length,
    keys: cards.filter(c => c.kind === "keys").length,
  }), [cards]);

  const visibleCards = useMemo(() => cards.filter(c => {
    if (filter === "oauth") return c.kind === "oauth" || c.kind === "codex";
    if (filter === "keys") return c.kind === "keys";
    return true;
  }), [cards, filter]);

  const switchActive = async (card: HubProviderCard, accountId: string) => {
    const opKey = `${card.name}:${accountId}`;
    if (switchingKey) return;
    setSwitchingKey(opKey);
    try {
      const switchKind: TraySwitchKind = card.kind === "codex" ? "codex" : card.kind === "oauth" ? "oauth" : "apiKey";
      const req = accountSwitchRequest(card.kind === "oauth" ? card.slot : card.name, switchKind, accountId);
      const res = await fetch(`${apiBase}${req.path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      if (res.ok) await reload(false);
    } catch {
      // Non-fatal; keep existing state.
    } finally {
      setSwitchingKey(null);
    }
  };

  if (cards.length === 0) return null;
  if (hideWhenCodexOnly && cards.every(c => c.kind === "codex")) return null;

  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-solid border-line bg-surface p-4 mb-5"
      aria-labelledby="accounts-hub-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="accounts-hub-title" className="m-0 text-base font-semibold text-fg">
            {uxT(locale, "accountsHub.title")}
          </h2>
          <p className="m-0 mt-0.5 text-xs text-fg-muted">{uxT(locale, "accountsHub.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={uxT(locale, "accountsHub.title")}
            className="ui-v2 inline-flex items-center gap-0.5 rounded-[7px] bg-inset p-0.5 ring-1 ring-inset ring-line"
          >
            {(["all", "oauth", "keys"] as const).map(tab => (
              <button
                key={tab}
                type="button"
                aria-pressed={filter === tab}
                onClick={() => setFilter(tab)}
                className={cn(
                  "cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                  filter === tab ? "bg-raised text-fg shadow-sm ring-1 ring-inset ring-line" : "text-fg-subtle hover:text-fg",
                )}
              >
                {uxT(
                  locale,
                  tab === "all" ? "accountsHub.filterAll" : tab === "oauth" ? "accountsHub.filterOauth" : "accountsHub.filterKeys",
                  { count: counts[tab] },
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshing}
            onClick={() => { void reload(true); }}
          >
            {uxT(locale, "accountsHub.refresh")}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {visibleCards.map(card => {
          const activeAcc = card.accounts.find(a => a.active) ?? card.accounts[0];
          const topQuota = activeAcc?.quota ?? accountQuotaFromReport(card.quotaReport);
          return (
            <article
              key={card.name}
              data-hub-provider={card.name}
              className="flex flex-col gap-2.5 rounded-control border border-solid border-line bg-surface p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderIcon name={card.name} cls="provider-icon shrink-0" size={18} />
                  <strong className="text-sm text-fg truncate">{formatProviderDisplayName(card.name, t)}</strong>
                  {card.kind === "codex" && card.codexAccountMode && (
                    <span className={card.codexAccountMode === "pool" ? "badge badge-primary" : "badge badge-muted"}>
                      {card.codexAccountMode === "pool" ? t("codexAuth.accountModePool") : t("codexAuth.accountModeDirect")}
                    </span>
                  )}
                  {card.kind === "oauth" && <span className="badge badge-muted">OAuth</span>}
                  {card.kind === "keys" && <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>}
                </div>
                <button
                  type="button"
                  className="link-btn text-xs shrink-0"
                  onClick={() => openProviderAccounts(card.name)}
                >
                  {uxT(locale, "accountsHub.openProvider")}
                </button>
              </div>

              {topQuota ? (
                <QuotaBars quota={topQuota} plan={activeAcc?.plan} threshold={20} t={t} layout="stacked" />
              ) : (
                <span className="text-xs text-fg-subtle">{uxT(locale, "accountsHub.noQuota")}</span>
              )}

              {card.accounts.length > 0 && (
                <div className="flex flex-col gap-1.5 border-0 border-t border-solid border-line pt-2">
                  {card.accounts.map(acc => {
                    const rowLabel = acc.labelFallback ?? oauthAccountDisplayLabel(card.accounts, acc, t);
                    return (
                      <div key={acc.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate font-medium text-fg">{rowLabel}</span>
                          {acc.plan && <span className="badge badge-muted">{acc.plan}</span>}
                          {acc.needsReauth && <span className="badge badge-red">{uxT(locale, "accountsHub.reauthRequired")}</span>}
                          {acc.paused && <span className="badge badge-amber">{uxT(locale, "accountsHub.paused")}</span>}
                        </div>
                        {acc.active ? (
                          <span className="badge badge-green shrink-0">{uxT(locale, "accountsHub.activeBadge")}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm shrink-0"
                            disabled={switchingKey !== null || acc.paused}
                            onClick={() => { void switchActive(card, acc.id); }}
                          >
                            {uxT(locale, "accountsHub.switchAction")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
