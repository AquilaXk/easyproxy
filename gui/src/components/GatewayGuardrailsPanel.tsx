import { useCallback, useEffect, useRef, useState } from "react";
import { Notice, Select, Switch } from "../ui";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { readJsonIfOk } from "../fetch-json";
import {
  SAMPLE_ANSI_LOG,
  SAMPLE_ANTHROPIC_CACHE_PAYLOAD,
  SAMPLE_PRETTY_JSON,
  SAMPLE_REPETITIVE_BUILD_LOG,
} from "../dry-run-fixtures";
import { ContextInspectorPanel } from "./ContextInspectorPanel";

export type SecretGuardMode = "off" | "redact" | "block";
export type PromptCacheTtlChoice = "auto" | "5m" | "1h";

export interface GuardrailsPayload {
  outboundSecretGuard: { mode: SecretGuardMode };
  toolOutputCompression: {
    enabled: boolean;
    minChars: number;
    headChars: number;
    tailChars: number;
    stripAnsi: boolean;
    compactJson?: boolean;
    foldRepetitiveLines?: boolean;
    deduplicateIdentical?: boolean;
    dedupMinChars?: number;
  };
  promptCacheInjection?: {
    enabled: boolean;
    ttl?: PromptCacheTtlChoice;
    stripVolatileSystemTimestamps?: boolean;
  };
  stats: {
    scannedRequests: number;
    secretDetections: number;
    secretBlocks: number;
    compressedToolOutputs: number;
    compactedJsonOutputs?: number;
    foldedLogOutputs?: number;
    deduplicatedToolOutputs?: number;
    injectedCacheBreakpoints?: number;
    normalizedSystemTimestamps?: number;
    savedChars: number;
    estimatedSavedTokens?: number;
  };
}

export interface GuardrailsDryRunResult {
  blocked: boolean;
  limitExceeded: boolean;
  matches: number;
  redactions: number;
  findings: string[];
  compressedItems: number;
  compactedJsonItems: number;
  foldedLogItems: number;
  deduplicatedItems: number;
  injectedCacheBreakpoints: number;
  normalizedTimestamps: number;
  originalChars: number;
  outputChars: number;
  savedChars: number;
  estimatedSavedTokens: number;
  previewText: string;
}

const MAX_DRY_RUN_INPUT_CHARS = 65_536;

function parseBoundedInt(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

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
  const numOrZero = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const estimatedSavedTokens = typeof r.estimatedSavedTokens === "number" && Number.isFinite(r.estimatedSavedTokens)
    ? r.estimatedSavedTokens
    : Math.floor(r.savedChars / 4);
  return {
    blocked: r.blocked,
    limitExceeded: r.limitExceeded,
    matches: r.matches,
    redactions: r.redactions,
    findings,
    compressedItems: r.compressedItems,
    compactedJsonItems: numOrZero(r.compactedJsonItems),
    foldedLogItems: numOrZero(r.foldedLogItems),
    deduplicatedItems: numOrZero(r.deduplicatedItems),
    injectedCacheBreakpoints: numOrZero(r.injectedCacheBreakpoints),
    normalizedTimestamps: numOrZero(r.normalizedTimestamps),
    originalChars: r.originalChars,
    outputChars: r.outputChars,
    savedChars: r.savedChars,
    estimatedSavedTokens,
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
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
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
  const [compactJsonOverride, setCompactJsonOverride] = useState<boolean | null>(null);
  const [foldLinesOverride, setFoldLinesOverride] = useState<boolean | null>(null);
  const [dedupOverride, setDedupOverride] = useState<boolean | null>(null);
  const [dedupMinCharsOverride, setDedupMinCharsOverride] = useState<string | null>(null);
  const [cacheInjectOverride, setCacheInjectOverride] = useState<boolean | null>(null);
  const [cacheTtlOverride, setCacheTtlOverride] = useState<PromptCacheTtlChoice | null>(null);
  const [stripTimestampsOverride, setStripTimestampsOverride] = useState<boolean | null>(null);

  const [dryRunText, setDryRunText] = useState("");
  const [dryRunDuplicatePass, setDryRunDuplicatePass] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<GuardrailsDryRunResult | null>(null);
  const dryRunAbortRef = useRef<AbortController | null>(null);
  const inspectorScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    dryRunAbortRef.current?.abort();
    if (inspectorScrollTimerRef.current !== null) {
      clearTimeout(inspectorScrollTimerRef.current);
      inspectorScrollTimerRef.current = null;
    }
  }, []);

  const mode = modeOverride ?? data?.outboundSecretGuard.mode ?? "off";
  const compressionEnabled = compressionOverride ?? data?.toolOutputCompression.enabled ?? false;
  const minChars = minCharsOverride ?? String(data?.toolOutputCompression.minChars ?? 12000);
  const headChars = headCharsOverride ?? String(data?.toolOutputCompression.headChars ?? 4000);
  const tailChars = tailCharsOverride ?? String(data?.toolOutputCompression.tailChars ?? 4000);
  const stripAnsi = stripAnsiOverride ?? data?.toolOutputCompression.stripAnsi ?? false;
  const compactJson = compactJsonOverride ?? (data?.toolOutputCompression.compactJson !== false);
  const foldRepetitiveLines = foldLinesOverride ?? (data?.toolOutputCompression.foldRepetitiveLines !== false);
  const deduplicateIdentical = dedupOverride ?? (data?.toolOutputCompression.deduplicateIdentical !== false);
  const dedupMinChars = dedupMinCharsOverride ?? String(data?.toolOutputCompression.dedupMinChars ?? 512);
  const cacheInjectEnabled = cacheInjectOverride ?? (data?.promptCacheInjection?.enabled === true);
  const cacheTtl = cacheTtlOverride ?? data?.promptCacheInjection?.ttl ?? "auto";
  const stripVolatileTimestamps = stripTimestampsOverride ?? (data?.promptCacheInjection?.stripVolatileSystemTimestamps === true);

  const hydrate = useCallback((payload: GuardrailsPayload) => {
    setData(payload);
    setModeOverride(null);
    setCompressionOverride(null);
    setMinCharsOverride(null);
    setHeadCharsOverride(null);
    setTailCharsOverride(null);
    setStripAnsiOverride(null);
    setCompactJsonOverride(null);
    setFoldLinesOverride(null);
    setDedupOverride(null);
    setDedupMinCharsOverride(null);
    setCacheInjectOverride(null);
    setCacheTtlOverride(null);
    setStripTimestampsOverride(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void fetch(`${apiBase}/api/gateway-guardrails`, { signal: ac.signal })
      .then(res => readJsonIfOk<GuardrailsPayload>(res))
      .then(body => {
        if (cancelled) return;
        if (!body || !body.outboundSecretGuard || !body.toolOutputCompression) {
          setLoadError(uxT(localeRef.current, "guardrails.loadFailed"));
          return;
        }
        setLoadError(null);
        hydrate(body);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === "AbortError")) return;
        setLoadError(uxT(localeRef.current, "guardrails.loadFailed"));
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase, hydrate]);

  const supportsExtendedCompression = data !== null
    && ("compactJson" in data.toolOutputCompression || "deduplicateIdentical" in data.toolOutputCompression || "promptCacheInjection" in data);
  const supportsPromptCacheInjection = data !== null && "promptCacheInjection" in data;

  const handleSave = async () => {
    if (readOnly || saving) return;
    const parsedMin = parseBoundedInt(minChars, 512, 500_000);
    const parsedHead = parseBoundedInt(headChars, 0, 100_000);
    const parsedTail = parseBoundedInt(tailChars, 0, 100_000);
    const parsedDedupMin = parseBoundedInt(dedupMinChars, 128, 500_000);
    if (compressionEnabled && (parsedMin === null || parsedHead === null || parsedTail === null || (deduplicateIdentical && parsedDedupMin === null))) {
      setStatus({ ok: false, text: uxT(locale, "guardrails.saveFailed") });
      return;
    }
    const min = parsedMin ?? (data?.toolOutputCompression.minChars ?? 12_000);
    const head = parsedHead ?? (data?.toolOutputCompression.headChars ?? 4_000);
    const tail = parsedTail ?? (data?.toolOutputCompression.tailChars ?? 4_000);
    const dedupMin = parsedDedupMin ?? (data?.toolOutputCompression.dedupMinChars ?? 512);
    const supportsFold = data !== null && "foldRepetitiveLines" in data.toolOutputCompression;
    setSaving(true);
    setStatus(null);
    try {
      const payloadBody: Record<string, unknown> = {
        outboundSecretGuard: { mode },
        toolOutputCompression: {
          enabled: compressionEnabled,
          minChars: min,
          headChars: head,
          tailChars: tail,
          stripAnsi,
          ...(supportsExtendedCompression || !compactJson ? { compactJson } : {}),
          ...(supportsFold || !foldRepetitiveLines ? { foldRepetitiveLines } : {}),
          ...(supportsExtendedCompression || !deduplicateIdentical ? { deduplicateIdentical } : {}),
          ...(supportsExtendedCompression || dedupMin !== 512 ? { dedupMinChars: dedupMin } : {}),
        },
      };
      if (supportsPromptCacheInjection || cacheInjectEnabled || stripVolatileTimestamps) {
        payloadBody.promptCacheInjection = {
          enabled: cacheInjectEnabled,
          ttl: cacheTtl,
          stripVolatileSystemTimestamps: stripVolatileTimestamps,
        };
      }
      const res = await fetch(`${apiBase}/api/gateway-guardrails`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadBody),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: string } | null;
        setStatus({ ok: false, text: errBody?.error ?? uxT(locale, "guardrails.saveFailed") });
        return;
      }
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
    const min = parseBoundedInt(minChars, 512, 500_000);
    const head = parseBoundedInt(headChars, 0, 100_000);
    const tail = parseBoundedInt(tailChars, 0, 100_000);
    const dedupMin = parseBoundedInt(dedupMinChars, 128, 500_000);
    const supportsFold = data !== null && "foldRepetitiveLines" in data.toolOutputCompression;
    try {
      const reqPayload: Record<string, unknown> = {
        text: dryRunText.slice(0, MAX_DRY_RUN_INPUT_CHARS),
        ...(dryRunDuplicatePass ? { duplicatePass: true } : {}),
        outboundSecretGuard: { mode },
        toolOutputCompression: {
          enabled: compressionEnabled,
          ...(min !== null ? { minChars: min } : {}),
          ...(head !== null ? { headChars: head } : {}),
          ...(tail !== null ? { tailChars: tail } : {}),
          stripAnsi,
          ...(supportsExtendedCompression || !compactJson ? { compactJson } : {}),
          ...(supportsFold || !foldRepetitiveLines ? { foldRepetitiveLines } : {}),
          ...(supportsExtendedCompression || !deduplicateIdentical ? { deduplicateIdentical } : {}),
          ...(dedupMin !== null && (supportsExtendedCompression || dedupMin !== 512) ? { dedupMinChars: dedupMin } : {}),
        },
      };
      if (supportsPromptCacheInjection || cacheInjectEnabled || stripVolatileTimestamps) {
        reqPayload.promptCacheInjection = {
          enabled: cacheInjectEnabled,
          ttl: cacheTtl,
          stripVolatileSystemTimestamps: stripVolatileTimestamps,
        };
      }
      const res = await fetch(`${apiBase}/api/gateway-guardrails/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqPayload),
        signal: ac.signal,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: unknown } | null;
        const msg = typeof errBody?.error === "string" && errBody.error.trim()
          ? errBody.error
          : uxT(locale, "guardrails.dryRunFailed");
        setDryRunError(msg);
        return;
      }
      const raw = await res.json().catch(() => null);
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
    compactedJsonOutputs: 0,
    foldedLogOutputs: 0,
    deduplicatedToolOutputs: 0,
    injectedCacheBreakpoints: 0,
    normalizedSystemTimestamps: 0,
    savedChars: 0,
    estimatedSavedTokens: 0,
  };
  const optimizedHits = (stats.compactedJsonOutputs ?? 0) + (stats.foldedLogOutputs ?? 0) + (stats.deduplicatedToolOutputs ?? 0);
  const cacheBpHits = stats.injectedCacheBreakpoints ?? 0;
  const savedTokens = stats.estimatedSavedTokens ?? Math.floor(stats.savedChars / 4);

  return (
    <div className="flex flex-col gap-4 p-4 text-fg">
      {readOnly && <p className="m-0 text-xs text-fg-muted">{uxT(locale, "guardrails.readOnlyHint")}</p>}

      {/* Hairline-divided 6-metric telemetry strip */}
      <div className="grid grid-cols-2 overflow-hidden rounded-[10px] bg-surface ring-1 ring-line sm:grid-cols-3 lg:grid-cols-6 *:-mt-px *:-ml-px *:border-0 *:border-t *:border-l *:border-solid *:border-line">
        <div className="px-3 py-2.5">
          <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.statScanned")}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">{stats.scannedRequests.toLocaleString(locale)}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.statDetections")}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">{stats.secretDetections.toLocaleString(locale)}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.statBlocks")}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">{stats.secretBlocks.toLocaleString(locale)}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.statCompressed")}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">{stats.compressedToolOutputs.toLocaleString(locale)}</div>
        </div>
        <div className="px-3 py-2.5">
          <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.statOptimized")}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5 text-[15px] font-semibold text-fg tabular-nums">
            <span>{optimizedHits.toLocaleString(locale)}</span>
            {cacheBpHits > 0 && (
              <span className="text-[11px] font-normal text-success">
                +{cacheBpHits}
              </span>
            )}
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="truncate text-[11px] font-medium text-fg-subtle">{uxT(locale, "guardrails.statSavedTokens")}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-success tabular-nums" title={`${uxT(locale, "guardrails.statSavedChars")}: ${stats.savedChars.toLocaleString(locale)}`}>
            ~{savedTokens.toLocaleString(locale)}
          </div>
        </div>
      </div>

      {/* Ruled v2 policy controls */}
      <div className="divide-y divide-line overflow-hidden rounded-[10px] bg-surface ring-1 ring-line">
        <div className="grid gap-4 px-4 py-3.5 md:grid-cols-[minmax(0,16rem)_1fr] md:items-center">
          <div className="flex flex-col gap-1">
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
          <div className="flex flex-wrap items-center gap-5 pt-1 md:justify-end">
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
          <div className="flex flex-col gap-3 bg-inset/40 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Switch
                on={compactJson}
                disabled={readOnly || saving}
                onClick={() => setCompactJsonOverride(!compactJson)}
                label={uxT(locale, "guardrails.compactJson")}
                showLabel
              />
              <Switch
                on={deduplicateIdentical}
                disabled={readOnly || saving}
                onClick={() => setDedupOverride(!deduplicateIdentical)}
                label={uxT(locale, "guardrails.deduplicateIdentical")}
                showLabel
              />
              <Switch
                on={foldRepetitiveLines}
                disabled={readOnly || saving}
                onClick={() => setFoldLinesOverride(!foldRepetitiveLines)}
                label={uxT(locale, "guardrails.foldRepetitiveLines")}
                showLabel
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              <div className="flex flex-col gap-1">
                <label htmlFor="guardrails-dedup-min-chars" className="text-xs font-medium text-fg-muted">
                  {uxT(locale, "guardrails.dedupMinChars")}
                </label>
                <input
                  id="guardrails-dedup-min-chars"
                  type="number"
                  min={128}
                  max={500_000}
                  className="input"
                  value={dedupMinChars}
                  disabled={readOnly || saving || !deduplicateIdentical}
                  onChange={e => setDedupMinCharsOverride(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Prompt-cache prefix optimization row */}
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Switch
              on={cacheInjectEnabled}
              disabled={readOnly || saving}
              onClick={() => setCacheInjectOverride(!cacheInjectEnabled)}
              label={uxT(locale, "guardrails.promptCacheInjection")}
              showLabel
            />
            <Switch
              on={stripVolatileTimestamps}
              disabled={readOnly || saving}
              onClick={() => setStripTimestampsOverride(!stripVolatileTimestamps)}
              label={uxT(locale, "guardrails.stripVolatileTimestamps")}
              showLabel
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="guardrails-cache-ttl" className="text-xs font-medium text-fg-muted whitespace-nowrap">
              {uxT(locale, "guardrails.promptCacheTtl")}
            </label>
            <div className="min-w-44">
              <Select
                id="guardrails-cache-ttl"
                value={cacheTtl}
                disabled={readOnly || saving || !cacheInjectEnabled}
                onChange={v => setCacheTtlOverride(v as PromptCacheTtlChoice)}
                options={[
                  { value: "auto", label: uxT(locale, "guardrails.promptCacheTtlAuto") },
                  { value: "1h", label: "1h" },
                  { value: "5m", label: "5m" },
                ]}
              />
            </div>
          </div>
        </div>
      </div>

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

      {/* Dry-run simulator */}
      <details className="rounded-[10px] bg-surface ring-1 ring-line">
        <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-semibold text-fg select-none">
          {uxT(locale, "guardrails.dryRunTitle")}
        </summary>
        <section className="flex flex-col gap-2.5 border-0 border-t border-solid border-line p-3.5" aria-labelledby="guardrails-dryrun-title">
          <h4 id="guardrails-dryrun-title" className="sr-only">
            {uxT(locale, "guardrails.dryRunTitle")}
          </h4>
          <p className="m-0 text-xs text-fg-muted">{uxT(locale, "guardrails.dryRunDesc")}</p>
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
            {/* Keep the primary dry-run trigger first in DOM order inside this section. */}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={dryRunBusy || !dryRunText.trim()}
              onClick={() => { void handleDryRun(); }}
            >
              {dryRunBusy ? uxT(locale, "guardrails.dryRunRunning") : uxT(locale, "guardrails.dryRunRun")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={dryRunBusy}
              onClick={() => setDryRunText(SAMPLE_PRETTY_JSON)}
            >
              {uxT(locale, "guardrails.dryRunSampleJson")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={dryRunBusy}
              onClick={() => setDryRunText(SAMPLE_ANSI_LOG)}
            >
              {uxT(locale, "guardrails.dryRunSampleAnsi")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={dryRunBusy}
              onClick={() => setDryRunText(SAMPLE_REPETITIVE_BUILD_LOG)}
            >
              {uxT(locale, "guardrails.dryRunSampleBuildLog")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={dryRunBusy}
              onClick={() => setDryRunText(SAMPLE_ANTHROPIC_CACHE_PAYLOAD)}
            >
              {uxT(locale, "guardrails.dryRunSampleAnthropic")}
            </button>
            <label className="checkbox ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted select-none">
              <input
                type="checkbox"
                checked={dryRunDuplicatePass}
                onChange={e => setDryRunDuplicatePass(e.target.checked)}
              />
              <span>{uxT(locale, "guardrails.dryRunDuplicatePass")}</span>
            </label>
            {dryRunError && <span role="alert" className="text-xs text-danger">{dryRunError}</span>}
          </div>
          {dryRunResult && (
            <div className="flex flex-col gap-2 rounded-control border border-solid border-line bg-inset p-3" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <span className={dryRunResult.blocked ? "badge badge-red" : (dryRunResult.redactions > 0 || dryRunResult.compressedItems > 0 || dryRunResult.injectedCacheBreakpoints > 0) ? "badge badge-amber" : "badge badge-muted"}>
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
                {dryRunResult.savedChars > 0 && dryRunResult.originalChars > 0 && (
                  <span className="badge badge-green tabular-nums">
                    {uxT(locale, "guardrails.dryRunSavedTokens", {
                      chars: dryRunResult.savedChars.toLocaleString(locale),
                      tokens: dryRunResult.estimatedSavedTokens.toLocaleString(locale),
                      pct: Math.round((dryRunResult.savedChars / dryRunResult.originalChars) * 100),
                    })}
                  </span>
                )}
                {dryRunResult.injectedCacheBreakpoints > 0 && (
                  <span className="badge badge-green tabular-nums">
                    +{dryRunResult.injectedCacheBreakpoints} cache_control
                  </span>
                )}
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

      {/* Context & Prompt-Cache Prefix Inspector */}
      <details
        id="gateway-context-inspector"
        className="scroll-mt-4 rounded-[10px] bg-surface ring-1 ring-line"
        onToggle={e => {
          const el = e.currentTarget;
          if (inspectorScrollTimerRef.current !== null) {
            clearTimeout(inspectorScrollTimerRef.current);
            inspectorScrollTimerRef.current = null;
          }
          if (!el.open || typeof el.scrollIntoView !== "function") return;
          const scrollIfClipped = () => {
            if (!el.isConnected || !el.open) return;
            const rect = el.getBoundingClientRect();
            const viewH = typeof window !== "undefined" ? window.innerHeight : 0;
            if (rect.top < 0 || (viewH > 0 && rect.bottom > viewH && rect.top > 24)) {
              el.scrollIntoView({ block: "start" });
            }
          };
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(scrollIfClipped);
          } else {
            scrollIfClipped();
          }
          inspectorScrollTimerRef.current = setTimeout(() => {
            inspectorScrollTimerRef.current = null;
            scrollIfClipped();
          }, 220);
        }}
      >
        <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-semibold text-fg select-none">
          {uxT(locale, "inspector.title")}
        </summary>
        <section className="border-0 border-t border-solid border-line p-3.5" aria-label={uxT(locale, "inspector.title")}>
          <ContextInspectorPanel />
        </section>
      </details>
    </div>
  );
}
