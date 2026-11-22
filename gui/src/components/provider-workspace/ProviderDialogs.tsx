/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave, JSON save-before-leave.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useT } from "../../i18n/shared";
import { collectFocusableElements, isTopmostOverlayLayer } from "../overlay-layers";

/**
 * Escape cancels a confirmation (#8849). These are plain alertdialogs, not native <dialog>s, so
 * nothing else maps the key. Only the topmost layer acts: a confirmation left open beneath the
 * Add Provider modal or a native dialog ignores the key (and does not prevent it), and a page that
 * stacks one over Add Provider tells that modal to leave Escape alone, so one keystroke closes
 * exactly one layer.
 */
function useEscapeToCancel(layer: RefObject<HTMLElement | null>, onCancel: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!isTopmostOverlayLayer(layer.current)) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layer, onCancel, enabled]);
}

function useAlertDialogFocus(layer: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const overlay = layer.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    collectFocusableElements(overlay)[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTopmostOverlayLayer(overlay)) return;
      const items = collectFocusableElements(overlay);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !overlay?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [layer]);
}

export function RemoveConfirmDialog({
  providerName, defaultProviderName, onConfirm, onCancel,
}: {
  providerName: string;
  /** The automatic replacement when deleting the current default provider. */
  defaultProviderName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  useEscapeToCancel(layer, onCancel);
  useAlertDialogFocus(layer);
  return (
    <div ref={layer} className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={t("pws.removeConfirmTitle")} onClick={e => e.stopPropagation()}>
        <h3>{t("pws.removeConfirmTitle")}</h3>
        <p>{defaultProviderName
          ? t("pws.removeDefaultConfirmBody", { name: providerName, defaultProvider: defaultProviderName })
          : t("pws.removeConfirmBody", { name: providerName })}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>{t("pws.removeConfirm")}</button>
        </div>
      </div>
    </div>
  );
}

export function UnsavedLeaveDialog({
  onSave, onDiscard, onCancel, saving = false,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  // A save in flight cannot be abandoned from the keyboard, as the Save button is disabled too.
  useEscapeToCancel(layer, onCancel, !saving);
  useAlertDialogFocus(layer);
  return (
    <div ref={layer} className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={t("pws.unsavedLeaveTitle")} onClick={e => e.stopPropagation()}>
        <h3>{t("pws.unsavedLeaveTitle")}</h3>
        <p>{t("pws.unsavedLeaveBody")}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-ghost" onClick={onDiscard}>{t("pws.discardSettings")}</button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? t("pws.saving") : t("pws.saveSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}
