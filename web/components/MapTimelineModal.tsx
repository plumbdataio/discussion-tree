// Map-wide chronological preview: a single time-ordered stream of EVERY
// message across all node threads + the general chat. A map's conversation is
// scattered across cards (and the user silently rearranges them), so "wait,
// which node did we discuss X in?" is hard to answer by eye. This modal
// serialises the whole map into one timeline; clicking an entry jumps to the
// node it belongs to (via the same MapNodeModal scroll-to-item the cards use).

import React, { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MapNode, MapNodeKind, ThreadItem } from "../../shared/types.ts";
import { MAP_GENERAL_NODE } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";

export type TimelineEntry = {
  item: ThreadItem;
  nodeId: string;
  nodeTitle: string;
  kind?: MapNodeKind;
  isGeneral: boolean;
};

// Flatten every node thread + the general chat into one chronological stream.
// Pure (labels passed in, not t()) so it can be unit-tested. Drops system rows
// (status changes etc. — bookkeeping, not comments) and threads whose node was
// deleted. Oldest first, ties broken by item id for a stable order.
export function buildTimelineEntries(
  nodes: MapNode[],
  threads: Record<string, ThreadItem[]>,
  labels: { general: string; untitled: string },
): TimelineEntry[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const all: TimelineEntry[] = [];
  for (const [nodeId, items] of Object.entries(threads)) {
    const isGeneral = nodeId === MAP_GENERAL_NODE;
    const node = byId.get(nodeId);
    if (!isGeneral && !node) continue;
    for (const it of items) {
      if (it.source === "system") continue;
      all.push({
        item: it,
        nodeId,
        nodeTitle: isGeneral ? labels.general : node!.title || labels.untitled,
        kind: isGeneral ? undefined : node!.kind,
        isGeneral,
      });
    }
  }
  all.sort((a, b) => {
    if (a.item.created_at < b.item.created_at) return -1;
    if (a.item.created_at > b.item.created_at) return 1;
    return a.item.id - b.item.id;
  });
  return all;
}

export function MapTimelineModal({
  nodes,
  threads,
  onJump,
  onClose,
}: {
  nodes: MapNode[];
  threads: Record<string, ThreadItem[]>;
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

  const entries = useMemo(
    () =>
      buildTimelineEntries(nodes, threads, {
        general: t("map.general_chat"),
        untitled: t("map.untitled"),
      }),
    [nodes, threads, t],
  );

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
          <h2 className="node-modal-title">{t("map.timeline_title")}</h2>
          <span className="timeline-count">
            {t("map.timeline_count", { count: entries.length })}
          </span>
        </div>
        <div className="node-modal-scroll timeline-scroll">
          {entries.length === 0 ? (
            <p className="timeline-empty">{t("map.timeline_empty")}</p>
          ) : (
            entries.map((e) => (
              <div
                key={`${e.nodeId}:${e.item.id}`}
                className={`timeline-entry from-${e.item.source}`}
                role="button"
                tabIndex={0}
                title={t("map.timeline_jump")}
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
                  <span
                    className="timeline-time"
                    title={e.item.created_at}
                  >
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
