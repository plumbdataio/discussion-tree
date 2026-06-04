import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoardView, Node, ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { MessageModal } from "./MessageModal.tsx";
import { ScrollToBottomButton } from "./ScrollToBottomButton.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { extractImageFiles, uploadImage } from "../utils/api.ts";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useSettings } from "../utils/settings.ts";

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

  // Persisted-on-localStorage draft (cleared on successful send).
  const [draft, setDraft] = useDraft(data.board.id, node.id);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tentativeText, setTentativeText] = useState<string | null>(null);
  const [expandedMsg, setExpandedMsg] = useState<ThreadItem | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useMarkReadOnVisible(rootRef, myThread);

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

  // True while the user has deliberately scrolled away from the bottom.
  // Flips back to false once they return within ~30px of the bottom,
  // so a scroll-down gesture re-engages auto-pinning.
  const detachedRef = useRef(false);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    // Reset the detached flag when the effect re-runs (= new message
    // arrived or a tentative submission was placed). The user clearly
    // wants to see new activity, so the auto-pin should be re-armed.
    detachedRef.current = false;
    const pin = () => {
      if (detachedRef.current) return;
      el.scrollTop = Number.MAX_SAFE_INTEGER;
    };
    pin();
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance > 80) detachedRef.current = true;
      else if (distance < 30) detachedRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      if (!detachedRef.current) pin();
    });
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    const t1 = window.setTimeout(pin, 200);
    const t2 = window.setTimeout(pin, 1000);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [myThread.length, tentativeText]);

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
          via i18n so the user sees their preferred language. */}
      <div className="default-board-context md-body">
        <MDView text={t("default_board.welcome_message")} />
      </div>
      <div className="default-board-thread" ref={threadRef}>
        {myThread.map((it) => (
          <ThreadMessage
            key={it.id}
            item={it}
            boardId={data.board.id}
            nodeId={node.id}
            sessionId={ownerSessionId}
            onExpand={openExpandedMsg}
          />
        ))}
        {tentativeText && (
          <div className="thread-msg from-user pending">
            <span className="who">
              {t("item_card.you")} <span className="loading-spinner" />{" "}
              {t("item_card.sending")}
            </span>
            <MDView text={tentativeText} />
          </div>
        )}
        <ScrollToBottomButton scrollRef={threadRef} />
      </div>
      <div className="default-board-input">
        <textarea
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
          <button
            onClick={handleSubmit}
            disabled={submitting || uploading || !draft.trim() || !ownerAlive}
          >
            {t("item_card.send_button")}
          </button>
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
