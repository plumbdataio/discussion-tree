import React, { useState } from "react";
import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";

// Send button with a JOINED timer button on its right (one rectangle, no gap —
// see .send-timer-group in style.css). The timer opens a small popover to pick
// an absolute time; on confirm it POSTs /schedule-message so the broker delivers
// the composer's text to this board node at that time. Scheduling does NOT need
// the owner alive right now (the message fires later), so the timer half stays
// usable even when the send half is disabled for an offline owner — it only
// needs some text to schedule.
export function TimerSendButton({
  sendLabel,
  sendDisabled,
  onSend,
  boardId,
  nodeId,
  getText,
  onScheduled,
}: {
  sendLabel: string;
  sendDisabled: boolean;
  onSend: () => void;
  boardId: string;
  nodeId: string;
  getText: () => string;
  onScheduled?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const hasText = !!getText().trim();

  // datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. Default to now + 1h so
  // the picker opens pre-filled with a sensible value the user can nudge.
  const defaultWhen = () => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const togglePicker = () =>
    setOpen((v) => {
      if (!v) setWhen(defaultWhen()); // fresh default each time it opens
      return !v;
    });

  const schedule = async () => {
    const text = getText().trim();
    if (!text || !when) return;
    const fireAt = new Date(when); // datetime-local is local time → ISO is UTC
    if (isNaN(fireAt.getTime())) return;
    setBusy(true);
    try {
      const res = await fetch("/schedule-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board_id: boardId,
          node_id: nodeId,
          text,
          fire_at: fireAt.toISOString(),
        }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        alert(t("timer.schedule_failed", { message: j.error ?? "" }));
        return;
      }
      setOpen(false);
      setWhen("");
      onScheduled?.();
    } catch (e) {
      alert(
        t("timer.schedule_failed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="send-timer-group">
      <button
        type="button"
        className="send-btn"
        onClick={onSend}
        disabled={sendDisabled}
      >
        {sendLabel}
      </button>
      <button
        type="button"
        className="timer-btn"
        title={t("timer.button_title")}
        aria-label={t("timer.button_title")}
        disabled={!hasText || busy}
        onClick={togglePicker}
      >
        <Clock size={14} strokeWidth={1.9} />
      </button>
      {open && (
        <div className="timer-picker" role="dialog">
          <label className="timer-picker-label">{t("timer.picker_label")}</label>
          <input
            type="datetime-local"
            className="timer-picker-input"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
          <div className="timer-picker-actions">
            <button
              type="button"
              className="timer-cancel"
              onClick={() => setOpen(false)}
            >
              {t("timer.close")}
            </button>
            <button
              type="button"
              className="timer-confirm"
              disabled={busy || !when || !hasText}
              onClick={schedule}
            >
              {t("timer.schedule")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
