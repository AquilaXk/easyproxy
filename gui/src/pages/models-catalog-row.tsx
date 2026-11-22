import { memo, useEffect, useRef, useState } from "react";
import type { TFn } from "../i18n/shared";
import { IconPencil, IconPlay } from "../icons";
import { modelLabel } from "../model-display";
import { formatProviderDisplayName } from "../provider-icons";
import { Switch } from "../ui";
import { fmtK, type ModelRow } from "./models-shared";

interface AliasEntry {
  alias: string;
  source: "user" | "builtin";
  stale?: boolean;
}

interface ModelsCatalogRowProps {
  m: ModelRow;
  off: boolean;
  visibilityDisabled: boolean;
  aliasEntry?: AliasEntry;
  isRecent: boolean;
  contextCapValue: number;
  onToggleVisibility: () => void;
  onEditAlias: () => void;
  onOpenDisplayName: (trigger: HTMLButtonElement) => void;
  onOpenPrice: (trigger: HTMLButtonElement) => void;
  onOpenSettings: () => void;
  onEditCustom: () => void;
  onDeleteCustom: () => Promise<void>;
  onLaunchPlayground?: () => void;
  t: TFn;
}

/** Single model catalog row with isolated hover/focus tooltip state so row hover does not re-render Models. */
export const ModelsCatalogRow = memo(function ModelsCatalogRow({
  m,
  off,
  visibilityDisabled,
  aliasEntry,
  isRecent,
  contextCapValue,
  onToggleVisibility,
  onEditAlias,
  onOpenDisplayName,
  onOpenPrice,
  onOpenSettings,
  onEditCustom,
  onDeleteCustom,
  onLaunchPlayground,
  t,
}: ModelsCatalogRowProps) {
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const onRowEnter = (el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredRect(el.getBoundingClientRect());
    }, 300);
  };

  const onRowFocus = (el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredRect(el.getBoundingClientRect());
  };

  const onRowLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredRect(null), 120);
  };

  const keepRowTipOpen = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  };

  const flipUp = hoveredRect !== null && hoveredRect.bottom + 4 + 360 > window.innerHeight;

  return (
    <div
      className="model-row-wrap"
      onMouseEnter={e => onRowEnter(e.currentTarget)}
      onMouseLeave={onRowLeave}
      onFocus={e => onRowFocus(e.currentTarget)}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredRect(null);
      }}
    >
      <div className="row models-model-row">
        <Switch
          on={!off}
          onClick={onToggleVisibility}
          disabled={visibilityDisabled || m.initialSelectionPending}
          label={m.native ? m.id : m.namespaced}
        />
        <span className="models-model-main">
          {aliasEntry && <strong className="mono text-control">{aliasEntry.alias}</strong>}
          <span className="models-model-identity">
            <code
              className="mono text-control"
              style={{ color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}
            >
              {m.native ? modelLabel(m.id) : m.namespaced}
            </code>
            {!m.native && m.displayName?.trim() && m.displayName.trim() !== m.namespaced && (
              <span className="models-model-friendly text-caption">{m.displayName.trim()}</span>
            )}
          </span>
          {m.initialSelectionPending && (
            <span className="models-chip muted" role="status">{t("models.initialSelectionPending")}</span>
          )}
          {m.quotaInactiveReason === "no_credit" && (
            <span className="models-chip muted" role="status" title={t("models.inactiveNoCreditHint")}>
              {t("models.inactiveNoCredit")}
            </span>
          )}
          {aliasEntry?.source === "builtin" && (
            <span className="models-chip muted text-caption">{t("models.aliasAuto")}</span>
          )}
          {m.custom && <span className="models-chip muted text-caption">{t("models.customBadge")}</span>}
          {!m.native && m.provider !== "combo" && m.manualPricing === true && (
            <span className="models-chip muted text-caption">{t("pricing.override.badge")}</span>
          )}
          {!m.custom && isRecent && <span className="badge badge-amber">{t("models.newBadge")}</span>}
          {m.contextCapped && (
            <span className="models-chip muted text-caption tabular-nums">
              {t("models.contextCappedValue", { value: fmtK(m.contextCap ?? contextCapValue) })}
            </span>
          )}
        </span>
        <span className="models-model-actions" role="group" aria-label={t("modelsV2.modelActions")}>
          {onLaunchPlayground && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`${t("ux.playground.open")}: ${m.native ? m.id : m.namespaced}`}
              title={t("ux.playground.open")}
              onClick={onLaunchPlayground}
            >
              <IconPlay style={{ width: 13, height: 13 }} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t("models.editModelAlias")}
            title={t("models.editModelAlias")}
            onClick={onEditAlias}
          >
            <IconPencil style={{ width: 13, height: 13 }} />
          </button>
          {!m.native && !m.custom && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-caption models-display-name-trigger"
              aria-haspopup="dialog"
              aria-label={t("models.displayNameActionLabel", { model: m.namespaced })}
              onClick={event => onOpenDisplayName(event.currentTarget)}
            >
              {t("models.displayNameAction")}
            </button>
          )}
          {!m.native && m.provider !== "combo" && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-caption models-display-name-trigger"
              aria-haspopup="dialog"
              aria-label={t("pricing.override.actionLabel", { model: m.namespaced })}
              onClick={event => onOpenPrice(event.currentTarget)}
            >
              {t("pricing.override.action")}
            </button>
          )}
          {!m.native && !m.custom && m.provider !== "combo" && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-caption models-display-name-trigger"
              aria-haspopup="dialog"
              aria-label={t("models.settingsTitle", { model: m.namespaced })}
              onClick={onOpenSettings}
            >
              {t("models.customEdit")}
            </button>
          )}
        </span>
      </div>
      {hoveredRect !== null && (
        <div
          className={`model-tip${m.custom ? " has-actions" : ""}${flipUp ? " flip-up" : ""}`}
          role="tooltip"
          style={{
            position: "fixed",
            left: hoveredRect.left + 24,
            ...(flipUp
              ? { bottom: window.innerHeight - hoveredRect.top + 4 }
              : { top: hoveredRect.bottom + 4 }),
          }}
          onMouseEnter={keepRowTipOpen}
          onMouseLeave={onRowLeave}
        >
          <div className="model-tip-id">{m.native ? m.id : m.namespaced}</div>
          {m.displayName && <div className="model-tip-display">{m.displayName}</div>}
          {m.custom && (
            <span className="models-chip models-chip--tip muted mono text-caption">
              {t("models.customBadge")}
            </span>
          )}
          <div className="model-tip-grid">
            <span className="model-tip-key">{t("models.tipProvider")}</span>
            <span className="model-tip-val">{formatProviderDisplayName(m.provider, t)}</span>
            {(m.contextWindow || m.contextCap) && (
              <>
                <span className="model-tip-key">{t("models.tipContext")}</span>
                <span className="model-tip-val">{fmtK(m.contextWindow ?? m.contextCap ?? 0)}</span>
              </>
            )}
            {m.inputModalities && m.inputModalities.length > 0 && (
              <>
                <span className="model-tip-key">{t("models.tipModalities")}</span>
                <span className="model-tip-val">{m.inputModalities.join(", ")}</span>
              </>
            )}
            <span className="model-tip-key">{t("models.tipStatus")}</span>
            <span className="model-tip-val">{off ? t("models.tipDisabled") : t("models.tipActive")}</span>
          </div>
          {m.custom && m.customId && (
            <div className="model-tip-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm text-caption"
                onClick={() => {
                  onEditCustom();
                  setHoveredRect(null);
                }}
              >
                {t("models.customEdit")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-caption"
                style={{ color: "var(--red)" }}
                onClick={() => {
                  // Clear tooltip after dialog closes so modal has a focus return target.
                  void onDeleteCustom().finally(() => setHoveredRect(null));
                }}
              >
                {t("models.customDelete")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
