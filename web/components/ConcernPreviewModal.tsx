import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Node } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";

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

  // Render through a portal into document.body so that ancestor stacking
  // contexts / layout containment (e.g. `.board-container` has
  // `container-type: inline-size`, which establishes layout containment and
  // captures `position: fixed` descendants) can't trap the backdrop inside
  // a sub-area of the page.
  return createPortal(
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
            <MDView className="node-modal-context" text={concern.context} />
          ) : (
            <div className="empty" style={{ padding: 12 }}>
              {t("concern_card.no_context")}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
