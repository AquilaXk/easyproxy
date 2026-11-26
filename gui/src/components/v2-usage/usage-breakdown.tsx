import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import { formatTokens } from "../../format-tokens";
import { cachedNumberFormat, formatEstimatedUsdValue as formatUsdEstimate } from "../../intl-formatters";
import { formatProviderDisplayName } from "../../provider-icons";
import { modelLabel } from "../../model-display";
import { IconChevron, IconSearch } from "../../icons";
import { cn } from "@/lib/utils";
import {
  cacheHitRateTitle, formatOptionalPct, formatOptionalTokens, formatPct, hasThroughput, throughputTitle,
  type UsageApp, type UsageModel, type UsageProvider, type UsageSummaryTotals,
} from "./usage-model";

/*
 * Breakdowns by model and provider: plain tables with the share drawn inline, so the long tail
 * reads at a glance before anyone compares a column. Every column the old report had is still
 * here; the identity and the three comparison figures lead, the per-request detail follows.
 */

type UsageCostRow = Pick<UsageModel, "estimatedCostUsd" | "estimatedCacheSavingsUsd" | "pricedRequests" | "unpricedRequests">;
type SortDirection = "ascending" | "descending";
type ModelSortColumn = "model" | "tokens" | "cost" | "requests" | "tokPerSec" | "cacheHitRate";
type ProviderSortColumn = "provider" | "tokens" | "cost" | "requests" | "tokPerSec" | "cacheHitRate";

function SortableHeader<C extends string>({
  column,
  label,
  activeColumn,
  direction,
  onSort,
  numeric = false,
  describedBy,
}: {
  column: C;
  label: string;
  activeColumn: C;
  direction: SortDirection;
  onSort: (column: C, label: string) => void;
  numeric?: boolean;
  describedBy?: string;
}) {
  const active = activeColumn === column;
  return (
    <th
      scope="col"
      className={cn(numeric && "num")}
      {...(active ? { "aria-sort": direction } : {})}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
    >
      <button
        type="button"
        onClick={() => onSort(column, label)}
        className={cn(
          "inline-flex min-h-6 w-full cursor-pointer appearance-none items-center gap-1 rounded-[4px] border-0 bg-transparent px-3 py-2 font-inherit text-inherit transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-highlight",
          numeric ? "justify-end" : "justify-start",
          active && "text-fg",
        )}
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex shrink-0 transition-transform",
            active ? "opacity-90" : "opacity-35",
            active && direction === "ascending" ? "-rotate-90" : "rotate-90",
          )}
        >
          <IconChevron size={11} />
        </span>
      </button>
    </th>
  );
}

/**
 * Renders a row's API list-price estimate with explicit pricing coverage.
 * Newer proxies return the coverage fields even when every request is
 * unpriced; older proxies have none of them, so their cells stay unavailable
 * rather than making an unknown amount look free.
 *
 * The coverage caption is `usage-cost-note`, which the stylesheet makes a block so it always
 * begins the line under the amount instead of trailing it and folding mid-phrase. Its leading
 * space stays in the markup: a block box drops leading white space when it lays out, so the cell
 * reads the same either way, and the space keeps the rendered text exactly what it was for
 * anything reading the cell as one string.
 */
function UsageListPrice({ row, locale, t }: { row: UsageCostRow; locale: Locale; t: TFn }) {
  const hasPriceData = row.estimatedCostUsd !== undefined
    || row.pricedRequests !== undefined
    || row.unpricedRequests !== undefined;
  if (!hasPriceData) return <span className="muted">—</span>;

  const excludedRequests = row.unpricedRequests ?? 0;
  const excludedCaption = t(
    excludedRequests === 1 ? "usage.cost.excludedOne" : "usage.cost.excluded",
    { count: excludedRequests },
  );
  if (row.estimatedCostUsd === undefined) {
    return (
      <>
        <span className="muted">—</span>
        {excludedRequests > 0 && (
          <span className="muted text-caption usage-cost-note"> {excludedCaption}</span>
        )}
      </>
    );
  }
  const netSaved = typeof row.estimatedCacheSavingsUsd === "number"
    && Number.isFinite(row.estimatedCacheSavingsUsd)
    && row.estimatedCacheSavingsUsd > 0
    ? row.estimatedCacheSavingsUsd
    : null;
  return (
    <>
      <span className="mono">{formatUsdEstimate(row.estimatedCostUsd ?? 0, locale)}</span>
      {netSaved !== null && (
        <span className="block font-sans text-[11px] font-medium text-success tabular-nums">
          {uxT(locale, "tokenMix.estSavings", { amount: formatUsdEstimate(netSaved, locale).replace(/^~/, "") })}
        </span>
      )}
      {excludedRequests > 0 && (
        <span className="muted text-caption usage-cost-note"> {excludedCaption}</span>
      )}
    </>
  );
}

/** Share of the window's tokens: a bar and the number, so the bar is never the only signal. */
function ShareBar({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="flex items-center gap-2.5">
      <div className="usage-bar h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="usage-bar-fill h-full rounded-full bg-fg/75" style={{ width: `${Math.round(clamped * 100)}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-xs text-fg-muted tabular-nums">{formatPct(clamped)}</span>
    </div>
  );
}

/** One report section: a titled card that is also the anchor the page links to. */
export function UsageWorkspaceSection({
  title,
  titleId,
  meta,
  actions,
  children,
}: {
  title: string;
  titleId: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="usw-section flex min-w-0 flex-col gap-3 rounded-[12px] bg-surface p-5 ring-1 ring-line" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 id={titleId} className="h-section m-0 text-[15px] leading-6 font-semibold tracking-normal text-fg">{title}</h3>
          {meta && <span className="text-[13px] text-fg-subtle tabular-nums">{meta}</span>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function UsageModelsTable({
  models,
  totalModels,
  modelQuery,
  onModelQuery,
  locale,
  t,
}: {
  models: UsageModel[];
  totalModels: number;
  modelQuery: string;
  onModelQuery: (query: string) => void;
  locale: Locale;
  t: TFn;
}) {
  const searchLabel = t("usage.search.models");
  const listPriceDisclaimerId = "usage-models-list-price-disclaimer";
  const unavailable = t("usage.unavailable");
  const [sortCol, setSortCol] = useState<ModelSortColumn>("tokens");
  const [sortDir, setSortDir] = useState<SortDirection>("descending");
  const [sortAnnouncement, setSortAnnouncement] = useState("");

  const handleSort = (nextCol: ModelSortColumn, label: string) => {
    const defaultDir: SortDirection = nextCol === "model" ? "ascending" : "descending";
    const nextDir: SortDirection = sortCol === nextCol
      ? (sortDir === "descending" ? "ascending" : "descending")
      : defaultDir;
    setSortCol(nextCol);
    setSortDir(nextDir);
    setSortAnnouncement(
      uxT(locale, "usageSort.status", {
        column: label,
        direction: uxT(locale, nextDir === "ascending" ? "usageSort.asc" : "usageSort.desc"),
      }),
    );
  };

  const collator = useMemo(() => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }), [locale]);

  const sortedModels = useMemo(() => {
    const factor = sortDir === "ascending" ? 1 : -1;
    if (sortCol === "model") {
      return models.toSorted((a, b) => factor * collator.compare(a.model, b.model));
    }
    const metric = (row: UsageModel): number => {
      switch (sortCol) {
        case "cost":
          return row.estimatedCostUsd ?? -1;
        case "requests":
          return row.requests;
        case "tokPerSec":
          return hasThroughput(row.throughputTokensPerSec) ? row.throughputTokensPerSec : -1;
        case "cacheHitRate":
          return typeof row.cacheHitRate === "number" && Number.isFinite(row.cacheHitRate) ? row.cacheHitRate : -1;
        case "tokens":
        default:
          return row.totalTokens;
      }
    };
    return models.toSorted((a, b) => factor * (metric(a) - metric(b)));
  }, [models, sortCol, sortDir, collator]);

  return (
    <UsageWorkspaceSection
      title={t("usage.section.models")}
      titleId="usage-models-title"
      meta={String(totalModels)}
      actions={(
        <label className="usw-section-toolbar relative m-0 flex w-full max-w-60 items-center">
          <span className="pointer-events-none absolute left-2.5 text-fg-subtle [&_svg]:size-3.5" aria-hidden="true"><IconSearch /></span>
          <input
            className="input h-[var(--epx-control-h)] w-full rounded-control pl-8 text-[13px]"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={modelQuery}
            onChange={event => onModelQuery(event.target.value)}
          />
        </label>
      )}
    >
      <span role="status" aria-live="polite" className="sr-only">{sortAnnouncement}</span>
      <div className="tbl-wrap usage-v2-tbl" tabIndex={0} role="region" aria-labelledby="usage-models-title">
        {/*
          Identity, then the three figures a reader compares models on, then the detail behind
          them. The pair in front is also the pair the stylesheet pins while the rest scrolls
          sideways, so their position here is load-bearing rather than cosmetic.
        */}
        <table className="tbl usage-models-tbl">
          <thead>
            <tr>
              <SortableHeader column="model" label={t("logs.col.model")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} />
              <th scope="col">{t("logs.col.provider")}</th>
              <th scope="col">{t("usage.col.share")}</th>
              <SortableHeader column="tokens" label={t("usage.col.tokens")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
              <SortableHeader column="cost" label={t("usage.col.apiListPrice")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric describedBy={listPriceDisclaimerId} />
              <SortableHeader column="requests" label={t("usage.col.requests")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
              <th scope="col" className="num">{t("usage.col.measured")}</th>
              <th scope="col" className="num">{t("usage.col.inputTokens")}</th>
              <th scope="col" className="num">{t("usage.col.outputTokens")}</th>
              <SortableHeader column="tokPerSec" label={t("usage.col.tokPerSec")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
              <th scope="col" className="num">{t("usage.col.cacheHits")}</th>
              <th scope="col" className="num">{t("usage.col.cacheWrites")}</th>
              <SortableHeader column="cacheHitRate" label={t("usage.col.cacheHitRate")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
            </tr>
          </thead>
          <tbody>
            {sortedModels.map(model => {
              const providerName = formatProviderDisplayName(model.provider, t);
              const cacheCoverage = cacheHitRateTitle(model, locale, t);
              const throughputNote = throughputTitle(model, t);
              const hasTp = hasThroughput(model.throughputTokensPerSec);
              const throughputText = hasThroughput(model.throughputTokensPerSec)
                ? `${model.throughputTokensPerSec.toFixed(1)} tok/s`
                : unavailable;
              const cacheReadText = formatOptionalTokens(model.cacheReadInputTokens ?? model.cachedInputTokens, locale, unavailable);
              const cacheWriteText = formatOptionalTokens(model.cacheCreationInputTokens, locale, unavailable);
              const cacheHitText = formatOptionalPct(model.cacheHitRate, unavailable);
              return (
                <tr key={`${model.provider}/${model.model}`}>
                  {/* Both pinned columns are width-capped, so carry the full value in a tooltip. */}
                  <td className="mono font-medium text-fg" title={model.model}>{modelLabel(model.model)}</td>
                  <td className="muted" title={providerName}>{providerName}</td>
                  <td><ShareBar ratio={model.shareRatio} /></td>
                  <td className="num mono">{formatTokens(model.totalTokens, locale)}</td>
                  <td className="num"><UsageListPrice row={model} locale={locale} t={t} /></td>
                  <td className="num mono">{cachedNumberFormat(locale).format(model.requests)}</td>
                  <td className="num mono">{cachedNumberFormat(locale).format(model.measuredRequests)}</td>
                  <td className="num mono">{formatTokens(model.inputTokens, locale)}</td>
                  <td className="num mono">{formatTokens(model.outputTokens, locale)}</td>
                  <td className={cn("num", hasTp ? "mono" : "font-sans text-fg-subtle")} title={throughputNote}>
                    <span className="usage-hit-rate">
                      {throughputText}
                    </span>
                    {hasTp && <span className="sr-only">{throughputNote}</span>}
                  </td>
                  <td className={cn("num", cacheReadText !== unavailable ? "mono" : "font-sans text-fg-subtle")}>{cacheReadText}</td>
                  <td className={cn("num", cacheWriteText !== unavailable ? "mono" : "font-sans text-fg-subtle")}>{cacheWriteText}</td>
                  <td className={cn("num", cacheHitText !== unavailable ? "mono" : "font-sans text-fg-subtle")} title={cacheCoverage}>
                    <span className="usage-hit-rate">{cacheHitText}</span>
                    {cacheCoverage !== undefined && <span className="sr-only">{cacheCoverage}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p id={listPriceDisclaimerId} className="m-0 text-xs text-fg-subtle">{t("usage.cost.disclaimer")}</p>
    </UsageWorkspaceSection>
  );
}

export function UsageAppsTable({ apps, locale, t }: { apps?: UsageApp[]; locale: Locale; t: TFn }) {
  const names: Record<UsageApp["client"], string> = {
    codex: "Codex", claude_code: "Claude Code", claude_desktop: "Claude Desktop", grok: "Grok", opencode: "OpenCode", aside: "Aside",
    other: t("usageV2.other"), unknown: t("usageV2.unknown"), unclassified: t("usageV2.unclassified"),
  };
  const disclaimerId = "usage-apps-list-price-disclaimer";
  return (
    <UsageWorkspaceSection title={t("usageV2.apps")} titleId="usage-apps-title" meta={apps ? String(apps.length) : undefined}>
      {!apps || apps.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-muted" role="status">{t(apps ? "usageV2.appsEmpty" : "usageV2.appsUnavailable")}</p>
      ) : <>
        <div className="tbl-wrap usage-v2-tbl" tabIndex={0} role="region" aria-labelledby="usage-apps-title">
          <table className="tbl">
            <thead><tr>
              <th scope="col">{t("usageV2.app")}</th><th scope="col">{t("usage.col.share")}</th>
              <th scope="col" className="num">{t("usage.col.tokens")}</th>
              <th scope="col" className="num" aria-describedby={disclaimerId}>{t("usage.col.apiListPrice")}</th>
              <th scope="col" className="num">{t("usage.col.requests")}</th><th scope="col" className="num">{t("usage.col.measured")}</th>
            </tr></thead>
            <tbody>{apps.toSorted((a, b) => b.totalTokens - a.totalTokens).map(app => (
              <tr key={app.client}>
                <td className="font-medium text-fg">{names[app.client]}</td>
                <td><ShareBar ratio={app.shareRatio} /></td>
                <td className="num mono">{formatTokens(app.totalTokens, locale)}</td>
                <td className="num"><UsageListPrice row={app} locale={locale} t={t} /></td>
                <td className="num mono">{cachedNumberFormat(locale).format(app.requests)}</td><td className="num mono">{cachedNumberFormat(locale).format(app.measuredRequests)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p id={disclaimerId} className="m-0 text-xs text-fg-subtle">{t("usage.cost.disclaimer")}</p>
      </>}
    </UsageWorkspaceSection>
  );
}

const EMPTY_USAGE_MODELS: readonly UsageModel[] = [];

export function UsageProvidersTable({
  providers,
  models = EMPTY_USAGE_MODELS,
  locale,
  t,
}: {
  providers: UsageProvider[];
  models?: readonly UsageModel[];
  locale: Locale;
  t: TFn;
}) {
  const unavailable = t("usage.unavailable");
  const listPriceDisclaimerId = "usage-providers-list-price-disclaimer";
  const [sortCol, setSortCol] = useState<ProviderSortColumn>("tokens");
  const [sortDir, setSortDir] = useState<SortDirection>("descending");
  const [sortAnnouncement, setSortAnnouncement] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(() => new Set());

  const toggleProvider = (providerKey: string) => {
    setExpandedProviders(prev => {
      const next = new Set(prev);
      if (next.has(providerKey)) next.delete(providerKey);
      else next.add(providerKey);
      return next;
    });
  };

  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, UsageModel[]>();
    for (const model of models) {
      const list = grouped.get(model.provider);
      if (list) list.push(model);
      else grouped.set(model.provider, [model]);
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => b.totalTokens - a.totalTokens);
    }
    return grouped;
  }, [models]);

  const handleSort = (nextCol: ProviderSortColumn, label: string) => {
    const defaultDir: SortDirection = nextCol === "provider" ? "ascending" : "descending";
    const nextDir: SortDirection = sortCol === nextCol
      ? (sortDir === "descending" ? "ascending" : "descending")
      : defaultDir;
    setSortCol(nextCol);
    setSortDir(nextDir);
    setSortAnnouncement(
      uxT(locale, "usageSort.status", {
        column: label,
        direction: uxT(locale, nextDir === "ascending" ? "usageSort.asc" : "usageSort.desc"),
      }),
    );
  };

  const collator = useMemo(() => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }), [locale]);

  const orderedProviders = useMemo(() => {
    const factor = sortDir === "ascending" ? 1 : -1;
    if (sortCol === "provider") {
      return providers.toSorted((a, b) =>
        factor * collator.compare(formatProviderDisplayName(a.provider, t), formatProviderDisplayName(b.provider, t)),
      );
    }
    const metric = (row: UsageProvider): number => {
      switch (sortCol) {
        case "cost":
          return row.estimatedCostUsd ?? -1;
        case "requests":
          return row.requests;
        case "tokPerSec":
          return hasThroughput(row.throughputTokensPerSec) ? row.throughputTokensPerSec : -1;
        case "cacheHitRate":
          return typeof row.cacheHitRate === "number" && Number.isFinite(row.cacheHitRate) ? row.cacheHitRate : -1;
        case "tokens":
        default:
          return row.totalTokens;
      }
    };
    return providers.toSorted((a, b) => factor * (metric(a) - metric(b)));
  }, [providers, sortCol, sortDir, collator, t]);

  return (
    <UsageWorkspaceSection title={t("usage.section.providers")} titleId="usage-providers-title" meta={String(providers.length)}>
      <span role="status" aria-live="polite" className="sr-only">{sortAnnouncement}</span>
      <div className="tbl-wrap usage-v2-tbl" tabIndex={0} role="region" aria-labelledby="usage-providers-title">
        <table className="tbl usage-providers-tbl">
          <thead>
            <tr>
              <SortableHeader column="provider" label={t("logs.col.provider")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} />
              <th scope="col">{t("usage.col.share")}</th>
              <SortableHeader column="tokens" label={t("usage.col.tokens")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
              <SortableHeader column="cost" label={t("usage.col.apiListPrice")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric describedBy={listPriceDisclaimerId} />
              <SortableHeader column="requests" label={t("usage.col.requests")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
              <th scope="col" className="num">{t("usage.col.measured")}</th>
              <th scope="col" className="num">{t("usage.col.cacheHits")}</th>
              <SortableHeader column="cacheHitRate" label={t("usage.col.cacheHitRate")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
              <SortableHeader column="tokPerSec" label={t("usage.col.tokPerSec")} activeColumn={sortCol} direction={sortDir} onSort={handleSort} numeric />
            </tr>
          </thead>
          <tbody>
            {orderedProviders.map(provider => {
              const displayName = formatProviderDisplayName(provider.provider, t);
              const childModels = modelsByProvider.get(provider.provider) ?? [];
              const canExpand = childModels.length > 0;
              const isExpanded = canExpand && expandedProviders.has(provider.provider);
              const cacheCoverage = cacheHitRateTitle(provider, locale, t);
              const cacheReadText = formatOptionalTokens(provider.cacheReadInputTokens ?? provider.cachedInputTokens, locale, unavailable);
              const cacheHitText = formatOptionalPct(provider.cacheHitRate, unavailable);
              return (
                <Fragment key={provider.provider}>
                  <tr>
                    <td className="font-medium text-fg">
                      {canExpand ? (
                        <button
                          type="button"
                          data-provider-expand={provider.provider}
                          aria-expanded={isExpanded}
                          aria-label={uxT(locale, isExpanded ? "usage.providerCollapse" : "usage.providerExpand", { provider: displayName })}
                          onClick={() => toggleProvider(provider.provider)}
                          className="inline-flex min-h-6 cursor-pointer appearance-none items-center gap-1.5 rounded-[4px] border-0 bg-transparent p-0 font-inherit text-fg transition-colors hover:text-highlight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight"
                        >
                          <span aria-hidden="true" className={cn("inline-flex shrink-0 text-fg-subtle transition-transform", isExpanded && "rotate-90")}>
                            <IconChevron size={12} />
                          </span>
                          <span>{displayName}</span>
                          <span className="rounded-full bg-surface-2 px-1.5 py-0.2 text-[11px] font-normal text-fg-subtle tabular-nums">
                            {childModels.length}
                          </span>
                        </button>
                      ) : (
                        displayName
                      )}
                    </td>
                    <td><ShareBar ratio={provider.shareRatio} /></td>
                    <td className="num mono">{formatTokens(provider.totalTokens, locale)}</td>
                    <td className="num"><UsageListPrice row={provider} locale={locale} t={t} /></td>
                    <td className="num mono">{cachedNumberFormat(locale).format(provider.requests)}</td>
                    <td className="num mono">{cachedNumberFormat(locale).format(provider.measuredRequests)}</td>
                    <td className={cn("num", cacheReadText !== unavailable ? "mono" : "font-sans text-fg-subtle")}>{cacheReadText}</td>
                    <td className={cn("num", cacheHitText !== unavailable ? "mono" : "font-sans text-fg-subtle")} title={cacheCoverage}>
                      <span className="usage-hit-rate">{cacheHitText}</span>
                      {cacheCoverage !== undefined && <span className="sr-only">{cacheCoverage}</span>}
                    </td>
                    <td className="num mono" title={throughputTitle(provider, t)}>
                      <span className="usage-hit-rate">
                        {hasThroughput(provider.throughputTokensPerSec) ? `${provider.throughputTokensPerSec.toFixed(1)} tok/s` : unavailable}
                      </span>
                      {hasThroughput(provider.throughputTokensPerSec) && <span className="sr-only">{throughputTitle(provider, t)}</span>}
                    </td>
                  </tr>
                  {isExpanded && childModels.map(child => {
                    const childCacheRead = formatOptionalTokens(child.cacheReadInputTokens ?? child.cachedInputTokens, locale, unavailable);
                    const childHitText = formatOptionalPct(child.cacheHitRate, unavailable);
                    const childTp = hasThroughput(child.throughputTokensPerSec)
                      ? `${child.throughputTokensPerSec.toFixed(1)} tok/s`
                      : unavailable;
                    const shareWithinProvider = provider.totalTokens > 0 ? child.totalTokens / provider.totalTokens : 0;
                    return (
                      <tr key={`${provider.provider}::${child.model}`} className="usage-provider-child-row">
                        <td className="mono text-fg-muted" title={child.model}>
                          <span className="usage-provider-tree-branch inline-block">{modelLabel(child.model)}</span>
                        </td>
                        <td><ShareBar ratio={shareWithinProvider} /></td>
                        <td className="num mono">{formatTokens(child.totalTokens, locale)}</td>
                        <td className="num"><UsageListPrice row={child} locale={locale} t={t} /></td>
                        <td className="num mono">{cachedNumberFormat(locale).format(child.requests)}</td>
                        <td className="num mono">{cachedNumberFormat(locale).format(child.measuredRequests)}</td>
                        <td className={cn("num", childCacheRead !== unavailable ? "mono" : "font-sans text-fg-subtle")}>{childCacheRead}</td>
                        <td className={cn("num", childHitText !== unavailable ? "mono" : "font-sans text-fg-subtle")}>{childHitText}</td>
                        <td className={cn("num", hasThroughput(child.throughputTokensPerSec) ? "mono" : "font-sans text-fg-subtle")}>{childTp}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p id={listPriceDisclaimerId} className="m-0 text-xs text-fg-subtle">{t("usage.cost.disclaimer")}</p>
    </UsageWorkspaceSection>
  );
}

/**
 * How the request count splits by what is known about its tokens, as one stacked meter
 * (React Bits Pro dashboard-5) with the exact counts beside each swatch.
 */
export function UsageCoveragePanel({ summary, locale, t }: { summary: UsageSummaryTotals; locale: Locale; t: TFn }) {
  const number = new Intl.NumberFormat(locale);
  const total = Math.max(1, summary.requests);
  // Measured = reported + estimated; whatever the two do not explain stays inside "measured".
  const otherMeasured = Math.max(0, summary.measuredRequests - summary.reportedRequests - summary.estimatedRequests);
  const parts = [
    { key: "reported", label: t("usage.coverage.reported"), count: summary.reportedRequests + otherMeasured, tone: "bg-fg" },
    { key: "estimated", label: t("usage.coverage.estimated"), count: summary.estimatedRequests, tone: "bg-fg/45" },
    { key: "unreported", label: t("logs.tokens.unreported"), count: summary.unreportedRequests, tone: "bg-warning" },
    { key: "unsupported", label: t("logs.tokens.unsupported"), count: summary.unsupportedRequests, tone: "bg-line-strong" },
  ];
  return (
    <UsageWorkspaceSection
      title={t("usage.section.coverage")}
      titleId="usage-coverage-title"
      meta={formatPct(summary.coverageRatio)}
    >
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {parts.filter(part => part.count > 0).map(part => (
          <span key={part.key} className={cn("block h-full first:rounded-l-full last:rounded-r-full", part.tone)}
            style={{ width: `${(part.count / total) * 100}%` }} />
        ))}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-fg-subtle">{t("usage.coverage.measured")}</dt>
          <dd className="m-0 text-[17px] font-semibold text-fg tabular-nums">{number.format(summary.measuredRequests)}</dd>
        </div>
        {parts.map(part => (
          <div key={part.key} className="flex flex-col gap-0.5">
            <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span className={cn("size-2 shrink-0 rounded-[2px]", part.tone)} aria-hidden="true" />
              {part.label}
            </dt>
            <dd className="m-0 text-[17px] font-semibold text-fg tabular-nums">
              {number.format(part.key === "reported" ? summary.reportedRequests : part.count)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-xs leading-5 text-fg-subtle">{t("usage.coverage.note")}</p>
    </UsageWorkspaceSection>
  );
}
