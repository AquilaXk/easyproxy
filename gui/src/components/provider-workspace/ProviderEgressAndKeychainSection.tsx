import { useCallback, useEffect, useId, useRef, useState } from "react";
import { readJsonIfOk } from "../../fetch-json";
import { confirmAction } from "../../action-dialogs";
import { useI18n } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";
import { IconEye, IconEyeOff } from "../../icons";
import { Select } from "../../ui";
import type { WorkspaceItem } from "./types";

type TlsProfileStatus = "disabled" | "pending" | "active" | "failed";
type KeychainStoreKind = "plaintext" | "keychain" | "mixed" | "env" | "absent" | "gcp-sa";

interface LiveProviderEgressMeta {
  hasProxy?: boolean;
  proxyLabel?: string;
  noProxy?: string | string[];
  tlsProfile?: { profile: "antigravity-browser"; status: TlsProfileStatus };
}

interface KeychainStateResponse {
  name: string;
  store: KeychainStoreKind;
  keychainAvailable: boolean;
  keychainUnavailableReason?: string | null;
}

interface Props {
  item: WorkspaceItem;
  apiBase?: string;
  isCanonicalOpenAi: boolean;
  onRefreshConfig?: () => void;
}

function formatNoProxyValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

function isTlsProfileEnabled(tlsProfile?: LiveProviderEgressMeta["tlsProfile"]): boolean {
  return tlsProfile?.profile === "antigravity-browser" && tlsProfile.status !== "disabled";
}

interface LiveDetailsSnapshot {
  providerMeta?: LiveProviderEgressMeta;
  keychain?: KeychainStateResponse;
  historySlim?: "off" | "codex";
}

async function fetchLiveDetailsSnapshot(
  apiBase: string,
  providerName: string,
  supportsKeychain: boolean,
  isCanonicalOpenAi: boolean,
  signal?: AbortSignal,
): Promise<LiveDetailsSnapshot> {
  const snapshot: LiveDetailsSnapshot = {};
  try {
    const providersRes = await fetch(`${apiBase}/api/providers`, signal ? { signal } : undefined);
    const list = await readJsonIfOk<Array<LiveProviderEgressMeta & { name: string }>>(providersRes);
    const match = Array.isArray(list) ? list.find(row => row.name === providerName) : undefined;
    if (match) snapshot.providerMeta = match;
  } catch {
    // Non-fatal: keep initial projection.
  }

  if (supportsKeychain) {
    try {
      const kcRes = await fetch(
        `${apiBase}/api/providers/keychain?name=${encodeURIComponent(providerName)}`,
        signal ? { signal } : undefined,
      );
      const kc = await readJsonIfOk<KeychainStateResponse>(kcRes);
      if (kc) snapshot.keychain = kc;
    } catch {
      // Non-fatal.
    }
  }

  if (isCanonicalOpenAi) {
    try {
      const settingsRes = await fetch(`${apiBase}/api/settings`, signal ? { signal } : undefined);
      const settings = await readJsonIfOk<{ upstreamHistorySlim?: "off" | "codex" }>(settingsRes);
      if (settings?.upstreamHistorySlim === "codex" || settings?.upstreamHistorySlim === "off") {
        snapshot.historySlim = settings.upstreamHistorySlim;
      }
    } catch {
      // Non-fatal.
    }
  }
  return snapshot;
}

export function ProviderEgressAndKeychainSection({
  item,
  apiBase,
  isCanonicalOpenAi,
  onRefreshConfig,
}: Props) {
  const { locale } = useI18n();
  const proxyInputId = useId();
  const [proxyInput, setProxyInput] = useState("");
  const [showProxy, setShowProxy] = useState(false);
  const [noProxyInput, setNoProxyInput] = useState(() => formatNoProxyValue(item.noProxy));
  const [hasProxy, setHasProxy] = useState(item.hasProxy === true);
  const [proxyLabel, setProxyLabel] = useState(item.proxyLabel ?? "");
  const [tlsEnabled, setTlsEnabled] = useState(() => isTlsProfileEnabled(item.tlsProfile));
  const [tlsStatus, setTlsStatus] = useState<TlsProfileStatus>(item.tlsProfile?.status ?? "disabled");
  const [egressSaving, setEgressSaving] = useState(false);
  const [egressMsg, setEgressMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [keychainState, setKeychainState] = useState<KeychainStateResponse | null>(null);
  const [keychainBusy, setKeychainBusy] = useState(false);
  const [keychainMsg, setKeychainMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [historySlim, setHistorySlim] = useState<"off" | "codex">("off");
  const [historySlimSaving, setHistorySlimSaving] = useState(false);
  const [historySlimMsg, setHistorySlimMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const supportsKeychain = item.authMode !== "oauth" && item.authMode !== "forward" && item.authMode !== "local";
  const supportsTlsProfile =
    (item.name === "google-antigravity"
      && item.adapter === "google"
      && item.authMode === "oauth"
      && item.googleMode === "cloud-code-assist")
    || item.tlsProfile !== undefined;

  const noProxyDirtyRef = useRef(false);
  const tlsDirtyRef = useRef(false);

  const applySnapshot = useCallback((snapshot: LiveDetailsSnapshot) => {
    if (snapshot.providerMeta) {
      setHasProxy(snapshot.providerMeta.hasProxy === true);
      setProxyLabel(snapshot.providerMeta.proxyLabel ?? "");
      if (!noProxyDirtyRef.current) {
        setNoProxyInput(formatNoProxyValue(snapshot.providerMeta.noProxy));
      }
      if (!tlsDirtyRef.current) {
        setTlsEnabled(isTlsProfileEnabled(snapshot.providerMeta.tlsProfile));
        setTlsStatus(snapshot.providerMeta.tlsProfile?.status ?? "disabled");
      }
    }
    if (snapshot.keychain) setKeychainState(snapshot.keychain);
    if (snapshot.historySlim) setHistorySlim(snapshot.historySlim);
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const prevProviderKeyRef = useRef(`${apiBase ?? ""}::${item.name}`);
  const latestItemRef = useRef(item);
  useEffect(() => {
    latestItemRef.current = item;
  });

  const loadLiveDetails = useCallback(async (expectedProviderKey: string, signal?: AbortSignal) => {
    if (apiBase === undefined) return;
    const snapshot = await fetchLiveDetailsSnapshot(
      apiBase,
      item.name,
      supportsKeychain,
      isCanonicalOpenAi,
      signal,
    );
    if (!mountedRef.current || signal?.aborted || prevProviderKeyRef.current !== expectedProviderKey) return;
    applySnapshot(snapshot);
  }, [apiBase, applySnapshot, isCanonicalOpenAi, item.name, supportsKeychain]);

  useEffect(() => {
    const providerKey = `${apiBase ?? ""}::${item.name}`;
    if (prevProviderKeyRef.current !== providerKey) {
      prevProviderKeyRef.current = providerKey;
      noProxyDirtyRef.current = false;
      tlsDirtyRef.current = false;
      const current = latestItemRef.current;
      setProxyInput("");
      setShowProxy(false);
      setNoProxyInput(formatNoProxyValue(current.noProxy));
      setHasProxy(current.hasProxy === true);
      setProxyLabel(current.proxyLabel ?? "");
      setTlsEnabled(isTlsProfileEnabled(current.tlsProfile));
      setTlsStatus(current.tlsProfile?.status ?? "disabled");
      setEgressMsg(null);
      setKeychainState(null);
      setKeychainMsg(null);
      setHistorySlim("off");
      setHistorySlimMsg(null);
    }
    if (apiBase === undefined) return;
    const ac = new AbortController();
    fetchLiveDetailsSnapshot(apiBase, item.name, supportsKeychain, isCanonicalOpenAi, ac.signal)
      .then(snapshot => {
        if (mountedRef.current && !ac.signal.aborted && prevProviderKeyRef.current === providerKey) {
          applySnapshot(snapshot);
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [apiBase, applySnapshot, isCanonicalOpenAi, item.name, supportsKeychain]);

  const saveEgress = async (override?: { proxy?: string | null; tlsEnabled?: boolean }) => {
    if (apiBase === undefined || egressSaving) return;
    const startProviderKey = `${apiBase}::${item.name}`;
    setEgressSaving(true);
    setEgressMsg(null);
    const isTlsToggle = override?.tlsEnabled !== undefined;
    const isClearProxy = override?.proxy === null;
    const rollbackTlsIfOverridden = () => {
      if (override?.tlsEnabled !== undefined) {
        setTlsEnabled(!override.tlsEnabled);
        tlsDirtyRef.current = false;
      }
    };
    const body: Record<string, unknown> = isTlsToggle
      ? { tlsProfile: override.tlsEnabled ? "antigravity-browser" : null }
      : isClearProxy
        ? { proxy: null }
        : {
            noProxy: noProxyInput.trim() || null,
            ...(supportsTlsProfile ? { tlsProfile: tlsEnabled ? "antigravity-browser" : null } : {}),
            ...(proxyInput.trim() ? { proxy: proxyInput.trim() } : {}),
          };
    try {
      const res = await fetch(`${apiBase}/api/providers/egress?name=${encodeURIComponent(item.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!mountedRef.current || prevProviderKeyRef.current !== startProviderKey) return;
      if (!res.ok) {
        rollbackTlsIfOverridden();
        const errJson = await res.json().catch(() => null) as { error?: string } | null;
        if (!mountedRef.current || prevProviderKeyRef.current !== startProviderKey) return;
        setEgressMsg({ ok: false, text: errJson?.error ?? uxT(locale, "providerEgress.saveFailed") });
        return;
      }
      const payload = await res.json().catch(() => null) as LiveProviderEgressMeta | null;
      if (!mountedRef.current || prevProviderKeyRef.current !== startProviderKey) return;
      if (!payload || typeof payload !== "object") {
        rollbackTlsIfOverridden();
        setEgressMsg({ ok: false, text: uxT(locale, "providerEgress.saveFailed") });
        return;
      }
      if (isTlsToggle) {
        setTlsEnabled(isTlsProfileEnabled(payload.tlsProfile));
        setTlsStatus(payload.tlsProfile?.status ?? "disabled");
        tlsDirtyRef.current = false;
      } else if (isClearProxy) {
        setHasProxy(payload.hasProxy === true);
        setProxyLabel(payload.proxyLabel ?? "");
        setProxyInput("");
        if (!tlsDirtyRef.current) {
          setTlsEnabled(isTlsProfileEnabled(payload.tlsProfile));
          setTlsStatus(payload.tlsProfile?.status ?? "disabled");
        }
      } else {
        setHasProxy(payload.hasProxy === true);
        setProxyLabel(payload.proxyLabel ?? "");
        setNoProxyInput(formatNoProxyValue(payload.noProxy));
        noProxyDirtyRef.current = false;
        setTlsEnabled(isTlsProfileEnabled(payload.tlsProfile));
        setTlsStatus(payload.tlsProfile?.status ?? "disabled");
        tlsDirtyRef.current = false;
        if (proxyInput.trim()) setProxyInput("");
      }
      setEgressMsg({
        ok: true,
        text: isClearProxy
          ? uxT(locale, "providerEgress.proxyCleared")
          : uxT(locale, "providerEgress.saved"),
      });
      onRefreshConfig?.();
    } catch {
      if (!mountedRef.current || prevProviderKeyRef.current !== startProviderKey) return;
      rollbackTlsIfOverridden();
      setEgressMsg({ ok: false, text: uxT(locale, "providerEgress.saveFailed") });
    } finally {
      if (mountedRef.current && prevProviderKeyRef.current === startProviderKey) setEgressSaving(false);
    }
  };

  const handleKeychainAction = async (action: "store" | "restore") => {
    if (apiBase === undefined || keychainBusy) return;
    const startProviderKey = `${apiBase}::${item.name}`;
    const targetName = item.name;
    if (action === "restore") {
      const ok = await confirmAction({
        message: uxT(locale, "providerEgress.keychainRestoreConfirm"),
        tone: "danger",
      });
      if (!ok || prevProviderKeyRef.current !== startProviderKey) return;
    }
    setKeychainBusy(true);
    setKeychainMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/keychain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: targetName, action }),
      });
      if (prevProviderKeyRef.current !== startProviderKey) return;
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        if (prevProviderKeyRef.current !== startProviderKey) return;
        setKeychainMsg({ ok: false, text: data?.error ?? uxT(locale, "providerEgress.saveFailed") });
        return;
      }
      await loadLiveDetails(startProviderKey);
      if (!mountedRef.current || prevProviderKeyRef.current !== startProviderKey) return;
      setKeychainMsg({
        ok: true,
        text: action === "store"
          ? uxT(locale, "providerEgress.keychainStored")
          : uxT(locale, "providerEgress.keychainRestored"),
      });
      onRefreshConfig?.();
    } catch {
      if (prevProviderKeyRef.current !== startProviderKey) return;
      setKeychainMsg({ ok: false, text: uxT(locale, "providerEgress.saveFailed") });
    } finally {
      if (prevProviderKeyRef.current === startProviderKey) setKeychainBusy(false);
    }
  };

  const handleHistorySlimChange = async (value: "off" | "codex") => {
    if (apiBase === undefined || historySlimSaving) return;
    const startProviderKey = `${apiBase}::${item.name}`;
    setHistorySlimSaving(true);
    setHistorySlimMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upstreamHistorySlim: value }),
      });
      const updated = await readJsonIfOk<{ upstreamHistorySlim?: "off" | "codex" }>(res);
      if (prevProviderKeyRef.current !== startProviderKey) return;
      if (!res.ok || !updated) {
        setHistorySlimMsg({ ok: false, text: uxT(locale, "providerEgress.saveFailed") });
        return;
      }
      setHistorySlim(updated.upstreamHistorySlim === "codex" ? "codex" : "off");
      setHistorySlimMsg({ ok: true, text: uxT(locale, "providerEgress.saved") });
      onRefreshConfig?.();
    } catch {
      if (prevProviderKeyRef.current !== startProviderKey) return;
      setHistorySlimMsg({ ok: false, text: uxT(locale, "providerEgress.saveFailed") });
    } finally {
      if (prevProviderKeyRef.current === startProviderKey) setHistorySlimSaving(false);
    }
  };

  if (apiBase === undefined) return null;

  const storeBadgeText = (() => {
    switch (keychainState?.store) {
      case "keychain": return uxT(locale, "providerEgress.keychainStatusKeychain");
      case "plaintext": return uxT(locale, "providerEgress.keychainStatusPlaintext");
      case "mixed": return uxT(locale, "providerEgress.keychainStatusMixed");
      case "env": return uxT(locale, "providerEgress.keychainStatusEnv");
      case "gcp-sa": return uxT(locale, "providerEgress.keychainStatusGcpSa");
      default: return uxT(locale, "providerEgress.keychainStatusAbsent");
    }
  })();

  const tlsStatusText = (() => {
    switch (tlsStatus) {
      case "pending": return uxT(locale, "providerEgress.tlsStatusPending");
      case "active": return uxT(locale, "providerEgress.tlsStatusActive");
      case "failed": return uxT(locale, "providerEgress.tlsStatusFailed");
      default: return uxT(locale, "providerEgress.tlsStatusDisabled");
    }
  })();

  return (
    <section className="pwi-pacing-card" aria-labelledby="pwi-egress-title">
      <div className="pwi-pacing-head">
        <div>
          <h3 id="pwi-egress-title">{uxT(locale, "providerEgress.title")}</h3>
          <p>{uxT(locale, "providerEgress.desc")}</p>
        </div>
        <span className={hasProxy ? "badge badge-primary" : "badge badge-muted"}>
          {hasProxy ? (proxyLabel || uxT(locale, "providerEgress.proxyConfigured")) : uxT(locale, "providerEgress.proxyDirect")}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="pwi-settings-field">
          <label htmlFor={proxyInputId} className="pwi-settings-label">{uxT(locale, "providerEgress.proxyLabel")}</label>
          <div className="relative flex items-center">
            <input
              id={proxyInputId}
              className="input w-full pr-9 font-mono"
              type={showProxy ? "text" : "password"}
              autoComplete="off"
              value={proxyInput}
              onChange={e => setProxyInput(e.target.value)}
              placeholder={hasProxy ? uxT(locale, "providerEgress.proxyReplacePlaceholder") : "http://127.0.0.1:7890"}
              disabled={egressSaving}
            />
            <button
              type="button"
              className="btn-icon absolute right-1"
              aria-label={uxT(locale, showProxy ? "providerEgress.hideProxy" : "providerEgress.showProxy")}
              aria-pressed={showProxy}
              disabled={egressSaving}
              onClick={() => setShowProxy(prev => !prev)}
            >
              {showProxy ? <IconEyeOff size={15} aria-hidden="true" /> : <IconEye size={15} aria-hidden="true" />}
            </button>
          </div>
        </div>
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{uxT(locale, "providerEgress.noProxyLabel")}</span>
          <input
            className="input font-mono"
            value={noProxyInput}
            onChange={e => {
              noProxyDirtyRef.current = true;
              setNoProxyInput(e.target.value);
            }}
            placeholder={uxT(locale, "providerEgress.noProxyPlaceholder")}
            disabled={egressSaving}
          />
        </label>
      </div>

      {supportsTlsProfile && (
        <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={tlsEnabled}
            disabled={egressSaving}
            onChange={e => {
              const checked = e.target.checked;
              tlsDirtyRef.current = true;
              setTlsEnabled(checked);
              void saveEgress({ tlsEnabled: checked });
            }}
          />
          <span>
            <span className="pwi-settings-label">
              {uxT(locale, "providerEgress.tlsAntigravity")}{" "}
              <span className="badge badge-muted">{tlsStatusText}</span>
            </span>
            <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>
              {uxT(locale, "providerEgress.tlsDesc")}
            </span>
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={egressSaving}
          onClick={() => { void saveEgress(); }}
        >
          {uxT(locale, "providerEgress.save")}
        </button>
        {hasProxy && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={egressSaving}
            onClick={() => { void saveEgress({ proxy: null }); }}
          >
            {uxT(locale, "providerEgress.clearProxy")}
          </button>
        )}
        {egressMsg && (
          <span
            role={egressMsg.ok ? "status" : "alert"}
            className={egressMsg.ok ? "pwi-settings-mode-msg pwi-settings-mode-msg--ok" : "pwi-settings-mode-msg pwi-settings-mode-msg--err"}
          >
            {egressMsg.text}
          </span>
        )}
      </div>

      {supportsKeychain && keychainState && (
        <div className="flex flex-col gap-2 pt-2 border-0 border-t border-solid border-line">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="pwi-settings-label">{uxT(locale, "providerEgress.keychainTitle")}</span>
              <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>
                {uxT(locale, "providerEgress.keychainDesc")}
              </span>
            </div>
            <span className={keychainState.store === "keychain" ? "badge badge-green" : "badge badge-muted"}>
              {storeBadgeText}
            </span>
          </div>
          {!keychainState.keychainAvailable && keychainState.keychainUnavailableReason && (
            <p className="m-0 text-xs text-fg-muted">{keychainState.keychainUnavailableReason}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(keychainState.store === "plaintext" || keychainState.store === "mixed") && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={keychainBusy || !keychainState.keychainAvailable}
                onClick={() => { void handleKeychainAction("store"); }}
              >
                {uxT(locale, "providerEgress.keychainStore")}
              </button>
            )}
            {(keychainState.store === "keychain" || keychainState.store === "mixed") && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={keychainBusy || !keychainState.keychainAvailable}
                onClick={() => { void handleKeychainAction("restore"); }}
              >
                {uxT(locale, "providerEgress.keychainRestore")}
              </button>
            )}
            {keychainMsg && (
              <span
                role={keychainMsg.ok ? "status" : "alert"}
                className={keychainMsg.ok ? "pwi-settings-mode-msg pwi-settings-mode-msg--ok" : "pwi-settings-mode-msg pwi-settings-mode-msg--err"}
              >
                {keychainMsg.text}
              </span>
            )}
          </div>
        </div>
      )}

      {isCanonicalOpenAi && (
        <div className="flex flex-col gap-1.5 pt-2 border-0 border-t border-solid border-line">
          <span className="pwi-settings-label">{uxT(locale, "providerEgress.historySlimTitle")}</span>
          <Select
            fullWidth
            label={uxT(locale, "providerEgress.historySlimTitle")}
            value={historySlim}
            disabled={historySlimSaving}
            onChange={value => { void handleHistorySlimChange(value as "off" | "codex"); }}
            options={[
              { value: "off", label: uxT(locale, "providerEgress.historySlimOff") },
              { value: "codex", label: uxT(locale, "providerEgress.historySlimCodex") },
            ]}
          />
          <span className="pwi-settings-hint">{uxT(locale, "providerEgress.historySlimDesc")}</span>
          {historySlimMsg && (
            <span
              role={historySlimMsg.ok ? "status" : "alert"}
              className={historySlimMsg.ok ? "pwi-settings-mode-msg pwi-settings-mode-msg--ok" : "pwi-settings-mode-msg pwi-settings-mode-msg--err"}
            >
              {historySlimMsg.text}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
