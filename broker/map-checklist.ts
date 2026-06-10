// Map checklist handlers — the map-side counterpart to checklist.ts. A map
// node can be flagged is_checklist=1 (mark_map_checklist_node), after which it
// carries a list of tracked items. The items REUSE the same checklist_items
// table as boards, keyed by board_id = map_id, node_id = map node id (a map_id
// never collides with a board_id, and the item id space is global, so the two
// domains share storage without clashing).
//
// Kept SEPARATE from checklist.ts because the board handlers validate their
// node against the `nodes` table; a map node lives in `map_nodes`. These map
// handlers validate against map_nodes and broadcast a `map-update` (so the
// open canvas refetches), instead of a board structure-update.

import {
  bumpMapChecklistVersion,
  db,
  selectMap,
  selectMapNode,
  setMapChecklistRead,
  setMapNodeChecklist,
} from "./db.ts";
import { broadcast } from "./ws.ts";

const insertItem = db.prepare(
  `INSERT INTO checklist_items (board_id, node_id, summary, status, drop_reason, source_node_id, position, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selectItem = db.prepare(`SELECT * FROM checklist_items WHERE id = ?`);
const selectMaxPos = db.prepare(
  `SELECT MAX(position) AS m FROM checklist_items WHERE board_id = ? AND node_id = ?`,
);
const updateItem = db.prepare(
  `UPDATE checklist_items SET summary = ?, status = ?, drop_reason = ? WHERE id = ?`,
);
const selectThreadCount = db.prepare(
  `SELECT COUNT(*) AS c FROM thread_items WHERE board_id = ? AND node_id = ?`,
);

const VALID_STATUS = new Set(["pending", "in-progress", "done", "dropped"]);

function emit(mapId: string) {
  broadcast(mapId, { type: "map-update" });
}

// Flag (or unflag) an existing map node as a checklist node. Like the board
// version, promoting a node that already has conversation messages is refused
// (the read-only checklist card does not render a thread, so those messages
// would silently vanish from the UI) — make a fresh node and flag that.
export function handleMarkMapChecklist(body: {
  map_id?: string;
  node_id?: string;
  is_checklist?: boolean;
}): { ok: boolean; error?: string } {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  if (!selectMapNode.get(mapId, nodeId)) {
    return { ok: false, error: "map node not found" };
  }
  const promoting = body.is_checklist !== false;
  if (promoting) {
    const tc = selectThreadCount.get(mapId, nodeId) as { c: number };
    if (tc.c > 0) {
      return {
        ok: false,
        error: `map node has ${tc.c} conversation message(s) that the read-only checklist card does not render — flagging it would hide them. Add a fresh node and flag THAT as the checklist node instead.`,
      };
    }
  }
  setMapNodeChecklist.run(promoting ? 1 : 0, mapId, nodeId);
  // Becoming a checklist node makes it freshly unread (like a new node) — bump
  // the version so the canvas shows the unread cue until the user views it.
  if (promoting) bumpMapChecklistVersion.run(mapId, nodeId);
  emit(mapId);
  return { ok: true };
}

// Append a line to a map checklist node as a new pending item. Map checklist
// items are intentionally simple — summary + status only (no cross-board
// source citations like the board checklist), since a map is a single-surface
// working list.
export function handleRecordMapDecision(body: {
  map_id?: string;
  node_id?: string;
  summary?: string;
}): { ok: boolean; item_id?: number; error?: string } {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? "");
  const summary = body.summary?.trim();
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const node = selectMapNode.get(mapId, nodeId) as
    | { is_checklist: number }
    | undefined;
  if (!node) return { ok: false, error: "map node not found" };
  if (!node.is_checklist) {
    return {
      ok: false,
      error:
        "map node is not a checklist node (is_checklist=0). Flag it first with mark_map_checklist_node.",
    };
  }
  if (!summary) return { ok: false, error: "summary is required" };
  const pos =
    (((selectMaxPos.get(mapId, nodeId) as { m: number | null }).m) ?? -1) + 1;
  const now = new Date().toISOString();
  const res = insertItem.run(
    mapId,
    nodeId,
    summary,
    "pending",
    null,
    null,
    pos,
    now,
  );
  // A new item makes the checklist unread again (same as a new CC message).
  bumpMapChecklistVersion.run(mapId, nodeId);
  emit(mapId);
  return { ok: true, item_id: Number(res.lastInsertRowid) };
}

// Update a map checklist item (status / summary / drop_reason). Same rules as
// the board version (status=dropped requires drop_reason; moving off dropped
// clears it). Guarded so it only touches items that belong to a MAP — a board
// item must go through update_decision.
export function handleUpdateMapDecision(body: {
  item_id?: number;
  status?: string;
  summary?: string;
  drop_reason?: string;
}): { ok: boolean; error?: string } {
  if (body.item_id == null) return { ok: false, error: "item_id is required" };
  const cur = selectItem.get(body.item_id) as
    | {
        id: number;
        board_id: string;
        node_id: string;
        summary: string;
        status: string;
        drop_reason: string | null;
      }
    | undefined;
  if (!cur) return { ok: false, error: "checklist item not found" };
  if (!selectMap.get(cur.board_id)) {
    return {
      ok: false,
      error:
        "this checklist item belongs to a board, not a map — use update_decision instead.",
    };
  }

  const nextStatus = body.status ?? cur.status;
  if (!VALID_STATUS.has(nextStatus)) {
    return {
      ok: false,
      error: `invalid status '${nextStatus}' (expected pending|in-progress|done|dropped)`,
    };
  }
  const trimmed = body.summary?.trim();
  const nextSummary = trimmed ? trimmed : cur.summary;

  let nextReason: string | null;
  if (nextStatus === "dropped") {
    const reason = body.drop_reason?.trim() || cur.drop_reason || "";
    if (!reason) {
      return { ok: false, error: "drop_reason is required when status=dropped" };
    }
    nextReason = reason;
  } else {
    nextReason = null;
  }

  updateItem.run(nextSummary, nextStatus, nextReason, body.item_id);
  // A status/summary change makes the checklist unread again. board_id == map_id.
  bumpMapChecklistVersion.run(cur.board_id, cur.node_id);
  emit(cur.board_id);
  return { ok: true };
}

// Stamp a checklist node read (the user dwelled on it). Mirrors marking a
// thread's CC messages read — the canvas unread cue clears.
export function handleMarkMapChecklistRead(body: {
  map_id?: string;
  node_id?: string;
  version?: number;
}): { ok: boolean; error?: string } {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const node = selectMapNode.get(mapId, nodeId) as
    | { checklist_version: number }
    | undefined;
  if (!node) return { ok: false, error: "map node not found" };
  // Only mark read up to the version the client actually saw — a change that
  // landed after it rendered must stay unread. Fall back to the current
  // version if the client didn't say (older callers).
  const observed =
    typeof body.version === "number"
      ? body.version
      : (node.checklist_version ?? 0);
  setMapChecklistRead.run(observed, mapId, nodeId, observed);
  emit(mapId);
  return { ok: true };
}

export const routes = {
  "/map-mark-checklist": handleMarkMapChecklist,
  "/map-record-decision": handleRecordMapDecision,
  "/map-update-decision": handleUpdateMapDecision,
  "/map-checklist-read": handleMarkMapChecklistRead,
};
