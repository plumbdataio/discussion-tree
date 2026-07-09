import React, { useState } from "react";
import { Clock, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MDView } from "./MDView.tsx";
import { openScheduledEdit } from "../utils/scheduledList.ts";

// Pending timer-send messages, pinned below a node's thread until they fire.
// Shared by the default conversation board (DefaultBoardLayout) and concern
// boards (ItemCard) so both surfaces render the identical dashed chip. The
// `scheduled` prop is the list already filtered to THIS node.
export function ScheduledPinned({ scheduled }: { scheduled: any[] }) {
  const { t } = useTranslation();
  // Reservation id awaiting delete confirmation (× is one click away, so gate it).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!scheduled || scheduled.length === 0) return null;
  const cancel = (id: string) => {
    fetch("/cancel-scheduled-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {
      /* WS scheduled-messages-update refetches the board */
    });
  };
  return (
    <div className="scheduled-pinned">
      {scheduled.map((m: any) => (
        <div key={m.id} className="scheduled-pinned-item">
          <div className="scheduled-pinned-head">
            <Clock size={12} strokeWidth={2} className="scheduled-pinned-clock" />
            <span className="scheduled-pinned-time">
              {new Date(m.fire_at).toLocaleString([], {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <button
              type="button"
              className="scheduled-pinned-edit"
              title={t("timer.edit_title")}
              aria-label={t("timer.edit_title")}
              onClick={() =>
                openScheduledEdit({
                  id: m.id,
                  text: m.text,
                  fire_at: m.fire_at,
                })
              }
            >
              <Pencil size={11} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="scheduled-pinned-cancel"
              title={t("timer.cancel_title")}
              aria-label={t("timer.cancel_title")}
              onClick={() => setConfirmId(m.id)}
            >
              ×
            </button>
          </div>
          <MDView className="scheduled-pinned-text" text={m.text} />
        </div>
      ))}
      {confirmId && (
        <ConfirmDialog
          title={t("timer.delete_title")}
          message={t("timer.delete_body")}
          confirmLabel={t("timer.delete_confirm")}
          cancelLabel={t("timer.confirm_cancel")}
          tone="warn"
          onConfirm={() => {
            cancel(confirmId);
            setConfirmId(null);
          }}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}
