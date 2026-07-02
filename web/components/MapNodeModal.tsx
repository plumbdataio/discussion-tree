// Full-node preview for a map card — the map counterpart to the board's
// NodeModal. Opens a full-screen modal showing the node's title + context +
// whole thread + an input, and (like the board) can open scrolled to a single
// message (flashing it) when a message's expand button is clicked. Replaces the
// old single-message MessageModal so "expand a message" and "expand the node"
// land in the same surface, exactly as the board does.

import React, { useEffect, useRef, useState } from "react";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MapNodeKind, ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { ScrollToBottomButton } from "./ScrollToBottomButton.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";
import { useDraft } from "../utils/drafts.ts";
import { useSnapToBottom } from "../utils/useSnapToBottom.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { usePreviewModalLock } from "../utils/previewModalLock.ts";
import {
  extractImageFiles,
  postMapChat,
  uploadImage,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

export function MapNodeModal({
  mapId,
  nodeId,
  title,
  context,
  kind,
  messages,
  ownerAlive,
  onClose,
  scrollToItemId = null,
  sendChat,
}: {
  mapId: string;
  nodeId: string;
  title: string;
  context: string;
  // Absent for the map-wide general chat, which has no kind badge.
  kind?: MapNodeKind | null;
  messages: ThreadItem[];
  ownerAlive: boolean;
  onClose: () => void;
  scrollToItemId?: number | null;
  // Override the post endpoint. Defaults to the map chat (/map-chat); the
  // diagram surface reuses this modal but posts to /diagram-chat instead.
  sendChat?: (text: string) => Promise<Response>;
}) {
  const { t } = useTranslation();
  // Same localStorage draft key as the inline card composer, so the draft
  // follows the user between the card and this modal.
  const [draft, setDraft] = useDraft(mapId, nodeId);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useSnapToBottom(threadRef, {
    deps: [messages.length],
    enabled: !scrollToItemId,
  });

  // Reading the node here IS a deliberate, full-screen, legible read — so mark
  // its unread CC messages read after the usual visible-dwell, with the gate
  // OPEN regardless of canvas zoom (the zoom gate only guards the tiny on-canvas
  // card; once the modal is up the text is plainly legible). Without this, a
  // node opened from a zoomed-out canvas would stay unread forever.
  // Hold the lock so the map nodes behind this preview pause their auto-read.
  // This modal's OWN read above stays ungated (it's the foreground thread the
  // user is actually looking at), so the previewed node still gets marked read.
  usePreviewModalLock();
  useMarkReadOnVisible(threadRef, messages, true);

  // Opened from a single message's expand button → scroll that message into
  // view (centered) and flash it so it's findable in the full thread.
  useEffect(() => {
    if (!scrollToItemId) return;
    const root = threadRef.current;
    if (!root) return;
    const el = root.querySelector(
      `[data-thread-item-id="${scrollToItemId}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    // Instant jump (no smooth animation) — with a long thread the smooth
    // scroll took ~1s and felt like waiting. The flash still marks the target.
    el.scrollIntoView({ behavior: "instant", block: "center" });
    el.classList.add("thread-msg-flash");
    const tid = setTimeout(() => el.classList.remove("thread-msg-flash"), 1600);
    return () => clearTimeout(tid);
  }, [scrollToItemId]);

  const appendImage = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        const { url, path } = await uploadImage(f, mapId);
        setDraft(
          (prev) =>
            `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}![image](${url})\n[image] [${path}](${url})\n`,
        );
      }
    } catch {
      showToast(t("map.image_failed"), "error");
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !ownerAlive) return;
    setSending(true);
    setDraft("");
    try {
      const res = sendChat
        ? await sendChat(text)
        : await postMapChat(mapId, nodeId, text);
      if (!res.ok) {
        setDraft(text);
        showToast(t("map.send_failed"), "error");
      }
    } catch {
      setDraft(text);
      showToast(t("map.send_failed"), "error");
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content node-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={onClose}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
        <div className="node-modal-header">
          <h2 className="node-modal-title">
            {kind && (
              <span className={`map-card-kind kind-${kind}`}>
                {t(`map.kind.${kind}`)}
              </span>
            )}
            {title || t("map.untitled")}
          </h2>
        </div>
        <div className="node-modal-scroll" ref={threadRef}>
          {context && (
            <MDView className="node-modal-context" text={context} />
          )}
          {messages.length > 0 && (
            <div className="node-modal-thread">
              {messages.map((it) => {
                if (it.source === "system") {
                  return (
                    <div
                      key={it.id}
                      className="thread-msg from-system"
                      data-thread-item-id={it.id}
                    >
                      {renderSystemMessage(it.text)}
                    </div>
                  );
                }
                return (
                  <div
                    key={it.id}
                    className={`node-modal-msg from-${it.source}`}
                    data-thread-item-id={it.id}
                  >
                    <div className="modal-who">
                      {it.source === "user"
                        ? t("item_card.you")
                        : t("item_card.claude")}
                      <span className="thread-msg-time" title={it.created_at}>
                        {formatThreadTimestamp(it.created_at)}
                      </span>
                    </div>
                    <MDView className="modal-body" text={it.text} />
                  </div>
                );
              })}
            </div>
          )}
          <ScrollToBottomButton scrollRef={threadRef} />
        </div>
        <div className="node-modal-input">
          <ResizableTextarea
            className="answer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            onPaste={(e) => {
              const imgs = extractImageFiles(e.clipboardData?.items ?? null);
              if (imgs.length) {
                e.preventDefault();
                appendImage(imgs);
              }
            }}
            onDrop={(e) => {
              const imgs = extractImageFiles(e.dataTransfer?.files ?? null);
              if (imgs.length) {
                e.preventDefault();
                appendImage(imgs);
              }
            }}
            disabled={!ownerAlive}
            placeholder={
              ownerAlive
                ? t("map.node_input_placeholder")
                : t("map.input_disabled")
            }
          />
          <div className="actions">
            {uploading && (
              <span className="upload-status">{t("map.uploading")}</span>
            )}
            <button
              onClick={send}
              disabled={sending || uploading || !draft.trim() || !ownerAlive}
            >
              {t("map.send")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
