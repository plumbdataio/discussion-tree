import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Node, ThreadItem } from "../../shared/types.ts";
import { MarkdownAnchor, urlTransform } from "./MarkdownAnchor.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { getBoardIdFromUrl } from "../utils/url.ts";
import { extractImageFiles, uploadImage } from "../utils/api.ts";
import { useDraft } from "../utils/drafts.ts";
import { formatThreadTimestamp } from "../utils/format.ts";

export function NodeModal({
  node,
  threadItems,
  ownerAlive,
  onSubmit,
  onClose,
}: {
  node: Node;
  threadItems: ThreadItem[];
  ownerAlive: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const boardId = getBoardIdFromUrl() ?? "misc";
  // Persisted-on-localStorage draft (shared key with the underlying ItemCard
  // for the same node — they back the same conversation, so the draft
  // follows whichever surface the user types in).
  const [draft, setDraft] = useDraft(boardId, node.id);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tentativeText, setTentativeText] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadItems.length]);

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
          // absolute filesystem path so Claude Code can extract it for its Read tool.
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
          <h2 className="node-modal-title">{node.title}</h2>
          <span className={`status-badge status-${node.status}`}>
            {t([`node_status.${node.status}`, node.status])}
          </span>
        </div>
        <div className="node-modal-scroll" ref={threadRef}>
          {node.context && (
            <div className="node-modal-context md-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={urlTransform}
                components={{
                  a: ({ node: _n, ...props }) => <MarkdownAnchor {...props} />,
                }}
              >
                {node.context}
              </ReactMarkdown>
            </div>
          )}
          {(threadItems.length > 0 || tentativeText) && (
            <div className="node-modal-thread">
              {threadItems.map((it) => {
                if (it.source === "system") {
                  return (
                    <div key={it.id} className="thread-msg from-system">
                      {renderSystemMessage(it.text)}
                    </div>
                  );
                }
                return (
                  <div
                    key={it.id}
                    className={`node-modal-msg from-${it.source}`}
                  >
                    <div className="modal-who">
                      {it.source === "user" ? t("item_card.you") : t("item_card.claude")}
                      <span className="thread-msg-time" title={it.created_at}>
                        {formatThreadTimestamp(it.created_at)}
                      </span>
                    </div>
                    <div className="md-body modal-body">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        urlTransform={urlTransform}
                        components={{
                          a: ({ node: _n, ...props }) => <MarkdownAnchor {...props} />,
                        }}
                      >
                        {it.text}
                      </ReactMarkdown>
                    </div>
                  </div>
                );
              })}
              {tentativeText && (
                <div className="node-modal-msg from-user pending">
                  <div className="modal-who">
                    {t("item_card.you")} <span className="loading-spinner" />{" "}
                    {t("item_card.sending")}
                  </div>
                  <div className="md-body modal-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      urlTransform={urlTransform}
                      components={{
                        a: ({ node: _n, ...props }) => <MarkdownAnchor {...props} />,
                      }}
                    >
                      {tentativeText}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="node-modal-input">
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
      </div>
    </div>
  );
}
