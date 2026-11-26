import { useCallback, useEffect, useRef, useState } from "react";
import { Notice, Select, Switch } from "../ui";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { readJsonIfOk } from "../fetch-json";

export type SecretGuardMode = "off" | "redact" | "block";

export interface GuardrailsPayload {
  outboundSecretGuard: { mode: SecretGuardMode };
  toolOutputCompression: {
    enabled: boolean;
    minChars: number;
    headChars: number;
    tailChars: number;
    stripAnsi: boolean;
  };
  stats: {
    scannedRequests: number;
    secretDetections: number;
    secretBlocks: number;
    compressedToolOutputs: number;
    savedChars: number;
  };
}

export interface GuardrailsDryRunResult {
  blocked: boolean;
  limitExceeded: boolean;
  matches: number;
  redactions: number;
  findings: string[];
  compressedItems: number;
  originalChars: number;
  outputChars: number;
  savedChars: number;
  previewText: string;
}

const MAX_DRY_RUN_INPUT_CHARS = 65_536;

function parseDryRunResult(raw: unknown): GuardrailsDryRunResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.blocked !== "boolean"
    || typeof r.limitExceeded !== "boolean"
    || typeof r.matches !== "number" || !Number.isFinite(r.matches)
    || typeof r.redactions !== "number" || !Number.isFinite(r.redactions)
    || typeof r.compressedItems !== "number" || !Number.isFinite(r.compressedItems)
    || typeof r.originalChars !== "number" || !Number.isFinite(r.originalChars)
    || typeof r.outputChars !== "number" || !Number.isFinite(r.outputChars)
    || typeof r.savedChars !== "number" || !Number.isFinite(r.savedChars)
    || typeof r.previewText !== "string"
    || !Array.isArray(r.findings)
  ) {
    return null;
  }
  const findings: string[] = [];
  for (const item of r.findings) {
    if (typeof item === "string" && item) findings.push(item);
    if (findings.length >= 64) break;
  }
  return {
    blocked: r.blocked,
    limitExceeded: r.limitExceeded,
    matches: r.matches,
    redactions: r.redactions,
    findings,
    compressedItems: r.compressedItems,
    originalChars: r.originalChars,
    outputChars: r.outputChars,
    savedChars: r.savedChars,
    previewText: r.previewText,
  };
}

export default function GatewayGuardrailsPanel({
  apiBase,
  readOnly = false,
}: {
  apiBase: string;
  readOnly?: boolean;
}) {
  const { locale } = useI18n();
  const [data, setData] = useState<GuardrailsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const [modeOverride, setModeOverride] = useState<SecretGuardMode | null>(null);
  const [compressionOverride, setCompressionOverride] = useState<boolean | null>(null);
  const [minCharsOverride, setMinCharsOverride] = useState<string | null>(null);
  const [headCharsOverride, setHeadCharsOverride] = useState<string | null>(null);
  const [tailCharsOverride, setTailCharsOverride] = useState<string | null>(null);
  const [stripAnsiOverride, setStripAnsiOverride] = useState<boolean | null>(null);
  const [dryRunText, setDryRunText] = useState("");
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<GuardrailsDryRunResult | null>(null);
  const dryRunAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    dryRunAbortRef.current?.abort();
  }, []);

  const mode = modeOverride ?? data?.outboundSecretGuard.mode ?? "off";
  const compressionEnabled = compressionOverride ?? data?.toolOutputCompression.enabled ?? false;
  const minChars = minCharsOverride ?? String(data?.toolOutputCompression.minChars ?? 12000);
  const headChars = headCharsOverride ?? String(data?.toolOutputCompression.headChars ?? 4000);
  const tailChars = tailCharsOverride ?? String(data?.toolOutputCompression.tailChars ?? 4000);
  const stripAnsi = stripAnsiOverride ?? data?.toolOutputCompression.stripAnsi ?? false;

  const hydrate = useCallback((payload: GuardrailsPayload) => {
    setData(payload);
    setModeOverride(null);
    setCompressionOverride(null);
    setMinCharsOverride(null);
    setHeadCharsOverride(null);
    setTailCharsOverride(null);
    setStripAnsiOverride(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void fetch(`${apiBase}/api/gateway-guardrails`, { signal: ac.signal })
      .then(res => readJsonIfOk<GuardrailsPayload>(res))
      .then(body => {
        if (cancelled) return;
        if (!body || !body.outboundSecretGuard || !body.toolOutputCompression) {
          setLoadError(uxT(locale, "guardrails.loadFailed"));
          return;
        }
        setLoadError(null);
        hydrate(body);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === "AbortError")) return;
        setLoadError(uxT(locale, "guardrails.loadFailed"));
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase, hydrate, locale]);

  const handleSave = async () => {
    if (readOnly || saving) return;
    const min = Number(minChars.trim());
    const head = Number(headChars.trim());
    const tail = Number(tailChars.trim());
    if (
      !Number.isSafeInteger(min) || min < 512 || min > 500_000
      || !Number.isSafeInteger(head) || head < 0 || head > 100_000
      || !Number.isSafeInteger(tail) || tail < 0 || tail > 100_000
    ) {
      setStatus({ ok: false, text: uxT(locale, "guardrails.saveFailed") });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/gateway-guardrails`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundSecretGuard: { mode },
          toolOutputCompression: {
            enabled: compressionEnabled,
            minChars: min,
            headChars: head,
            tailChars: tail,
            stripAnsi,
          },
        }),
      });
      const updated = await readJsonIfOk<GuardrailsPayload>(res);
      if (!updated) {
        setStatus({ ok: false, text: uxT(locale, "guardrails.saveFailed") });
        return;
      }
      hydrate(updated);
      setStatus({ ok: true, text: uxT(locale, "guardrails.saved") });
    } catch {
      setStatus({ ok: false, text: uxT(locale, "guardrails.saveFailed") });
    } finally {
      setSaving(false);
    }
  };

  const handleDryRun = async () => {
    if (dryRunBusy || !dryRunText.trim()) return;
    dryRunAbortRef.current?.abort();
    const ac = new AbortController();
    dryRunAbortRef.current = ac;
    setDryRunBusy(true);
    setDryRunError(null);
    const min = Number(minChars.trim());
    const head = Number(headChars.trim());
    const tail = Number(tailChars.trim());
    try {
      const res = await fetch(`${apiBase}/api/gateway-guardrails/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: dryRunText.slice(0, MAX_DRY_RUN_INPUT_CHARS),
          outboundSecretGuard: { mode },
          toolOutputCompression: {
            enabled: compressionEnabled,
            ...(Number.isSafeInteger(min) && min >= 512 && min <= 500_000 ? { minChars: min } : {}),
            ...(Number.isSafeInteger(head) && head >= 0 && head <= 100_000 ? { headChars: head } : {}),
            ...(Number.isSafeInteger(tail) && tail >= 0 && tail <= 100_000 ? { tailChars: tail } : {}),
            stripAnsi,
          },
        }),
        signal: ac.signal,
      });
      const raw = await readJsonIfOk<unknown>(res);
      const parsed = parseDryRunResult(raw);
      if (!parsed) {
        setDryRunError(uxT(locale, "guardrails.dryRunFailed"));
        return;
      }
      setDryRunResult(parsed);
    } catch (error: unknown) {
      if (ac.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
      setDryRunError(uxT(locale, "guardrails.dryRunFailed"));
    } finally {
      if (dryRunAbortRef.current === ac) {
        dryRunAbortRef.current = null;
        setDryRunBusy(false);
      }
    }
  };

  if (loadError && !data) {
    return <Notice tone="err">{loadError}</Notice>;
  }

  const stats = data?.stats ?? {
    scannedRequests: 0,
    secretDetections: 0,
    secretBlocks: 0,
    compressedToolOutputs: 0,
    savedChars: 0,
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {readOnly && <p className="m-0 text-xs text-fg-muted">{uxT(locale, "guardrails.readOnlyHint")}</p>}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-solid border-line bg-line sm:grid-cols-5">
        <div className="bg-surface px-3 py-2">
          <div className="text-xs text-fg-subtle">{uxT(locale, "guardrails.statScanned")}</div>
          <div className="text-sm font-semibold tabular-nums">{stats.scannedRequests.toLocaleString()}</div>
        </div>
        <div className="bg-surface px-3 py-2">
          <div className="text-xs text-fg-subtle">{uxT(locale, "guardrails.statDetections")}</div>
          <div className="text-sm font-semibold tabular-nums">{stats.secretDetections.toLocaleString()}</div>
        </div>
        <div className="bg-surface px-3 py-2">
          <div className="text-xs text-fg-subtle">{uxT(locale, "guardrails.statBlocks")}</div>
          <div className="text-sm font-semibold tabular-nums">{stats.secretBlocks.toLocaleString()}</div>
        </div>
        <div className="bg-surface px-3 py-2">
          <div className="text-xs text-fg-subtle">{uxT(locale, "guardrails.statCompressed")}</div>
          <div className="text-sm font-semibold tabular-nums">{stats.compressedToolOutputs.toLocaleString()}</div>
        </div>
        <div className="bg-surface px-3 py-2">
          <div className="text-xs text-fg-subtle">{uxT(locale, "guardrails.statSavedChars")}</div>
          <div className="text-sm font-semibold tabular-nums">{stats.savedChars.toLocaleString()}</div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="guardrails-secret-mode" className="text-xs font-medium text-fg-muted">
            {uxT(locale, "guardrails.secretModeLabel")}
          </label>
          <Select
            id="guardrails-secret-mode"
            value={mode}
            disabled={readOnly || saving}
            onChange={v => setModeOverride(v as SecretGuardMode)}
            options={[
              { value: "off", label: uxT(locale, "guardrails.secretModeOff") },
              { value: "redact", label: uxT(locale, "guardrails.secretModeRedact") },
              { value: "block", label: uxT(locale, "guardrails.secretModeBlock") },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Switch
            on={compressionEnabled}
            disabled={readOnly || saving}
            onClick={() => setCompressionOverride(!compressionEnabled)}
            label={uxT(locale, "guardrails.compressionEnabled")}
            showLabel
          />
          <Switch
            on={stripAnsi}
            disabled={readOnly || saving || !compressionEnabled}
            onClick={() => setStripAnsiOverride(!stripAnsi)}
            label={uxT(locale, "guardrails.stripAnsi")}
            showLabel
          />
        </div>
      </div>

      {compressionEnabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="guardrails-min-chars" className="text-xs font-medium text-fg-muted">
              {uxT(locale, "guardrails.minChars")}
            </label>
            <input
              id="guardrails-min-chars"
              type="number"
              min={512}
              max={500_000}
              className="input"
              value={minChars}
              disabled={readOnly || saving}
              onChange={e => setMinCharsOverride(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="guardrails-head-chars" className="text-xs font-medium text-fg-muted">
              {uxT(locale, "guardrails.headChars")}
            </label>
            <input
              id="guardrails-head-chars"
              type="number"
              min={0}
              max={100_000}
              className="input"
              value={headChars}
              disabled={readOnly || saving}
              onChange={e => setHeadCharsOverride(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="guardrails-tail-chars" className="text-xs font-medium text-fg-muted">
              {uxT(locale, "guardrails.tailChars")}
            </label>
            <input
              id="guardrails-tail-chars"
              type="number"
              min={0}
              max={100_000}
              className="input"
              value={tailChars}
              disabled={readOnly || saving}
              onChange={e => setTailCharsOverride(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={readOnly || saving}
          onClick={() => { void handleSave(); }}
        >
          {saving ? uxT(locale, "guardrails.saving") : uxT(locale, "guardrails.save")}
        </button>
        {status && (
          <span role={status.ok ? "status" : "alert"} className={status.ok ? "text-xs text-success" : "text-xs text-danger"}>
            {status.text}
          </span>
        )}
      </div>

      <details className="rounded-card border border-solid border-line bg-surface">
        <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-semibold text-fg select-none">
          {uxT(locale, "guardrails.dryRunTitle")}
        </summary>
        <section className="flex flex-col gap-2.5 border-0 border-t border-solid border-line p-3.5" aria-labelledby="guardrails-dryrun-title">
          <div className="flex flex-col gap-0.5">
            <h4 id="guardrails-dryrun-title" className="m-0 text-[13px] font-semibold text-fg">
              {uxT(locale, "guardrails.dryRunTitle")}
            </h4>
            <p className="m-0 text-xs text-fg-muted">{uxT(locale, "guardrails.dryRunDesc")}</p>
          </div>
          <label htmlFor="guardrails-dryrun-input" className="text-xs font-medium text-fg-muted">
            {uxT(locale, "guardrails.dryRunInputLabel")}
          </label>
          <textarea
            id="guardrails-dryrun-input"
            className="input min-h-[84px] font-mono text-xs"
            rows={3}
            maxLength={MAX_DRY_RUN_INPUT_CHARS}
            placeholder={uxT(locale, "guardrails.dryRunPlaceholder")}
            value={dryRunText}
            onChange={e => setDryRunText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={dryRunBusy || !dryRunText.trim()}
              onClick={() => { void handleDryRun(); }}
            >
              {dryRunBusy ? uxT(locale, "guardrails.dryRunRunning") : uxT(locale, "guardrails.dryRunRun")}
            </button>
            {dryRunError && <span role="alert" className="text-xs text-danger">{dryRunError}</span>}
          </div>
          {dryRunResult && (
            <div className="flex flex-col gap-2 rounded-control border border-solid border-line bg-inset p-3" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <span className={dryRunResult.blocked ? "badge badge-red" : (dryRunResult.redactions > 0 || dryRunResult.compressedItems > 0) ? "badge badge-amber" : "badge badge-muted"}>
                  {dryRunResult.blocked
                    ? uxT(locale, "guardrails.dryRunBlocked")
                    : dryRunResult.redactions > 0
                      ? uxT(locale, "guardrails.dryRunRedacted")
                      : uxT(locale, "guardrails.dryRunPassed")}
                </span>
                <span className="text-xs text-fg-muted tabular-nums">
                  {uxT(locale, "guardrails.dryRunSummary", {
                    matches: dryRunResult.matches,
                    redactions: dryRunResult.redactions,
                    compressed: dryRunResult.compressedItems,
                    saved: dryRunResult.savedChars,
                    original: dryRunResult.originalChars,
                    output: dryRunResult.outputChars,
                  })}
                </span>
              </div>
              {dryRunResult.findings.length > 0 && (
                <div className="font-mono text-xs text-fg-muted">
                  {uxT(locale, "guardrails.dryRunFindings", { list: dryRunResult.findings.join(", ") })}
                </div>
              )}
              {dryRunResult.previewText.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.dryRunPreviewLabel")}</span>
                  <pre className="m-0 max-h-48 overflow-auto rounded-control border border-solid border-line bg-bg p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-fg">
                    {dryRunResult.previewText}
                  </pre>
                </div>
              )}
            </div>
          )}
        </section>
      </details>
    </div>
  );
}
