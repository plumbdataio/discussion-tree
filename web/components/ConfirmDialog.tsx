import React, { useEffect } from "react";
import { createPortal } from "react-dom";

// @reusable-ui ConfirmDialog — USE WHEN: confirming a destructive / irreversible
//   action before it runs. INSTEAD OF: window.confirm() or a hand-rolled dialog.
// Generic two-button confirmation. Used currently by the anchor list
// modal's "remove from this side" path so the user can't kill a pinned
// message with a stray click. Keep it simple — title + message body
// + Cancel / Confirm.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = "warn",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "warn" | "neutral";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Close on Escape; mirrors the rest of the app's modal behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title">{title}</h3>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-ok confirm-tone-${tone}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
