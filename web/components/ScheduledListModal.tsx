import React, { useCallback, useEffect, useState } from "react";
import { Clock, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import {
  openScheduledEdit,
  subscribeOpenScheduledList,
} from "../utils/scheduledList.ts";

// Global cross-session reservations list. Rendered once (frontend.tsx); opened
// from the sidebar clock indicator or a board-header button via the
// scheduledList open channel. Shows every still-pending timer send on the
// machine (all sessions), soonest first, with its target + a cancel button.
export function ScheduledListModal() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(() => {
    setLoading(true);
    fetch("/list-all-scheduled-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json())
      .then((j) => setItems(j.scheduled ?? []))
      .catch(() => {
        /* leave the previous list on a blip */
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(
    () =>
      subscribeOpenScheduledList(() => {
        setOpen(true);
        refetch();
      }),
    [refetch],
  );

  // Esc closes; refresh on the WS scheduled-messages nudge while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onUpdate = () => refetch();
    document.addEventListener("keydown", onKey);
    window.addEventListener("pd-scheduled-messages-update", onUpdate);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pd-scheduled-messages-update", onUpdate);
    };
  }, [open, refetch]);

  if (!open) return null;

  const cancel = (id: string) => {
    fetch("/cancel-scheduled-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then(() => refetch())
      .catch(() => {
        /* WS update will refetch */
      });
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="modal-content node-modal scheduled-list-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={() => setOpen(false)}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          ×
        </button>
        <div className="node-modal-header">
          <h2 className="node-modal-title">
            <Clock size={16} strokeWidth={2} /> {t("timer.list_title")}
          </h2>
          <span className="timeline-count">{items.length}</span>
        </div>
        {items.length === 0 ? (
          <div className="scheduled-list-empty">
            {loading ? t("sidebar.loading") : t("timer.list_empty")}
          </div>
        ) : (
          <ul className="scheduled-list">
            {items.map((m) => (
              <li key={m.id} className="scheduled-list-row">
                <div className="scheduled-list-meta">
                  <span className="scheduled-list-time">
                    <Clock size={12} strokeWidth={2} /> {fmt(m.fire_at)}
                  </span>
                  <span className="scheduled-list-target">
                    {m.session_name || "?"}
                    {m.board_title
                      ? ` › ${m.board_is_default ? t("default_board.title") : m.board_title}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="scheduled-list-edit"
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
                    <Pencil size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="scheduled-list-cancel"
                    title={t("timer.cancel_title")}
                    aria-label={t("timer.cancel_title")}
                    onClick={() => cancel(m.id)}
                  >
                    ×
                  </button>
                </div>
                <MDView className="scheduled-list-text" text={m.text} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
