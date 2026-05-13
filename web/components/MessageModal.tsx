import React, { useEffect } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownAnchor, urlTransform } from "./MarkdownAnchor.tsx";

export function MessageModal({
  text,
  source,
  onClose,
}: {
  text: string;
  source: string;
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

  const who =
    source === "user"
      ? t("item_card.you")
      : source === "cc"
        ? t("item_card.claude")
        : source === "system"
          ? "system"
          : source;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-content modal-source-${source}`}
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
        <div className="modal-who">{who}</div>
        <div className="modal-body md-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={urlTransform}
            components={{
              a: ({ node, ...props }) => <MarkdownAnchor {...props} />,
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
