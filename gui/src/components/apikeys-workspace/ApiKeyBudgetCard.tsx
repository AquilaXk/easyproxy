import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import { formatProviderDisplayName } from "../../provider-icons";
import type { ApiKeyEntry } from "../../pages/api-keys-utils";
import { Combobox } from "../ui-v2/combobox";

export interface ApiKeyBudgetPatch {
  rpmLimit?: number | null;
  maxDailyRequests?: number | null;
  dailyTokenLimit?: number | null;
  dailyCostLimitUsd?: number | null;
  allowedProviders?: string[] | null;
  allowedModels?: string[] | null;
}

function toDraft(value: number | undefined): string {
  return value !== undefined ? String(value) : "";
}

function parseDraftLimit(raw: string, max: number): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) return { ok: false };
  return { ok: true, value: n };
}

function parseDraftCost(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { ok: false };
  return { ok: true, value: n };
}

function parseScopeList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]+/)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 256) break;
  }
  return out;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every(item => setB.has(item));
}

function pct(used: number, limit: number | undefined): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function ApiKeyBudgetCard({
  entry,
  localeTag,
  disabled,
  availableProviders = [],
  availableModels = [],
  onSave,
}: {
  entry: ApiKeyEntry;
  localeTag?: string;
  disabled?: boolean;
  availableProviders?: readonly string[];
  availableModels?: readonly string[];
  onSave: (id: string, patch: ApiKeyBudgetPatch) => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const [rpmEdit, setRpmEdit] = useState<string | null>(null);
  const [dailyReqEdit, setDailyReqEdit] = useState<string | null>(null);
  const [dailyTokEdit, setDailyTokEdit] = useState<string | null>(null);
  const [dailyCostEdit, setDailyCostEdit] = useState<string | null>(null);
  const [providersEdit, setProvidersEdit] = useState<string[] | null>(null);
  const [modelsTextEdit, setModelsTextEdit] = useState<string | null>(null);
  const [modelQuickPick, setModelQuickPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const savedProviders = useMemo(() => entry.allowedProviders ?? [], [entry.allowedProviders]);
  const savedModels = useMemo(() => entry.allowedModels ?? [], [entry.allowedModels]);

  const rpmDraft = rpmEdit ?? toDraft(entry.rpmLimit);
  const dailyReqDraft = dailyReqEdit ?? toDraft(entry.maxDailyRequests);
  const dailyTokDraft = dailyTokEdit ?? toDraft(entry.dailyTokenLimit);
  const dailyCostDraft = dailyCostEdit ?? toDraft(entry.dailyCostLimitUsd);
  const providersDraft = providersEdit ?? savedProviders;
  const modelsTextDraft = modelsTextEdit ?? savedModels.join(", ");
  const parsedModelsDraft = useMemo(() => parseScopeList(modelsTextDraft), [modelsTextDraft]);

  const providerChoices = useMemo(() => {
    const set = new Set<string>(availableProviders);
    for (const p of savedProviders) {
      if (p) set.add(p);
    }
    return Array.from(set).sort();
  }, [availableProviders, savedProviders]);

  const usage = entry.budgetUsage ?? {
    rpmCurrent: 0,
    dailyRequestsUsed: 0,
    dailyTokensUsed: 0,
    dailyCostUsdUsed: 0,
  };
  const dailyCostUsed = usage.dailyCostUsdUsed ?? 0;

  const submitPatch = async (patch: ApiKeyBudgetPatch) => {
    setSaving(true);
    setFeedback(null);
    try {
      const ok = await onSave(entry.id, patch);
      if (ok) {
        setRpmEdit(null);
        setDailyReqEdit(null);
        setDailyTokEdit(null);
        setDailyCostEdit(null);
        setProvidersEdit(null);
        setModelsTextEdit(null);
        setFeedback({ ok: true, text: uxT(locale, "budget.saved") });
      } else {
        setFeedback({ ok: false, text: uxT(locale, "budget.saveFailed") });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const rpm = parseDraftLimit(rpmDraft, 1_000_000);
    const req = parseDraftLimit(dailyReqDraft, 100_000_000);
    const tok = parseDraftLimit(dailyTokDraft, 10_000_000_000);
    if (!rpm.ok || !req.ok || !tok.ok) {
      setFeedback({ ok: false, text: uxT(locale, "budget.invalidNumber") });
      return;
    }
    const cost = parseDraftCost(dailyCostDraft);
    if (!cost.ok) {
      setFeedback({ ok: false, text: uxT(locale, "budget.invalidCost") });
      return;
    }
    const nextProviders = Array.from(new Set(providersDraft.map(p => p.trim()).filter(Boolean)));
    const nextModels = parseScopeList(modelsTextDraft);
    void submitPatch({
      rpmLimit: rpm.value,
      maxDailyRequests: req.value,
      dailyTokenLimit: tok.value,
      dailyCostLimitUsd: cost.value,
      allowedProviders: nextProviders.length > 0 ? nextProviders : null,
      allowedModels: nextModels.length > 0 ? nextModels : null,
    });
  };

  const handleClear = () => {
    void submitPatch({
      rpmLimit: null,
      maxDailyRequests: null,
      dailyTokenLimit: null,
      dailyCostLimitUsd: null,
      allowedProviders: null,
      allowedModels: null,
    });
  };

  const busy = Boolean(disabled) || saving;
  const dirty =
    rpmDraft !== toDraft(entry.rpmLimit)
    || dailyReqDraft !== toDraft(entry.maxDailyRequests)
    || dailyTokDraft !== toDraft(entry.dailyTokenLimit)
    || dailyCostDraft !== toDraft(entry.dailyCostLimitUsd)
    || !sameStringList(providersDraft, savedProviders)
    || !sameStringList(parsedModelsDraft, savedModels);

  const toggleProvider = (provider: string) => {
    const nextSet = new Set(providersDraft);
    if (nextSet.has(provider)) nextSet.delete(provider);
    else nextSet.add(provider);
    setProvidersEdit(Array.from(nextSet).sort());
  };

  const removeModelTag = (modelId: string) => {
    const next = parsedModelsDraft.filter(item => item !== modelId);
    setModelsTextEdit(next.join(", "));
  };

  const addModelFromPicker = (picked: string) => {
    const tokens = picked.split(",").map(item => item.trim()).filter(Boolean);
    if (tokens.length === 0) return;
    const next = [...parsedModelsDraft];
    for (const token of tokens) {
      if (!next.includes(token)) next.push(token);
    }
    setModelsTextEdit(next.join(", "));
    setModelQuickPick("");
  };

  const integerRows = [
    {
      id: "awi-budget-rpm",
      label: uxT(locale, "budget.rpmLabel"),
      value: rpmDraft,
      onChange: (value: string) => setRpmEdit(value),
      used: usage.rpmCurrent,
      limit: entry.rpmLimit,
    },
    {
      id: "awi-budget-daily-req",
      label: uxT(locale, "budget.dailyReqLabel"),
      value: dailyReqDraft,
      onChange: (value: string) => setDailyReqEdit(value),
      used: usage.dailyRequestsUsed,
      limit: entry.maxDailyRequests,
    },
    {
      id: "awi-budget-daily-tok",
      label: uxT(locale, "budget.dailyTokensLabel"),
      value: dailyTokDraft,
      onChange: (value: string) => setDailyTokEdit(value),
      used: usage.dailyTokensUsed,
      limit: entry.dailyTokenLimit,
    },
  ] as const;

  const costPct = pct(dailyCostUsed, entry.dailyCostLimitUsd);
  const hasAnySavedLimit =
    entry.rpmLimit !== undefined
    || entry.maxDailyRequests !== undefined
    || entry.dailyTokenLimit !== undefined
    || entry.dailyCostLimitUsd !== undefined
    || savedProviders.length > 0
    || savedModels.length > 0;

  return (
    <div className="awi-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="awi-section-title">{uxT(locale, "budget.title")}</h3>
        {dirty && <span className="badge badge-amber">{uxT(locale, "budget.unsaved")}</span>}
      </div>
      <p className="muted mb-3 text-[13px]">{uxT(locale, "budget.subtitle")}</p>
      <p className="mb-3 rounded-card border border-solid border-line bg-surface px-3 py-2 text-xs text-fg-muted" role="note">
        {uxT(locale, "budget.loopbackNotice")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {integerRows.map(row => {
          const percent = pct(row.used, row.limit);
          const usedFmt = row.used.toLocaleString(localeTag);
          const limitFmt = row.limit !== undefined ? row.limit.toLocaleString(localeTag) : uxT(locale, "budget.unlimited");
          return (
            <div key={row.id} className="flex flex-col gap-1.5 rounded-card border border-solid border-line bg-inset p-3">
              <label htmlFor={row.id} className="text-xs font-medium text-fg-muted">{row.label}</label>
              <input
                id={row.id}
                type="number"
                min={1}
                step={1}
                className="input"
                placeholder={uxT(locale, "budget.unlimited")}
                value={row.value}
                disabled={busy}
                onChange={e => row.onChange(e.target.value)}
              />
              <div className="flex items-center justify-between text-xs text-fg-muted tabular-nums">
                <span>{uxT(locale, "budget.usageSummary", { used: usedFmt, limit: limitFmt })}</span>
                {row.limit !== undefined && <span>{percent}%</span>}
              </div>
              {row.limit !== undefined && (
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <div
                    className={percent >= 90 ? "h-full rounded-full bg-danger" : "h-full rounded-full bg-accent"}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
        <div className="flex flex-col gap-1.5 rounded-card border border-solid border-line bg-inset p-3">
          <label htmlFor="awi-budget-daily-cost" className="text-xs font-medium text-fg-muted">
            {uxT(locale, "budget.dailyCostLabel")}
          </label>
          <input
            id="awi-budget-daily-cost"
            type="number"
            min={0.000001}
            max={1_000_000}
            step="0.01"
            className="input"
            placeholder={uxT(locale, "budget.unlimited")}
            value={dailyCostDraft}
            disabled={busy}
            onChange={e => setDailyCostEdit(e.target.value)}
          />
          <div className="flex items-center justify-between text-xs text-fg-muted tabular-nums">
            <span>
              {uxT(locale, "budget.usageSummary", {
                used: formatUsd(dailyCostUsed),
                limit: entry.dailyCostLimitUsd !== undefined ? formatUsd(entry.dailyCostLimitUsd) : uxT(locale, "budget.unlimited"),
              })}
            </span>
            {entry.dailyCostLimitUsd !== undefined && <span>{costPct}%</span>}
          </div>
          {entry.dailyCostLimitUsd !== undefined && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div
                className={costPct >= 90 ? "h-full rounded-full bg-danger" : "h-full rounded-full bg-accent"}
                style={{ width: `${costPct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-card border border-solid border-line bg-inset p-3">
          <span className="text-xs font-medium text-fg-muted">{uxT(locale, "budget.allowedProvidersLabel")}</span>
          {providerChoices.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={uxT(locale, "budget.allowedProvidersLabel")}>
              {providerChoices.map(provider => {
                const selected = providersDraft.includes(provider);
                return (
                  <button
                    key={provider}
                    type="button"
                    aria-pressed={selected}
                    disabled={busy}
                    onClick={() => toggleProvider(provider)}
                    data-provider={provider}
                    className={selected
                      ? "btn btn-sm border border-solid border-[var(--epx-highlight)] bg-[var(--epx-accent-soft)] text-[var(--epx-highlight)]"
                      : "btn btn-ghost btn-sm border border-solid border-line text-fg-muted"}
                  >
                    {formatProviderDisplayName(provider, t)}
                  </button>
                );
              })}
            </div>
          )}
          <span className="text-xs text-fg-subtle">{uxT(locale, "budget.allProviders")}</span>
        </div>

        <div className="flex flex-col gap-2 rounded-card border border-solid border-line bg-inset p-3">
          <label htmlFor="awi-budget-allowed-models" className="text-xs font-medium text-fg-muted">
            {uxT(locale, "budget.allowedModelsLabel")}
          </label>
          <div
            className="flex items-center gap-2"
            onKeyDown={e => {
              if (e.defaultPrevented) return;
              if (e.key === "Enter" || e.key === ",") {
                const candidate = modelQuickPick.trim();
                if (!candidate) return;
                e.preventDefault();
                addModelFromPicker(candidate);
              }
            }}
          >
            <Combobox
              className="flex-1"
              value={modelQuickPick}
              onChange={next => {
                if (next.includes(",")) {
                  addModelFromPicker(next);
                } else {
                  setModelQuickPick(next);
                }
              }}
              onSelect={addModelFromPicker}
              options={availableModels.filter(id => !parsedModelsDraft.includes(id))}
              placeholder={uxT(locale, "playground.modelPlaceholder")}
              aria-label={uxT(locale, "budget.allowedModelsLabel")}
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0"
              disabled={busy || !modelQuickPick.trim()}
              onClick={() => addModelFromPicker(modelQuickPick)}
            >
              {t("subagentsV2.add")}
            </button>
          </div>
          <textarea
            id="awi-budget-allowed-models"
            className="input min-h-[64px] font-mono text-xs"
            rows={2}
            placeholder={uxT(locale, "budget.allowedModelsPlaceholder")}
            value={modelsTextDraft}
            disabled={busy}
            onChange={e => setModelsTextEdit(e.target.value)}
          />
          {parsedModelsDraft.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {parsedModelsDraft.map(modelId => (
                <button
                  key={modelId}
                  type="button"
                  disabled={busy}
                  onClick={() => removeModelTag(modelId)}
                  className="badge badge-muted cursor-pointer font-mono hover:text-fg"
                >
                  {modelId} ×
                </button>
              ))}
            </div>
          )}
          <span className="text-xs text-fg-subtle">{uxT(locale, "budget.allowedModelsHint")}</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={handleSave}>
          {saving ? uxT(locale, "budget.saving") : uxT(locale, "budget.save")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !hasAnySavedLimit}
          onClick={handleClear}
        >
          {uxT(locale, "budget.clear")}
        </button>
        {feedback && (
          <span role={feedback.ok ? "status" : "alert"} className={feedback.ok ? "text-xs text-success" : "text-xs text-danger"}>
            {feedback.text}
          </span>
        )}
      </div>
    </div>
  );
}
