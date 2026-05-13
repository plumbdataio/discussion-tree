import React from "react";
import type { Activity, Node, ThreadItem } from "../../shared/types.ts";
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
  const items = childrenByParent.get(concern.id) ?? [];
  const ITEM_WIDTH = 360;
  const ITEM_GAP = 16;
  const itemCount = Math.max(items.length, 1);
  const columnWidth = itemCount * ITEM_WIDTH + (itemCount - 1) * ITEM_GAP;
  return (
    <div className="concern-column" style={{ width: `${columnWidth}px` }}>
      <div className="concern-card">
        <div className="concern-card-inner">
          <h2 className="title">{concern.title}</h2>
          {concern.context && <MDView className="context" text={concern.context} />}
        </div>
      </div>
      <div className="connector" />
      <div className={`items-row ${items.length === 1 ? "single" : ""}`}>
        {items.length === 0 && (
          <div className="empty" style={{ padding: 12 }}>
            (no items)
          </div>
        )}
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
    </div>
  );
}
