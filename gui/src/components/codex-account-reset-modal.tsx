import { useCallback, useEffect, useRef } from "react";
import { isValidStrictTimestamp } from "../../../src/lib/strict-timestamp";
import { useI18n } from "../i18n/shared";
import { IconAlert, IconTicket } from "../icons";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { CodexCreditItem } from "./codex-account-pool-helpers";
import { formatCreditDate } from "./codex-account-pool-utils";

function keyedCreditDetails(
  credits: ReadonlyArray<{ granted_at: string; expires_at: string | null }>,
): Array<{ credit: { granted_at: string; expires_at: string | null }; position: number; key: string }> {
  const seen = new Map<string, number>();
  return credits.map((credit, position) => {
    const base = JSON.stringify([credit.granted_at, credit.expires_at]);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { credit, position, key: count === 1 ? base : `${base}#${count}` };
  });
}

export function CodexAccountResetModal({
  resetPopup,
  resetConfirm,
  creditDetails,
  creditDetailsLoading,
  redeeming,
  onClose,
  onShowConfirm,
  onCancelConfirm,
  onRedeem,
}: {
  resetPopup: CodexAccountEntry;
  resetConfirm: boolean;
  creditDetails: { granted_at: string; expires_at: string | null }[] | null;
  creditDetailsLoading: boolean;
  redeeming: boolean;
  onClose: () => void;
  onShowConfirm: () => void;
  onCancelConfirm: () => void;
  onRedeem: () => void;
}) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!redeeming) onClose();
  }, [onClose, redeeming]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="codex-reset-title"
      onCancel={handleCancel}
     
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} disabled={redeeming} />
      <div className="modal-card" onClick={e => e.stopPropagation()} role="document">
        {!resetConfirm ? (
          <>
            <h3 id="codex-reset-title"><IconTicket width={16} /> {t("codexAuth.resetCreditsTitle")}</h3>
            <div className="card-sub">{resetPopup.email}{resetPopup.plan ? ` · ${resetPopup.plan}` : ""}</div>
            <div style={{ margin: "16px 0" }}>
              {(resetPopup.quota?.resetCredits ?? 0) > 0 ? (
                <>
                  <p style={{ marginBottom: 12 }}>{t("codexAuth.resetCreditsAvailable", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
                  {creditDetailsLoading && <p className="faint text-label">{t("common.loading")}</p>}
                  {creditDetails && creditDetails.length > 0 && (
                    <div className="credit-list">
                      {keyedCreditDetails(creditDetails).map(({ credit, position, key }) => (
                        <CodexCreditItem key={key} index={position} grantedAt={credit.granted_at} expiresAt={credit.expires_at} isNext={position === 0} locale={locale} t={t} />
                      ))}
                    </div>
                  )}
                  <button type="button" className="btn btn-primary" style={{ marginTop: 12, width: "100%" }}
                    onClick={onShowConfirm} disabled={redeeming || creditDetailsLoading}>
                    {t("codexAuth.useOneCredit")}
                  </button>
                  <p className="card-sub text-caption" style={{ marginTop: 8, textAlign: "center" }}>{t("codexAuth.fifoNote")}</p>
                </>
              ) : (
                <>
                  <p className="faint">{t("codexAuth.noResetCredits")}</p>
                  <p className="modal-desc">{t("codexAuth.earnCreditsHint")}</p>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div className="confirm-icon"><IconAlert width={22} /></div>
              <h3 id="codex-reset-title">{t("codexAuth.confirmResetTitle")}</h3>
              <p className="modal-desc">{t("codexAuth.confirmResetDesc", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
              {creditDetails && creditDetails[0] && isValidStrictTimestamp(creditDetails[0].granted_at) && (
                <p className="faint text-label">
                  {t("codexAuth.confirmWhichCredit", { date: formatCreditDate(creditDetails[0].granted_at, locale) })}
                </p>
              )}
              <p className="faint text-label">{t("codexAuth.irreversible")}</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onCancelConfirm} disabled={redeeming}>{t("codexAuth.cancel")}</button>
              <button type="button" className="btn btn-primary" onClick={onRedeem} disabled={redeeming}>
                {redeeming ? t("codexAuth.redeeming") : t("codexAuth.useCredit")}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
