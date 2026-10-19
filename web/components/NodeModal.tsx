import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Node, ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { SenderName } from "./SenderName.tsx";
import { ScrollToBottomButton } from "./ScrollToBottomButton.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { getBoardIdFromUrl } from "../utils/url.ts";
import { ThreadComposer } from "./ThreadComposer.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";
import { useSnapToBottom } from "../utils/useSnapToBottom.ts";
import { usePreviewModalLock } from "../utils/previewModalLock.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useDetachOnUnmount } from "../utils/useDetachOnUnmount.ts";
import { WidthResizeHandles } from "./WidthResizeHandles.tsx";
import { THREAD_PREVIEW_WIDTH_KEY } from "../utils/resizableWidth.ts";

export function NodeModal({
  node,
  threadItems,
  ownerAlive,
  onSubmit,
  onClose,
  scrollToItemId = null,
}: {
  node: Node;
  threadItems: ThreadItem[];
  ownerAlive: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
  onClose: () => void;
  // When set, open scrolled to (and briefly flashing) this thread item
  // instead of the bottom — used when a single message's expand button
  // opens the whole node in context.
  scrollToItemId?: number | null;
}) {
  const { t } = useTranslation();
  // While this preview is open, pause the board cards' auto-read behind it
  // (a node occluded by the preview isn't something the user is reading).
  usePreviewModalLock();
  const boardId = getBoardIdFromUrl() ?? "misc";
  // The draft lives in ThreadComposer (same persisted key as the underlying
  // ItemCard for this node — they back the same conversation, so the draft
  // follows whichever surface the user types in), so a keystroke re-renders
  // only the composer, not this modal's thread.
  const [tentativeText, setTentativeText] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // Empty on unmount so a textarea kept by Chrome's autofill cannot keep
  // this content alive (see useDetachOnUnmount).
  useDetachOnUnmount(threadRef);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Non-reversed because .node-modal-scroll holds both the context
  // block and the thread in one scroll container — flipping that to
  // column-reverse would place the context at the visual bottom,
  // which would need a layout refactor. For now we stick with the
  // classic "scrollTop = scrollHeight" approach, just hardened with
  // the multi-pass mount snap so hydration / scroll-restoration
  // can't strand the modal mid-thread. tentativeText is in deps so
  // the user's own submission scrolls into view even if they were
  // browsing higher up.
  useSnapToBottom(threadRef, {
    deps: [threadItems.length, tentativeText],
    // Skip the bottom-snap when opening targeted at a specific message.
    enabled: !scrollToItemId,
  });

  // Mark THIS previewed node's unread CC messages read while the modal is open
  // (it's the foreground thread the user is reading). Ungated by the preview
  // lock above — that lock only pauses the board cards BEHIND the modal.
  useMarkReadOnVisible(threadRef, threadItems);

  // When opened from a single message's expand button, scroll that message
  // into view (centered) and flash it so the user finds it in the full thread.
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

  const sendToNode = (text: string) => onSubmit(node.id, text);
  const noConfirm = async () => true;

  // Portal into document.body so .board-container's layout containment
  // (container-type: inline-size) can't trap the fixed backdrop.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content node-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <WidthResizeHandles storageKey={THREAD_PREVIEW_WIDTH_KEY} />
        <button
          className="modal-close"
          onClick={onClose}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
        <div className="node-modal-header">
          <h2 className="node-modal-title">{node.title}</h2>
          <span className={`status-badge status-${node.status}`}>
            {t([`node_status.${node.status}`, node.status])}
          </span>
        </div>
        <div className="node-modal-scroll" ref={threadRef}>
          {node.context && (
            <MDView className="node-modal-context" text={node.context} />
          )}
          {(threadItems.length > 0 || tentativeText) && (
            <div className="node-modal-thread">
              {threadItems.map((it) => {
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
                      <SenderName source={it.source} label={it.sender_label} />
                      <span className="thread-msg-time" title={it.created_at}>
                        {formatThreadTimestamp(it.created_at)}
                      </span>
                    </div>
                    <MDView className="modal-body" text={it.text} />
                  </div>
                );
              })}
              {tentativeText && (
                <div className="node-modal-msg from-user pending">
                  <div className="modal-who">
                    {t("item_card.you")} <span className="loading-spinner" />{" "}
                    {t("item_card.sending")}
                  </div>
                  <MDView className="modal-body" text={tentativeText} />
                </div>
              )}
            </div>
          )}
          <ScrollToBottomButton scrollRef={threadRef} />
        </div>
        <ThreadComposer
          className="node-modal-input"
          draftBoardId={boardId}
          timerBoardId={boardId}
          nodeId={node.id}
          ownerAlive={ownerAlive}
          placeholder={
            ownerAlive
              ? t("item_card.input_placeholder")
              : t("item_card.input_disabled")
          }
          confirmSend={noConfirm}
          onSend={sendToNode}
          onTentative={setTentativeText}
          timerSend={false}
        />
      </div>
    </div>,
    document.body,
  );
}
