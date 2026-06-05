import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckSquare,
  Maximize2,
  MinusSquare,
  Square,
  X,
  XSquare,
} from "lucide-react";
import type { ChecklistItemStatus, Node } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";

// Read-only renderer for a decision-checklist node (is_checklist=1). The
// node's checklist_items are mutated only through CC tools — this surface
// just displays them. The status icon is a display indicator, NOT a
// clickable toggle (UI is deliberately read-only per the design decision).
const STATUS_ICON: Record<
  ChecklistItemStatus,
  React.ComponentType<{ size?: number; strokeWidth?: number }>
> = {
  done: CheckSquare,
  "in-progress": MinusSquare,
  pending: Square,
  dropped: XSquare,
};

function ChecklistBody({ node }: { node: Node }) {
  const items = node.checklist_items ?? [];
  if (items.length === 0) {
    return <div className="checklist-empty">まだ項目がありません</div>;
  }
  return (
    <ul className="checklist-items">
      {items.map((it) => {
        const Icon = STATUS_ICON[it.status] ?? Square;
        return (
        <li
          key={it.id}
          className={`checklist-item checklist-status-${it.status}`}
        >
          <span
            className="checklist-glyph"
            aria-label={it.status}
            title={it.status}
          >
            <Icon size={17} strokeWidth={2} />
          </span>
          <span className="checklist-item-body">
            <MDView className="checklist-summary" text={it.summary} />
            {it.status === "dropped" && it.drop_reason && (
              <span className="checklist-drop-reason">
                却下理由: {it.drop_reason}
              </span>
            )}
          </span>
        </li>
        );
      })}
    </ul>
  );
}

export function ChecklistCard({ node }: { node: Node }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <div className="checklist-card">
      <div className="checklist-card-header">
        <h3 className="checklist-card-title">{node.title}</h3>
        <button
          type="button"
          className="checklist-expand"
          title="拡大表示"
          aria-label="チェックリストを拡大表示"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      {node.context && (
        <MDView className="checklist-card-context" text={node.context} />
      )}
      <ChecklistBody node={node} />

      {expanded &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => setExpanded(false)}
          >
            <div
              className="checklist-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="checklist-modal-header">
                <h2 className="checklist-modal-title">{node.title}</h2>
                <button
                  type="button"
                  className="checklist-modal-close"
                  onClick={() => setExpanded(false)}
                  aria-label="閉じる"
                  title="閉じる"
                >
                  <X size={18} strokeWidth={1.75} />
                </button>
              </div>
              {node.context && (
                <MDView className="checklist-card-context" text={node.context} />
              )}
              <ChecklistBody node={node} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
