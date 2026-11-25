import { useCallback, useEffect, useState } from "react";
import { readJsonIfOk } from "../../fetch-json";
import { navigateHash } from "../../hash-routing";
import { useI18n } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import { codexAccountModeState } from "../../codex-multi-state";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../../provider-payload";
import { Notice, Switch } from "../../ui";
import { cn } from "../../lib/utils";
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
    const providerState = openAiAccountProviderState(readOpenAiEntry(config));
    const accountMode = providerState === "ready"
      ? codexAccountModeState(config)
      : providerState;
    const nativeStatus = Array.isArray(nativeList?.clients)
      ? nativeList.clients.find(client => client.clientId === "codex") ?? null
      : null;
    return {
      codexAutoStart: settings?.codexAutoStart !== false,
      codexDesktopAuthless: settings?.codexDesktopAuthless === true,
      codexAccountPickerEnabled: settings?.codexAccountPickerEnabled === true,
      accountMode,
      nativeStatus,
    };
  } catch {
    return null;
  }
}

export default function CodexIntegrationPage({ apiBase, active }: { apiBase: string; active: boolean }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<CodexIntegrationSettings | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchCodexIntegrationState(apiBase, signal);
    if (!signal?.aborted && next) setState(next);
  }, [apiBase]);

  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    fetchCodexIntegrationState(apiBase, ac.signal)
      .then(next => {
        if (!ac.signal.aborted && next) setState(next);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [active, apiBase]);

  const updateBooleanSetting = async (
    key: "codexAutoStart" | "codexDesktopAuthless" | "codexAccountPickerEnabled",
    nextValue: boolean,
  ) => {
    if (busyKey) return;
    setBusyKey(key);
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: nextValue }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        setFeedback({ tone: "err", text: err?.error ?? uxT(locale, "codexRoute.saveFailed") });
        return;
      }
      if (key === "codexDesktopAuthless") {
        await fetch(`${apiBase}/api/sync`, { method: "POST" }).catch(() => undefined);
      }
      await reload();
      setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
    } catch {
      setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
    } finally {
      setBusyKey(null);
    }
  };

  const setAccountMode = async (mode: "pool" | "direct") => {
    if (busyKey || state?.accountMode === mode) return;
    setBusyKey("accountMode");
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/providers?name=openai`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAccountMode: mode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        setFeedback({ tone: "err", text: err?.error ?? uxT(locale, "codexRoute.saveFailed") });
        return;
      }
      await reload();
      setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
    } catch {
      setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
    } finally {
      setBusyKey(null);
    }
  };

  const enableOpenAi = async () => {
    if (busyKey || (state?.accountMode !== "absent" && state?.accountMode !== "disabled")) return;
    setBusyKey("enableOpenAi");
    setFeedback(null);
    try {
      await ensureOpenAiProvider(apiBase, state.accountMode);
      await reload();
      setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.saved") });
    } catch (error) {
      if (error instanceof OpenAiEnableError) {
        setFeedback({ tone: "err", text: t(error.i18nKey) });
      } else {
        setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
      }
    } finally {
      setBusyKey(null);
    }
  };

  const applyNativeConnection = async (next: boolean) => {
    if (busyKey) return;
    setBusyKey("nativeConnection");
    setFeedback(null);
    try {
      const result = await toggleNativeIntegration(apiBase, "codex", next);
      await reload();
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
      await reload();
      setFeedback({
        tone: "err",
        text: describeRefusal(t, error, undefined, state?.nativeStatus?.configPath),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const syncCodexConfig = async () => {
    if (busyKey) return;
    setBusyKey("sync");
    setFeedback(null);
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        setFeedback({ tone: "err", text: err?.error ?? uxT(locale, "codexRoute.saveFailed") });
        return;
      }
      setFeedback({ tone: "ok", text: uxT(locale, "codexRoute.synced") });
    } catch {
      setFeedback({ tone: "err", text: uxT(locale, "codexRoute.saveFailed") });
    } finally {
      setBusyKey(null);
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
            className="btn btn-primary btn-sm"
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
              <div className="min-w-0 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="m-0 text-sm font-semibold text-fg">{t("integrations.codex.title")}</h4>
                  <IntegrationStateBadge
                    state={native ? native.state : "unknown"}
                    installed={native?.installed ?? true}
                  />
                </div>
                {native?.configPath && (
                  <p className="m-0 font-mono text-xs text-fg-muted break-all">{native.configPath}</p>
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
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h4 className="m-0 text-sm font-semibold text-fg">{uxT(locale, "codexRoute.modeTitle")}</h4>
            <p className="m-0 mt-1 text-xs text-fg-muted">{uxT(locale, "codexRoute.modeDesc")}</p>
          </div>
          {(state?.accountMode === "pool" || state?.accountMode === "direct") && (
            <span className={state.accountMode === "pool" ? "badge badge-blue" : "badge badge-muted"}>
              {state.accountMode === "pool" ? t("codexAuth.accountModePool") : t("codexAuth.accountModeDirect")}
            </span>
          )}
        </div>

        {(state?.accountMode === "absent" || state?.accountMode === "disabled") ? (
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
        ) : (
          <div
            role="radiogroup"
            aria-label={uxT(locale, "codexRoute.modeTitle")}
            className="grid gap-2 sm:grid-cols-2"
          >
            {(["pool", "direct"] as const).map(mode => {
              const selected = state?.accountMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busyKey !== null || state === null || state.accountMode === "invalid"}
                  onClick={() => { void setAccountMode(mode); }}
                  className={cn(
                    "ui-v2 cursor-pointer rounded-control border border-solid p-3 text-left transition-colors",
                    selected
                      ? "border-line-strong bg-raised ring-1 ring-highlight"
                      : "border-line bg-inset hover:border-line-strong",
                  )}
                >
                  <div className="text-sm font-semibold text-fg">
                    {uxT(locale, mode === "pool" ? "codexRoute.modePool" : "codexRoute.modeDirect")}
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    {uxT(locale, mode === "pool" ? "codexRoute.modePoolHint" : "codexRoute.modeDirectHint")}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-card border border-solid border-line bg-surface p-4 flex flex-col gap-3">
        <h4 className="m-0 text-sm font-semibold text-fg">{uxT(locale, "codexRoute.switchesTitle")}</h4>

        <div className="flex items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">{uxT(locale, "codexRoute.autoStart")}</div>
            <div className="text-xs text-fg-muted">{uxT(locale, "codexRoute.autoStartHint")}</div>
          </div>
          <Switch
            on={state?.codexAutoStart ?? true}
            label={uxT(locale, "codexRoute.autoStart")}
            disabled={busyKey !== null || state === null}
            onClick={() => { void updateBooleanSetting("codexAutoStart", !(state?.codexAutoStart ?? true)); }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-solid border-line pt-3">
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

        <div className="flex items-center justify-between gap-3 border-t border-solid border-line pt-3">
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
