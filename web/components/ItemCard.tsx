import React, { useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, Node, ThreadItem } from "../../shared/types.ts";
import { ActivityBadge } from "./ActivityBadge.tsx";
import { MDView } from "./MDView.tsx";
import { MessageModal } from "./MessageModal.tsx";
import { NodeModal } from "./NodeModal.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { extractImageFiles, uploadImage } from "../utils/api.ts";
import { useDraft } from "../utils/drafts.ts";
import { formatThreadTimestamp } from "../utils/format.ts";
import { getBoardIdFromUrl } from "../utils/url.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useSettings } from "../utils/settings.ts";

export function ItemCard({
  node,
  childrenByParent,
  threads,
  flashingNodes,
  activity,
  ownerAlive,
  onSubmit,
}: {
  node: Node;
  childrenByParent: Map<string | null, Node[]>;
  threads: Record<string, ThreadItem[]>;
  flashingNodes: Set<string>;
  activity: Activity | null;
  ownerAlive: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const boardId = getBoardIdFromUrl() ?? "misc";
  // Persisted-on-localStorage draft so a refresh / SPA-nav / accidental tab
  // close doesn't lose what the user was typing. Cleared on successful send.
  const [draft, setDraft] = useDraft(boardId, node.id);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Optimistic in-flight message: shown as a faded card with a spinner. Set
  // when the user clicks Send, cleared on success / failure. On failure we
  // also restore the text into the textarea so they can retry without retyping.
  const [tentativeText, setTentativeText] = useState<string | null>(null);
  const [expandedMsg, setExpandedMsg] = useState<ThreadItem | null>(null);
  const [nodeExpanded, setNodeExpanded] = useState(false);
  const myThread = threads[node.id] ?? [];
  const threadRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const flashing = flashingNodes.has(node.id);
  const isActive = !!(activity && activity.node_id === node.id);
  const hasUnread = myThread.some((t) => t.source === "cc" && !t.read_at);
  const [settings] = useSettings();
  const showManualReadButton = !settings.autoReadEnabled && hasUnread;

  useMarkReadOnVisible(cardRef, myThread);

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
      /* network blip — UI stays unread, user can retry */
    });
  };

  useEffect(() => {
    const el = threadRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [myThread.length]);

  const handleImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const boardId = getBoardIdFromUrl() ?? "misc";
    setUploading(true);
    try {
      const uploaded: { url: string; path: string }[] = [];
      for (const f of files) {
        try {
          uploaded.push(await uploadImage(f, boardId));
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
          // Markdown image syntax (rendered inline via broker's /uploads/ route)
          // + a clickable link that opens the same URL in a new browser tab so the
          // user can see the original at full size. The display text shows the
          // absolute filesystem path so Claude Code can extract it via its Read tool.
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
      ref={cardRef}
      className={`item-card status-${node.status}${flashing ? " flashing" : ""}${isActive ? " active" : ""}${hasUnread ? " has-unread" : ""}`}
    >
      <div className="title-row">
        <h3 className="title">{node.title}</h3>
        <span className="status-badge">
          {t([`node_status.${node.status}`, node.status])}
        </span>
        {showManualReadButton && (
          <button
            className="mark-node-read"
            title={t("item_card.mark_read_node_title")}
            onClick={markNodeRead}
          >
            {t("item_card.mark_read_button")}
          </button>
        )}
        <button
          className="node-expand"
          title={t("item_card.expand_node")}
          onClick={() => setNodeExpanded(true)}
        >
          <Maximize2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      {isActive && activity && <ActivityBadge activity={activity} />}
      {node.context && <MDView className="context" text={node.context} />}

      {(myThread.length > 0 || tentativeText) && (
        <div className="thread" ref={threadRef}>
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
      )}

      <div className="input-row">
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
              ? t("item_card.input_placeholder")
              : t("item_card.input_disabled")
          }
        />
        <div className="actions">
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

      {nodeExpanded && (
        <NodeModal
          node={node}
          threadItems={myThread}
          ownerAlive={ownerAlive}
          onSubmit={onSubmit}
          onClose={() => setNodeExpanded(false)}
        />
      )}
    </div>
  );
}
