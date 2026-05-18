import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { postBoardStructureRequest } from "../utils/api.ts";
import { translateError } from "../utils/errors.ts";

// Free-text modal for asking the CC to restructure a board (add a concern,
// add an item under an existing concern, rename, etc). The submission rides
// the existing /submit-answer endpoint with kind="board_structure_request",
// so the same block-until-delivered semantics apply — the modal stays open
// until the CC actually picks up the request.
export function BoardStructureRequestModal({
  boardId,
  onClose,
}: {
  boardId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, sending]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function submit() {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await postBoardStructureRequest(boardId, text.trim());
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(translateError(t, j, `HTTP ${res.status}`));
        setSending(false);
        return;
      }
      setSending(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!sending) onClose();
      }}
    >
      <div
        className="modal-content modal-structure-request"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={onClose}
          disabled={sending}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
        <h2 className="modal-title">{t("structure_request.title")}</h2>
        <p className="modal-description">
          {t("structure_request.description")}
        </p>
        <textarea
          ref={textareaRef}
          className="modal-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          rows={8}
          placeholder={t("structure_request.placeholder")}
          disabled={sending}
        />
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-cancel"
            onClick={onClose}
            disabled={sending}
          >
            {t("structure_request.cancel")}
          </button>
          <button
            type="button"
            className="modal-submit"
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
          >
            {sending
              ? t("structure_request.sending")
              : t("structure_request.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
