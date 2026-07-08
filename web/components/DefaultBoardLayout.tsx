import React, { useCallback, useRef, useState } from "react";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { TimerSendButton } from "./TimerSendButton.tsx";
import { ScheduledPinned } from "./ScheduledPinned.tsx";
import { useTranslation } from "react-i18next";
import type { BoardView, Node, ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { MessageModal } from "./MessageModal.tsx";
import { ScrollToBottomButton } from "./ScrollToBottomButton.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { extractImageFiles, uploadImage } from "../utils/api.ts";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useAnyPreviewModalOpen } from "../utils/previewModalLock.ts";
import { useSettings } from "../utils/settings.ts";
import { useSnapToBottom } from "../utils/useSnapToBottom.ts";

// Default conversation board: a single fixed item, no concern column / no
// items-row chrome. The whole main pane becomes one tall thread with a
// textarea pinned at the bottom — closer to a chat UI than a board.
export function DefaultBoardLayout({
  data,
  ownerAlive,
  onSubmit,
  flashingNodes,
  ownerSessionId,
}: {
  data: BoardView;
  ownerAlive: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
  flashingNodes: Set<string>;
  // Owner session_id of this default board — forwarded to ThreadMessage
  // for Anchor toggling.
  ownerSessionId: string;
}) {
  const { t } = useTranslation();
  // Default boards are seeded with a single root concern + a single item under
  // it. We surface the item — its thread is the conversation log.
  const item = data.nodes.find(
    (n) => n.kind === "item" && n.parent_id !== null,
  ) as Node | undefined;
  const node = item ?? data.nodes[0];
  if (!node)
    return <div className="empty">{t("board.conversation_node_missing")}</div>;

  const myThread: ThreadItem[] = data.threads[node.id] ?? [];
  const flashing = flashingNodes.has(node.id);
  // Real messages only — drop system rows (status changes etc.), matching how
  // the timeline modal counts on concern boards.
  const messageCount = myThread.filter((it) => it.source !== "system").length;
  // Pending timer sends for this node, pinned below the thread until they fire.
  const scheduledForNode = ((data as any).scheduled ?? []).filter(
    (m: any) => m.node_id === node.id,
  );

  // Persisted-on-localStorage draft (cleared on successful send).
  const [draft, setDraft] = useDraft(data.board.id, node.id);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tentativeText, setTentativeText] = useState<string | null>(null);
  const [expandedMsg, setExpandedMsg] = useState<ThreadItem | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Pause auto-read while a preview modal (e.g. an expanded message) occludes
  // the thread behind it.
  const previewOpen = useAnyPreviewModalOpen();
  useMarkReadOnVisible(rootRef, myThread, !previewOpen);

  const [settings] = useSettings();
  const hasUnread = myThread.some((t) => t.source === "cc" && !t.read_at);
  const showManualReadButton = !settings.autoReadEnabled && hasUnread;
  const markNodeRead = () => {
    const ids = myThread
      .filter((t) => t.source === "cc" && !t.read_at)
      .map((t) => t.id);
    if (ids.length === 0) return;
    fetch("/mark-thread-items-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_item_ids: ids }),
    }).catch(() => {
      /* network blip — UI stays unread */
    });
  };

  // Snap to the bottom on mount and when the user starts their own
  // post (tentativeText flip). Following incoming messages while at
  // the bottom, and staying put when scrolled up, is handled by
  // column-reverse in CSS — no JS follow loop needed.
  useSnapToBottom(threadRef, { reversed: true, deps: [tentativeText] });

  const handleImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: { url: string; path: string }[] = [];
      for (const f of files) {
        try {
          uploaded.push(await uploadImage(f, data.board.id));
        } catch (e) {
          alert(
            t("item_card.image_upload_failed", {
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
      if (uploaded.length > 0) {
        setDraft((prev) => {
          const sep = prev && !prev.endsWith("\n") ? "\n" : "";
          const block = uploaded
            .map((u) => `![image](${u.url})\n[image] [${u.path}](${u.url})`)
            .join("\n\n");
          return prev + sep + block + "\n";
        });
      }
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = extractImageFiles(e.clipboardData?.items ?? null);
    if (files.length > 0) {
      e.preventDefault();
      handleImageFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = extractImageFiles(e.dataTransfer?.files ?? null);
    if (files.length > 0) {
      e.preventDefault();
      handleImageFiles(files);
    }
  };

  const handleSubmit = async () => {
    const text = draft.trim();
    if (!text) return;
    setSubmitting(true);
    setTentativeText(text);
    setDraft("");
    try {
      await onSubmit(node.id, text);
      setTentativeText(null);
    } catch (e) {
      setTentativeText(null);
      setDraft(text);
      alert(
        t("item_card.send_failed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Stable identity so memoized ThreadMessage skips reconciliation
  // on every keystroke in the draft textarea.
  const openExpandedMsg = useCallback((it: ThreadItem) => {
    setExpandedMsg(it);
  }, []);

  return (
    <div
      ref={rootRef}
      className={`default-board${flashing ? " flashing" : ""}`}
    >
      {/* The default board's seeded item context is stored in English in the DB
          (so SQL inspection reads naturally), but the display side overrides
          via i18n so the user sees their preferred language. The right end shows
          the total message count — this board has no timeline modal (it's one
          flat thread), but the running count is still handy to glance at. */}
      <div className="default-board-context">
        <MDView
          className="default-board-welcome"
          text={t("default_board.welcome_message")}
        />
        <span className="default-board-count">
          {t("default_board.message_count", { count: messageCount })}
        </span>
      </div>
      {/* column-reverse: the first DOM child renders at the visual
          bottom. So tentativeText (= the optimistic in-flight message)
          comes first in source order, then myThread iterated newest →
          oldest. The result on screen is oldest at top, newest at
          bottom, exactly like before — but the browser's anchor
          behaviour keeps the bottom in view without any JS. */}
      <div className="default-board-thread" ref={threadRef}>
        {tentativeText && (
          <div className="thread-msg from-user pending">
            <span className="who">
              {t("item_card.you")} <span className="loading-spinner" />{" "}
              {t("item_card.sending")}
            </span>
            <MDView text={tentativeText} />
          </div>
        )}
        {[...myThread].reverse().map((it) => (
          <ThreadMessage
            key={it.id}
            item={it}
            boardId={data.board.id}
            nodeId={node.id}
            sessionId={ownerSessionId}
            onExpand={openExpandedMsg}
          />
        ))}
      </div>
      {/* Floating ▼ goes OUTSIDE the thread because the thread is
          column-reverse — making it a thread child would either put it
          at the top of the visible column or fight the flex order.
          Positioned by the `.scroll-to-bottom.is-reversed` rule
          relative to .default-board (which is position: relative). */}
      <ScrollToBottomButton scrollRef={threadRef} reversed />

      <ScheduledPinned scheduled={scheduledForNode} />
      <div className="default-board-input">
        <ResizableTextarea
          className="answer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          onDrop={handleDrop}
          disabled={!ownerAlive}
          placeholder={
            ownerAlive
              ? t("item_card.input_placeholder_default")
              : t("item_card.input_disabled")
          }
        />
        <div className="actions">
          {showManualReadButton && (
            <button
              type="button"
              className="mark-node-read"
              title={t("item_card.mark_read_default_title")}
              onClick={markNodeRead}
            >
              {t("item_card.mark_read_button")}
            </button>
          )}
          {uploading && (
            <span className="upload-status">
              {t("item_card.image_uploading")}
            </span>
          )}
          <TimerSendButton
            sendLabel={t("item_card.send_button")}
            sendDisabled={
              submitting || uploading || !draft.trim() || !ownerAlive
            }
            onSend={handleSubmit}
            boardId={data.board.id}
            nodeId={node.id}
            getText={() => draft}
            onScheduled={() => setDraft("")}
          />
        </div>
      </div>

      {expandedMsg && (
        <MessageModal
          text={expandedMsg.text}
          source={expandedMsg.source}
          onClose={() => setExpandedMsg(null)}
        />
      )}
    </div>
  );
}
