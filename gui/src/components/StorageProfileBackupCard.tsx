import { useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useI18n, type TFn } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { Notice } from "../ui";
import "../styles/profile-backup.css";

interface BackupInspectDto {
  schema: string;
  mode: "encrypted" | "redacted";
  createdAt: string;
  valid: boolean;
  summary: {
    providerCount: number;
    oauthAccountCount: number;
    codexAccountCount: number;
    hasLocalCredentials: boolean;
    integrationRecordCount: number;
    includedFiles: string[];
  };
  configValidation: { ok: boolean; error?: string };
}

export default function StorageProfileBackupCard({
  apiBase,
  t,
  onRestored,
}: {
  apiBase: string;
  t: TFn;
  onRestored: () => void;
}) {
  const { locale } = useI18n();
  const [exportMode, setExportMode] = useState<"encrypted" | "redacted">("encrypted");
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportBusy, setExportBusy] = useState(false);

  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [selectedBundle, setSelectedBundle] = useState<unknown>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [inspected, setInspected] = useState<BackupInspectDto | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const exportInvalidPass = exportMode === "encrypted" && exportPassphrase.length < 8;

  const triggerDownload = (bundle: unknown, mode: "encrypted" | "redacted") => {
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = [`easyproxy-profile-${mode}-${stamp}`, "epxbackup", "json"].join(".");
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    if (exportInvalidPass) return;
    setExportBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/profile/backup/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: exportMode,
          ...(exportMode === "encrypted" ? { passphrase: exportPassphrase } : {}),
        }),
      });
      const bundle = await readJsonOrThrow<unknown>(res);
      if (bundle) {
        triggerDownload(bundle, exportMode);
        setNotice(t("storageBackup.exportSuccess"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleFileChange = async (file: File | null) => {
    setInspected(null);
    setError(null);
    setNotice(null);
    if (!file) {
      setSelectedBundle(null);
      setSelectedFileName(null);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setSelectedBundle(null);
      setSelectedFileName(file.name);
      setError(t("storageBackup.fileTooLarge"));
      return;
    }
    try {
      const text = await file.text();
      setSelectedBundle(JSON.parse(text));
      setSelectedFileName(file.name);
    } catch {
      setSelectedBundle(null);
      setSelectedFileName(file.name);
      setError(t("storageBackup.invalidJson"));
    }
  };

  const handleInspect = async () => {
    if (!selectedBundle) return;
    setRestoreBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/profile/backup/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle: selectedBundle,
          ...(restorePassphrase ? { passphrase: restorePassphrase } : {}),
        }),
      });
      const data = await readJsonOrThrow<BackupInspectDto>(res);
      if (data) setInspected(data);
    } catch (err) {
      setInspected(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedBundle) return;
    setRestoreBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/profile/backup/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle: selectedBundle,
          ...(restorePassphrase ? { passphrase: restorePassphrase } : {}),
        }),
      });
      const data = await readJsonOrThrow<{ restoredFiles: string[] }>(res);
      if (data) {
        setNotice(t("storageBackup.restoreSuccess", { files: data.restoredFiles.length }));
        onRestored();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <section className="profile-backup-card" aria-labelledby="profile-backup-title">
      <div>
        <h2 id="profile-backup-title" className="m-0 text-base font-semibold">{t("storageBackup.title")}</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">{t("storageBackup.subtitle")}</p>
      </div>

      {error && <Notice tone="err">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}

      <div className="profile-backup-grid">
        <div className="profile-backup-panel">
          <h3 className="m-0 text-sm font-semibold">{t("storageBackup.exportTitle")}</h3>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="backup-export-mode"
              checked={exportMode === "encrypted"}
              disabled={exportBusy}
              onChange={() => setExportMode("encrypted")}
            />
            <span>{t("storageBackup.modeEncrypted")}</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="backup-export-mode"
              checked={exportMode === "redacted"}
              disabled={exportBusy}
              onChange={() => setExportMode("redacted")}
            />
            <span>{t("storageBackup.modeRedacted")}</span>
          </label>

          {exportMode === "encrypted" && (
            <div className="flex flex-col gap-1">
              <label htmlFor="backup-export-passphrase" className="text-xs font-medium">
                {t("storageBackup.passphraseLabel")}
              </label>
              <input
                id="backup-export-passphrase"
                type="password"
                className="input"
                value={exportPassphrase}
                disabled={exportBusy}
                placeholder={t("storageBackup.passphrasePlaceholder")}
                onChange={e => setExportPassphrase(e.target.value)}
              />
              {exportInvalidPass && (
                <span className="text-xs text-fg-muted">{t("storageBackup.passphraseMinHint")}</span>
              )}
            </div>
          )}

          <div className="profile-backup-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={exportBusy || exportInvalidPass}
              onClick={() => void handleExport()}
            >
              {t("storageBackup.exportBtn")}
            </button>
          </div>
        </div>

        <div className="profile-backup-panel">
          <h3 className="m-0 text-sm font-semibold">{t("storageBackup.restoreTitle")}</h3>
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            accept=".json,.epxbackup.json,application/json"
            aria-label={t("storageBackup.selectFile")}
            disabled={restoreBusy}
            onChange={e => { void handleFileChange(e.target.files?.[0] ?? null); }}
          />
          <div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={restoreBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {t("storageBackup.selectFile")}
            </button>
          </div>
          {selectedFileName && <span className="text-xs text-fg-muted"><code>{selectedFileName}</code></span>}

          <div className="flex flex-col gap-1">
            <label htmlFor="backup-restore-passphrase" className="text-xs font-medium">
              {t("storageBackup.passphraseLabel")}
            </label>
            <input
              id="backup-restore-passphrase"
              type="password"
              className="input"
              value={restorePassphrase}
              disabled={restoreBusy}
              placeholder={t("storageBackup.passphrasePlaceholder")}
              onChange={e => setRestorePassphrase(e.target.value)}
            />
          </div>

          <p className="m-0 text-xs text-fg-muted">{t("storageBackup.restoreConfirmNote")}</p>

          {inspected && (
            <div className="border border-solid border-line rounded-card p-2.5 text-xs flex flex-col gap-1">
              <div>
                <strong>
                  {uxT(locale, inspected.mode === "encrypted" ? "storageBackup.modeEncrypted" : "storageBackup.modeRedacted")}
                </strong>
                {" · "}
                {inspected.configValidation.ok ? uxT(locale, "storageBackup.valid") : inspected.configValidation.error}
              </div>
              <div className="text-fg-muted">
                {t("storageBackup.inspectSummary", {
                  providers: inspected.summary.providerCount,
                  oauth: inspected.summary.oauthAccountCount,
                  codex: inspected.summary.codexAccountCount,
                })}
              </div>
              <div className="text-fg-muted">
                <code>{inspected.summary.includedFiles.join(", ")}</code>
              </div>
            </div>
          )}

          <div className="profile-backup-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={restoreBusy || !selectedBundle}
              onClick={() => void handleInspect()}
            >
              {t("storageBackup.inspectBtn")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={restoreBusy || !selectedBundle}
              onClick={() => void handleRestore()}
            >
              {restoreBusy ? t("storageBackup.restoring") : t("storageBackup.restoreBtn")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
