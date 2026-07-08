import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  subscribeOpenScheduledEdit,
  type ScheduledEditTarget,
} from "../utils/scheduledList.ts";

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. Format an ISO fire time
// (stored UTC) into that local string to pre-fill the picker.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Global small modal to edit a pending timer send's TEXT and FIRE TIME. Opened
// from a pinned chip's pencil (below a thread) or a reservations-list row's
// pencil, via the scheduledEdit channel. Rendered once in frontend.tsx.
export function ScheduledEditModal() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<ScheduledEditTarget | null>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      subscribeOpenScheduledEdit((tg) => {
        setTarget(tg);
        setText(tg.text);
        setWhen(toLocalInput(tg.fire_at));
      }),
    [],
  );

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target]);

  if (!target) return null;

  const save = async () => {
    const body = text.trim();
    if (!body || !when) return;
    const fireAt = new Date(when); // datetime-local is local → ISO is UTC
    if (isNaN(fireAt.getTime())) return;
    setBusy(true);
    try {
      const res = await fetch("/update-scheduled-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: target.id,
          text: body,
          fire_at: fireAt.toISOString(),
        }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        alert(t("timer.schedule_failed", { message: j.error ?? "" }));
        return;
      }
      setTarget(null);
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
    <div className="modal-backdrop" onClick={() => setTarget(null)}>
      <div
        className="modal-content node-modal scheduled-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={() => setTarget(null)}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          ×
        </button>
        <div className="node-modal-header">
          <h2 className="node-modal-title">{t("timer.edit_title")}</h2>
        </div>
        <label className="timer-picker-label">{t("timer.picker_label")}</label>
        <input
          type="datetime-local"
          className="timer-picker-input"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <textarea
          className="answer-input scheduled-edit-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
        />
        <div className="timer-picker-actions">
          <button
            type="button"
            className="timer-cancel"
            onClick={() => setTarget(null)}
          >
            {t("timer.close")}
          </button>
          <button
            type="button"
            className="timer-confirm"
            disabled={busy || !when || !text.trim()}
            onClick={save}
          >
            {t("timer.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
