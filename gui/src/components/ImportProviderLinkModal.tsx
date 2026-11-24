import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useT } from "../i18n/shared";
import { ModalDialog } from "./ui-v2/modal-dialog";

interface DeepLinkPreviewDto {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel: string | null;
  models: string[];
  hasApiKey: boolean;
  maskedApiKey: string | null;
  requiresPrivateNetworkOptIn: boolean;
  privateNetworkOptInGranted: boolean;
  conflict: boolean;
  canImport: boolean;
  blockedReason: string | null;
  warnings: string[];
}

export default function ImportProviderLinkModal({
  apiBase,
  initialUrl = "",
  onClose,
  onImported,
}: {
  apiBase: string;
  initialUrl?: string;
  onClose: () => void;
  onImported: (name: string) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState(initialUrl);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<DeepLinkPreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const runPreviewWithTarget = useCallback(async (
    targetUrl: string,
    nextAllowPrivate: boolean,
    nextOverwrite: boolean,
    signal?: AbortSignal,
  ) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    if (!signal) {
      previewAbortRef.current?.abort();
    }
    const controller = signal ? null : new AbortController();
    const activeSignal = signal ?? controller!.signal;
    if (controller) previewAbortRef.current = controller;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/import-url/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: trimmed,
          allowPrivateNetwork: nextAllowPrivate,
          overwrite: nextOverwrite,
        }),
        signal: activeSignal,
      });
      const data = await readJsonOrThrow<DeepLinkPreviewDto>(res);
      if (data && !activeSignal.aborted) setPreview(data);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError" || activeSignal.aborted) return;
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!activeSignal.aborted) setBusy(false);
    }
  }, [apiBase]);

  const runPreview = (nextAllowPrivate = allowPrivateNetwork, nextOverwrite = overwrite) =>
    runPreviewWithTarget(url, nextAllowPrivate, nextOverwrite);

  useEffect(() => {
    const trimmed = initialUrl.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    previewAbortRef.current = controller;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return runPreviewWithTarget(trimmed, false, false, controller.signal);
    });
    return () => controller.abort();
  }, [initialUrl, runPreviewWithTarget]);

  const runImport = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/import-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          allowPrivateNetwork,
          overwrite,
        }),
      });
      const data = await readJsonOrThrow<{ name: string }>(res);
      if (data) onImported(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog onClose={onClose} dismissDisabled={busy} aria-labelledby="import-link-modal-title">
      <div className="p-4 flex flex-col gap-3 min-w-[340px] max-w-[520px]">
        <h2 id="import-link-modal-title" className="m-0 text-base font-semibold">
          {t("deepLinkImport.title")}
        </h2>
        <p className="m-0 text-xs text-fg-muted">{t("deepLinkImport.subtitle")}</p>

        <div className="flex flex-col gap-1">
          <label htmlFor="deep-link-url-input" className="text-xs font-medium">
            {t("deepLinkImport.urlLabel")}
          </label>
          <input
            id="deep-link-url-input"
            type="text"
            className="input"
            value={url}
            disabled={busy}
            placeholder={t("deepLinkImport.urlPlaceholder")}
            onChange={e => { setUrl(e.target.value); setPreview(null); setError(null); }}
          />
        </div>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={allowPrivateNetwork}
            disabled={busy}
            onChange={e => {
              const checked = e.target.checked;
              setAllowPrivateNetwork(checked);
              if (preview) void runPreview(checked, overwrite);
            }}
          />
          <span>{t("deepLinkImport.allowPrivate")}</span>
        </label>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={overwrite}
            disabled={busy}
            onChange={e => {
              const checked = e.target.checked;
              setOverwrite(checked);
              if (preview) void runPreview(allowPrivateNetwork, checked);
            }}
          />
          <span>{t("deepLinkImport.overwrite")}</span>
        </label>

        {error && <div className="alert alert-err text-xs" role="alert">{error}</div>}

        {preview && (
          <div className="border rounded-lg p-3 text-xs flex flex-col gap-1">
            <div><strong>{preview.name}</strong> · <code>{preview.adapter}</code></div>
            <div className="text-fg-muted break-all"><code>{preview.baseUrl}</code></div>
            <div>
              {preview.hasApiKey
                ? `${t("deepLinkImport.maskedKey")}: ${preview.maskedApiKey ?? "••••••••"}`
                : t("deepLinkImport.noneKey")}
            </div>
            {preview.requiresPrivateNetworkOptIn && !preview.privateNetworkOptInGranted && (
              <div className="alert alert-warn text-xs mt-1">{t("deepLinkImport.privateWarning")}</div>
            )}
            {preview.blockedReason && (
              <div className="text-err text-xs mt-1">{preview.blockedReason}</div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy || !url.trim()}
            onClick={() => void runPreview()}
          >
            {t("deepLinkImport.preview")}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !url.trim() || (preview !== null && !preview.canImport)}
            onClick={() => void runImport()}
          >
            {busy ? t("deepLinkImport.importing") : t("deepLinkImport.import")}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
