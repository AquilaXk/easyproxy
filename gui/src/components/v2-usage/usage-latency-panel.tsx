import { useEffect, useState } from "react";
import { uxT } from "../../i18n/ux-overhaul-copy";
import type { Locale } from "../../i18n/shared";

interface AnalyticsBreakdownItem {
  provider: string;
  model: string;
  requests: number;
  successRate: number | null;
  p50DurationMs?: number;
}

interface RoutingAnalyticsSummary {
  totalRequests: number;
  fallbackRate: number | null;
  durationMs: {
    p50?: number;
    p95?: number;
    sampleCount: number;
  };
  firstOutputMs: {
    p50?: number;
    p95?: number;
    sampleCount: number;
    coverage: number | null;
  };
  breakdown: AnalyticsBreakdownItem[];
}

function readOptionalFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readOptionalRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function parseRoutingAnalytics(raw: unknown): RoutingAnalyticsSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.totalRequests !== "number" || !Number.isFinite(obj.totalRequests) || obj.totalRequests <= 0) {
    return null;
  }
  const dur = obj.durationMs;
  const ttft = obj.firstOutputMs;
  if (!dur || typeof dur !== "object" || !ttft || typeof ttft !== "object") return null;
  const durObj = dur as Record<string, unknown>;
  const ttftObj = ttft as Record<string, unknown>;
  if (typeof durObj.sampleCount !== "number" || typeof ttftObj.sampleCount !== "number") return null;

  const breakdownRaw = Array.isArray(obj.breakdown) ? obj.breakdown : [];
  const breakdown: AnalyticsBreakdownItem[] = [];
  for (const row of breakdownRaw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.provider !== "string" || typeof r.model !== "string" || typeof r.requests !== "number" || r.requests <= 0) {
      continue;
    }
    breakdown.push({
      provider: r.provider,
      model: r.model,
      requests: Math.trunc(r.requests),
      successRate: readOptionalRate(r.successRate),
      p50DurationMs: readOptionalFinite(r.p50DurationMs),
    });
  }
  breakdown.sort((a, b) => b.requests - a.requests);

  return {
    totalRequests: Math.trunc(obj.totalRequests),
    fallbackRate: readOptionalRate(obj.fallbackRate),
    durationMs: {
      p50: readOptionalFinite(durObj.p50),
      p95: readOptionalFinite(durObj.p95),
      sampleCount: Math.max(0, Math.trunc(durObj.sampleCount)),
    },
    firstOutputMs: {
      p50: readOptionalFinite(ttftObj.p50),
      p95: readOptionalFinite(ttftObj.p95),
      sampleCount: Math.max(0, Math.trunc(ttftObj.sampleCount)),
      coverage: readOptionalRate(ttftObj.coverage),
    },
    breakdown: breakdown.slice(0, 6),
  };
}

function formatMs(ms: number | undefined, locale: Locale, unavailable: string): string {
  if (ms === undefined) return unavailable;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "second",
    unitDisplay: "narrow",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(ms / 1000);
}

function formatPercent(ratio: number | null, unavailable: string): string {
  if (ratio === null) return unavailable;
  return `${(ratio * 100).toFixed(1)}%`;
}

export function UsageLatencyPanel({
  apiBase,
  locale,
  enabled = true,
}: {
  apiBase: string;
  locale: Locale;
  enabled?: boolean;
}) {
  const [state, setState] = useState<{ apiBase: string; summary: RoutingAnalyticsSummary | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const ac = new AbortController();
    void fetch(`${apiBase}/api/routing-analytics`, { signal: ac.signal })
      .then(async res => (res.ok ? parseRoutingAnalytics(await res.json()) : null))
      .then(summary => {
        if (!cancelled) setState({ apiBase, summary });
      })
      .catch(() => {
        if (!cancelled) setState({ apiBase, summary: null });
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase, enabled]);

  const analytics = enabled && state?.apiBase === apiBase ? state.summary : null;
  if (!analytics) return null;

  const unavailable = uxT(locale, "usageLatency.unavailable");
  const cards = [
    {
      label: uxT(locale, "usageLatency.p50Duration"),
      value: formatMs(analytics.durationMs.p50, locale, unavailable),
      sub: uxT(locale, "usageLatency.samples", { count: analytics.durationMs.sampleCount }),
    },
    {
      label: uxT(locale, "usageLatency.p95Duration"),
      value: formatMs(analytics.durationMs.p95, locale, unavailable),
      sub: uxT(locale, "usageLatency.samples", { count: analytics.durationMs.sampleCount }),
    },
    {
      label: uxT(locale, "usageLatency.p50Ttft"),
      value: formatMs(analytics.firstOutputMs.p50, locale, unavailable),
      sub: uxT(locale, "usageLatency.samples", { count: analytics.firstOutputMs.sampleCount }),
    },
    {
      label: uxT(locale, "usageLatency.p95Ttft"),
      value: formatMs(analytics.firstOutputMs.p95, locale, unavailable),
      sub: uxT(locale, "usageLatency.samples", { count: analytics.firstOutputMs.sampleCount }),
    },
    {
      label: uxT(locale, "usageLatency.fallbackRate"),
      value: formatPercent(analytics.fallbackRate, unavailable),
      sub: uxT(locale, "usageLatency.samples", { count: analytics.totalRequests }),
    },
  ];

  return (
    <section
      className="ui-v2 flex flex-col gap-3 rounded-[12px] bg-surface p-4 ring-1 ring-line"
      aria-labelledby="usage-latency-title"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id="usage-latency-title" className="m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">
          {uxT(locale, "usageLatency.title")}
        </h3>
        <p className="m-0 text-[12.5px] leading-5 text-fg-muted">{uxT(locale, "usageLatency.subtitle")}</p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(card => (
          <div key={card.label} className="rounded-[8px] bg-bg px-3 py-2.5 ring-1 ring-line">
            <div className="text-[11.5px] text-fg-subtle">{card.label}</div>
            <div className="mt-0.5 text-[16px] font-semibold tracking-[-0.01em] text-fg tabular-nums">
              {card.value}
            </div>
            <div className="mt-0.5 text-[11px] text-fg-muted tabular-nums">{card.sub}</div>
          </div>
        ))}
      </div>

      {analytics.breakdown.length > 0 && (
        <div className="min-w-0 overflow-x-auto rounded-[8px] bg-bg ring-1 ring-line">
          <table className="w-full border-collapse text-left text-[12.5px] leading-5">
            <thead className="border-b border-line text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{uxT(locale, "usageLatency.colTarget")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{uxT(locale, "usageLatency.colRequests")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{uxT(locale, "usageLatency.colSuccessRate")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{uxT(locale, "usageLatency.colP50")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {analytics.breakdown.map(row => (
                <tr key={`${row.provider}\0${row.model}`}>
                  <td className="px-3 py-1.5 font-mono text-fg">
                    <span className="text-fg-muted">{row.provider}</span>
                    <span className="mx-1 text-fg-subtle">/</span>
                    <span>{row.model}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{row.requests.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{formatPercent(row.successRate, unavailable)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-fg tabular-nums">{formatMs(row.p50DurationMs, locale, unavailable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
