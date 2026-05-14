import React, { useEffect } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Node } from "../../shared/types.ts";
import { MarkdownAnchor, urlTransform } from "./MarkdownAnchor.tsx";

// Read-only enlarged view of a concern (title + context only — child nodes
// are intentionally omitted; concerns are category headers and their value as
// an "expand" target is the long-form context, not the items underneath).
export function ConcernPreviewModal({
  concern,
  onClose,
}: {
  concern: Node;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content node-modal concern-preview-modal"
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
          <h2 className="node-modal-title">{concern.title}</h2>
        </div>
        <div className="node-modal-scroll">
          {concern.context ? (
            <div className="node-modal-context md-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={urlTransform}
                components={{
                  a: ({ node: _n, ...props }) => <MarkdownAnchor {...props} />,
                }}
              >
                {concern.context}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="empty" style={{ padding: 12 }}>
              {t("concern_card.no_context")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
