// Shared chronological all-comments preview, used by BOTH the map and the board.
// It renders a pre-built, time-ordered stream (see buildTimelineEntries) and
// clicking an entry calls onJump(nodeId, itemId) — the caller scrolls to the
// node/message on its own surface (map: center the card; board: jumpToAnchor).

import React, { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";
import type { TimelineEntry } from "../utils/timeline.ts";

export function TimelineModal({
  entries,
  onJump,
  onClose,
}: {
  entries: TimelineEntry[];
  onJump: (nodeId: string, itemId: number) => void;
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

  const count = useMemo(() => entries.length, [entries]);

  // Open at the newest message (bottom), like every other thread preview.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content node-modal timeline-modal"
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
          <h2 className="node-modal-title">{t("timeline.title")}</h2>
          <span className="timeline-count">
            {t("timeline.count", { count })}
          </span>
        </div>
        <div className="node-modal-scroll timeline-scroll" ref={scrollRef}>
          {entries.length === 0 ? (
            <p className="timeline-empty">{t("timeline.empty")}</p>
          ) : (
            entries.map((e) => (
              <div
                key={`${e.nodeId}:${e.item.id}`}
                className={`timeline-entry from-${e.item.source}`}
                role="button"
                tabIndex={0}
                title={t("timeline.jump")}
                onClick={(ev) => {
                  // A markdown link / button in the body owns its own click —
                  // don't also jump (which would navigate AND close the modal).
                  if ((ev.target as HTMLElement).closest("a, button")) return;
                  onJump(e.nodeId, e.item.id);
                }}
                onKeyDown={(ev) => {
                  // Only the entry itself activates the jump; Enter/Space on a
                  // focused inner link must perform the link's default, not be
                  // hijacked into a jump.
                  if (ev.target !== ev.currentTarget) return;
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onJump(e.nodeId, e.item.id);
                  }
                }}
              >
                <div className="timeline-meta">
                  <span
                    className={
                      "timeline-node-chip" +
                      (e.isGeneral ? " is-general" : "") +
                      (e.kind ? ` kind-${e.kind}` : "")
                    }
                  >
                    {e.nodeTitle}
                  </span>
                  <span className="timeline-who">
                    {e.item.source === "user"
                      ? t("item_card.you")
                      : t("item_card.claude")}
                  </span>
                  <span className="timeline-time" title={e.item.created_at}>
                    {formatThreadTimestamp(e.item.created_at)}
                  </span>
                </div>
                <MDView className="timeline-body" text={e.item.text} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
