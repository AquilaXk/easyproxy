/**
 * Token composition and prompt-cache efficiency summary panel.
 *
 * Adapted from Apache-2.0 reference gateway telemetry patterns (see
 * `THIRD_PARTY_NOTICES.md`): cache reads stay out of the proportional
 * input-vs-output bar so multi-megatoken cache reuse does not flatten the
 * active prompt/generation split, while cache hit rate and net USD savings
 * surface prominently alongside the four-part breakdown.
 */
import type { Locale, TFn } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import { formatTokens } from "../../format-tokens";
import { formatEstimatedUsdValue } from "../../intl-formatters";
import { formatPct, type UsageSummaryTotals } from "./usage-model";

export function UsageTokenMixPanel({
  summary,
  locale,
  t: _t,
}: {
  summary: UsageSummaryTotals;
  locale: Locale;
  t: TFn;
}) {
  const cacheRead = Math.max(0, summary.cacheReadInputTokens ?? summary.cachedInputTokens ?? 0);
  const cacheWrite = Math.max(0, summary.cacheCreationInputTokens ?? 0);
  const uncachedInput = Math.max(0, summary.inputTokens - cacheRead - cacheWrite);
  const activePrompt = uncachedInput + cacheWrite;
  const output = Math.max(0, summary.outputTokens);
  const reasoning = Math.max(0, summary.reasoningOutputTokens ?? 0);
  const barTotal = activePrompt + output;

  const observedHitRate = summary.cacheHitRate === null
    ? null
    : typeof summary.cacheHitRate === "number" && Number.isFinite(summary.cacheHitRate)
      ? summary.cacheHitRate
      : (typeof summary.cacheObservedInputTokens === "number" && summary.cacheObservedInputTokens > 0
        ? Math.max(0, Math.min(1, cacheRead / summary.cacheObservedInputTokens))
        : (summary.inputTokens > 0 && cacheRead > 0 ? Math.max(0, Math.min(1, cacheRead / summary.inputTokens)) : null));

  const cacheSavings = typeof summary.estimatedCacheSavingsUsd === "number"
    && Number.isFinite(summary.estimatedCacheSavingsUsd)
    && summary.estimatedCacheSavingsUsd > 0
    ? summary.estimatedCacheSavingsUsd
    : null;

  const uncachedPct = barTotal > 0 ? (uncachedInput / barTotal) * 100 : 0;
  const cacheWritePct = barTotal > 0 ? (cacheWrite / barTotal) * 100 : 0;
  const outputPct = barTotal > 0 ? (output / barTotal) * 100 : 0;
  const barSummaryParts = [
    `${uxT(locale, "tokenMix.uncachedInput")} ${formatTokens(uncachedInput, locale)}`,
    ...(cacheWrite > 0 ? [`${uxT(locale, "tokenMix.cacheWrites")} ${formatTokens(cacheWrite, locale)}`] : []),
    `${uxT(locale, "tokenMix.output")} ${formatTokens(output, locale)}`,
  ];

  return (
    <section
      className="usw-section flex min-w-0 flex-col gap-3.5 rounded-[12px] bg-surface p-5 ring-1 ring-line"
      aria-labelledby="usage-token-mix-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h3 id="usage-token-mix-title" className="h-section m-0 text-[15px] leading-6 font-semibold tracking-normal text-fg">
          {uxT(locale, "tokenMix.title")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {observedHitRate !== null && (
            <span className="inline-flex items-center rounded-full bg-inset px-2.5 py-0.5 text-xs font-medium text-fg-muted ring-1 ring-inset ring-line tabular-nums">
              {uxT(locale, "tokenMix.hitRate", { rate: formatPct(observedHitRate) })}
            </span>
          )}
          {cacheSavings !== null && (
            <span className="inline-flex items-center rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-semibold text-success tabular-nums">
              {uxT(locale, "tokenMix.estSavings", { amount: formatEstimatedUsdValue(cacheSavings, locale).replace(/^~/, "") })}
            </span>
          )}
        </div>
      </div>

      <div
        role="img"
        aria-label={`${uxT(locale, "tokenMix.barLabel")}: ${barSummaryParts.join(", ")}`}
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2"
      >
        {barTotal > 0 ? (
          <>
            {uncachedInput > 0 && (
              <span
                data-part="uncached-input"
                className="block h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${uncachedPct}%`, background: "var(--epx-chart-1)" }}
              />
            )}
            {cacheWrite > 0 && (
              <span
                data-part="cache-write"
                className="block h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${cacheWritePct}%`, background: "var(--epx-chart-4)" }}
              />
            )}
            {output > 0 && (
              <span
                data-part="output"
                className="block h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${outputPct}%`, background: "var(--epx-chart-2)" }}
              />
            )}
          </>
        ) : (
          <span className="block h-full w-full rounded-full bg-line" />
        )}
      </div>

      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: "var(--epx-chart-1)" }} aria-hidden="true" />
            <span className="truncate">{uxT(locale, "tokenMix.uncachedInput")}</span>
          </dt>
          <dd className="m-0 font-mono text-[16px] font-semibold text-fg tabular-nums">
            {formatTokens(uncachedInput, locale)}
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: "var(--epx-chart-4)" }} aria-hidden="true" />
            <span className="truncate">{uxT(locale, "tokenMix.cacheWrites")}</span>
          </dt>
          <dd className="m-0 font-mono text-[16px] font-semibold text-fg tabular-nums">
            {formatTokens(cacheWrite, locale)}
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: "var(--epx-chart-2)" }} aria-hidden="true" />
            <span className="truncate">{uxT(locale, "tokenMix.output")}</span>
          </dt>
          <dd className="m-0 flex flex-col">
            <span className="font-mono text-[16px] font-semibold text-fg tabular-nums">
              {formatTokens(output, locale)}
            </span>
            {reasoning > 0 && (
              <span className="truncate text-[11px] text-fg-subtle tabular-nums">
                {uxT(locale, "tokenMix.reasoningSub", { tokens: formatTokens(reasoning, locale) })}
              </span>
            )}
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5 sm:border-0 sm:border-l sm:border-solid sm:border-line sm:pl-5">
          <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span
              className="size-2 shrink-0 rounded-full border border-solid border-success bg-success-soft"
              aria-hidden="true"
            />
            <span className="truncate">{uxT(locale, "tokenMix.cacheHits")}</span>
          </dt>
          <dd className="m-0 font-mono text-[16px] font-semibold text-fg tabular-nums">
            {formatTokens(cacheRead, locale)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
