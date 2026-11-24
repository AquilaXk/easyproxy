import { useCallback, useEffect, useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { useI18n } from "../../i18n/shared";
import { Notice, Select } from "../../ui";
import "../../styles/ecosystem-sync.css";

type CliId = "claude" | "codex" | "gemini" | "opencode";
type SyncKind = "mcp" | "skills";

const ALL_CLIS: readonly CliId[] = ["claude", "codex", "gemini", "opencode"];

const CLI_LABELS: Record<CliId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

interface RedactedMcpItem {
  name: string;
  transport: string;
  envKeys: string[];
  headerKeys: string[];
  digest: string;
}

interface RedactedSkillItem {
  slug: string;
  bytes: number;
  digest: string;
}

interface CliStatusDto {
  cli: CliId;
  installed: boolean;
  mcpCount: number;
  skillCount: number;
  mcp: RedactedMcpItem[];
  skills: RedactedSkillItem[];
  unsupportedMcp: Array<{ name: string; reason: string }>;
  warnings: string[];
}

interface BatchSummaryDto {
  batchId: string;
  createdAt: number;
  source: CliId;
  targets: CliId[];
  fileCount: number;
}

interface EcosystemStatusResponseDto {
  clis: Record<CliId, CliStatusDto>;
  batches: BatchSummaryDto[];
}

interface TargetPlanDto {
  target: CliId;
  mcp: Array<{ name: string; action: string }>;
  skills: Array<{ slug: string; action: string }>;
}

interface PreviewResponseDto {
  source: CliId;
  targets: CliId[];
  sourceMcpCount: number;
  sourceSkillCount: number;
  plans: Partial<Record<CliId, TargetPlanDto>>;
}

export default function EcosystemSyncPage({ apiBase, active }: { apiBase: string; active: boolean }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<EcosystemStatusResponseDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [source, setSource] = useState<CliId>("claude");
  const [targets, setTargets] = useState<CliId[]>(["codex", "gemini", "opencode"]);
  const [kinds, setKinds] = useState<SyncKind[]>(["mcp", "skills"]);
  const [overwrite, setOverwrite] = useState(false);
  const [forceRestore, setForceRestore] = useState(false);
  const [preview, setPreview] = useState<PreviewResponseDto | null>(null);

  const [reloadSeq, setReloadSeq] = useState(0);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${apiBase}/api/ecosystem/sync`, { signal });
      const data = await readJsonOrThrow<EcosystemStatusResponseDto>(res, t("ecoSync.loadError"));
      if (data && !signal?.aborted) {
        setStatus(data);
        setError(null);
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      setError(err instanceof Error && err.message ? err.message : t("ecoSync.loadError"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError(null);
      return loadStatus(controller.signal);
    });
    return () => controller.abort();
  }, [active, reloadSeq, loadStatus]);

  const onChangeSource = (next: CliId) => {
    setSource(next);
    setTargets(prev => prev.filter(id => id !== next));
    setPreview(null);
  };

  const toggleTarget = (id: CliId) => {
    setTargets(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    setPreview(null);
  };

  const toggleKind = (kind: SyncKind) => {
    setKinds(prev => {
      const next = prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind];
      return next.length > 0 ? next : prev;
    });
    setPreview(null);
  };

  const runPreview = async () => {
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/ecosystem/sync/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, targets, kinds, overwrite }),
      });
      const data = await readJsonOrThrow<PreviewResponseDto>(res);
      if (data) setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/ecosystem/sync/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, targets, kinds, overwrite }),
      });
      const data = await readJsonOrThrow<{
        batchId: string;
        appliedMcpCount: number;
        appliedSkillCount: number;
      }>(res);
      if (data) {
        setNotice(t("ecoSync.appliedSuccess", {
          mcp: data.appliedMcpCount,
          skills: data.appliedSkillCount,
          batchId: data.batchId,
        }));
        setPreview(null);
        setReloadSeq(n => n + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async (batchId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/ecosystem/sync/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId, force: forceRestore }),
      });
      const data = await readJsonOrThrow<{ restoredBatchId: string }>(res);
      if (data) {
        setNotice(t("ecoSync.restoredSuccess", { batchId: data.restoredBatchId }));
        setReloadSeq(n => n + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="eco-sync-page" aria-labelledby="eco-sync-title">
      <div>
        <h3 id="eco-sync-title" className="m-0 text-base font-semibold">{t("ecoSync.title")}</h3>
        <p className="muted text-sm m-0 mt-1">{t("ecoSync.subtitle")}</p>
        <p className="muted text-xs m-0 mt-1">{t("ecoSync.secretsRedactedNote")}</p>
      </div>

      {error && <Notice tone="err">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}

      {status && (
        <div className="eco-sync-grid">
          {ALL_CLIS.map(id => {
            const entry = status.clis[id];
            return (
              <article key={id} className="eco-sync-card">
                <div className="eco-sync-card__head">
                  <h4 className="eco-sync-card__title">{CLI_LABELS[id]}</h4>
                  <span className={`eco-sync-badge${entry.installed ? " eco-sync-badge--ok" : ""}`}>
                    {entry.installed ? t("ecoSync.installed") : t("ecoSync.absent")}
                  </span>
                </div>
                <div className="muted text-xs">
                  {t("ecoSync.mcpCount", { count: entry.mcpCount })} · {t("ecoSync.skillCount", { count: entry.skillCount })}
                </div>
                {entry.unsupportedMcp.length > 0 && (
                  <div className="muted text-xs">
                    {t("ecoSync.unsupportedWarning", { count: entry.unsupportedMcp.length })}
                  </div>
                )}
                {(entry.mcp.length > 0 || entry.skills.length > 0) && (
                  <ul className="eco-sync-list">
                    {entry.mcp.slice(0, 4).map(server => (
                      <li key={`mcp-${server.name}`}>
                        <code>{server.name}</code> ({server.transport})
                      </li>
                    ))}
                    {entry.skills.slice(0, 4).map(skill => (
                      <li key={`skill-${skill.slug}`}>
                        <code>/{skill.slug}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="eco-sync-controls">
        <div className="eco-sync-row">
          <label className="text-sm font-medium" htmlFor="eco-sync-source">{t("ecoSync.source")}</label>
          <Select
            id="eco-sync-source"
            value={source}
            disabled={busy}
            label={t("ecoSync.source")}
            options={ALL_CLIS.map(id => ({ value: id, label: CLI_LABELS[id] }))}
            onChange={next => onChangeSource(next as CliId)}
          />
        </div>

        <div className="eco-sync-row">
          <span className="text-sm font-medium">{t("ecoSync.targets")}</span>
          {ALL_CLIS.filter(id => id !== source).map(id => (
            <label key={id} className="eco-sync-check">
              <input
                type="checkbox"
                checked={targets.includes(id)}
                disabled={busy}
                onChange={() => toggleTarget(id)}
              />
              <span>{CLI_LABELS[id]}</span>
            </label>
          ))}
        </div>

        <div className="eco-sync-row">
          <span className="text-sm font-medium">{t("ecoSync.kinds")}</span>
          <label className="eco-sync-check">
            <input
              type="checkbox"
              checked={kinds.includes("mcp")}
              disabled={busy}
              onChange={() => toggleKind("mcp")}
            />
            <span>{t("ecoSync.kindMcp")}</span>
          </label>
          <label className="eco-sync-check">
            <input
              type="checkbox"
              checked={kinds.includes("skills")}
              disabled={busy}
              onChange={() => toggleKind("skills")}
            />
            <span>{t("ecoSync.kindSkills")}</span>
          </label>
          <label className="eco-sync-check">
            <input
              type="checkbox"
              checked={overwrite}
              disabled={busy}
              onChange={e => { setOverwrite(e.target.checked); setPreview(null); }}
            />
            <span>{t("ecoSync.overwrite")}</span>
          </label>
        </div>

        <div className="eco-sync-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy || loading || targets.length === 0}
            onClick={() => void runPreview()}
          >
            {t("ecoSync.preview")}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || loading || targets.length === 0}
            onClick={() => void runApply()}
          >
            {busy ? t("ecoSync.applying") : t("ecoSync.apply")}
          </button>
        </div>

        {preview && (
          <div className="eco-sync-grid">
            {preview.targets.map(id => {
              const plan = preview.plans[id];
              if (!plan) return null;
              return (
                <div key={id} className="eco-sync-card">
                  <strong className="text-sm">{CLI_LABELS[id]}</strong>
                  <ul className="eco-sync-list">
                    {plan.mcp.slice(0, 6).map(item => (
                      <li key={`p-mcp-${item.name}`}>
                        <code>{item.name}</code> ({item.action})
                      </li>
                    ))}
                    {plan.skills.slice(0, 6).map(item => (
                      <li key={`p-skill-${item.slug}`}>
                        <code>/{item.slug}</code> ({item.action})
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="eco-sync-controls">
        <div className="eco-sync-card__head">
          <h4 className="m-0 text-sm font-semibold">{t("ecoSync.batchesTitle")}</h4>
          <label className="eco-sync-check text-xs">
            <input
              type="checkbox"
              checked={forceRestore}
              disabled={busy}
              onChange={e => setForceRestore(e.target.checked)}
            />
            <span>{t("ecoSync.forceRestore")}</span>
          </label>
        </div>
        {!status || status.batches.length === 0 ? (
          <p className="muted text-xs m-0">{t("ecoSync.noBatches")}</p>
        ) : (
          <div className="eco-sync-batches">
            {status.batches.map(batch => (
              <div key={batch.batchId} className="eco-sync-batch-row">
                <div className="text-xs">
                  <code>{batch.batchId}</code> · {CLI_LABELS[batch.source]} → {batch.targets.map(targetId => CLI_LABELS[targetId] ?? targetId).join(", ")} · {new Date(batch.createdAt).toLocaleString(locale)}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void runRestore(batch.batchId)}
                >
                  {t("ecoSync.restore")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
