import React, { useEffect, useRef, useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export function EditableSessionName({
  sessionId,
  name,
  onSaved,
}: {
  sessionId: string;
  name: string | null;
  onSaved: (newName: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Resync draft when the upstream name changes (e.g., another tab saved a new
  // name and the sidebar poller refreshed our parent).
  useEffect(() => {
    if (!editing) setDraft(name ?? "");
  }, [name, editing]);

  const save = async () => {
    const trimmed = draft.trim();
    if (trimmed === (name ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/set-session-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          name: trimmed === "" ? null : trimmed,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      onSaved(trimmed);
      setEditing(false);
    } catch (e) {
      alert(
        `${t("session_dashboard.session_name_save_failed")}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(name ?? "");
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="session-name-edit">
        <input
          ref={inputRef}
          className="session-name-input"
          value={draft}
          disabled={saving}
          placeholder={t("session_dashboard.session_name_placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Ignore Enter while the IME is mid-composition (e.g., kana →
            // kanji confirmation) — that Enter belongs to the IME, not us.
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
        <button
          type="button"
          className="session-name-action save"
          title={t("session_dashboard.session_name_save")}
          aria-label={t("session_dashboard.session_name_save")}
          disabled={saving}
          onClick={save}
        >
          <Check size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="session-name-action cancel"
          title={t("session_dashboard.session_name_cancel")}
          aria-label={t("session_dashboard.session_name_cancel")}
          disabled={saving}
          onClick={cancel}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </span>
    );
  }

  return (
    <span className="session-name-display">
      {name ? (
        <span className="session-name-text">{name}</span>
      ) : (
        <em className="session-name-unset">{sessionId}</em>
      )}
      <button
        type="button"
        className="session-name-action edit"
        title={
          name
            ? t("session_dashboard.session_name_edit_title")
            : t("session_dashboard.session_name_set_title")
        }
        aria-label={
          name
            ? t("session_dashboard.session_name_edit_title")
            : t("session_dashboard.session_name_set_title")
        }
        onClick={() => setEditing(true)}
      >
        <Pencil size={14} strokeWidth={1.75} />
      </button>
    </span>
  );
}
