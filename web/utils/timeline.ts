import type { ThreadItem } from "../../shared/types.ts";

// Shared chronological-timeline model, used by BOTH the map and the board
// timeline previews. A surface's conversation is scattered across many nodes (a
// map's cards, a board's columns) and once unread turns read it's hard to answer
// "which node did we discuss X in?" by eye. buildTimelineEntries serialises the
// whole surface into one time-ordered stream; the shared TimelineModal renders
// it and a per-surface onJump scrolls to the node/message it belongs to.

export type TimelineEntry = {
  item: ThreadItem;
  nodeId: string;
  nodeTitle: string;
  // Free-form node-kind tag used only for a CSS chip class (e.g. concern / item
  // on a board, idea / question on a map). Optional; the general chat has none.
  kind?: string;
  isGeneral: boolean;
};

// Resolve a thread's node id into display meta, or null to DROP that thread
// (node was deleted). The surface owns the lookup: a map maps its general-chat
// id + MapNode titles/kinds; a board maps its concern/item node titles/kinds.
export type TimelineNodeResolver = (
  nodeId: string,
) => { title: string; kind?: string; isGeneral?: boolean } | null;

// Flatten every node thread into one chronological stream. Pure (no i18n — the
// resolver supplies labels) so it can be unit-tested. Drops system rows (status
// changes etc. — bookkeeping, not comments) and threads whose node the resolver
// rejects. Oldest first, ties broken by item id for a stable order.
export function buildTimelineEntries(
  threads: Record<string, ThreadItem[]>,
  resolve: TimelineNodeResolver,
): TimelineEntry[] {
  const all: TimelineEntry[] = [];
  for (const [nodeId, items] of Object.entries(threads)) {
    const meta = resolve(nodeId);
    if (!meta) continue;
    for (const it of items) {
      if (it.source === "system") continue;
      all.push({
        item: it,
        nodeId,
        nodeTitle: meta.title,
        kind: meta.kind,
        isGeneral: !!meta.isGeneral,
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
