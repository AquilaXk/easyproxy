import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Notice, Select, Switch } from "../ui";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { cachedNumberFormat } from "../intl-formatters";
import { SCENARIO_PROBE_SAMPLES as PROBE_SAMPLES } from "../dry-run-fixtures";
import { Combobox } from "@/components/ui-v2/combobox";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";

export type ScenarioKind = "background" | "longContext" | "webSearch" | "think";
export type ScenarioEffortChoice = "" | "low" | "medium" | "high" | "xhigh";

interface ScenarioRoutingDto {
  enabled: boolean;
  precedence?: ScenarioKind[];
  longContextThresholdTokens?: number;
  thinkBudgetThreshold?: number;
  routes: Partial<Record<ScenarioKind, string>>;
  efforts?: Partial<Record<ScenarioKind, Exclude<ScenarioEffortChoice, "">>>;
  matchModels?: string[];
  overrideExplicitRoutes?: boolean;
}

interface ClassifyResponseDto {
  active: boolean;
  matched: ScenarioKind | null;
  targetSelector: string | null;
  resolvedTarget: { provider: string; model: string; routeKind: string } | null;
  resolvedEffort: Exclude<ScenarioEffortChoice, ""> | null;
  resolveError?: string;
  classification: {
    matched: ScenarioKind | null;
    matchedScenarios: ScenarioKind[];
    estimatedTokens: number;
    signals: Record<ScenarioKind, boolean>;
    truncated: boolean;
  };
}

export interface ScenarioRoutingPanelProps {
  apiBase: string;
  /** False while mounted inside a hidden tab; prevents background fetches and state writes. */
  active?: boolean;
  /** Optional provider/model suggestions from loaded catalog. */
  routeSuggestions?: readonly string[];
}

const DEFAULT_LONG_CONTEXT_TOKENS = 60_000;
const MIN_LONG_CONTEXT_TOKENS = 1_000;
const MAX_LONG_CONTEXT_TOKENS = 10_000_000;
const MAX_ROUTE_LENGTH = 256;
const MAX_PROBE_CHARS = 32_768;

const SCENARIO_ORDER: readonly ScenarioKind[] = [
  "background",
  "longContext",
  "webSearch",
  "think",
];
const EMPTY_ROUTE_SUGGESTIONS: readonly string[] = [];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScenarioKind(value: unknown): value is ScenarioKind {
  return value === "background" || value === "longContext" || value === "webSearch" || value === "think";
}

function isScenarioEffort(value: unknown): value is Exclude<ScenarioEffortChoice, ""> {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function expandPrecedenceOrder(partial?: readonly ScenarioKind[]): ScenarioKind[] {
  const seen = new Set<ScenarioKind>();
  const out: ScenarioKind[] = [];
  if (partial) {
    for (const kind of partial) {
      if (isScenarioKind(kind) && !seen.has(kind)) {
        seen.add(kind);
        out.push(kind);
      }
    }
  }
  for (const kind of SCENARIO_ORDER) {
    if (!seen.has(kind)) {
      seen.add(kind);
      out.push(kind);
    }
  }
  return out;
}

function parseScenarioRoutingDto(raw: unknown): ScenarioRoutingDto | null {
  if (!isPlainRecord(raw)) return null;
  const inner = Object.hasOwn(raw, "scenarioRouting") ? raw.scenarioRouting : raw;
  if (inner === null || inner === undefined) return null;
  if (!isPlainRecord(inner) || typeof inner.enabled !== "boolean" || !isPlainRecord(inner.routes)) {
    return null;
  }
  const routes: Partial<Record<ScenarioKind, string>> = {};
  for (const kind of SCENARIO_ORDER) {
    const target = inner.routes[kind];
    if (typeof target === "string" && target.trim()) {
      routes[kind] = target.trim();
    }
  }
  const efforts: Partial<Record<ScenarioKind, Exclude<ScenarioEffortChoice, "">>> = {};
  if (isPlainRecord(inner.efforts)) {
    for (const kind of SCENARIO_ORDER) {
      const eff = inner.efforts[kind];
      if (isScenarioEffort(eff)) efforts[kind] = eff;
    }
  }
  const precedence = Array.isArray(inner.precedence)
    ? inner.precedence.filter(isScenarioKind)
    : undefined;
  const matchModels = Array.isArray(inner.matchModels)
    ? inner.matchModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : undefined;
  return {
    enabled: inner.enabled,
    routes,
    ...(Object.keys(efforts).length > 0 ? { efforts } : {}),
    ...(precedence && precedence.length > 0 ? { precedence } : {}),
    ...(typeof inner.longContextThresholdTokens === "number" && Number.isFinite(inner.longContextThresholdTokens)
      ? { longContextThresholdTokens: inner.longContextThresholdTokens }
      : {}),
    ...(typeof inner.thinkBudgetThreshold === "number" && Number.isFinite(inner.thinkBudgetThreshold)
      ? { thinkBudgetThreshold: inner.thinkBudgetThreshold }
      : {}),
    ...(matchModels && matchModels.length > 0 ? { matchModels } : {}),
    ...(typeof inner.overrideExplicitRoutes === "boolean"
      ? { overrideExplicitRoutes: inner.overrideExplicitRoutes }
      : {}),
  };
}

function parseClassifyResponse(raw: unknown): ClassifyResponseDto | null {
  if (!isPlainRecord(raw) || !isPlainRecord(raw.classification)) return null;
  const cls = raw.classification;
  if (typeof cls.estimatedTokens !== "number" || !Number.isFinite(cls.estimatedTokens)) return null;
  const matched = isScenarioKind(raw.matched) ? raw.matched : null;
  const clsMatched = isScenarioKind(cls.matched) ? cls.matched : null;
  const matchedScenarios = Array.isArray(cls.matchedScenarios)
    ? cls.matchedScenarios.filter(isScenarioKind)
    : [];
  const rawSignals = isPlainRecord(cls.signals) ? cls.signals : {};
  const signals: Record<ScenarioKind, boolean> = {
    background: rawSignals.background === true,
    longContext: rawSignals.longContext === true,
    webSearch: rawSignals.webSearch === true,
    think: rawSignals.think === true,
  };
  let resolvedTarget: ClassifyResponseDto["resolvedTarget"] = null;
  if (
    isPlainRecord(raw.resolvedTarget)
    && typeof raw.resolvedTarget.provider === "string"
    && typeof raw.resolvedTarget.model === "string"
    && typeof raw.resolvedTarget.routeKind === "string"
  ) {
    resolvedTarget = {
      provider: raw.resolvedTarget.provider,
      model: raw.resolvedTarget.model,
      routeKind: raw.resolvedTarget.routeKind,
    };
  }
  return {
    active: raw.active === true,
    matched,
    targetSelector: typeof raw.targetSelector === "string" ? raw.targetSelector : null,
    resolvedTarget,
    resolvedEffort: isScenarioEffort(raw.resolvedEffort) ? raw.resolvedEffort : null,
    ...(typeof raw.resolveError === "string" ? { resolveError: raw.resolveError } : {}),
    classification: {
      matched: clsMatched,
      matchedScenarios,
      estimatedTokens: cls.estimatedTokens,
      signals,
      truncated: cls.truncated === true,
    },
  };
}

export function ScenarioRoutingPanel({
  apiBase,
  active = true,
  routeSuggestions = EMPTY_ROUTE_SUGGESTIONS,
}: ScenarioRoutingPanelProps) {
  const { locale, t } = useI18n();
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  const idPrefix = useId();
  const numberFmt = cachedNumberFormat(locale);

  const [enabled, setEnabled] = useState(false);
  const [overrideExplicit, setOverrideExplicit] = useState(false);
  const [longContextTokens, setLongContextTokens] = useState(String(DEFAULT_LONG_CONTEXT_TOKENS));
  const [routes, setRoutes] = useState<Record<ScenarioKind, string>>({
    background: "",
    longContext: "",
    webSearch: "",
    think: "",
  });
  const [efforts, setEfforts] = useState<Record<ScenarioKind, ScenarioEffortChoice>>({
    background: "",
    longContext: "",
    webSearch: "",
    think: "",
  });
  const [rawPrecedence, setRawPrecedence] = useState<ScenarioKind[] | undefined>(undefined);
  const [preservedExtras, setPreservedExtras] = useState<{
    thinkBudgetThreshold?: number;
    matchModels?: string[];
  }>({});

  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const [probeInput, setProbeInput] = useState(PROBE_SAMPLES.background);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [probeResult, setProbeResult] = useState<ClassifyResponseDto | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const loadEnabledRef = useRef(true);
  const loadAbortRef = useRef<AbortController | null>(null);
  const probeAbortRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const probeGenerationRef = useRef(0);

  const cancelActiveWork = useCallback(() => {
    loadEnabledRef.current = false;
    loadAbortRef.current?.abort();
    probeAbortRef.current?.abort();
    loadGenerationRef.current += 1;
  }, []);

  const applyDtoToState = useCallback((dto: ScenarioRoutingDto | null) => {
    if (!dto) {
      setEnabled(false);
      setOverrideExplicit(false);
      setLongContextTokens(String(DEFAULT_LONG_CONTEXT_TOKENS));
      setRoutes({ background: "", longContext: "", webSearch: "", think: "" });
      setEfforts({ background: "", longContext: "", webSearch: "", think: "" });
      setRawPrecedence(undefined);
      setPreservedExtras({});
      return;
    }
    setEnabled(dto.enabled);
    setOverrideExplicit(dto.overrideExplicitRoutes === true);
    setLongContextTokens(String(dto.longContextThresholdTokens ?? DEFAULT_LONG_CONTEXT_TOKENS));
    setRoutes({
      background: dto.routes.background ?? "",
      longContext: dto.routes.longContext ?? "",
      webSearch: dto.routes.webSearch ?? "",
      think: dto.routes.think ?? "",
    });
    setEfforts({
      background: dto.efforts?.background ?? "",
      longContext: dto.efforts?.longContext ?? "",
      webSearch: dto.efforts?.webSearch ?? "",
      think: dto.efforts?.think ?? "",
    });
    setRawPrecedence(dto.precedence);
    setPreservedExtras({
      ...(dto.thinkBudgetThreshold !== undefined ? { thinkBudgetThreshold: dto.thinkBudgetThreshold } : {}),
      ...(dto.matchModels ? { matchModels: dto.matchModels } : {}),
    });
  }, []);

  const load = useCallback(async () => {
    if (!loadEnabledRef.current) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const { signal } = controller;
    const generation = ++loadGenerationRef.current;
    setLoadError("");
    try {
      const res = await fetch(`${apiBase}/api/routing/scenario`, { signal });
      if (generation !== loadGenerationRef.current) return;
      if (res.status === 404) {
        applyDtoToState(null);
        return;
      }
      if (!res.ok) {
        setLoadError(`${uxT(localeRef.current, "scenarioRouting.loadFailed")} (${res.status})`);
        return;
      }
      const raw = await res.json().catch(() => null);
      if (generation !== loadGenerationRef.current) return;
      applyDtoToState(parseScenarioRoutingDto(raw));
    } catch {
      if (generation !== loadGenerationRef.current || signal.aborted) return;
      setLoadError(uxT(localeRef.current, "scenarioRouting.loadFailed"));
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
      }
    }
  }, [apiBase, applyDtoToState]);

  useEffect(() => {
    if (!active) {
      cancelActiveWork();
      return;
    }
    loadEnabledRef.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      cancelActiveWork();
    };
  }, [active, cancelActiveWork, load]);

  useEffect(() => {
    if (!feedback?.ok) return;
    const timer = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const moveScenarioPrecedence = (kind: ScenarioKind, delta: -1 | 1) => {
    const full = expandPrecedenceOrder(rawPrecedence);
    const idx = full.indexOf(kind);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= full.length) return;
    const swapped = [...full];
    const tmp = swapped[idx]!;
    swapped[idx] = swapped[nextIdx]!;
    swapped[nextIdx] = tmp;
    const isDefault = swapped.length === SCENARIO_ORDER.length && swapped.every((k, i) => k === SCENARIO_ORDER[i]);
    setRawPrecedence(isDefault ? undefined : swapped);
  };

  const parseDraftFields = (): {
    ok: true;
    cleanRoutes: Partial<Record<ScenarioKind, string>>;
    cleanEfforts: Partial<Record<ScenarioKind, Exclude<ScenarioEffortChoice, "">>>;
    threshold?: number;
  } | { ok: false; error: string } => {
    const cleanRoutes: Partial<Record<ScenarioKind, string>> = {};
    const cleanEfforts: Partial<Record<ScenarioKind, Exclude<ScenarioEffortChoice, "">>> = {};
    for (const kind of SCENARIO_ORDER) {
      const trimmed = routes[kind].trim();
      if (trimmed) {
        if (trimmed.length > MAX_ROUTE_LENGTH) {
          return { ok: false, error: uxT(locale, "scenarioRouting.saveFailed") };
        }
        cleanRoutes[kind] = trimmed;
      }
      const eff = efforts[kind];
      if (eff) cleanEfforts[kind] = eff;
    }

    let threshold: number | undefined;
    const trimmedThreshold = longContextTokens.trim();
    if (trimmedThreshold) {
      const parsed = Number(trimmedThreshold);
      if (
        !Number.isSafeInteger(parsed)
        || parsed < MIN_LONG_CONTEXT_TOKENS
        || parsed > MAX_LONG_CONTEXT_TOKENS
      ) {
        return { ok: false, error: uxT(locale, "scenarioRouting.saveFailed") };
      }
      threshold = parsed;
    }

    return {
      ok: true,
      cleanRoutes,
      cleanEfforts,
      ...(threshold !== undefined ? { threshold } : {}),
    };
  };

  const buildCandidatePayload = (): { ok: true; dto: ScenarioRoutingDto } | { ok: false; error: string } => {
    const draft = parseDraftFields();
    if (!draft.ok) return draft;
    const hasRules = Object.keys(draft.cleanRoutes).length > 0 || Object.keys(draft.cleanEfforts).length > 0;
    if (enabled && !hasRules) {
      return { ok: false, error: uxT(locale, "scenarioRouting.saveFailed") };
    }
    return {
      ok: true,
      dto: {
        enabled,
        routes: draft.cleanRoutes,
        ...(Object.keys(draft.cleanEfforts).length > 0 ? { efforts: draft.cleanEfforts } : {}),
        ...(draft.threshold !== undefined ? { longContextThresholdTokens: draft.threshold } : {}),
        ...(overrideExplicit ? { overrideExplicitRoutes: true } : {}),
        ...(rawPrecedence && rawPrecedence.length > 0 ? { precedence: rawPrecedence } : {}),
        ...(preservedExtras.thinkBudgetThreshold !== undefined
          ? { thinkBudgetThreshold: preservedExtras.thinkBudgetThreshold }
          : {}),
        ...(preservedExtras.matchModels ? { matchModels: preservedExtras.matchModels } : {}),
      },
    };
  };

  const buildProbeCandidateDto = (): ScenarioRoutingDto | undefined => {
    const draft = parseDraftFields();
    if (!draft.ok) return undefined;
    const hasRules = Object.keys(draft.cleanRoutes).length > 0 || Object.keys(draft.cleanEfforts).length > 0;
    return {
      enabled: enabled && hasRules,
      routes: draft.cleanRoutes,
      ...(Object.keys(draft.cleanEfforts).length > 0 ? { efforts: draft.cleanEfforts } : {}),
      ...(draft.threshold !== undefined ? { longContextThresholdTokens: draft.threshold } : {}),
      ...(overrideExplicit ? { overrideExplicitRoutes: true } : {}),
      ...(rawPrecedence && rawPrecedence.length > 0 ? { precedence: rawPrecedence } : {}),
      ...(preservedExtras.thinkBudgetThreshold !== undefined
        ? { thinkBudgetThreshold: preservedExtras.thinkBudgetThreshold }
        : {}),
      ...(preservedExtras.matchModels ? { matchModels: preservedExtras.matchModels } : {}),
    };
  };

  const handleSave = async () => {
    const built = buildCandidatePayload();
    if (!built.ok) {
      setFeedback({ ok: false, text: built.error });
      return;
    }
    const generation = ++saveGenerationRef.current;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/routing/scenario`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioRouting: built.dto }),
      });
      if (!loadEnabledRef.current || generation !== saveGenerationRef.current) return;
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: unknown } | null;
        const detail = errBody && typeof errBody.error === "string" ? `: ${errBody.error}` : "";
        setFeedback({ ok: false, text: `${uxT(locale, "scenarioRouting.saveFailed")}${detail}` });
        return;
      }
      const raw = await res.json().catch(() => null);
      if (!loadEnabledRef.current || generation !== saveGenerationRef.current) return;
      const savedDto = parseScenarioRoutingDto(raw) ?? built.dto;
      applyDtoToState(savedDto);
      setFeedback({ ok: true, text: uxT(locale, "scenarioRouting.saved") });
    } catch {
      if (!loadEnabledRef.current || generation !== saveGenerationRef.current) return;
      setFeedback({ ok: false, text: uxT(locale, "scenarioRouting.saveFailed") });
    } finally {
      if (mountedRef.current && generation === saveGenerationRef.current) setSaving(false);
    }
  };

  const handleReset = async () => {
    const generation = ++saveGenerationRef.current;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/routing/scenario`, { method: "DELETE" });
      if (!loadEnabledRef.current || generation !== saveGenerationRef.current) return;
      if (!res.ok) {
        setFeedback({ ok: false, text: uxT(locale, "scenarioRouting.saveFailed") });
        return;
      }
      applyDtoToState(null);
      setProbeResult(null);
      setFeedback({ ok: true, text: uxT(locale, "scenarioRouting.cleared") });
    } catch {
      if (!loadEnabledRef.current || generation !== saveGenerationRef.current) return;
      setFeedback({ ok: false, text: uxT(locale, "scenarioRouting.saveFailed") });
    } finally {
      if (mountedRef.current && generation === saveGenerationRef.current) setSaving(false);
    }
  };

  const handleRunProbe = async () => {
    const trimmed = probeInput.trim();
    if (!trimmed || trimmed.length > MAX_PROBE_CHARS) {
      setProbeError(uxT(locale, "scenarioRouting.loadFailed"));
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(trimmed);
    } catch {
      parsedBody = { messages: [{ role: "user", content: trimmed }] };
    }

    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    const generation = ++probeGenerationRef.current;
    setProbing(true);
    setProbeError("");
    try {
      const probeCandidate = buildProbeCandidateDto();
      const res = await fetch(`${apiBase}/api/routing/scenario/classify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: parsedBody,
          ...(probeCandidate ? { scenarioRouting: probeCandidate } : {}),
        }),
        signal: controller.signal,
      });
      if (!loadEnabledRef.current || generation !== probeGenerationRef.current) return;
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: unknown } | null;
        const msg = errBody && typeof errBody.error === "string" && errBody.error.trim()
          ? errBody.error
          : `${uxT(locale, "scenarioRouting.loadFailed")} (${res.status})`;
        setProbeError(msg);
        return;
      }
      const raw = await res.json().catch(() => null);
      if (!loadEnabledRef.current || generation !== probeGenerationRef.current) return;
      const parsed = parseClassifyResponse(raw);
      if (!parsed) {
        setProbeError(uxT(locale, "scenarioRouting.loadFailed"));
        return;
      }
      setProbeResult(parsed);
    } catch {
      if (!loadEnabledRef.current || generation !== probeGenerationRef.current || controller.signal.aborted) return;
      setProbeError(uxT(locale, "scenarioRouting.loadFailed"));
    } finally {
      if (probeAbortRef.current === controller) {
        probeAbortRef.current = null;
      }
      if (mountedRef.current && generation === probeGenerationRef.current) {
        setProbing(false);
      }
    }
  };

  const scenarioLabel = (kind: ScenarioKind): string => {
    switch (kind) {
      case "background":
        return uxT(locale, "scenarioRouting.routeBackground");
      case "longContext":
        return uxT(locale, "scenarioRouting.routeLongContext");
      case "webSearch":
        return uxT(locale, "scenarioRouting.routeWebSearch");
      case "think":
        return uxT(locale, "scenarioRouting.routeThink");
    }
  };

  const displayedPrecedence = expandPrecedenceOrder(rawPrecedence);
  const matchedKind = probeResult?.matched ?? probeResult?.classification.matched ?? null;
  const matchedTarget = probeResult?.resolvedTarget
    ? `${probeResult.resolvedTarget.provider}/${probeResult.resolvedTarget.model}`
    : (probeResult?.targetSelector ?? (matchedKind ? routes[matchedKind].trim() : "") ?? "");
  const matchedEffort = probeResult?.resolvedEffort ?? (matchedKind ? efforts[matchedKind] || null : null);

  return (
    <section
      className="mt-3.5 flex flex-col gap-4 rounded-[12px] bg-surface p-5 text-fg ring-1 ring-line"
      aria-labelledby="scenario-routing-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <h3 id="scenario-routing-title" className="m-0 text-[15px] leading-6 font-semibold text-fg">
            {uxT(locale, "scenarioRouting.title")}
          </h3>
          <p className="m-0 text-[13px] leading-5 text-fg-muted">
            {uxT(locale, "scenarioRouting.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch
            on={enabled}
            disabled={saving}
            onClick={() => setEnabled(prev => !prev)}
            label={uxT(locale, "scenarioRouting.enabled")}
            showLabel
          />
        </div>
      </div>

      {loadError ? <Notice tone="err">{loadError}</Notice> : null}
      {feedback ? <Notice tone={feedback.ok ? "ok" : "err"}>{feedback.text}</Notice> : null}

      {/* Visual priority order strip */}
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-inset/60 px-3 py-2 ring-1 ring-inset ring-line">
        <span className="text-xs font-medium text-fg-subtle">{uxT(locale, "scenarioRouting.precedenceLabel")}:</span>
        {displayedPrecedence.map((kind, idx) => (
          <span
            key={kind}
            className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-0.5 text-xs text-fg ring-1 ring-inset ring-line"
          >
            <span className="font-mono text-[11px] text-fg-subtle tabular-nums">{idx + 1}.</span>
            <span className="max-w-44 truncate">{scenarioLabel(kind)}</span>
            {idx > 0 && (
              <button
                type="button"
                aria-label={uxT(locale, "scenarioRouting.moveEarlier", { scenario: scenarioLabel(kind) })}
                onClick={() => moveScenarioPrecedence(kind, -1)}
                className="ml-0.5 inline-flex size-4 cursor-pointer appearance-none items-center justify-center rounded border-0 bg-transparent p-0 text-[11px] text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                ←
              </button>
            )}
            {idx < displayedPrecedence.length - 1 && (
              <button
                type="button"
                aria-label={uxT(locale, "scenarioRouting.moveLater", { scenario: scenarioLabel(kind) })}
                onClick={() => moveScenarioPrecedence(kind, 1)}
                className="inline-flex size-4 cursor-pointer appearance-none items-center justify-center rounded border-0 bg-transparent p-0 text-[11px] text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                →
              </button>
            )}
          </span>
        ))}
      </div>

      {/* 4 Scenario cards in fixed SCENARIO_ORDER with v2 Combobox + Effort Select */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {SCENARIO_ORDER.map((kind, idx) => {
          const labelId = `${idPrefix}-1-${idx}`;
          const effortId = `${idPrefix}-2-${idx}`;
          return (
            <div
              key={kind}
              className="flex flex-col gap-2.5 rounded-[10px] bg-inset/35 p-3.5 ring-1 ring-inset ring-line"
            >
              <span id={labelId} className="text-[13px] font-medium text-fg">
                {scenarioLabel(kind)}
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <Combobox
                  aria-labelledby={labelId}
                  value={routes[kind]}
                  options={routeSuggestions}
                  placeholder={uxT(locale, "scenarioRouting.routePlaceholder")}
                  onChange={value => setRoutes(prev => ({ ...prev, [kind]: value }))}
                />
                <div className="flex flex-col">
                  <label htmlFor={effortId} className="sr-only">
                    {scenarioLabel(kind)} — {uxT(locale, "scenarioRouting.effortLabel")}
                  </label>
                  <Select
                    id={effortId}
                    value={efforts[kind]}
                    onChange={val => setEfforts(prev => ({ ...prev, [kind]: val as ScenarioEffortChoice }))}
                    options={[
                      { value: "", label: uxT(locale, "scenarioRouting.effortKeep") },
                      { value: "low", label: t("models.reasoningEffort.low") },
                      { value: "medium", label: t("models.reasoningEffort.medium") },
                      { value: "high", label: t("models.reasoningEffort.high") },
                      { value: "xhigh", label: t("models.reasoningEffort.xhigh") },
                    ]}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex flex-wrap items-center gap-2 text-[13px] text-fg">
            <span className="text-fg-muted">{uxT(locale, "scenarioRouting.longContextTokens")}</span>
            <input
              type="number"
              className="input w-32 tabular-nums"
              min={MIN_LONG_CONTEXT_TOKENS}
              max={MAX_LONG_CONTEXT_TOKENS}
              step={1000}
              value={longContextTokens}
              onChange={event => setLongContextTokens(event.target.value)}
            />
          </label>
          <label className="checkbox inline-flex cursor-pointer items-center gap-1.5 text-[13px] text-fg select-none">
            <input
              type="checkbox"
              checked={overrideExplicit}
              onChange={event => setOverrideExplicit(event.target.checked)}
            />
            <span>{uxT(locale, "scenarioRouting.overrideExplicit")}</span>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void handleReset()}
          >
            {uxT(locale, "scenarioRouting.clear")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {uxT(locale, "scenarioRouting.save")}
          </Button>
        </div>
      </div>

      {/* Classifier dry-run probe */}
      <details className="rounded-[10px] bg-inset/35 ring-1 ring-inset ring-line">
        <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-semibold text-fg select-none">
          {uxT(locale, "scenarioRouting.probeTitle")}
        </summary>
        <div className="flex flex-col gap-2.5 border-0 border-t border-solid border-line p-3.5">
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProbeInput(PROBE_SAMPLES.background)}
            >
              {uxT(locale, "scenarioRouting.routeBackground")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProbeInput(PROBE_SAMPLES.think)}
            >
              {uxT(locale, "scenarioRouting.routeThink")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProbeInput(PROBE_SAMPLES.webSearch)}
            >
              {uxT(locale, "scenarioRouting.routeWebSearch")}
            </Button>
          </div>
          <textarea
            className="input min-h-[88px] font-mono text-xs"
            rows={4}
            aria-label={uxT(locale, "scenarioRouting.probeTitle")}
            value={probeInput}
            onChange={event => setProbeInput(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              variant="primary"
              size="sm"
              disabled={probing || !probeInput.trim()}
              onClick={() => void handleRunProbe()}
            >
              {uxT(locale, "scenarioRouting.probeRun")}
            </Button>
            {probeResult ? (
              <div className="flex flex-wrap items-center gap-2" role="status">
                <span className={cn("badge tabular-nums", matchedKind ? "badge-green" : "badge-muted")}>
                  {matchedKind
                    ? uxT(locale, "scenarioRouting.probeMatched", {
                        scenario: scenarioLabel(matchedKind),
                        target: matchedTarget || "—",
                        tokens: numberFmt.format(probeResult.classification.estimatedTokens),
                      })
                    : uxT(locale, "scenarioRouting.probeNoMatch", {
                        tokens: numberFmt.format(probeResult.classification.estimatedTokens),
                      })}
                </span>
                {matchedEffort && (
                  <span className="badge badge-amber font-mono">
                    {uxT(locale, "scenarioRouting.probeEffortSuffix", { effort: matchedEffort })}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  {SCENARIO_ORDER.map(kind => {
                    const activeSig = probeResult.classification.signals[kind];
                    return (
                      <span
                        key={kind}
                        className={cn(
                          "rounded-full px-2 py-0.5 font-mono text-[11px]",
                          activeSig ? "bg-accent-soft text-highlight ring-1 ring-inset ring-highlight/30" : "bg-surface text-fg-subtle ring-1 ring-inset ring-line",
                        )}
                      >
                        {kind}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          {probeError ? <Notice tone="err">{probeError}</Notice> : null}
          {probeResult?.resolveError ? <Notice tone="err">{probeResult.resolveError}</Notice> : null}
        </div>
      </details>
    </section>
  );
}
