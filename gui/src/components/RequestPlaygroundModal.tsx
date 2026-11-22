import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { Select } from "../ui";
import { Combobox } from "./ui-v2/combobox";
import {
  buildPlaygroundCurl,
  buildPlaygroundPayload,
  DEFAULT_PLAYGROUND_MODEL,
  executePlaygroundRequest,
  fetchPlaygroundModelIds,
  type PlaygroundEffort,
  type PlaygroundEndpoint,
  type PlaygroundPayloadOptions,
  type PlaygroundSeed,
  type PlaygroundTelemetry,
  type PlaygroundTurn,
} from "../lib/playground-client";
import "./request-playground.css";

export type { PlaygroundSeed };

const MAX_MODEL_SUGGESTIONS = 256;

const EMPTY_TELEMETRY: PlaygroundTelemetry = {
  status: null,
  ttftMs: null,
  totalMs: null,
  throughputCps: null,
  tokens: null,
  inputTokens: null,
  outputTokens: null,
  tokensPerSec: null,
};

interface LaneState {
  output: string;
  errorMsg: string | null;
  telemetry: PlaygroundTelemetry;
}

const INITIAL_LANE: LaneState = {
  output: "",
  errorMsg: null,
  telemetry: EMPTY_TELEMETRY,
};

function parseOptionalMaxTokens(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000 ? n : undefined;
}

function parseOptionalTemperature(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : undefined;
}

function isPointOutsideRect(rect: DOMRect, clientX: number, clientY: number): boolean {
  if (rect.width === 0 && rect.height === 0) return false;
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

export default function RequestPlaygroundModal({
  apiBase,
  initialSeed,
  onClose,
}: {
  apiBase: string;
  initialSeed?: PlaygroundSeed | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const endpointId = useId();
  const modelAInputId = useId();
  const modelBInputId = useId();
  const maxTokensId = useId();
  const temperatureId = useId();
  const effortId = useId();
  const systemInputId = useId();
  const userInputId = useId();

  const dialogRef = useRef<HTMLDialogElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);
  const pointerDownOutsideRef = useRef(false);

  const [mode, setMode] = useState<"single" | "compare">("single");
  const [endpoint, setEndpoint] = useState<PlaygroundEndpoint>(() => initialSeed?.endpoint ?? "/v1/chat/completions");
  const [modelA, setModelA] = useState(() => initialSeed?.model?.trim() || DEFAULT_PLAYGROUND_MODEL);
  const [modelB, setModelB] = useState(() => initialSeed?.model?.trim() || DEFAULT_PLAYGROUND_MODEL);
  const [models, setModels] = useState<string[]>([]);
  const [maxTokensDraft, setMaxTokensDraft] = useState(() => (
    typeof initialSeed?.maxTokens === "number" && Number.isSafeInteger(initialSeed.maxTokens) && initialSeed.maxTokens > 0
      ? String(initialSeed.maxTokens)
      : ""
  ));
  const [temperatureDraft, setTemperatureDraft] = useState(() => (
    typeof initialSeed?.temperature === "number" && Number.isFinite(initialSeed.temperature)
      ? String(initialSeed.temperature)
      : ""
  ));
  const [effort, setEffort] = useState<PlaygroundEffort>(() => initialSeed?.effort ?? "");
  const [serviceTier, setServiceTier] = useState(() => initialSeed?.serviceTier ?? "");
  const [systemPrompt, setSystemPrompt] = useState(() => initialSeed?.systemPrompt ?? "");
  const [priorTurns, setPriorTurns] = useState<PlaygroundTurn[]>(() => (
    initialSeed?.turns?.map(turn => ({ ...turn })) ?? []
  ));
  const [userPrompt, setUserPrompt] = useState(() => initialSeed?.userPrompt ?? "");
  const [stream, setStream] = useState(true);

  const [sending, setSending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [laneA, setLaneA] = useState<LaneState>(INITIAL_LANE);
  const [laneB, setLaneB] = useState<LaneState>(INITIAL_LANE);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [trackedSeed, setTrackedSeed] = useState(initialSeed);

  if (trackedSeed !== initialSeed) {
    setTrackedSeed(initialSeed);
    if (initialSeed) {
      if (initialSeed.endpoint) setEndpoint(initialSeed.endpoint);
      if (initialSeed.model?.trim()) {
        const nextModel = initialSeed.model.trim();
        setModelA(nextModel);
        setModelB(nextModel);
      }
      if (initialSeed.systemPrompt !== undefined) setSystemPrompt(initialSeed.systemPrompt);
      if (initialSeed.userPrompt !== undefined) setUserPrompt(initialSeed.userPrompt);
      if (initialSeed.turns !== undefined) setPriorTurns(initialSeed.turns.map(turn => ({ ...turn })));
      if (initialSeed.maxTokens !== undefined) {
        setMaxTokensDraft(Number.isSafeInteger(initialSeed.maxTokens) && initialSeed.maxTokens > 0 ? String(initialSeed.maxTokens) : "");
      }
      if (initialSeed.temperature !== undefined) {
        setTemperatureDraft(Number.isFinite(initialSeed.temperature) ? String(initialSeed.temperature) : "");
      }
      if (initialSeed.effort !== undefined) setEffort(initialSeed.effort);
      if (initialSeed.serviceTier !== undefined) setServiceTier(initialSeed.serviceTier);
    }
  }

  const requestClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    abortRef.current?.abort();
    const dlg = dialogRef.current;
    if (dlg && typeof dlg.close === "function" && dlg.open) {
      dlg.close();
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dlg = dialogRef.current;
    if (dlg) {
      if (typeof dlg.showModal === "function") {
        try {
          if (!dlg.open) dlg.showModal();
        } catch {
          dlg.setAttribute("open", "");
        }
      } else {
        dlg.setAttribute("open", "");
      }
      surfaceRef.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    }
    return () => {
      abortRef.current?.abort();
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      if (dlg && typeof dlg.close === "function" && dlg.open) {
        dlg.close();
      }
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void fetchPlaygroundModelIds(apiBase, ac.signal, MAX_MODEL_SUGGESTIONS)
      .then((ids) => {
        if (cancelled) return;
        setModels(ids);
        if (ids.length > 0) {
          setModelA((current) => (current.trim() ? current : ids[0]!));
          setModelB((current) => (current.trim() ? current : (ids[1] ?? ids[0]!)));
        }
      })
      .catch(() => {
        // Model autocomplete is optional; manual entry always stays enabled.
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase]);

  const stopRequest = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setValidationError(uxT(locale, "playground.aborted"));
  };

  const buildPayloadOptions = (promptText: string): PlaygroundPayloadOptions | undefined => {
    const temperature = parseOptionalTemperature(temperatureDraft);
    const nonEmptyTurns = priorTurns.filter(turn => turn.content.trim().length > 0);
    const turns = nonEmptyTurns.length > 0
      ? [...nonEmptyTurns, { role: "user" as const, content: promptText }]
      : undefined;
    const trimmedTier = serviceTier.trim();
    if (temperature === undefined && !effort && !trimmedTier && !turns) {
      return undefined;
    }
    return {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(effort ? { effort } : {}),
      ...(trimmedTier ? { serviceTier: trimmedTier } : {}),
      ...(turns ? { turns } : {}),
    };
  };

  const runLane = async (
    targetModel: string,
    maxTokens: number | undefined,
    ac: AbortController,
    update: (updater: (prev: LaneState) => LaneState) => void,
  ) => {
    const payload = buildPlaygroundPayload(
      endpoint,
      targetModel,
      systemPrompt,
      userPrompt,
      stream,
      maxTokens,
      buildPayloadOptions(userPrompt),
    );
    try {
      const result = await executePlaygroundRequest({
        apiBase,
        endpoint,
        payload,
        stream,
        truncatedSuffix: uxT(locale, "playground.truncated"),
        signal: ac.signal,
        onStatus: (status) => update((prev) => ({ ...prev, telemetry: { ...prev.telemetry, status } })),
        onOutput: (text) => update((prev) => ({ ...prev, output: text })),
      });
      update((prev) => ({
        ...prev,
        telemetry: result.telemetry,
        errorMsg: result.httpErrorStatus !== null
          ? (result.errorDetail
            ? `${uxT(locale, "playground.httpError", { status: result.httpErrorStatus })}: ${result.errorDetail}`
            : uxT(locale, "playground.httpError", { status: result.httpErrorStatus }))
          : null,
      }));
    } catch (error) {
      if (ac.signal.aborted) return;
      update((prev) => ({
        ...prev,
        errorMsg: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const runRequest = async () => {
    const targetA = modelA.trim();
    const targetB = modelB.trim();
    if (!targetA || (mode === "compare" && !targetB)) {
      setValidationError(uxT(locale, "playground.modelRequired"));
      return;
    }
    if (!userPrompt.trim()) {
      setValidationError(uxT(locale, "playground.promptRequired"));
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const maxTokens = parseOptionalMaxTokens(maxTokensDraft);
    setSending(true);
    setValidationError(null);
    setLaneA(INITIAL_LANE);
    setLaneB(INITIAL_LANE);

    try {
      if (mode === "compare") {
        await Promise.allSettled([
          runLane(targetA, maxTokens, ac, setLaneA),
          runLane(targetB, maxTokens, ac, setLaneB),
        ]);
      } else {
        await runLane(targetA, maxTokens, ac, setLaneA);
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setSending(false);
      }
    }
  };

  const handleCopyCurl = async () => {
    const maxTokens = parseOptionalMaxTokens(maxTokensDraft);
    const effectiveUserPrompt = userPrompt.trim() || "...";
    const payload = buildPlaygroundPayload(
      endpoint,
      modelA.trim() || DEFAULT_PLAYGROUND_MODEL,
      systemPrompt,
      effectiveUserPrompt,
      stream,
      maxTokens,
      buildPayloadOptions(effectiveUserPrompt),
    );
    const cmd = buildPlaygroundCurl(apiBase, endpoint, payload);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyStatus("idle"), 2_000);
  };

  const renderTelemetryAndOutput = (lane: LaneState, label?: string) => {
    const statusTone = lane.telemetry.status === null
      ? ""
      : lane.telemetry.status >= 200 && lane.telemetry.status < 300
        ? " playground-chip--ok"
        : " playground-chip--err";
    return (
      <div className="playground-lane">
        {label && <div className="playground-lane-label">{label}</div>}
        {lane.errorMsg && <div className="notice notice-err" role="alert">{lane.errorMsg}</div>}
        <div className="playground-telemetry" aria-live="polite">
          {lane.telemetry.status !== null && (
            <span className={`playground-chip${statusTone}`}>
              {uxT(locale, "playground.statusLabel", { status: lane.telemetry.status })}
            </span>
          )}
          {lane.telemetry.ttftMs !== null && (
            <span className="playground-chip">
              {uxT(locale, "playground.ttftLabel", { ms: lane.telemetry.ttftMs })}
            </span>
          )}
          {lane.telemetry.totalMs !== null && (
            <span className="playground-chip">
              {uxT(locale, "playground.latencyLabel", { ms: lane.telemetry.totalMs })}
            </span>
          )}
          {lane.telemetry.throughputCps !== null && (
            <span className="playground-chip">
              {uxT(locale, "playground.throughputLabel", { rate: lane.telemetry.throughputCps })}
            </span>
          )}
          {lane.telemetry.inputTokens !== null && lane.telemetry.outputTokens !== null ? (
            <span className="playground-chip">
              {uxT(locale, "playground.tokensSplitLabel", {
                input: lane.telemetry.inputTokens,
                output: lane.telemetry.outputTokens,
              })}
            </span>
          ) : lane.telemetry.tokens !== null && (
            <span className="playground-chip">
              {uxT(locale, "playground.tokensLabel", { count: lane.telemetry.tokens })}
            </span>
          )}
          {lane.telemetry.tokensPerSec !== null && (
            <span className="playground-chip">
              {uxT(locale, "playground.tokSecLabel", { rate: lane.telemetry.tokensPerSec })}
            </span>
          )}
        </div>
        <pre className={`playground-output${lane.output ? "" : " playground-output--empty"}`}>
          {lane.output || uxT(locale, "playground.emptyResponse")}
        </pre>
      </div>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="playground-native-dialog"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onPointerDown={(event) => {
        if (!surfaceRef.current) return;
        pointerDownOutsideRef.current = isPointOutsideRect(
          surfaceRef.current.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
      }}
      onPointerUp={(event) => {
        if (!pointerDownOutsideRef.current || !surfaceRef.current) {
          pointerDownOutsideRef.current = false;
          return;
        }
        pointerDownOutsideRef.current = false;
        if (isPointOutsideRect(surfaceRef.current.getBoundingClientRect(), event.clientX, event.clientY)) {
          requestClose();
        }
      }}
    >
      <div ref={surfaceRef} tabIndex={-1} className="modal-card playground-modal-card playground-dialog-surface">
        <div className="modal-head">
          <div className="playground-head-left">
            <h3 id={titleId}>{uxT(locale, "playground.title")}</h3>
            <div className="segmented playground-mode-switch" role="group" aria-label={uxT(locale, "playground.title")}>
              <button
                type="button"
                aria-pressed={mode === "single"}
                disabled={sending}
                onClick={() => setMode("single")}
              >
                {uxT(locale, "playground.modeSingle")}
              </button>
              <button
                type="button"
                aria-pressed={mode === "compare"}
                disabled={sending}
                onClick={() => setMode("compare")}
              >
                {uxT(locale, "playground.modeCompare")}
              </button>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={requestClose}>
            <IconX />
          </button>
        </div>
        <p className="playground-subtitle">
          {mode === "compare" ? uxT(locale, "playground.compareHint") : uxT(locale, "playground.subtitle")}
        </p>

        <form className="playground-form" onSubmit={(e) => { e.preventDefault(); void runRequest(); }}>
          <div className="playground-grid playground-grid--3">
            <div className="playground-field">
              <label htmlFor={endpointId}>{uxT(locale, "playground.endpoint")}</label>
              <Select
                id={endpointId}
                fullWidth
                value={endpoint}
                disabled={sending}
                onChange={(v) => setEndpoint(v as PlaygroundEndpoint)}
                options={[
                  { value: "/v1/chat/completions", label: uxT(locale, "playground.endpointChat") },
                  { value: "/v1/responses", label: uxT(locale, "playground.endpointResponses") },
                  { value: "/v1/messages", label: uxT(locale, "playground.endpointMessages") },
                ]}
              />
            </div>
            <div className="playground-field">
              <label htmlFor={modelAInputId}>
                {mode === "compare" ? uxT(locale, "playground.modelA") : uxT(locale, "playground.model")}
              </label>
              <Combobox
                id={modelAInputId}
                value={modelA}
                options={models}
                placeholder={uxT(locale, "playground.modelPlaceholder")}
                onChange={setModelA}
                disabled={sending}
              />
            </div>
            {mode === "compare" ? (
              <div className="playground-field">
                <label htmlFor={modelBInputId}>{uxT(locale, "playground.modelB")}</label>
                <Combobox
                  id={modelBInputId}
                  value={modelB}
                  options={models}
                  placeholder={uxT(locale, "playground.modelPlaceholder")}
                  onChange={setModelB}
                  disabled={sending}
                />
              </div>
            ) : (
              <div className="playground-field">
                <label htmlFor={maxTokensId}>{uxT(locale, "playground.maxTokens")}</label>
                <input
                  id={maxTokensId}
                  type="number"
                  min={1}
                  max={1_000_000}
                  step={1}
                  className="input"
                  value={maxTokensDraft}
                  placeholder={uxT(locale, "playground.maxTokensPlaceholder")}
                  onChange={(e) => setMaxTokensDraft(e.target.value)}
                  disabled={sending}
                />
              </div>
            )}
          </div>

          <div className="playground-grid">
            <div className="playground-field">
              <label htmlFor={temperatureId}>{uxT(locale, "playground.temperature")}</label>
              <input
                id={temperatureId}
                type="number"
                min={0}
                max={2}
                step={0.1}
                className="input"
                value={temperatureDraft}
                placeholder={uxT(locale, "playground.temperaturePlaceholder")}
                onChange={(e) => setTemperatureDraft(e.target.value)}
                disabled={sending}
              />
            </div>
            <div className="playground-field">
              <label htmlFor={effortId}>{uxT(locale, "playground.reasoningEffort")}</label>
              <Select
                id={effortId}
                fullWidth
                value={effort}
                disabled={sending}
                onChange={(v) => setEffort(v as PlaygroundEffort)}
                options={[
                  { value: "", label: uxT(locale, "playground.effortDefault") },
                  { value: "low", label: t("models.reasoningEffort.low") },
                  { value: "medium", label: t("models.reasoningEffort.medium") },
                  { value: "high", label: t("models.reasoningEffort.high") },
                  { value: "xhigh", label: t("models.reasoningEffort.xhigh") },
                ]}
              />
            </div>
          </div>

          {mode === "compare" && (
            <div className="playground-grid">
              <div className="playground-field">
                <label htmlFor={systemInputId}>{uxT(locale, "playground.systemPrompt")}</label>
                <input
                  id={systemInputId}
                  type="text"
                  className="input"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  disabled={sending}
                />
              </div>
              <div className="playground-field">
                <label htmlFor={maxTokensId}>{uxT(locale, "playground.maxTokens")}</label>
                <input
                  id={maxTokensId}
                  type="number"
                  min={1}
                  max={1_000_000}
                  step={1}
                  className="input"
                  value={maxTokensDraft}
                  placeholder={uxT(locale, "playground.maxTokensPlaceholder")}
                  onChange={(e) => setMaxTokensDraft(e.target.value)}
                  disabled={sending}
                />
              </div>
            </div>
          )}

          {mode === "single" && (
            <div className="playground-field">
              <label htmlFor={systemInputId}>{uxT(locale, "playground.systemPrompt")}</label>
              <input
                id={systemInputId}
                type="text"
                className="input"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={sending}
              />
            </div>
          )}

          {priorTurns.length > 0 && (
            <div className="flex flex-col gap-2">
              {priorTurns.map((turn, idx) => (
                <div key={idx} className="playground-turn-row">
                  <div className="playground-turn-head">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={sending}
                      onClick={() => setPriorTurns(prev => prev.map((item, i) => (
                        i === idx ? { ...item, role: item.role === "user" ? "assistant" : "user" } : item
                      )))}
                    >
                      {turn.role === "assistant"
                        ? uxT(locale, "playground.roleAssistant")
                        : uxT(locale, "playground.roleUser")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={sending}
                      onClick={() => setPriorTurns(prev => prev.filter((_, i) => i !== idx))}
                    >
                      {uxT(locale, "playground.removeTurn")}
                    </button>
                  </div>
                  <textarea
                    className="input playground-textarea playground-turn-textarea"
                    value={turn.content}
                    disabled={sending}
                    onChange={(e) => setPriorTurns(prev => prev.map((item, i) => (
                      i === idx ? { ...item, content: e.target.value } : item
                    )))}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="playground-field">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={userInputId}>{uxT(locale, "playground.userPrompt")}</label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={sending}
                onClick={() => {
                  if (priorTurns.length === 0 && userPrompt.trim()) {
                    setPriorTurns([
                      { role: "user", content: userPrompt },
                      { role: "assistant", content: "" },
                    ]);
                    setUserPrompt("");
                    return;
                  }
                  const nextRole = priorTurns.length > 0 && priorTurns[priorTurns.length - 1]!.role === "user"
                    ? "assistant"
                    : "user";
                  setPriorTurns(prev => [...prev, { role: nextRole, content: "" }]);
                }}
              >
                {uxT(locale, "playground.addTurn")}
              </button>
            </div>
            <textarea
              id={userInputId}
              className="input playground-textarea"
              value={userPrompt}
              placeholder={uxT(locale, "playground.userPlaceholder")}
              onChange={(e) => setUserPrompt(e.target.value)}
              disabled={sending}
            />
          </div>

          <div className="playground-controls">
            <label className="playground-stream-toggle">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                disabled={sending}
              />
              <span>{uxT(locale, "playground.stream")}</span>
            </label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void handleCopyCurl(); }}>
              {copyStatus === "copied"
                ? uxT(locale, "playground.copied")
                : copyStatus === "failed"
                  ? uxT(locale, "playground.copyFailed")
                  : uxT(locale, "playground.copyCurl")}
            </button>
            {sending ? (
              <button type="button" className="btn btn-danger btn-sm" onClick={stopRequest}>
                {uxT(locale, "playground.stop")}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary btn-sm">
                {uxT(locale, "playground.send")}
              </button>
            )}
          </div>
        </form>

        {validationError && <div className="notice notice-err" role="alert">{validationError}</div>}

        {mode === "compare" ? (
          <div className="playground-compare-grid">
            {renderTelemetryAndOutput(laneA, modelA.trim() || uxT(locale, "playground.modelA"))}
            {renderTelemetryAndOutput(laneB, modelB.trim() || uxT(locale, "playground.modelB"))}
          </div>
        ) : (
          renderTelemetryAndOutput(laneA)
        )}
      </div>
    </dialog>
  );
}
