import { useState } from "react";
import { useI18n } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import type { ApiKeyEntry } from "../../pages/api-keys-utils";

export interface ApiKeyBudgetPatch {
  rpmLimit?: number | null;
  maxDailyRequests?: number | null;
  dailyTokenLimit?: number | null;
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

function pct(used: number, limit: number | undefined): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function ApiKeyBudgetCard({
  entry,
  localeTag,
  disabled,
  onSave,
}: {
  entry: ApiKeyEntry;
  localeTag?: string;
  disabled?: boolean;
  onSave: (id: string, patch: ApiKeyBudgetPatch) => Promise<boolean>;
}) {
  const { locale } = useI18n();
  const [rpmEdit, setRpmEdit] = useState<string | null>(null);
  const [dailyReqEdit, setDailyReqEdit] = useState<string | null>(null);
  const [dailyTokEdit, setDailyTokEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const rpmDraft = rpmEdit ?? toDraft(entry.rpmLimit);
  const dailyReqDraft = dailyReqEdit ?? toDraft(entry.maxDailyRequests);
  const dailyTokDraft = dailyTokEdit ?? toDraft(entry.dailyTokenLimit);

  const usage = entry.budgetUsage ?? { rpmCurrent: 0, dailyRequestsUsed: 0, dailyTokensUsed: 0 };

  const submitPatch = async (patch: ApiKeyBudgetPatch) => {
    setSaving(true);
    setFeedback(null);
    try {
      const ok = await onSave(entry.id, patch);
      if (ok) {
        setRpmEdit(null);
        setDailyReqEdit(null);
        setDailyTokEdit(null);
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
    void submitPatch({
      rpmLimit: rpm.value,
      maxDailyRequests: req.value,
      dailyTokenLimit: tok.value,
    });
  };

  const handleClear = () => {
    void submitPatch({ rpmLimit: null, maxDailyRequests: null, dailyTokenLimit: null });
  };

  const busy = Boolean(disabled) || saving;
  const rows = [
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

  return (
    <div className="awi-section">
      <h3 className="awi-section-title">{uxT(locale, "budget.title")}</h3>
      <p className="muted mb-3 text-[13px]">{uxT(locale, "budget.subtitle")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map(row => {
          const percent = pct(row.used, row.limit);
          const usedFmt = row.used.toLocaleString(localeTag);
          const limitFmt = row.limit !== undefined ? row.limit.toLocaleString(localeTag) : uxT(locale, "budget.unlimited");
          return (
            <div key={row.id} className="flex flex-col gap-1.5 rounded-card border border-line bg-inset p-3">
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
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={handleSave}>
          {saving ? uxT(locale, "budget.saving") : uxT(locale, "budget.save")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || (entry.rpmLimit === undefined && entry.maxDailyRequests === undefined && entry.dailyTokenLimit === undefined)}
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
