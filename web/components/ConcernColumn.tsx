import React, { useState } from "react";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, Node, ThreadItem } from "../../shared/types.ts";
import { ConcernPreviewModal } from "./ConcernPreviewModal.tsx";
import { ItemCard } from "./ItemCard.tsx";
import { MDView } from "./MDView.tsx";

export function ConcernColumn({
  concern,
  childrenByParent,
  threads,
  flashingNodes,
  activity,
  ownerAlive,
  onSubmit,
}: {
  concern: Node;
  childrenByParent: Map<string | null, Node[]>;
  threads: Record<string, ThreadItem[]>;
  flashingNodes: Set<string>;
  activity: Activity | null;
  ownerAlive: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const items = childrenByParent.get(concern.id) ?? [];
  const ITEM_WIDTH = 360;
  const ITEM_GAP = 16;
  const itemCount = Math.max(items.length, 1);
  const columnWidth = itemCount * ITEM_WIDTH + (itemCount - 1) * ITEM_GAP;
  // When a concern has no items yet, drop the connector + items-row entirely.
  // Otherwise the empty items-row keeps `flex: 1` and steals the full vertical
  // space, forcing the concern-card into its natural height — which overflows
  // the viewport once the context is long.
  const hasItems = items.length > 0;
  return (
    <div
      className={`concern-column${hasItems ? "" : " no-items"}`}
      style={{ width: `${columnWidth}px` }}
    >
      <div className="concern-card">
        <div className="concern-card-inner">
          <div className="concern-title-row">
            <h2 className="title">{concern.title}</h2>
            <button
              className="node-expand concern-expand"
              title={t("concern_card.expand")}
              onClick={() => setExpanded(true)}
            >
              <Maximize2 size={14} strokeWidth={1.75} />
            </button>
          </div>
          {concern.context && <MDView className="context" text={concern.context} />}
        </div>
      </div>
      {expanded && (
        <ConcernPreviewModal
          concern={concern}
          onClose={() => setExpanded(false)}
        />
      )}
      {hasItems && (
        <>
          <div className="connector" />
          <div className={`items-row ${items.length === 1 ? "single" : ""}`}>
            {items.map((item) => (
              <ItemCard
                key={item.id}
                node={item}
                childrenByParent={childrenByParent}
                threads={threads}
                flashingNodes={flashingNodes}
                activity={activity}
                ownerAlive={ownerAlive}
                onSubmit={onSubmit}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
