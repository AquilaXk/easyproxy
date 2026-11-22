import type { Locale, TFn } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { computeWaterfallLayout, type WaterfallAttempt } from "../lib/log-attempt-waterfall";
import { formatProviderDisplayName } from "../provider-icons";
import "./log-attempt-waterfall.css";

export function LogAttemptWaterfall({
  attempts,
  totalDurationMs,
  locale,
  t,
}: {
  attempts: readonly WaterfallAttempt[];
  totalDurationMs: number;
  locale: Locale;
  t: TFn;
}) {
  if (!attempts.length) return null;
  const { scaleMs, rows } = computeWaterfallLayout(attempts, totalDurationMs);

  return (
    <div className="log-waterfall" aria-label={uxT(locale, "logs.waterfall.title")}>
      <div className="log-waterfall-head">
        <span className="log-waterfall-title">{uxT(locale, "logs.waterfall.title")}</span>
        <div className="log-waterfall-legend">
          <span className="log-waterfall-legend-item">
            <span className="log-waterfall-swatch log-waterfall-swatch--ttft" aria-hidden="true" />
            <span>{uxT(locale, "logs.waterfall.ttftLegend")}</span>
          </span>
          <span className="log-waterfall-legend-item">
            <span className="log-waterfall-swatch log-waterfall-swatch--decode" aria-hidden="true" />
            <span>{uxT(locale, "logs.waterfall.decodeLegend")}</span>
          </span>
          <span className="log-waterfall-legend-item">
            <span className="log-waterfall-swatch log-waterfall-swatch--error" aria-hidden="true" />
            <span>{uxT(locale, "logs.waterfall.errorLegend")}</span>
          </span>
        </div>
      </div>

      <div className="log-waterfall-rows">
        {rows.map(({ attempt, metrics }) => {
          const providerLabel = formatProviderDisplayName(attempt.provider, t);
          const ttftLabel = metrics.hasTtftSplit
            ? ` · ${uxT(locale, "playground.ttftLabel", { ms: Math.round(attempt.firstOutputMs!) })}`
            : "";
          const statusText = uxT(locale, "playground.statusLabel", { status: attempt.status });
          const aria = `${uxT(locale, "logs.waterfall.attemptLabel", { ordinal: attempt.ordinal })} · ${providerLabel} · ${statusText} · ${attempt.durationMs}ms${ttftLabel} / ${scaleMs}ms`;
          return (
            <div key={`${attempt.ordinal}-${attempt.provider}-${attempt.model}`} className="log-waterfall-row">
              <div className="log-waterfall-meta" title={`${providerLabel} / ${attempt.model}`}>
                <span className="log-waterfall-ordinal">#{attempt.ordinal}</span>
                <span className="log-waterfall-target">{providerLabel}</span>
              </div>
              <div className="log-waterfall-track" role="img" aria-label={aria}>
                <div
                  className={`log-waterfall-bar log-waterfall-bar--${metrics.tone}`}
                  style={{ left: `${metrics.offsetPct}%`, width: `${metrics.widthPct}%` }}
                >
                  {metrics.hasTtftSplit ? (
                    <>
                      {metrics.ttftPct > 0 && (
                        <span
                          className="log-waterfall-seg log-waterfall-seg--ttft"
                          style={{ width: `${metrics.ttftPct}%` }}
                        />
                      )}
                      {metrics.decodePct > 0 && (
                        <span
                          className="log-waterfall-seg log-waterfall-seg--decode"
                          style={{ width: `${metrics.decodePct}%` }}
                        />
                      )}
                    </>
                  ) : (
                    <span className="log-waterfall-seg log-waterfall-seg--full" style={{ width: "100%" }} />
                  )}
                </div>
              </div>
              <div className="log-waterfall-timing">
                {attempt.status >= 100 && (
                  <span className={`log-waterfall-status log-waterfall-status--${metrics.tone}`}>
                    {attempt.status}
                  </span>
                )}
                <span>{attempt.durationMs}ms</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
