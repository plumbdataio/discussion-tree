import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { SenderName } from "./SenderName.tsx";
import { usePreviewModalLock } from "../utils/previewModalLock.ts";

export function MessageModal({
  text,
  source,
  senderLabel,
  onClose,
}: {
  text: string;
  source: string;
  // source="external" only: the relay's name.
  senderLabel?: string | null;
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
    source === "user" || source === "cc" || source === "external" ? (
      <SenderName source={source} label={senderLabel} />
    ) : source === "system" ? (
      "system"
    ) : (
      source
    );

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
