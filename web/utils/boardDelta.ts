// Incremental board refresh: merge a /api/board/<id>/threads delta into the
// BoardView already on screen, instead of re-downloading the whole board.
//
// WHY: a thread-update used to refetch /api/board/<id> — the WHOLE board. On
// the default board that is ~4,400 items / 4.3MB of JSON (measured
// 2026-10-16), so a single post took ~30s to appear on a phone over 4G. The
// delta carries only the items newer than the largest id held, the read state,
// node statuses and the header fields (see broker getBoardThreadDelta).
//
// IDENTITY RULES (they matter for render cost): an untouched node keeps its
// exact thread array, an untouched item keeps its exact object, and the nodes
// array is reused when no status moved. ThreadRows' chunk memo and
// ThreadMessage's memo then skip everything but what actually changed, and
// appending never re-renders an older content-visibility chunk.
//
// Returns `view` itself when the delta changes nothing (see step 4).
//
// Returns null when the delta can't be applied safely (different board, or it
// mentions a node this view doesn't have = the structure changed); the caller
// then falls back to a full fetch.

import type {
  BoardThreadDelta,
  BoardView,
  Node,
  ThreadItem,
} from "../../shared/types.ts";
import { countsAsUnreadSource } from "./threadSource.ts";

// Largest thread_items.id held anywhere in the view (0 when empty). Ids are a
// global AUTOINCREMENT, so "id > this" is exactly "arrived since".
export function maxThreadItemId(view: BoardView): number {
  let max = 0;
  for (const items of Object.values(view.threads)) {
    // Each node's list is ascending by id, so its last item is its max.
    const last = items[items.length - 1];
    if (last && last.id > max) max = last.id;
  }
  return max;
}

export function mergeBoardDelta(
  view: BoardView,
  delta: BoardThreadDelta,
  // The `after` the delta was requested with. Read state is reconciled only for
  // items the server could see at query time (id <= max(after, newest delta
  // item)): if `view` already holds something newer (a full fetch landed while
  // this delta was in flight), the delta's unread set says nothing about it.
  afterId: number,
  // read_at stamped onto items the server now reports read. Only its
  // truthiness is ever used by the UI.
  readAt: string = new Date().toISOString(),
): BoardView | null {
  if (!delta || !delta.board || delta.board.id !== view.board.id) return null;

  const knownNodes = new Set(view.nodes.map((n) => n.id));
  for (const id of Object.keys(delta.node_statuses ?? {})) {
    if (!knownNodes.has(id)) return null;
  }
  for (const it of delta.threads ?? []) {
    if (!knownNodes.has(it.node_id) && !view.threads[it.node_id]) return null;
  }

  // 1. Append the new items per node (de-duplicated by id, kept ascending).
  const threads: Record<string, ThreadItem[]> = { ...view.threads };
  const touched = new Set<string>();
  const incomingByNode = new Map<string, ThreadItem[]>();
  for (const it of delta.threads ?? []) {
    const list = incomingByNode.get(it.node_id);
    if (list) list.push(it);
    else incomingByNode.set(it.node_id, [it]);
  }
  for (const [nodeId, incoming] of incomingByNode) {
    const existing = threads[nodeId] ?? [];
    const have = new Set(existing.map((t) => t.id));
    const fresh = incoming.filter((t) => !have.has(t.id));
    if (fresh.length === 0) continue;
    const lastId = existing.length ? existing[existing.length - 1].id : 0;
    let next = existing.concat(fresh);
    // The delta is ascending and normally entirely newer; sort only if an
    // out-of-order id slipped in so the list invariant still holds.
    if (fresh[0].id <= lastId || !isAscending(fresh)) {
      next = next.slice().sort((a, b) => a.id - b.id);
    }
    threads[nodeId] = next;
    touched.add(nodeId);
  }

  // 2. Reconcile read state on every held item. Items are never edited or
  //    deleted server-side — only read_at flips — so the unread set is enough.
  const unread = new Set(delta.unread_ids ?? []);
  const deltaThreads = delta.threads ?? [];
  const seenUpTo = Math.max(
    afterId,
    deltaThreads.length ? deltaThreads[deltaThreads.length - 1].id : 0,
  );
  for (const [nodeId, items] of Object.entries(threads)) {
    let copy: ThreadItem[] | null = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.id > seenUpTo || !countsAsUnreadSource(it.source)) continue;
      const serverUnread = unread.has(it.id);
      const localUnread = !it.read_at;
      if (serverUnread === localUnread) continue;
      if (!copy) copy = touched.has(nodeId) ? items : items.slice();
      copy[i] = { ...it, read_at: serverUnread ? null : it.read_at || readAt };
    }
    if (copy) {
      threads[nodeId] = copy;
      touched.add(nodeId);
    }
  }

  // 3. Node statuses (a post can move its node, e.g. needs-reply → discussing).
  let nodes: Node[] = view.nodes;
  const statuses = delta.node_statuses ?? {};
  if (view.nodes.some((n) => n.id in statuses && statuses[n.id] !== n.status)) {
    nodes = view.nodes.map((n) =>
      n.id in statuses && statuses[n.id] !== n.status
        ? { ...n, status: statuses[n.id] as Node["status"] }
        : n,
    );
  }

  // 4. Header / owner fields + board row; image dims merge. A field whose
  //    value is unchanged keeps the view's own object, and a delta that
  //    changes nothing at all returns `view` itself — the caller then skips
  //    setData and the cache write. Most live events (a second delta in a
  //    burst, the submitter's own catch-up fetch) carry nothing new, and a
  //    fresh object would re-render the whole board subtree for no change.
  const {
    threads: _t,
    unread_ids: _u,
    node_statuses: _s,
    image_dims,
    ...rest
  } = delta;
  const header: Record<string, unknown> = {};
  let headerChanged = false;
  const prev = view as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(rest)) {
    if (sameValue(prev[key], value)) {
      header[key] = prev[key];
    } else {
      header[key] = value;
      headerChanged = true;
    }
  }
  let mergedDims = view.image_dims;
  for (const [url, d] of Object.entries(image_dims ?? {})) {
    if (!sameValue(view.image_dims?.[url], d)) {
      mergedDims = { ...(view.image_dims ?? {}), ...(image_dims ?? {}) };
      break;
    }
  }
  if (
    !headerChanged &&
    touched.size === 0 &&
    nodes === view.nodes &&
    mergedDims === view.image_dims
  ) {
    return view;
  }
  return {
    ...view,
    ...header,
    nodes,
    threads: touched.size > 0 ? threads : view.threads,
    image_dims: mergedDims ?? {},
  } as BoardView;
}

// Structural equality for the small JSON values a delta carries (the board
// row, activity, the scheduled list, image dims). Both sides come from JSON,
// so key order is the broker's and stable; a plain stringify is enough.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAscending(items: ThreadItem[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i].id <= items[i - 1].id) return false;
  }
  return true;
}
