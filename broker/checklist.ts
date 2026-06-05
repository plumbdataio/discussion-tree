// Decision-checklist mutation handlers. The checklist UI is read-only; all
// writes flow through these two endpoints, called by the record_decision /
// update_decision MCP tools. Each row in checklist_items is one tracked
// decision under a node flagged is_checklist=1.

import { db } from "./db.ts";
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
const selectNode = db.prepare(
  `SELECT id, is_checklist FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL`,
);
const setNodeChecklist = db.prepare(
  `UPDATE nodes SET is_checklist = ? WHERE board_id = ? AND id = ? AND deleted_at IS NULL`,
);

const VALID_STATUS = new Set(["pending", "in-progress", "done", "dropped"]);

// Append a decision to a checklist node as a new pending item. The node must
// exist on the board and be flagged is_checklist=1 (created via a normal
// node + the is_checklist property) — we don't auto-create checklist nodes.
export function handleRecordDecision(body: {
  board_id?: string;
  node_id?: string;
  summary?: string;
  source_node_id?: string | null;
}): { ok: boolean; item_id?: number; error?: string } {
  const { board_id, node_id } = body;
  const summary = body.summary?.trim();
  if (!board_id || !node_id || !summary) {
    return { ok: false, error: "board_id, node_id and summary are required" };
  }
  const node = selectNode.get(board_id, node_id) as
    | { is_checklist: number }
    | undefined;
  if (!node) return { ok: false, error: "node not found" };
  if (!node.is_checklist) {
    return {
      ok: false,
      error:
        "node is not a checklist node (is_checklist=0). Flag a node as a checklist node first.",
    };
  }
  const pos =
    (((selectMaxPos.get(board_id, node_id) as { m: number | null }).m) ?? -1) +
    1;
  const res = insertItem.run(
    board_id,
    node_id,
    summary,
    "pending",
    null,
    body.source_node_id ?? null,
    pos,
    new Date().toISOString(),
  );
  broadcast(board_id, { type: "structure-update" });
  return { ok: true, item_id: Number(res.lastInsertRowid) };
}

// Update a checklist item: change status, edit the summary, and/or set a
// drop reason. status=dropped requires a non-empty drop_reason (the only
// place this is enforced — the UI can't edit at all). Moving OFF dropped
// clears the reason.
export function handleUpdateDecision(body: {
  item_id?: number;
  status?: string;
  summary?: string;
  drop_reason?: string;
}): { ok: boolean; error?: string } {
  if (body.item_id == null) {
    return { ok: false, error: "item_id is required" };
  }
  const cur = selectItem.get(body.item_id) as
    | {
        id: number;
        board_id: string;
        summary: string;
        status: string;
        drop_reason: string | null;
      }
    | undefined;
  if (!cur) return { ok: false, error: "checklist item not found" };

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
    // A non-dropped item carries no drop reason.
    nextReason = null;
  }

  updateItem.run(nextSummary, nextStatus, nextReason, body.item_id);
  broadcast(cur.board_id, { type: "structure-update" });
  return { ok: true };
}

// Flag (or unflag) an existing ordinary node as a decision-checklist node.
// Checklist nodes are made deliberately (never auto-created) — this is how a
// normal node gains its checklist_items list. is_checklist defaults to true.
export function handleSetNodeChecklist(body: {
  board_id?: string;
  node_id?: string;
  is_checklist?: boolean;
}): { ok: boolean; error?: string } {
  const { board_id, node_id } = body;
  if (!board_id || !node_id) {
    return { ok: false, error: "board_id and node_id are required" };
  }
  const node = selectNode.get(board_id, node_id) as { id: string } | undefined;
  if (!node) return { ok: false, error: "node not found" };
  setNodeChecklist.run(body.is_checklist === false ? 0 : 1, board_id, node_id);
  broadcast(board_id, { type: "structure-update" });
  return { ok: true };
}

export const routes = {
  "/record-decision": handleRecordDecision,
  "/update-decision": handleUpdateDecision,
  "/set-node-checklist": handleSetNodeChecklist,
};
