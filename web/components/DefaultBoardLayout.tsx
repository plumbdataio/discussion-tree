import React, { useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BoardView, Node, ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { MessageModal } from "./MessageModal.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { extractImageFiles, uploadImage } from "../utils/api.ts";
import { useDraft } from "../utils/drafts.ts";
import { formatThreadTimestamp } from "../utils/format.ts";
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
}: {
  data: BoardView;
  ownerAlive: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
  flashingNodes: Set<string>;
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

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
        {myThread.map((it) => {
          if (it.source === "system") {
            return (
              <div key={it.id} className="thread-msg from-system">
                {renderSystemMessage(it.text)}
              </div>
            );
          }
          const isUnread = it.source === "cc" && !it.read_at;
          return (
            <div
              key={it.id}
              className={`thread-msg from-${it.source}${isUnread ? " unread" : ""}`}
              data-unread-id={isUnread ? it.id : undefined}
            >
              <span className="who">
                {it.source === "user" ? t("item_card.you") : t("item_card.claude")}
                <span className="thread-msg-time" title={it.created_at}>
                  {formatThreadTimestamp(it.created_at)}
                </span>
              </span>
              <button
                className="msg-expand"
                title={t("item_card.expand_message")}
                onClick={() => setExpandedMsg(it)}
              >
                <Maximize2 size={12} strokeWidth={1.75} />
              </button>
              <MDView text={it.text} />
            </div>
          );
        })}
        {tentativeText && (
          <div className="thread-msg from-user pending">
            <span className="who">
              {t("item_card.you")} <span className="loading-spinner" />{" "}
              {t("item_card.sending")}
            </span>
            <MDView text={tentativeText} />
          </div>
        )}
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
