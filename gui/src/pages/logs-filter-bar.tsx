import { useId, useRef, useState, type ReactNode } from "react";
import { useI18n, type TFn, type TKey } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { IconFilter, IconSearch, IconX } from "../icons";
import { formatProviderDisplayName } from "../provider-icons";
import { PROTOCOL_MODE_KEYS } from "../components/protocols/protocol-labels";
import { chip, fieldControl, fieldLabel, quietButton } from "../components/v2-logs/classes";
import { cn } from "@/lib/utils";
import { Select } from "../ui";
import { LOG_PROTOCOL_MODE_FILTERS, type LogFilterState, type LogProtocolModeFilter, type LogStatusFilter, type LogTimeWindow } from "./logs-filter";

interface LogsFilterBarProps {
  filters: LogFilterState;
  options: { models: string[]; providers: string[]; apiKeys?: string[] };
  hasActiveFilters: boolean;
  filteredCount: number;
  totalCount: number;
  t: TFn;
  onFilterChange: (next: LogFilterState) => void;
  onResetFilters: () => void;
  /** Table controls that share the toolbar row (the column toggles). */
  trailing?: ReactNode;
}

/** The compact 32px field the filter grid uses, filling its column. */
const FILTER_SELECT = { fullWidth: true, size: "sm", triggerClassName: "px-2.5 text-fg" } as const;

type SpeedChoice = "all" | "slow" | "medium" | "fast";

function speedChoice(filters: LogFilterState): SpeedChoice {
  if (filters.maxTokPerSec === 15) return "slow";
  if (filters.minTokPerSec === 15 && filters.maxTokPerSec === 50) return "medium";
  if (filters.minTokPerSec === 50) return "fast";
  return "all";
}

function speedBounds(value: string): Pick<LogFilterState, "minTokPerSec" | "maxTokPerSec"> {
  if (value === "slow") return { minTokPerSec: undefined, maxTokPerSec: 15 };
  if (value === "medium") return { minTokPerSec: 15, maxTokPerSec: 50 };
  if (value === "fast") return { minTokPerSec: 50, maxTokPerSec: undefined };
  return { minTokPerSec: undefined, maxTokPerSec: undefined };
}

/*
 * The Logs toolbar (React Bits monitoring-5 + data-table-1): one row with the conversation
 * search, a Filters disclosure and the column toggles; the rest of the
 * filters fold into a panel under it, and whatever is active shows as removable chips with
 * the match count and one reset. The folded panel stays mounted so its fields keep their
 * state and remain reachable by label.
 */
export function LogsFilterBar({
  filters, options, hasActiveFilters, filteredCount, totalCount, t, onFilterChange, onResetFilters, trailing,
}: LogsFilterBarProps) {
  const { locale } = useI18n();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const resetFilters = () => {
    onResetFilters();
    searchRef.current?.focus({ preventScroll: true });
  };
  const set = (patch: Partial<LogFilterState>) => onFilterChange({ ...filters, ...patch });
  const currentSpeed = speedChoice(filters);
  const protocolMode = filters.protocolMode ?? "all";
  const apiKeys = options.apiKeys ?? [];
  const activeApiKey = (filters.apiKeyId ?? "").trim();
  const activeDurationMs = typeof filters.minDurationMs === "number" && Number.isFinite(filters.minDurationMs) && filters.minDurationMs > 0
    ? filters.minDurationMs
    : undefined;

  const statusLabel = (status: LogStatusFilter): string => {
    if (status === "429") return uxT(locale, "logs.status429");
    if (status === "auth") return uxT(locale, "logs.statusAuth");
    if (status === "5xx") return uxT(locale, "logs.status5xx");
    return t(`logs.filter.status.${status}`);
  };
  const durationLabel = (ms: number): string => {
    if (ms >= 30_000) return uxT(locale, "logs.duration30s");
    if (ms >= 5_000) return uxT(locale, "logs.duration5s");
    return uxT(locale, "logs.duration1s");
  };

  // Everything the folded panel holds, as chips that each clear one filter.
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.interceptedOnly) chips.push({ key: "intercepted", label: t("logs.filter.interceptedHelpersOnly"), clear: () => set({ interceptedOnly: false }) });
  if (filters.provider) chips.push({ key: "provider", label: `${t("logs.filter.provider.label")}: ${formatProviderDisplayName(filters.provider, t)}`, clear: () => set({ provider: "" }) });
  if (filters.model) chips.push({ key: "model", label: `${t("logs.filter.model.label")}: ${filters.model}`, clear: () => set({ model: "" }) });
  if (filters.timeWindow !== "all") chips.push({ key: "time", label: `${t("logs.filter.time.label")}: ${t(`logs.filter.time.${filters.timeWindow}`)}`, clear: () => set({ timeWindow: "all" }) });
  if (currentSpeed !== "all") chips.push({ key: "speed", label: `${t("logs.filter.speed.label")}: ${t(`logs.filter.speed.${currentSpeed}`)}`, clear: () => set(speedBounds("all")) });
  if (filters.status !== "all") chips.push({ key: "status", label: `${t("logs.filter.status.label")}: ${statusLabel(filters.status)}`, clear: () => set({ status: "all" }) });
  if (protocolMode !== "all") chips.push({ key: "protocol", label: `${t("logs.filter.protocol.label")}: ${t(protocolModeFilterKey(protocolMode))}`, clear: () => set({ protocolMode: "all" }) });
  if (activeApiKey) chips.push({ key: "apiKey", label: `${uxT(locale, "logs.apiKeyLabel")}: ${activeApiKey}`, clear: () => set({ apiKeyId: undefined }) });
  if (activeDurationMs !== undefined) chips.push({ key: "duration", label: `${uxT(locale, "logs.durationLabel")}: ${durationLabel(activeDurationMs)}`, clear: () => set({ minDurationMs: undefined }) });

  return (
    <div className="logs-filter-container flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-72">
          <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" />
          <input
            ref={searchRef}
            type="search"
            className={cn(fieldControl, "mono placeholder:font-sans pl-8")}
            value={filters.conversationId}
            onChange={event => set({ conversationId: event.target.value })}
            placeholder={t("logs.filter.conversation.placeholder")}
            aria-label={t("logs.filter.conversation.label")}
          />
        </div>

        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(value => !value)}
          className={quietButton}
        >
          <IconFilter aria-hidden />
          {t("logsV2.filters")}
          {chips.length > 0 && (
            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-xs font-semibold text-on-accent tabular-nums">
              {chips.length}
            </span>
          )}
        </button>

        {trailing && <div className="ml-auto flex items-center gap-1">{trailing}</div>}
      </div>

      <div
        id={panelId}
        hidden={!open}
        className={cn(
          "grid-cols-2 gap-3 rounded-[10px] bg-bg p-3 ring-1 ring-inset ring-line sm:grid-cols-3 lg:grid-cols-6",
          open ? "grid" : "hidden",
        )}
      >
        <label className={fieldLabel}>
          {t("logs.filter.provider.label")}
          <Select {...FILTER_SELECT} value={filters.provider} label={t("logs.filter.provider.label")} onChange={provider => set({ provider })}
            options={[
              { value: "", label: t("logs.filter.provider.all") },
              ...options.providers.map(provider => ({ value: provider, label: formatProviderDisplayName(provider, t) })),
            ]} />
        </label>

        <label className={fieldLabel}>
          {t("logs.filter.model.label")}
          <Select {...FILTER_SELECT} value={filters.model} label={t("logs.filter.model.label")} onChange={model => set({ model })}
            options={[
              { value: "", label: t("logs.filter.model.all") },
              ...options.models.map(model => ({ value: model, label: model })),
            ]} />
        </label>

        <label className={fieldLabel}>
          {t("logs.filter.time.label")}
          <Select {...FILTER_SELECT} value={filters.timeWindow} label={t("logs.filter.time.label")}
            onChange={timeWindow => set({ timeWindow: timeWindow as LogTimeWindow })}
            options={[
              { value: "all", label: t("logs.filter.time.all") },
              { value: "15m", label: t("logs.filter.time.15m") },
              { value: "1h", label: t("logs.filter.time.1h") },
              { value: "24h", label: t("logs.filter.time.24h") },
            ]} />
        </label>

        <label className={fieldLabel}>
          {t("logs.filter.speed.label")}
          <Select {...FILTER_SELECT} value={currentSpeed} label={t("logs.filter.speed.label")} onChange={speed => set(speedBounds(speed))}
            options={[
              { value: "all", label: t("logs.filter.speed.all") },
              { value: "slow", label: t("logs.filter.speed.slow") },
              { value: "medium", label: t("logs.filter.speed.medium") },
              { value: "fast", label: t("logs.filter.speed.fast") },
            ]} />
        </label>

        <label className={fieldLabel}>
          {t("logs.filter.status.label")}
          <Select {...FILTER_SELECT} value={filters.status} label={t("logs.filter.status.label")}
            onChange={status => set({ status: status as LogStatusFilter })}
            options={[
              { value: "all", label: t("logs.filter.status.all") },
              { value: "success", label: t("logs.filter.status.success") },
              { value: "errors", label: t("logs.filter.status.errors") },
              { value: "429", label: uxT(locale, "logs.status429") },
              { value: "auth", label: uxT(locale, "logs.statusAuth") },
              { value: "5xx", label: uxT(locale, "logs.status5xx") },
            ]} />
        </label>

        <label className={fieldLabel}>
          {t("logs.filter.protocol.label")}
          <Select {...FILTER_SELECT} value={protocolMode} label={t("logs.filter.protocol.label")}
            onChange={mode => set({ protocolMode: mode as LogProtocolModeFilter })}
            options={LOG_PROTOCOL_MODE_FILTERS.map(mode => ({ value: mode, label: t(protocolModeFilterKey(mode)) }))} />
        </label>

        <div className={fieldLabel}>
          <span>{uxT(locale, "logs.durationLabel")}</span>
          <div
            role="group"
            aria-label={uxT(locale, "logs.durationLabel")}
            className="inline-flex h-[var(--epx-control-h)] items-center gap-0.5 rounded-control border border-line bg-inset p-0.5"
          >
            {([
              { value: undefined, labelKey: "logs.durationAll" },
              { value: 1000, labelKey: "logs.duration1s" },
              { value: 5000, labelKey: "logs.duration5s" },
              { value: 30000, labelKey: "logs.duration30s" },
            ] as const).map(opt => {
              const pressed = activeDurationMs === opt.value;
              return (
                <button
                  key={opt.labelKey}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => set({ minDurationMs: opt.value })}
                  className={cn(
                    "cursor-pointer rounded-[5px] px-2 py-1 text-xs font-medium transition-colors",
                    pressed ? "bg-raised text-fg shadow-sm ring-1 ring-inset ring-line" : "text-fg-muted hover:text-fg",
                  )}
                >
                  {uxT(locale, opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {(apiKeys.length > 0 || activeApiKey) && (
          <label className={fieldLabel}>
            {uxT(locale, "logs.apiKeyLabel")}
            <Select
              {...FILTER_SELECT}
              value={activeApiKey}
              label={uxT(locale, "logs.apiKeyLabel")}
              onChange={apiKeyId => set({ apiKeyId: apiKeyId || undefined })}
              options={[
                { value: "", label: uxT(locale, "logs.apiKeyAll") },
                ...apiKeys.map(id => ({ value: id, label: id })),
                ...(activeApiKey && !apiKeys.includes(activeApiKey) ? [{ value: activeApiKey, label: activeApiKey }] : []),
              ]}
            />
          </label>
        )}

        <label className="col-span-full inline-flex w-fit cursor-pointer items-center gap-2 text-[13px] text-fg-muted hover:text-fg">
          <input
            type="checkbox"
            className="size-4 cursor-pointer accent-[var(--epx-accent)]"
            checked={filters.interceptedOnly}
            onChange={event => set({ interceptedOnly: event.target.checked })}
          />
          {t("logs.filter.interceptedHelpersOnly")}
        </label>
      </div>

      {hasActiveFilters && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {chips.map(item => (
            <button
              key={item.key}
              type="button"
              className={chip}
              onClick={item.clear}
              aria-label={t("logsV2.removeFilter", { name: item.label })}
            >
              <span className="truncate">{item.label}</span>
              <IconX aria-hidden />
            </button>
          ))}
          <div className="logs-filter-status ml-auto inline-flex flex-wrap items-center gap-1">
            <span className="text-[13px] text-fg-muted tabular-nums">{t("logs.filter.showingCount", { count: filteredCount, total: totalCount })}</span>
            <button type="button" className={quietButton} onClick={resetFilters}>
              <IconX aria-hidden /> {t("logs.filter.reset")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function protocolModeFilterKey(mode: LogProtocolModeFilter): TKey {
  if (mode === "all") return "logs.filter.protocol.all";
  if (mode === "none") return "logs.filter.protocol.none";
  return PROTOCOL_MODE_KEYS[mode];
}
