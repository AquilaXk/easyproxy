import { useT } from "../i18n/shared";
import { ModalDialog } from "./ui-v2/modal-dialog";

export function RemoveComboDialog({
  model,
  onCancel,
  onConfirm,
}: {
  model: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();

  return (
    <ModalDialog
      aria-labelledby="cwi-remove-title"
      cardClassName="pwi-remove-confirm-card"
      cardRole={undefined}
      onClose={onCancel}
    >
      <h3 id="cwi-remove-title" className="pwi-remove-confirm-title">
        {t("cws.removeConfirmTitle", { model })}
      </h3>
      <p className="muted pwi-remove-confirm-desc">{t("cws.removeConfirmDesc")}</p>
      <div className="pwi-remove-confirm-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="btn pwi-remove-confirm-danger" onClick={onConfirm}>{t("common.remove")}</button>
      </div>
    </ModalDialog>
  );
}

export function UnsavedLeaveDialog({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();

  return (
    <ModalDialog
      aria-labelledby="cwi-unsaved-title"
      cardClassName="pwi-json-unsaved-card"
      cardRole={undefined}
      onClose={onKeep}
    >
      <h3 id="cwi-unsaved-title" className="pwi-json-unsaved-title">{t("cws.unsavedTitle")}</h3>
      <p className="muted pwi-json-unsaved-desc">{t("cws.unsavedDesc")}</p>
      <div className="pwi-json-unsaved-actions">
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="cwi-unsaved-keep"
          onClick={onKeep}
        >
          {t("cws.keepEditing")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="cwi-unsaved-discard"
          onClick={onDiscard}
        >
          {t("common.discard")}
        </button>
      </div>
    </ModalDialog>
  );
}
