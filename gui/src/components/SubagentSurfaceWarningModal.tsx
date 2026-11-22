/**
 * Approval dialog for the sub-agent surface.
 *
 * Two triggers, one component: the operator selecting base or v2, and the one-time advisory
 * an install that predates the v1 default raises after an update. They say different things
 * and offer the same two answers, so keeping them apart would only let the wording drift.
 */
import { useId } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import { type SubagentSurfaceMode, subagentSurfaceLabel } from "../subagent-surface";
import { ModalDialog } from "./ui-v2/modal-dialog";

export default function SubagentSurfaceWarningModal({
  reason,
  mode,
  docsUrl,
  busy = false,
  onContinue,
  onChooseV1,
  onDismiss,
}: {
  /** `selection` is a mode the operator just clicked; `advisory` is the stored mode. */
  reason: "selection" | "advisory";
  mode: SubagentSurfaceMode;
  docsUrl: string;
  busy?: boolean;
  /** Keep or apply the non-v1 mode. */
  onContinue: () => void;
  /** Apply v1, the recommended answer. */
  onChooseV1: () => void;
  /** Escape or backdrop: abandon a selection, keep the stored mode for an advisory. */
  onDismiss: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();

  const label = subagentSurfaceLabel(mode);
  const advisory = reason === "advisory";

  return (
    <ModalDialog
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-subagent-surface-reason={reason}
      dismissDisabled={busy}
      cardStyle={{ maxWidth: 480 }}
      onClose={onDismiss}
    >
        <h3 id={titleId}>{t(advisory ? "subagentSurface.advisoryTitle" : "subagentSurface.selectionTitle", { mode: label })}</h3>
        <div
          id={bodyId}
          className="notice-warn"
          style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}
        >
          <IconAlert width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <p className="modal-desc" style={{ margin: 0 }}>
            {t(advisory ? "subagentSurface.advisoryBody" : "subagentSurface.selectionBody", { mode: label })}
          </p>
        </div>
        <p className="text-label" style={{ marginTop: 12 }}>
          <a href={docsUrl} target="_blank" rel="noreferrer" style={{ color: "var(--epx-highlight, var(--blue, var(--accent)))" }}>
            {t("subagentSurface.learnMore")}
          </a>
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onContinue}>
            {t("subagentSurface.continue")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onChooseV1}>
            {t("subagentSurface.switchToV1")}
          </button>
        </div>
    </ModalDialog>
  );
}
