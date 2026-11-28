import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { confirmAction } from "../../action-dialogs";
import { readJsonIfOk } from "../../fetch-json";
import { navigateHash } from "../../hash-routing";
import { useI18n } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import { codexAccountModeState } from "../../codex-multi-state";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../../provider-payload";
import { openProviderSettings } from "../../protocol-deep-links";
import { Notice, Switch } from "../../ui";
import { SegmentedControl } from "../../components/ui-v2/segmented-control";
import ConsequenceDialog, { type ConsequenceCopy } from "./ConsequenceDialog";
import IntegrationStateBadge from "./IntegrationStateBadge";
import { describeRefusal } from "./refusal-copy";
import {
  loadNativeIntegrations,
  toggleNativeIntegration,
  type NativeStatus,
} from "./native-api";

const CODEX_DISABLE_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.codex.title",
  changesKey: "integrations.dialog.codex.changes",
  breakageKey: "integrations.dialog.codex.breakage",
  undoKey: "integrations.dialog.codex.undo",
  sideEffectKey: "integrations.dialog.codex.sideEffect",
  confirmKey: "integrations.dialog.codex.confirm",
};

interface CodexIntegrationSettings {
  codexAutoStart: boolean;
  codexDesktopAuthless: boolean;
  codexAccountPickerEnabled: boolean;
  accountMode: "pool" | "direct" | "absent" | "disabled" | "invalid";
  nativeStatus: NativeStatus | null;
}

function readOpenAiEntry(config: unknown): {
  adapter?: string;
  authMode?: string;
  baseUrl?: string;
  disabled?: boolean;
} | undefined {
  if (!config || typeof config !== "object") return undefined;
  const providers = (config as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  if (!Object.hasOwn(providers, "openai")) return undefined;
  const entry = (providers as Record<string, unknown>).openai;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  return entry as { adapter?: string; authMode?: string; baseUrl?: string; disabled?: boolean };
}

async function fetchCodexIntegrationState(
  apiBase: string,
  signal?: AbortSignal,
): Promise<CodexIntegrationSettings | null> {
  try {
    const [settingsRes, configRes, nativeList] = await Promise.all([
      fetch(`${apiBase}/api/settings`, signal ? { signal } : undefined),
      fetch(`${apiBase}/api/config`, signal ? { signal } : undefined),
      loadNativeIntegrations(apiBase, signal),
    ]);
    const settings = await readJsonIfOk<{
      codexAutoStart?: unknown;
      codexDesktopAuthless?: unknown;
      codexAccountPickerEnabled?: unknown;
    }>(settingsRes);
    const config = await readJsonIfOk<unknown>(configRes);
    if (!settings || !config || typeof config !== "object") return null;
    const providerState = openAiAccountProviderState(readOpenAiEntry(config));
    const accountMode = providerState === "ready"
      ? codexAccountModeState(config)
      : providerState;
    const nativeStatus = Array.isArray(nativeList?.clients)
      ? nativeList.clients.find(client => client.clientId === "codex") ?? null
      : null;
    return {
      codexAutoStart: settings.codexAutoStart !== false,
      codexDesktopAuthless: settings.codexDesktopAuthless === true,
      codexAccountPickerEnabled: settings.codexAccountPickerEnabled === true,
      accountMode,
      nativeStatus,
    };
  } catch {
    return null;
  }
}

export default function CodexIntegrationPage({ apiBase, active }: { apiBase: string; active: boolean }) {
  const { t, locale } = useI18n();
  const [originBase, setOriginBase] = useState(apiBase);
  const [state, setState] = useState<CodexIntegrationSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  if (originBase !== apiBase) {
    setOriginBase(apiBase);
    setState(null);
    setLoadError(false);
    setBusyKey(null);
    setFeedback(null);
    setConfirmDisable(false);
  }
  const mountedRef = useRef(true);
  const requestEpochRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const seq = ++mutationEpochRef.current;
    return () => {
      mountedRef.current = false;
      if (mutationEpochRef.current === seq) mutationEpochRef.current += 1;
      fetchAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
      mutationAbortRef.current = null;
    };
  }, [apiBase]);

  const reload = async (): Promise<boolean> => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const epoch = ++requestEpochRef.current;
    const next = await fetchCodexIntegrationState(apiBase, controller.signal);
    if (!mountedRef.current || controller.signal.aborted || epoch !== requestEpochRef.current) return false;
    if (next) {
      setState(next);
      setLoadError(false);
      return true;
    }
    setLoadError(true);
    return false;
  };

  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = ac;
    const epoch = ++requestEpochRef.current;
    fetchCodexIntegrationState(apiBase, ac.signal)
      .then(next => {
        if (!mountedRef.current || ac.signal.aborted || epoch !== requestEpochRef.current) return;
        if (next) {
          setState(next);
          setLoadError(false);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => {
        if (mountedRef.current && !ac.signal.aborted && epoch === requestEpochRef.current) {
          setLoadError(true);
        }
      });
    return () => {
      ac.abort();
      fetchAbortRef.current?.abort();
      requestEpochRef.current += 1;
    };
  }, [active, apiBase]);

  const updateBooleanSetting = async (
    key: "codexAutoStart" | "codexDesktopAuthless" | "codexAccountPickerEnabled",
    nextValue: boolean,
  ) => {
    if (busyKey || !state) return;
    const seq = mutationEpochRef.current;
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    const alive = () => mountedRef.current && !controller.signal.aborted && mutationEpochRef.current === seq;
    setBusyKey(key);
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: nextValue }),
        signal: controller.signal,
      });
      if (!alive()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        if (!alive()) return;
        setFeedback({ tone: "err", text: err?.error ?? uxT(locale, "codexRoute.saveFailed") });
        return;
      }
      if (key === "codexDesktopAuthless") {
        await fetch(`${apiBase}/api/sync`, { method: "POST", signal: controller.signal }).catch(() => undefined);
      }
      if (!alive()) return;
      const refreshed = await reload();
      if (!alive()) return;
      if (refreshed) {
        setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
      } else {
        setState(prev => (prev ? { ...prev, [key]: nextValue } : prev));
      }
    } catch {
      if (alive()) {
        setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
      }
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      if (mountedRef.current && mutationEpochRef.current === seq) setBusyKey(null);
    }
  };

  const setAccountMode = async (mode: "pool" | "direct") => {
    if (busyKey || !state || state.accountMode === mode) return;
    const seq = mutationEpochRef.current;
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    const alive = () => mountedRef.current && !controller.signal.aborted && mutationEpochRef.current === seq;
    setBusyKey("accountMode");
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/providers?name=openai`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAccountMode: mode }),
        signal: controller.signal,
      });
      if (!alive()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        if (!alive()) return;
        setFeedback({ tone: "err", text: err?.error ?? uxT(locale, "codexRoute.saveFailed") });
        return;
      }
      const refreshed = await reload();
      if (!alive()) return;
      if (refreshed) {
        setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
      } else {
        setState(prev => (prev ? { ...prev, accountMode: mode } : prev));
      }
    } catch {
      if (alive()) {
        setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
      }
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      if (mountedRef.current && mutationEpochRef.current === seq) setBusyKey(null);
    }
  };

  const requestAccountMode = async (mode: "pool" | "direct") => {
    if (busyKey || !state || state.accountMode === mode) return;
    if (await confirmAction({ message: t("pws.accountModeConfirm") })) {
      await setAccountMode(mode);
    }
  };

  const enableOpenAi = async () => {
    if (busyKey || (state?.accountMode !== "absent" && state?.accountMode !== "disabled")) return;
    const seq = mutationEpochRef.current;
    const alive = () => mountedRef.current && mutationEpochRef.current === seq;
    setBusyKey("enableOpenAi");
    setFeedback(null);
    try {
      await ensureOpenAiProvider(apiBase, state.accountMode);
      if (!alive()) return;
      const refreshed = await reload();
      if (alive() && refreshed) {
        setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
      }
    } catch (error) {
      if (!alive()) return;
      if (error instanceof OpenAiEnableError) {
        setFeedback({ tone: "err", text: t(error.i18nKey) });
      } else {
        setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
      }
    } finally {
      if (alive()) setBusyKey(null);
    }
  };

  const applyNativeConnection = async (next: boolean) => {
    if (busyKey) return;
    const seq = mutationEpochRef.current;
    const alive = () => mountedRef.current && mutationEpochRef.current === seq;
    setBusyKey("nativeConnection");
    setFeedback(null);
    try {
      const result = await toggleNativeIntegration(apiBase, "codex", next);
      if (!alive()) return;
      await reload();
      if (!alive()) return;
      if (result.reason === "non_loopback_removed") {
        setFeedback({
          tone: "ok",
          text: t(result.changed
            ? "integrations.native.msg.nonLoopbackRemoved"
            : "integrations.native.msg.nonLoopbackRemovedNoop"),
        });
      } else if (result.reason === "non_loopback_superseded") {
        setFeedback({ tone: "ok", text: t("integrations.native.msg.nonLoopbackSuperseded") });
      } else {
        setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
      }
    } catch (error) {
      if (!alive()) return;
      await reload();
      if (!alive()) return;
      setFeedback({
        tone: "err",
        text: describeRefusal(t, error, undefined, state?.nativeStatus?.configPath),
      });
    } finally {
      if (alive()) setBusyKey(null);
    }
  };

  const syncCodexConfig = async () => {
    if (busyKey) return;
    const seq = mutationEpochRef.current;
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    const alive = () => mountedRef.current && !controller.signal.aborted && mutationEpochRef.current === seq;
    setBusyKey("sync");
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST", signal: controller.signal });
      if (!alive()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        if (!alive()) return;
        setFeedback({ tone: "err", text: err?.error ?? uxT(locale, "codexRoute.saveFailed") });
        return;
      }
      setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.synced") });
    } catch {
      if (alive()) setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      if (mountedRef.current && mutationEpochRef.current === seq) setBusyKey(null);
    }
  };

  return (
    <section className="integration-native-page flex flex-col gap-4" aria-labelledby="codex-integration-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-[60ch] flex-col gap-1">
          <h3 id="codex-integration-title" className="m-0">{t("integrations.codex.title")}</h3>
          <p className="m-0 text-fg-muted">{t("integrations.codex.body")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busyKey !== null}
            onClick={() => { void syncCodexConfig(); }}
          >
            {uxT(locale, "codexRoute.syncNow")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigateHash("startup")}
          >
            {t("integrations.codex.openService")}
          </button>
        </div>
      </div>

      {loadError && (
        <Notice tone="err">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("codexAuth.loadFailed")}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busyKey !== null}
              onClick={() => { void reload(); }}
            >
              {t("common.retry")}
            </button>
          </div>
        </Notice>
      )}

      {feedback && (
        <Notice tone={feedback.tone === "ok" ? "ok" : "err"}>{feedback.text}</Notice>
      )}

      {(() => {
        const native = state?.nativeStatus ?? null;
        const connected = native?.desiredEnabled ?? native?.state === "current";
        const toggleDisabled = busyKey !== null
          || native === null
          || !native.installed
          || native.state === "unsafe"
          || (connected && native.disableBlocked !== null);
        return (
          <div className="rounded-card border border-solid border-line bg-surface p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex flex-wrap items-center gap-2">
                <IntegrationStateBadge
                  state={native ? native.state : "unknown"}
                  installed={native?.installed ?? true}
                />
                {native?.configPath && (
                  <span className="font-mono text-xs text-fg-muted break-all">{native.configPath}</span>
                )}
              </div>
              <Switch
                on={connected}
                label={connected ? t("integrations.action.disable") : t("integrations.action.apply")}
                disabled={toggleDisabled}
                onClick={() => {
                  if (connected) setConfirmDisable(true);
                  else void applyNativeConnection(true);
                }}
              />
            </div>
            {connected && native?.disableBlocked && (
              <p className="m-0 text-xs text-fg-muted">{native.disableBlocked.message}</p>
            )}
          </div>
        );
      })()}

      {confirmDisable && (
        <ConsequenceDialog
          copy={{ ...CODEX_DISABLE_COPY, vars: { path: state?.nativeStatus?.configPath ?? "" } }}
          onClose={() => setConfirmDisable(false)}
          onConfirm={async () => {
            await applyNativeConnection(false);
            setConfirmDisable(false);
          }}
        />
      )}

      <div className="rounded-card border border-solid border-line bg-surface p-4 flex flex-col gap-3">
        {(state?.accountMode === "absent" || state?.accountMode === "disabled") ? (
          <div className="flex flex-col gap-2">
            <div>
              <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.modeTitle")}</div>
              <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.modeDesc")}</div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-control border border-solid border-line bg-inset p-3">
              <span className="text-xs text-fg-muted">{t("codexAuth.openaiUnavailableDesc")}</span>
              <button
                type="button"
                className="btn btn-primary btn-sm shrink-0"
                disabled={busyKey !== null}
                onClick={() => { void enableOpenAi(); }}
              >
                {t("codexAuth.enableOpenai")}
              </button>
            </div>
          </div>
        ) : state?.accountMode === "invalid" ? (
          <div className="flex flex-col gap-2">
            <div>
              <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.modeTitle")}</div>
              <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.modeDesc")}</div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-solid border-line bg-inset p-3">
              <span className="text-xs text-fg-muted">{t("codexAuth.openaiMissing")}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0"
                onClick={() => openProviderSettings("openai")}
              >
                {t("codexAuth.openProviders")}
              </button>
            </div>
          </div>
        ) : state ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.modeTitle")}</div>
              <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.modeDesc")}</div>
              <div className="mt-0.5 text-xs text-fg-subtle">
                {uxT(locale, state.accountMode === "direct" ? "codexRoute.modeDirectHint" : "codexRoute.modePoolHint")}
              </div>
            </div>
            <SegmentedControl
              size="sm"
              aria-label={uxT(locale, "codexRoute.modeTitle")}
              value={state.accountMode === "direct" ? "direct" : "pool"}
              disabled={busyKey !== null}
              onChange={mode => { void requestAccountMode(mode); }}
              items={[
                { value: "pool", label: uxT(locale, "codexRoute.modePoolShort"), title: uxT(locale, "codexRoute.modePool") },
                { value: "direct", label: uxT(locale, "codexRoute.modeDirectShort"), title: uxT(locale, "codexRoute.modeDirect") },
              ]}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.modeTitle")}</div>
            <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.modeDesc")}</div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-0 border-t border-solid border-line pt-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.autoStart")}</div>
            <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.autoStartHint")}</div>
          </div>
          <Switch
            on={state?.codexAutoStart ?? false}
            label={uxT(locale, "codexRoute.autoStart")}
            disabled={busyKey !== null || state === null}
            onClick={() => { void updateBooleanSetting("codexAutoStart", !(state?.codexAutoStart ?? false)); }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-0 border-t border-solid border-line pt-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.desktopAuthless")}</div>
            <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.desktopAuthlessHint")}</div>
          </div>
          <Switch
            on={state?.codexDesktopAuthless ?? false}
            label={uxT(locale, "codexRoute.desktopAuthless")}
            disabled={busyKey !== null || state === null}
            onClick={() => { void updateBooleanSetting("codexDesktopAuthless", !(state?.codexDesktopAuthless ?? false)); }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-0 border-t border-solid border-line pt-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.accountPicker")}</div>
            <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.accountPickerHint")}</div>
          </div>
          <Switch
            on={state?.codexAccountPickerEnabled ?? false}
            label={uxT(locale, "codexRoute.accountPicker")}
            disabled={busyKey !== null || state === null}
            onClick={() => { void updateBooleanSetting("codexAccountPickerEnabled", !(state?.codexAccountPickerEnabled ?? false)); }}
          />
        </div>
      </div>
    </section>
  );
}
