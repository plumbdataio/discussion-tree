import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { usePreviewModalLock } from "../utils/previewModalLock.ts";

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
  // Pause the board thread's auto-read behind this preview.
  usePreviewModalLock();
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

  // Portal through to document.body so ancestor stacking contexts (e.g.
  // .board-container's container-type) can't trap the backdrop in a sub-area.
  return createPortal(
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
        <MDView className="modal-body" text={text} />
      </div>
    </div>,
    document.body,
  );
}
