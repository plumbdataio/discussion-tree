import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BoardView, ThreadItem } from "../../shared/types.ts";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { postBoardStructureRequest } from "../utils/api.ts";
import { translateError } from "../utils/errors.ts";

// Free-text modal for asking the CC to restructure a board (add a concern,
// add an item under an existing concern, rename, etc). The submission rides
// the existing /submit-answer endpoint with kind="board_structure_request",
// so the same block-until-delivered semantics apply — the modal stays open
// until the CC actually picks up the request.
//
// The modal also doubles as the per-board structure-change audit trail:
// the broker auto-records each request to a dedicated log node (kind=item
// with is_log=1) and the CC is asked to post a summary back to the same
// node, so showing that node's thread inside this modal gives the user
// "what I asked / what was done" in one place.
export function BoardStructureRequestModal({
  boardId,
  boardView,
  onClose,
}: {
  boardId: string;
  boardView: BoardView;
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

  // Pull the per-board log item out of the supplied board view. The log
  // node is auto-created by the broker on getBoardView, so as long as
  // the user has the board open at all, boardView.nodes will include
  // a single item with is_log === 1.
  const logNode = boardView.nodes.find(
    (n) => n.is_log === 1 && n.kind === "item",
  );
  const logThread: ThreadItem[] = logNode
    ? boardView.threads[logNode.id] ?? []
    : [];

  // ThreadMessage wants a stable onExpand prop; we don't open a sub-
  // modal from inside this modal, so noop it.
  const noopExpand = useCallback(() => {}, []);

  // Auto-pin the log thread to the bottom when entries arrive so the
  // latest request/response pair is visible without scrolling.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logThread.length]);

  // Mark log-node Claude responses read whenever the modal is open and
  // unread items are visible. Re-runs when the thread grows (a new
  // arrival during the modal session also clears immediately).
  useEffect(() => {
    const unreadIds = logThread
      .filter((it) => it.source === "cc" && !it.read_at)
      .map((it) => it.id);
    if (unreadIds.length === 0) return;
    fetch("/mark-thread-items-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_item_ids: unreadIds }),
    }).catch(() => {
      /* network blip — count stays unread, next thread update retries */
    });
  }, [logThread]);

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

  // Portal into document.body so .board-container's layout containment
  // can't trap the fixed backdrop.
  return createPortal(
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
        {logNode && (
          <div className="modal-structure-history">
            <h3 className="modal-structure-history-title">
              {t("structure_request.history_title")}
            </h3>
            {logThread.length === 0 ? (
              <div className="modal-structure-history-empty">
                {t("structure_request.history_empty")}
              </div>
            ) : (
              <div className="modal-structure-history-thread" ref={logRef}>
                {logThread.map((it) => (
                  <ThreadMessage
                    key={it.id}
                    item={it}
                    onExpand={noopExpand}
                  />
                ))}
              </div>
            )}
          </div>
        )}
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
    </div>,
    document.body,
  );
}
