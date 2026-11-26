import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { IconX } from "../icons";
import { ModalDialog } from "./ui-v2/modal-dialog";

export interface CcSwitchCandidate {
  name: string;
  sourceId: string;
  appType: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  allowPrivateNetwork?: boolean;
  hasApiKey?: boolean;
  storedInKeychain?: boolean;
}

interface PreviewResponse {
  available?: boolean;
  keychainAvailable?: boolean;
  defaultSources?: Array<{ path: string; kind: "sqlite" | "json" }>;
  journalActive?: boolean;
  discovered: number;
  eligible: number;
  conflicts: number;
  conflictNames: string[];
  invalid: number;
  invalidReasons: Record<string, number>;
  importedWithApiKeys?: number;
  storedInKeychain?: number;
  providers: CcSwitchCandidate[];
  error?: string;
}

interface Props {
  apiBase: string;
  onClose: () => void;
  onChanged: (firstImportedName?: string) => void;
}

async function fetchCcSwitchPreview(
  apiBase: string,
  sourcePath: string,
  allowPrivateNetwork: boolean,
  signal?: AbortSignal,
): Promise<{ ok: boolean; body: PreviewResponse | null }> {
  const res = await fetch(`${apiBase}/api/providers/cc-switch/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(sourcePath ? { sourcePath } : {}),
      allowPrivateNetwork,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => null) as PreviewResponse | null;
    return { ok: false, body: errBody };
  }
  const body = await res.json().catch(() => null) as PreviewResponse | null;
  return { ok: body !== null, body };
}

export function CcSwitchImportModal({ apiBase, onClose, onChanged }: Props) {
  const { t, locale } = useI18n();
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  const [sourcePath, setSourcePath] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [includeApiKeys, setIncludeApiKeys] = useState(true);
  const [storeInKeychain, setStoreInKeychain] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const invalidateScannedPreview = () => {
    setPreview(null);
    setSelectedNames(new Set());
    setConsentChecked(false);
    setError(null);
    setNotice(null);
  };

  const runPreview = async (
    customSource?: string,
    customAllowPrivate?: boolean,
    options?: { preserveNotice?: boolean },
  ) => {
    setLoading(true);
    setError(null);
    if (!options?.preserveNotice) setNotice(null);
    const activeSource = (customSource ?? sourcePath).trim();
    const privateNet = customAllowPrivate ?? allowPrivateNetwork;
    try {
      const { ok, body } = await fetchCcSwitchPreview(apiBase, activeSource, privateNet);
      if (!ok || !body) {
        setPreview(null);
        setSelectedNames(new Set());
        setConsentChecked(false);
        setError(body?.error ?? uxT(localeRef.current, "ccSwitch.previewFailed"));
        return;
      }
      setPreview(body);
      if (!activeSource && body.defaultSources?.[0]?.path) {
        setSourcePath(body.defaultSources[0].path);
      }
      setSelectedNames(new Set(body.providers.map(p => p.name)));
      setConsentChecked(false);
    } catch {
      setPreview(null);
      setSelectedNames(new Set());
      setConsentChecked(false);
      setError(uxT(localeRef.current, "ccSwitch.previewFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const ac = new AbortController();
    fetchCcSwitchPreview(apiBase, "", false, ac.signal)
      .then(({ ok, body }) => {
        if (ac.signal.aborted) return;
        if (!ok || !body) {
          setPreview(null);
          setSelectedNames(new Set());
          setConsentChecked(false);
          setError(body?.error ?? uxT(localeRef.current, "ccSwitch.previewFailed"));
          return;
        }
        setPreview(body);
        if (body.defaultSources?.[0]?.path) {
          setSourcePath(body.defaultSources[0].path);
        }
        setSelectedNames(new Set(body.providers.map(p => p.name)));
        setConsentChecked(false);
      })
      .catch(() => {
        if (!ac.signal.aborted) {
          setPreview(null);
          setSelectedNames(new Set());
          setConsentChecked(false);
          setError(uxT(localeRef.current, "ccSwitch.previewFailed"));
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [apiBase]);

  const toggleProvider = (name: string) => {
    setSelectedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleApply = async () => {
    if (!consentChecked) {
      setError(uxT(locale, "ccSwitch.consentRequired"));
      return;
    }
    if (selectedNames.size === 0) return;
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const activeSource = sourcePath.trim();
      const res = await fetch(`${apiBase}/api/providers/cc-switch/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consent: true,
          ...(activeSource ? { sourcePath: activeSource } : {}),
          selectedProviders: [...selectedNames],
          allowPrivateNetwork,
          includeApiKeys,
          ...(includeApiKeys && preview?.keychainAvailable ? { storeInKeychain } : {}),
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: string } | null;
        setError(errBody?.error ?? uxT(locale, "ccSwitch.applyFailed"));
        return;
      }
      const body = await res.json().catch(() => null) as (PreviewResponse & { imported?: number }) | null;
      if (!body) {
        setError(uxT(locale, "ccSwitch.applyFailed"));
        return;
      }
      const imported = body.imported ?? 0;
      const importedKeys = body.importedWithApiKeys ?? 0;
      const first = body.providers?.[0]?.name;
      setNotice(
        importedKeys > 0
          ? uxT(locale, "ccSwitch.importedWithKeysSuccess", { count: imported, keys: importedKeys })
          : uxT(locale, "ccSwitch.importedSuccess", { count: imported }),
      );
      onChanged(first);
      await runPreview(undefined, undefined, { preserveNotice: true });
    } catch {
      setError(uxT(locale, "ccSwitch.applyFailed"));
    } finally {
      setApplying(false);
    }
  };

  const handleRestore = async () => {
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/cc-switch/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: string } | null;
        setError(errBody?.error ?? uxT(locale, "ccSwitch.restoreFailed"));
        return;
      }
      const body = await res.json().catch(() => null) as { restored?: number; error?: string } | null;
      if (!body) {
        setError(uxT(locale, "ccSwitch.restoreFailed"));
        return;
      }
      setNotice(uxT(locale, "ccSwitch.restoredSuccess", { count: body.restored ?? 0 }));
      onChanged();
      await runPreview(undefined, undefined, { preserveNotice: true });
    } catch {
      setError(uxT(locale, "ccSwitch.restoreFailed"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <ModalDialog
      aria-labelledby="cc-switch-modal-title"
      dismissDisabled={applying}
      cardClassName="flex flex-col overflow-hidden overscroll-contain"
      cardStyle={{ maxWidth: 760 }}
      onClose={onClose}
    >
      <div className="modal-head shrink-0 items-start gap-3 mb-3">
        <div className="min-w-0">
          <h3 id="cc-switch-modal-title">{uxT(locale, "ccSwitch.title")}</h3>
          <p className="muted mt-1 mb-0 text-xs">{uxT(locale, "ccSwitch.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn-icon shrink-0"
          aria-label={t("common.close")}
          disabled={applying}
          onClick={onClose}
        >
          <IconX aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain flex flex-col gap-3 px-1 -mx-1 py-0.5 -my-0.5">

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[220px] flex flex-col gap-1">
              <span className="text-xs font-medium text-fg-muted">{uxT(locale, "ccSwitch.sourceLabel")}</span>
              <input
                className="input font-mono text-xs"
                value={sourcePath}
                onChange={e => {
                  setSourcePath(e.target.value);
                  invalidateScannedPreview();
                }}
                onKeyDown={e => {
                  if (e.key === "Enter" && !loading && !applying) {
                    e.preventDefault();
                    void runPreview();
                  }
                }}
                placeholder={uxT(locale, "ccSwitch.sourcePlaceholder")}
                disabled={loading || applying}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={loading || applying}
              onClick={() => { void runPreview(); }}
            >
              {loading ? uxT(locale, "ccSwitch.scanning") : uxT(locale, "ccSwitch.previewBtn")}
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={allowPrivateNetwork}
              disabled={loading || applying}
              onChange={e => {
                setAllowPrivateNetwork(e.target.checked);
                invalidateScannedPreview();
              }}
            />
            <span>{uxT(locale, "ccSwitch.allowPrivateNetwork")}</span>
          </label>

          {error && <div role="alert" className="text-xs text-danger">{error}</div>}
          {notice && <div role="status" className="text-xs text-success">{notice}</div>}

          {preview && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="badge badge-muted">{uxT(locale, "ccSwitch.discoveredCount", { count: preview.discovered })}</span>
              {preview.eligible > 0 ? (
                <span className="badge badge-green">{uxT(locale, "ccSwitch.eligibleCount", { count: preview.eligible })}</span>
              ) : (preview.available !== false || preview.discovered > 0) ? (
                <span className="badge badge-muted">{uxT(locale, "ccSwitch.eligibleCount", { count: preview.eligible })}</span>
              ) : null}
              {preview.conflicts > 0 && (
                <span className="badge badge-amber">{uxT(locale, "ccSwitch.conflictCount", { count: preview.conflicts })}</span>
              )}
              {preview.invalid > 0 && (
                <span className="badge badge-red">{uxT(locale, "ccSwitch.invalidCount", { count: preview.invalid })}</span>
              )}
            </div>
          )}

          {preview && preview.available === false && preview.providers.length === 0 && (
            <p className="m-0 text-xs text-fg-muted">{uxT(locale, "ccSwitch.noSourceFound")}</p>
          )}

          {preview && preview.available !== false && preview.providers.length === 0 && (
            <p className="m-0 text-xs text-fg-muted">{uxT(locale, "ccSwitch.emptyCandidates")}</p>
          )}

          {preview && preview.providers.length > 0 && (
            <div className="max-h-[220px] shrink-0 overflow-auto overscroll-contain rounded-card border border-solid border-line">
              <table className="tbl w-full text-xs border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="w-8 sticky top-0 z-[1] bg-inset px-2.5 py-2" />
                    <th className="sticky top-0 z-[1] bg-inset px-2.5 py-2 whitespace-nowrap">{uxT(locale, "ccSwitch.columnName")}</th>
                    <th className="sticky top-0 z-[1] bg-inset px-2.5 py-2 whitespace-nowrap">{uxT(locale, "ccSwitch.columnAdapter")}</th>
                    <th className="sticky top-0 z-[1] bg-inset px-2.5 py-2 whitespace-nowrap">{uxT(locale, "ccSwitch.columnBaseUrl")}</th>
                    <th className="sticky top-0 z-[1] bg-inset px-2.5 py-2 whitespace-nowrap">{uxT(locale, "ccSwitch.columnModel")}</th>
                    <th className="sticky top-0 z-[1] bg-inset px-2.5 py-2 whitespace-nowrap">{uxT(locale, "ccSwitch.columnApiKey")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.providers.map(candidate => (
                    <tr key={candidate.name}>
                      <td className="px-2.5 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={selectedNames.has(candidate.name)}
                          onChange={() => toggleProvider(candidate.name)}
                          disabled={applying}
                          aria-label={candidate.name}
                        />
                      </td>
                      <td className="px-2.5 py-2 align-top break-words [overflow-wrap:anywhere]">
                        <code>{candidate.name}</code>{" "}
                        <span className="muted whitespace-nowrap">({candidate.appType})</span>
                      </td>
                      <td className="px-2.5 py-2 align-top whitespace-nowrap"><code>{candidate.adapter}</code></td>
                      <td
                        className="px-2.5 py-2 align-top font-mono break-all max-w-[200px] truncate"
                        title={candidate.baseUrl}
                      >
                        {candidate.baseUrl}
                      </td>
                      <td
                        className="px-2.5 py-2 align-top max-w-[160px] truncate"
                        title={candidate.defaultModel ?? undefined}
                      >
                        <code>{candidate.defaultModel ?? "—"}</code>
                      </td>
                      <td className="px-2.5 py-2 align-top whitespace-nowrap">
                        <span className={candidate.hasApiKey ? "badge badge-green whitespace-nowrap" : "badge badge-muted whitespace-nowrap"}>
                          {uxT(locale, candidate.hasApiKey ? "ccSwitch.keyDetected" : "ccSwitch.keyless")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview && preview.providers.length > 0 && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={includeApiKeys}
                  disabled={applying}
                  onChange={e => {
                    const next = e.target.checked;
                    setIncludeApiKeys(next);
                    if (!next) setStoreInKeychain(false);
                  }}
                />
                <span>{uxT(locale, "ccSwitch.includeApiKeys")}</span>
              </label>

              {includeApiKeys && preview.keychainAvailable && (
                <label className="flex items-center gap-2 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    checked={storeInKeychain}
                    disabled={applying}
                    onChange={e => setStoreInKeychain(e.target.checked)}
                  />
                  <span>{uxT(locale, "ccSwitch.storeInKeychain")}</span>
                </label>
              )}
            </div>
          )}
      </div>

      {preview && preview.providers.length > 0 && (
        <div className="shrink-0 pt-3 mt-1">
          <label className="flex items-start gap-2 rounded-card border border-solid border-line bg-inset p-2.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={consentChecked}
              disabled={applying}
              onChange={e => {
                setConsentChecked(e.target.checked);
                if (e.target.checked) setError(null);
              }}
            />
            <span>{uxT(locale, "ccSwitch.consentCheckbox")}</span>
          </label>
        </div>
      )}

      <div
        className="modal-actions shrink-0 flex-wrap items-center justify-between pt-3 mt-3"
        style={{ borderTop: "1px solid var(--epx-line)" }}
      >
        {preview?.journalActive && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={applying || loading}
            onClick={() => { void handleRestore(); }}
          >
            {uxT(locale, "ccSwitch.restoreBtn")}
          </button>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={applying}>{t("common.close")}</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={applying || loading || selectedNames.size === 0 || !consentChecked}
            onClick={() => { void handleApply(); }}
          >
            {uxT(locale, "ccSwitch.applyBtn", { count: selectedNames.size })}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
