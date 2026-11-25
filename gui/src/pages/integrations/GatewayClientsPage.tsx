import { useCallback, useId, useMemo, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { Combobox } from "../../components/ui-v2/combobox";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import {
  loadGatewayClients,
  loadGatewayModelOptions,
  runGatewayClientAction,
  type GatewayClientAction,
  type GatewayClientActionOutcome,
  type GatewayClientId,
  type GatewayClientState,
  type GatewayClientStatus,
  type GatewayNoteCode,
  type GatewayOverrideCode,
} from "./gateway-clients-api";

const FALLBACK_ANTIGRAVITY_MODELS: readonly string[] = [
  "gemini-3-pro",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
];

/**
 * Antigravity and agy read their gateway from files the proxy can write, so unlike the Cursor
 * tab this one is a switch. The server owns the backup and the restore; the page only shows what
 * the status route reports and says what an action did. Both arrive as codes, translated here.
 */

/** Badge per state, in the words of the buttons next to it rather than the file tabs' "Applied". */
const BADGE: Record<GatewayClientState, { key: TKey; className: string }> = {
  connected: { key: "gatewayClients.connected", className: "badge badge-green" },
  disconnected: { key: "gatewayClients.notConnected", className: "badge badge-muted" },
  drifted: { key: "integrations.state.stale", className: "badge badge-amber" },
};

const OVERRIDE_KEYS: Record<GatewayOverrideCode, TKey> = {
  "admin-gateway": "gatewayClients.overrideAdminGateway",
  "admin-unreadable": "gatewayClients.overrideAdminUnreadable",
  "env-gateway": "gatewayClients.overrideEnv",
};

/** `null`: the restart hint is said once, in the message after an action, not as a standing note. */
const NOTE_KEYS: Record<GatewayNoteCode, TKey | null> = {
  "restart-app": null,
  "new-terminal": null,
  "no-google-sign-in": "gatewayClients.noteNoGoogleSignIn",
  "agy-follows-app": "gatewayClients.noteAgyFollowsApp",
  "settings-not-json": "gatewayClients.noteSettingsNotJson",
  "settings-not-object": "gatewayClients.noteSettingsNotObject",
  "no-restore-record": "gatewayClients.noteNoRestoreRecord",
  "agy-version": "gatewayClients.noteAgyVersion",
  "windows-unverified": "gatewayClients.noteWindowsUnverified",
  "agy-env-exported": "gatewayClients.noteAgyEnvExported",
};

const REFUSAL_KEYS: Record<string, TKey> = {
  "requires-admission-token": "gatewayClients.refusedCredential",
  "invalid-model": "gatewayClients.refusedModel",
};

const APPLY_HINT: Record<GatewayClientId, TKey> = {
  antigravity: "gatewayClients.hintAntigravity",
  agy: "gatewayClients.hintAgy",
};

interface OutcomeView { tone: "ok" | "err"; keys: TKey[]; detail: string | null; vars?: Record<string, string> }

function describeOutcome(id: GatewayClientId, action: GatewayClientAction, outcome: GatewayClientActionOutcome): OutcomeView {
  if (!outcome.reached) return { tone: "err", keys: ["gatewayClients.actionFailed"], detail: null };
  if (!outcome.ok) {
    if (outcome.code === "agy-profile-restore-required") {
      return outcome.profilePath
        ? { tone: "err", keys: ["gatewayClients.refusedAgyProfile"], detail: null, vars: { path: outcome.profilePath } }
        : { tone: "err", keys: ["gatewayClients.actionFailed"], detail: null };
    }
    if (id === "antigravity" && outcome.code === "unsupported-file") {
      return { tone: "err", keys: ["gatewayClients.refusedFile"], detail: null };
    }
    const known = outcome.code ? REFUSAL_KEYS[outcome.code] : undefined;
    if (known) return { tone: "err", keys: [known], detail: null };
    // The text of an I/O error is the operating system's; any other unexpected refusal is shown as sent.
    return { tone: "err", keys: [outcome.code === "io-error" ? "gatewayClients.refusedIo" : "gatewayClients.refused"], detail: outcome.message };
  }
  if (action === "connect") {
    return outcome.changed
      ? { tone: "ok", keys: ["gatewayClients.doneConnected", APPLY_HINT[id]], detail: null }
      : { tone: "ok", keys: ["gatewayClients.doneUnchanged"], detail: null };
  }
  if (outcome.restore === "exact" || outcome.restore === "path-wise") {
    const done: TKey = outcome.restore === "exact" ? "gatewayClients.doneRestored" : "gatewayClients.doneRestoredPartly";
    return { tone: "ok", keys: [done, APPLY_HINT[id]], detail: null };
  }
  return { tone: "ok", keys: ["gatewayClients.doneNothing"], detail: null };
}

function GatewayClientCard({
  apiBase,
  client,
  discoveredModels,
  onSettled,
}: {
  apiBase: string;
  client: GatewayClientStatus;
  discoveredModels: readonly string[];
  onSettled: () => void;
}) {
  const t = useT();
  // `null` until the user types: the field then shows what settings.json holds right now.
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<GatewayClientAction | null>(null);
  const [result, setResult] = useState<OutcomeView | null>(null);
  const modelId = useId();
  const hintId = useId();
  const badge = BADGE[client.state];
  const notes = client.notes.flatMap(note => {
    const key = NOTE_KEYS[note.code];
    return key ? [{ code: note.code, key }] : [];
  });
  const modelOptions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (id: string | undefined) => {
      const trimmed = id?.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push(trimmed);
    };
    add(client.defaultModel);
    for (const id of discoveredModels) add(id);
    for (const id of FALLBACK_ANTIGRAVITY_MODELS) add(id);
    return out;
  }, [client.defaultModel, discoveredModels]);

  const run = async (action: GatewayClientAction) => {
    setPending(action);
    setResult(null);
    const model = action === "connect" && modelDraft !== null ? modelDraft.trim() || undefined : undefined;
    const outcome = await runGatewayClientAction(apiBase, client.id, action, model);
    setResult(describeOutcome(client.id, action, outcome));
    if (outcome.ok) setModelDraft(null);
    setPending(null);
    onSettled();
  };

  return (
    <div className="cursor-card" data-gateway-client={client.id}>
      <h4>
        {client.label}{" "}
        <span className={badge.className} data-gateway-state={client.state}>{t(badge.key)}</span>
      </h4>

      {client.overrides.map(override => (
        <Notice key={override.code} tone="warn">{t(OVERRIDE_KEYS[override.code])}</Notice>
      ))}

      <div>
        <span className="field-label">{t("gatewayClients.files")}</span>
        {client.files.map(file => (
          <p key={file.path} className="integration-path">
            {file.path}{file.exists ? "" : ` · ${t("gatewayClients.fileMissing")}`}
          </p>
        ))}
      </div>

      {notes.length > 0 && (
        <ul className="muted">
          {notes.map(note => <li key={note.code}>{t(note.key)}</li>)}
        </ul>
      )}

      {client.id === "antigravity" && (
        <div className="stack">
          <label className="field-label" htmlFor={modelId}>{t("gatewayClients.model")}</label>
          <Combobox
            id={modelId}
            inputClassName="gateway-client-model"
            value={modelDraft ?? client.defaultModel ?? ""}
            onChange={value => setModelDraft(value)}
            options={modelOptions}
            disabled={pending !== null}
            aria-describedby={hintId}
          />
          <span id={hintId} className="muted">{t("gatewayClients.modelHint")}</span>
        </div>
      )}

      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" disabled={pending !== null} onClick={() => void run("connect")}>
          {t(pending === "connect" ? "gatewayClients.working" : "gatewayClients.connect")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pending !== null || client.state === "disconnected"}
          onClick={() => void run("disconnect")}
        >
          {t(pending === "disconnect" ? "gatewayClients.working" : "gatewayClients.disconnect")}
        </button>
      </div>

      {result && (
        <Notice tone={result.tone}>
          {result.keys.map(key => t(key, result.vars)).join(" ")}
          {result.detail && <> <code>{result.detail}</code></>}
        </Notice>
      )}
    </div>
  );
}

interface GatewayClientsSurfaceData {
  clients: GatewayClientStatus[];
  models: string[];
}

export default function GatewayClientsPage({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const fetchClients = useCallback(async (signal: AbortSignal): Promise<GatewayClientsSurfaceData> => {
    const [clients, models] = await Promise.all([
      loadGatewayClients(apiBase, signal),
      loadGatewayModelOptions(apiBase, signal),
    ]);
    if (!clients) throw new Error("gateway client status unavailable");
    return { clients, models };
  }, [apiBase]);
  const resource = useDataSurface<GatewayClientsSurfaceData>(
    `integration-gateway-clients:${apiBase}`,
    [apiBase],
    fetchClients,
    { isEmpty: () => false, enabled: active },
  );
  const surface = resource.state.data ?? null;
  const clients = surface?.clients ?? null;
  const discoveredModels = surface?.models ?? [];

  return (
    <section className="integration-native-page cursor-page" aria-labelledby="gateway-clients-title">
      <h3 id="gateway-clients-title">{t("gatewayClients.title")}</h3>
      <p>{t("gatewayClients.intro")}</p>
      {resource.state.showError && <Notice tone="err">{t("gatewayClients.unavailable")}</Notice>}
      {!clients && !resource.state.showError && <DataSurfaceSkeleton label={t("gatewayClients.loading")} rows={3} />}
      {clients?.map(client => (
        <GatewayClientCard
          key={`${apiBase}:${client.id}`}
          apiBase={apiBase}
          client={client}
          discoveredModels={discoveredModels}
          onSettled={() => resource.refresh()}
        />
      ))}
    </section>
  );
}
