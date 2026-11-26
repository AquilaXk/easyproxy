import { useMemo, useState } from "react";
import {
  inspectPromptContextJson,
  inspectPromptContextPayload,
  type ContextCategoryId,
  type ContextCellKind,
  type ContextEntryItem,
  type ContextInspectionReport,
  type ContextWarningCode,
} from "../../../src/lib/context-inspector";
import { formatTokens } from "../format-tokens";
import { useI18n, type Locale } from "../i18n/shared";
import { uxT, type UxCopyKey } from "../i18n/ux-overhaul-copy";
import {
  SAMPLE_ANTHROPIC_CACHE_PAYLOAD,
  SAMPLE_OPENAI_RESPONSES_PAYLOAD,
} from "../dry-run-fixtures";
import { cn } from "@/lib/utils";

const CATEGORY_COPY_KEY: Record<ContextCellKind, UxCopyKey> = {
  system: "inspector.cat.system",
  tools: "inspector.cat.tools",
  mcp: "inspector.cat.mcp",
  user: "inspector.cat.user",
  assistant: "inspector.cat.assistant",
  toolResults: "inspector.cat.toolResults",
  reasoning: "inspector.cat.reasoning",
  attachments: "inspector.cat.attachments",
  free: "inspector.cat.free",
};

const WARNING_COPY_KEY: Record<ContextWarningCode, UxCopyKey> = {
  volatile_iso_timestamp_in_system: "inspector.warn.volatileClock",
  missing_anthropic_cache_breakpoints: "inspector.warn.missingBreakpoints",
  ttl_ordering_hazard: "inspector.warn.ttlOrder",
  tool_schema_heavy: "inspector.warn.toolHeavy",
  duplicate_tool_outputs: "inspector.warn.duplicateTools",
  oversized_tool_output: "inspector.warn.oversizedTool",
};

export type ContextWaferViewMode = "fit" | "window";

export interface ContextInspectorPanelProps {
  /** Live object payload (e.g. from RequestPlaygroundModal). When omitted, renders an editable JSON box. */
  payload?: unknown;
  initialJson?: string;
  contextWindowTokens?: number;
  compact?: boolean;
}

function formatCategoryReadout(
  report: ContextInspectionReport,
  kind: ContextCellKind,
  locale: Locale,
): string {
  const label = uxT(locale, CATEGORY_COPY_KEY[kind]);
  if (kind === "free") {
    const pct = Math.round((report.freeTokens / Math.max(1, report.contextWindowTokens)) * 100);
    return `${label}: ${formatTokens(report.freeTokens, locale)} (${pct}%)`;
  }
  const cat = report.categories.find(c => c.id === kind);
  if (!cat) return label;
  const pct = Math.round(cat.shareOfUsed * 100);
  return `${label}: ${formatTokens(cat.tokens, locale)} (${pct}%)`;
}

export function ContextInspectorPanel({
  payload,
  initialJson = SAMPLE_ANTHROPIC_CACHE_PAYLOAD,
  contextWindowTokens,
  compact = false,
}: ContextInspectorPanelProps) {
  const { locale } = useI18n();
  const [jsonInput, setJsonInput] = useState(initialJson);
  const [viewMode, setViewMode] = useState<ContextWaferViewMode>("fit");
  const [hoveredKind, setHoveredKind] = useState<ContextCellKind | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<ContextCategoryId | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const report = useMemo<ContextInspectionReport>(() => {
    const opts = contextWindowTokens ? { contextWindowTokens } : undefined;
    if (payload !== undefined) {
      return inspectPromptContextPayload(payload, opts);
    }
    return inspectPromptContextJson(jsonInput, opts);
  }, [payload, jsonInput, contextWindowTokens]);

  const usedPct = Math.min(100, Math.round(report.utilizationRatio * 100));
  const cachedPrefixPct = Math.round(report.cache.cacheablePrefixShare * 100);
  const nonZeroCategories = report.categories.filter(c => c.tokens > 0);
  const activeFilterCategory = selectedCategory && nonZeroCategories.some(c => c.id === selectedCategory)
    ? selectedCategory
    : null;
  const highlightedKind: ContextCellKind | null = hoveredKind ?? activeFilterCategory;
  const displayedCells = viewMode === "fit" ? report.cellsFit : report.cells;

  const visibleEntries = useMemo<ContextEntryItem[]>(() => {
    if (!activeFilterCategory) return report.topEntries.slice(0, 8);
    return report.entries
      .filter(e => e.category === activeFilterCategory)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12);
  }, [report.entries, report.topEntries, activeFilterCategory]);

  const activePreviewEntry = useMemo<ContextEntryItem | null>(() => {
    if (!selectedEntryId) return null;
    return visibleEntries.find(e => e.id === selectedEntryId && Boolean(e.preview)) ?? null;
  }, [visibleEntries, selectedEntryId]);

  const loadSample = (sampleJson: string) => {
    setJsonInput(sampleJson);
    setSelectedCategory(null);
    setSelectedEntryId(null);
  };

  return (
    <div className="flex flex-col gap-3.5 text-fg">
      {payload === undefined && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-fg-muted">{uxT(locale, "inspector.subtitle")}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => loadSample(SAMPLE_ANTHROPIC_CACHE_PAYLOAD)}
              >
                {uxT(locale, "guardrails.dryRunSampleAnthropic")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => loadSample(SAMPLE_OPENAI_RESPONSES_PAYLOAD)}
              >
                {uxT(locale, "inspector.sampleResponses")}
              </button>
            </div>
          </div>
          <textarea
            className="input min-h-[72px] font-mono text-xs"
            rows={3}
            aria-label={uxT(locale, "inspector.title")}
            value={jsonInput}
            onChange={e => {
              setJsonInput(e.target.value);
              setSelectedEntryId(null);
            }}
          />
        </div>
      )}

      {!report.ok ? (
        <p role="status" className="m-0 rounded-control border border-solid border-line bg-inset px-3 py-2 text-xs text-fg-muted">
          {report.error}
        </p>
      ) : (
        <>
          {/* Summary header strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-solid border-line bg-inset px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {report.cache.wireFormat !== "unknown" && (
                <span className="badge badge-muted font-mono">{report.cache.wireFormat}</span>
              )}
              {report.model && (
                <span className="font-mono font-medium text-fg">{report.model}</span>
              )}
              <span className="font-medium text-fg tabular-nums">
                {uxT(locale, "inspector.windowUsed", {
                  used: formatTokens(report.usedTokens, locale),
                  window: formatTokens(report.contextWindowTokens, locale),
                  pct: usedPct,
                })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 tabular-nums">
              <span className={cn("badge", cachedPrefixPct >= 50 ? "badge-green" : "badge-muted")}>
                {uxT(locale, "inspector.cachedPrefix", {
                  pct: cachedPrefixPct,
                  tokens: formatTokens(report.cache.cacheablePrefixTokens, locale),
                })}
              </span>
              <span className="text-fg-muted">
                {uxT(locale, "inspector.uncachedTail", {
                  tokens: formatTokens(report.cache.uncachedActiveTokens, locale),
                })}
              </span>
              {report.cache.wireFormat === "anthropic-messages" && (
                <span className="badge badge-muted font-mono">
                  {uxT(locale, "inspector.breakpoints", { count: report.cache.explicitBreakpoints })}
                </span>
              )}
            </div>
          </div>

          {/* 128-cell proportional context wafer map with Fit / Window toggle */}
          <div className="flex flex-col gap-2 rounded-card border border-solid border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1 rounded-full bg-inset p-0.5 ring-1 ring-inset ring-line">
                <button
                  type="button"
                  data-inspector-mode="fit"
                  aria-pressed={viewMode === "fit"}
                  onClick={() => setViewMode("fit")}
                  className={cn(
                    "min-h-6 cursor-pointer appearance-none rounded-full border-0 px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    viewMode === "fit" ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "bg-transparent text-fg-subtle hover:text-fg",
                  )}
                >
                  {uxT(locale, "inspector.modeFit")}
                </button>
                <button
                  type="button"
                  data-inspector-mode="window"
                  aria-pressed={viewMode === "window"}
                  onClick={() => setViewMode("window")}
                  className={cn(
                    "min-h-6 cursor-pointer appearance-none rounded-full border-0 px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    viewMode === "window" ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "bg-transparent text-fg-subtle hover:text-fg",
                  )}
                >
                  {uxT(locale, "inspector.modeWindow")}
                </button>
              </div>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-subtle tabular-nums">
                <span className="ctx-inspector-cell--cached ctx-swatch--system inline-block h-3 w-3.5 shrink-0 rounded-[3px]" aria-hidden="true" />
                <span>{uxT(locale, "inspector.cachedBadge")}</span>
              </span>
            </div>

            <div
              className="ctx-inspector-grid"
              role="img"
              aria-label={uxT(locale, "inspector.windowUsed", {
                used: formatTokens(report.usedTokens, locale),
                window: formatTokens(report.contextWindowTokens, locale),
                pct: usedPct,
              })}
              onMouseLeave={() => setHoveredKind(null)}
            >
              {displayedCells.map(cell => {
                const dimmed = highlightedKind !== null && highlightedKind !== cell.kind;
                return (
                  <span
                    key={cell.index}
                    onMouseEnter={() => setHoveredKind(cell.kind)}
                    title={formatCategoryReadout(report, cell.kind, locale)}
                    className={cn(
                      "ctx-inspector-cell",
                      `ctx-swatch--${cell.kind}`,
                      cell.cached && "ctx-inspector-cell--cached",
                      dimmed && "opacity-30",
                    )}
                  />
                );
              })}
            </div>

            <div className="flex min-h-4 items-center justify-between gap-2 text-[11px] text-fg-subtle tabular-nums">
              <span>
                {highlightedKind
                  ? formatCategoryReadout(report, highlightedKind, locale)
                  : uxT(locale, "inspector.cachedPrefix", {
                      pct: cachedPrefixPct,
                      tokens: formatTokens(report.cache.cacheablePrefixTokens, locale),
                    })}
              </span>
              <span>
                {uxT(locale, "inspector.cat.free")}: {formatTokens(report.freeTokens, locale)}
              </span>
            </div>
          </div>

          {/* Interactive category filter & breakdown bars */}
          {nonZeroCategories.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {nonZeroCategories.map(cat => {
                const sharePct = Math.max(2, Math.round(cat.shareOfUsed * 100));
                const isSelected = activeFilterCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    data-inspector-category={cat.id}
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedEntryId(null);
                      setSelectedCategory(prev => (prev === cat.id ? null : cat.id));
                    }}
                    onMouseEnter={() => setHoveredKind(cat.id)}
                    onMouseLeave={() => setHoveredKind(null)}
                    className={cn(
                      "flex min-h-6 w-full cursor-pointer appearance-none flex-col gap-1.5 rounded-control border border-solid px-3 py-2 text-left font-inherit transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
                      isSelected
                        ? "border-highlight bg-highlight-soft/45"
                        : "border-line bg-surface hover:bg-surface-2/65",
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2 text-xs">
                      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-fg">
                        <span className={cn("size-2.5 shrink-0 rounded-[2px]", `ctx-swatch--${cat.id}`)} aria-hidden="true" />
                        <span className="truncate">{uxT(locale, CATEGORY_COPY_KEY[cat.id])}</span>
                        <span className="text-[11px] font-normal text-fg-subtle tabular-nums">({cat.itemCount})</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-fg tabular-nums">
                        {formatTokens(cat.tokens, locale)}{" "}
                        <span className="text-fg-subtle">({Math.round(cat.shareOfUsed * 100)}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                      <div
                        className={cn("h-full rounded-full", `ctx-swatch--${cat.id}`)}
                        style={{ width: `${sharePct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Prefix-busting & efficiency warnings */}
          {report.cache.warnings.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {report.cache.warnings.map(code => (
                <li
                  key={code}
                  className="flex items-center gap-2 rounded-control border border-solid border-warning/30 bg-warning-soft px-3 py-1.5 text-xs text-fg"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                  <span>{uxT(locale, WARNING_COPY_KEY[code])}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Top / filtered heavy context contributors + clickable bounded preview */}
          {!compact && visibleEntries.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fg-muted">
                  {activeFilterCategory
                    ? `${uxT(locale, CATEGORY_COPY_KEY[activeFilterCategory])} (${visibleEntries.length})`
                    : uxT(locale, "inspector.topEntries")}
                </span>
                {activeFilterCategory && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCategory(null);
                      setSelectedEntryId(null);
                    }}
                    className="min-h-6 cursor-pointer appearance-none rounded border-0 bg-transparent px-1.5 py-0.5 text-xs font-medium text-highlight hover:underline"
                  >
                    {uxT(locale, "inspector.clearFilter")}
                  </button>
                )}
              </div>
              <div className="divide-y divide-line overflow-hidden rounded-control border border-solid border-line bg-surface">
                {visibleEntries.map(entry => {
                  const isOpen = activePreviewEntry?.id === entry.id;
                  const canPreview = Boolean(entry.preview);
                  return (
                    <div key={entry.id} className="flex flex-col">
                      <button
                        type="button"
                        data-inspector-entry={entry.id}
                        disabled={!canPreview}
                        aria-expanded={canPreview ? isOpen : undefined}
                        onClick={() => {
                          if (!canPreview) return;
                          setSelectedEntryId(prev => (prev === entry.id ? null : entry.id));
                        }}
                        className={cn(
                          "flex min-h-8 w-full appearance-none items-center justify-between gap-3 border-0 bg-transparent px-3 py-1.5 text-left font-inherit text-xs transition-colors",
                          canPreview ? "cursor-pointer hover:bg-surface-2/65 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-highlight" : "cursor-default",
                          isOpen && "bg-surface-2/75",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className={cn("size-2 shrink-0 rounded-[2px]", `ctx-swatch--${entry.category}`)} aria-hidden="true" />
                          <span className="truncate font-mono text-fg" title={entry.label}>{entry.label}</span>
                          {entry.cached && (
                            <span className="badge badge-green shrink-0 text-[10px]">{uxT(locale, "inspector.cachedBadge")}</span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-fg-muted tabular-nums">
                          {formatTokens(entry.tokens, locale)} ({Math.round(entry.shareOfUsed * 100)}%)
                        </span>
                      </button>
                      {isOpen && entry.preview && (
                        <div className="flex flex-col gap-1 border-0 border-t border-solid border-line bg-inset px-3 py-2">
                          {entry.previewTruncated && (
                            <span className="text-[11px] text-fg-subtle">{uxT(locale, "inspector.previewTruncated")}</span>
                          )}
                          <pre
                            tabIndex={0}
                            className="m-0 max-h-36 overflow-auto rounded bg-bg p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-fg ring-1 ring-inset ring-line"
                          >
                            {entry.preview}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
