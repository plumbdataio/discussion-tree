// Per-board "structure-change log" — a dedicated concern + item that
// records every BoardStructureRequestModal submission and (later) the
// agent's response, so the user has an audit trail of "what was asked,
// what was done" to the board shape.
//
// The concern and the item are marked with nodes.is_log=1 and are NOT
// deletable / movable / reorderable. They are auto-created on first
// access via ensureBoardLogNode(boardId) — this avoids a separate
// migration pass on existing boards. Default boards are skipped (they
// don't support structure changes anyway).

import { randomBytes } from "node:crypto";
import { db } from "./db.ts";

// Local id generator (128-bit hex). Duplicating the broker's
// generateId here avoids a circular dep with helpers.ts (which
// imports getBoardView which now wants ensureBoardLogNode).
function newId(): string {
  return randomBytes(16).toString("hex");
}

const LOG_CONCERN_TITLE = "Board log";
const LOG_ITEM_TITLE = "Structure changes";

export interface BoardLogIds {
  concernId: string;
  nodeId: string;
}

// Returns the (concern_id, node_id) of the board-log structure for
// `boardId`, creating them on the fly the first time we see this board.
// Idempotent; safe to call on every getBoardView.
export function ensureBoardLogNode(boardId: string): BoardLogIds | null {
  // Default boards never get a log node — their structure is fixed.
  const board = db
    .prepare("SELECT is_default FROM boards WHERE id = ?")
    .get(boardId) as { is_default: number } | undefined;
  if (!board) return null;
  if (board.is_default) return null;

  const existingConcern = db
    .prepare(
      "SELECT id FROM nodes WHERE board_id = ? AND is_log = 1 AND kind = 'concern' AND deleted_at IS NULL",
    )
    .get(boardId) as { id: string } | undefined;
  const existingItem = db
    .prepare(
      "SELECT id FROM nodes WHERE board_id = ? AND is_log = 1 AND kind = 'item' AND deleted_at IS NULL",
    )
    .get(boardId) as { id: string } | undefined;

  if (existingConcern && existingItem) {
    return { concernId: existingConcern.id, nodeId: existingItem.id };
  }

  // Otherwise create whichever side is missing (normal flow on first call
  // is both missing). We don't try to repair half-created state from a
  // crash; the SELECT above already picked up anything that survives.
  const now = new Date().toISOString();

  // Place the log concern at the END so it doesn't bump the user's
  // primary content to the right. Compute the next available position.
  const maxPos = db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) AS m FROM nodes WHERE board_id = ? AND parent_id IS NULL AND deleted_at IS NULL",
    )
    .get(boardId) as { m: number };

  const concernId = existingConcern?.id ?? newId();
  if (!existingConcern) {
    db.prepare(
      `INSERT INTO nodes
         (board_id, id, parent_id, kind, title, context, status, position, created_at, is_log)
       VALUES (?, ?, NULL, 'concern', ?, '', 'pending', ?, ?, 1)`,
    ).run(boardId, concernId, LOG_CONCERN_TITLE, maxPos.m + 1, now);
  }

  const nodeId = existingItem?.id ?? newId();
  if (!existingItem) {
    db.prepare(
      `INSERT INTO nodes
         (board_id, id, parent_id, kind, title, context, status, position, created_at, is_log)
       VALUES (?, ?, ?, 'item', ?, '', 'pending', 0, ?, 1)`,
    ).run(boardId, nodeId, concernId, LOG_ITEM_TITLE, now);
  }

  return { concernId, nodeId };
}

// Throws if the node is a board-log node. Used by delete/move/reorder
// handlers to refuse destructive ops on the log structure.
export function assertNotLogNode(boardId: string, nodeId: string): void {
  const row = db
    .prepare("SELECT is_log FROM nodes WHERE board_id = ? AND id = ?")
    .get(boardId, nodeId) as { is_log: number } | undefined;
  if (row?.is_log === 1) {
    throw new Error("board-log node is protected from structural changes");
  }
}
