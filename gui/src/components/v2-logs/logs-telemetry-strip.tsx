import { useMemo } from "react";
import { formatTokens } from "../../format-tokens";
import { cachedNumberFormat, formatEstimatedUsdValue } from "../../intl-formatters";
import type { Locale } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";

export interface LogsTelemetryRowLike {
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningOutputTokens?: number;
  };
  cacheProvenance?: string;
  displayMetrics?: {
    cost?: {
      kind: string;
      estimate?: {
        cost?: { total: number };
        netCacheSavingsUsd?: number;
      };
    };
  };
}

export function LogsTelemetryStrip({
  logs,
  locale,
}: {
  logs: readonly LogsTelemetryRowLike[];
  locale: Locale;
}) {
  const numberFmt = cachedNumberFormat(locale);
  const agg = useMemo(() => {
    let totalTokens = 0;
    let observedInput = 0;
    let cacheReads = 0;
    let hasObservedCache = false;
    let netSavedUsd = 0;

    for (const row of logs) {
      const u = row.usage;
      if (u) {
        totalTokens += typeof u.totalTokens === "number" ? u.totalTokens : u.inputTokens + u.outputTokens;
        const read = u.cacheReadInputTokens ?? u.cachedInputTokens;
        const observed = row.cacheProvenance === "observed"
          || (row.cacheProvenance === undefined && (typeof read === "number" || typeof u.cacheCreationInputTokens === "number"));
        if (observed && u.inputTokens > 0) {
          hasObservedCache = true;
          observedInput += u.inputTokens;
          if (typeof read === "number" && read > 0) cacheReads += read;
        }
      }
      const saved = row.displayMetrics?.cost?.kind === "value"
        ? row.displayMetrics.cost.estimate?.netCacheSavingsUsd
        : undefined;
      if (typeof saved === "number" && Number.isFinite(saved)) {
        netSavedUsd += saved;
      }
    }

    const hitRate = hasObservedCache && observedInput > 0
      ? Math.max(0, Math.min(1, cacheReads / observedInput))
      : null;

    return {
      count: logs.length,
      totalTokens,
      cacheReads,
      hitRate,
      netSavedUsd: netSavedUsd > 0 ? netSavedUsd : null,
    };
  }, [logs]);

  if (agg.count === 0) return null;

  return (
    <div className="ui-v2 grid grid-cols-2 overflow-hidden border-0 border-b border-solid border-line bg-inset/45 sm:grid-cols-4 *:-mt-px *:-ml-px *:border-0 *:border-t *:border-l *:border-solid *:border-line">
      <div className="px-3.5 py-2">
        <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "logs.strip.requests")}</div>
        <div className="mt-0.5 font-mono text-[13px] font-semibold text-fg tabular-nums">
          {numberFmt.format(agg.count)}
        </div>
      </div>
      <div className="px-3.5 py-2">
        <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "logs.strip.tokens")}</div>
        <div className="mt-0.5 font-mono text-[13px] font-semibold text-fg tabular-nums">
          {formatTokens(agg.totalTokens, locale)}
        </div>
      </div>
      <div className="px-3.5 py-2">
        <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "logs.strip.cacheHit")}</div>
        <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-[13px] font-semibold text-fg tabular-nums">
          <span>{agg.hitRate !== null ? `${Math.round(agg.hitRate * 100)}%` : "—"}</span>
          {agg.cacheReads > 0 && (
            <span className="font-sans text-[11px] font-normal text-fg-subtle">
              ({formatTokens(agg.cacheReads, locale)})
            </span>
          )}
        </div>
      </div>
      <div className="px-3.5 py-2">
        <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "logs.strip.cacheSaved")}</div>
        <div className={`mt-0.5 font-mono text-[13px] font-semibold tabular-nums ${agg.netSavedUsd !== null ? "text-success" : "text-fg-muted"}`}>
          {agg.netSavedUsd !== null ? formatEstimatedUsdValue(agg.netSavedUsd, locale) : "—"}
        </div>
      </div>
    </div>
  );
}

export function LogDetailTokenEfficiencyBar({
  usage,
  tokenSplit,
  netCacheSavingsUsd,
  locale,
}: {
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningOutputTokens?: number;
  };
  tokenSplit: { read?: number; write?: number };
  netCacheSavingsUsd?: number;
  locale: Locale;
}) {
  if (!usage) return null;
  const cacheRead = Math.max(0, tokenSplit.read ?? 0);
  const cacheWrite = Math.max(0, tokenSplit.write ?? 0);
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const output = Math.max(0, usage.outputTokens);
  const activeTotal = uncachedInput + cacheWrite + output;
  if (activeTotal <= 0 && cacheRead <= 0) return null;

  const hitRate = usage.inputTokens > 0 && (tokenSplit.read !== undefined || tokenSplit.write !== undefined)
    ? Math.max(0, Math.min(1, cacheRead / usage.inputTokens))
    : null;
  const saved = typeof netCacheSavingsUsd === "number" && Number.isFinite(netCacheSavingsUsd) && netCacheSavingsUsd > 0
    ? netCacheSavingsUsd
    : null;

  const uncachedPct = activeTotal > 0 ? (uncachedInput / activeTotal) * 100 : 0;
  const writePct = activeTotal > 0 ? (cacheWrite / activeTotal) * 100 : 0;
  const outputPct = activeTotal > 0 ? (output / activeTotal) * 100 : 0;

  return (
    <div className="ui-v2 mb-2.5 flex flex-col gap-1.5 rounded-control border border-solid border-line bg-inset/60 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-fg-muted">{uxT(locale, "tokenMix.title")}</span>
        <div className="flex items-center gap-2 tabular-nums">
          {hitRate !== null && (
            <span className="badge badge-muted font-mono">
              {uxT(locale, "tokenMix.hitRate", { rate: `${Math.round(hitRate * 100)}%` })}
            </span>
          )}
          {saved !== null && (
            <span className="badge badge-green font-mono">
              {uxT(locale, "tokenMix.estSavings", { amount: formatEstimatedUsdValue(saved, locale).replace(/^~/, "") })}
            </span>
          )}
        </div>
      </div>
      {activeTotal > 0 && (
        <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          {uncachedPct > 0 && <span className="h-full bg-chart-1" style={{ width: `${uncachedPct}%` }} />}
          {writePct > 0 && <span className="h-full bg-chart-4" style={{ width: `${writePct}%` }} />}
          {outputPct > 0 && <span className="h-full bg-chart-2" style={{ width: `${outputPct}%` }} />}
        </div>
      )}
    </div>
  );
}
