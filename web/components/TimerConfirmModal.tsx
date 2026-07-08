import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearPendingConfirm,
  getPendingConfirm,
  subscribeConfirm,
  type TimerConfirmRequest,
} from "../utils/timerConfirm.ts";

// Single global "you have a pending timer send — send this live message now?"
// confirm. Rendered once in frontend.tsx. Showing it disarms the session's
// reservations (so it won't re-prompt until a fresh one re-arms), per the
// agreed design.
export function TimerConfirmModal() {
  const { t } = useTranslation();
  const [req, setReq] = useState<TimerConfirmRequest | null>(
    getPendingConfirm(),
  );

  useEffect(() => subscribeConfirm(() => setReq(getPendingConfirm())), []);

  // Disarm on SHOW (fire-and-forget) — the confirm fires only the first time
  // while reservations are pending.
  useEffect(() => {
    if (!req) return;
    fetch("/timer-confirm-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: req.sessionId }),
    }).catch(() => {
      /* best effort — worst case it prompts once more */
    });
  }, [req]);

  if (!req) return null;

  const choose = (proceed: boolean) => {
    req.resolve(proceed);
    clearPendingConfirm();
    setReq(null);
  };

  return (
    <div className="modal-backdrop" onClick={() => choose(false)}>
      <div
        className="modal-content node-modal timer-confirm-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="node-modal-header">
          <h2 className="node-modal-title">{t("timer.confirm_title")}</h2>
        </div>
        <p className="timer-confirm-body">
          {t("timer.confirm_body", { count: req.count })}
        </p>
        <div className="timer-picker-actions">
          <button
            type="button"
            className="timer-cancel"
            onClick={() => choose(false)}
          >
            {t("timer.confirm_cancel")}
          </button>
          <button
            type="button"
            className="timer-confirm"
            onClick={() => choose(true)}
          >
            {t("timer.confirm_send")}
          </button>
        </div>
      </div>
    </div>
  );
}
