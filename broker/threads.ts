// Thread / message handlers.
//
// /post-to-node persists a CC reply and bumps node status. /submit-answer is
// the user-side counterpart: it inserts a pending message and BLOCKS the
// HTTP response until the receiving CC actually polls (or until the timeout
// elapses). Mark-read endpoints flip read_at on existing thread items and
// fan out a sidebar-refresh so the unread dot updates everywhere.

import type { Board } from "../shared/types.ts";
import {
  bumpStatusToDiscussing,
  db,
  insertPending,
  insertThread,
  markDelivered,
  recomputeBoardStatus,
  selectBoard,
  selectPending,
  updateNodeStatus,
} from "./db.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
import { SUBMIT_DELIVERY_TIMEOUT_MS } from "./config.ts";
import { buildNodePath } from "./helpers.ts";

// Same helper as broker/nodes.ts — node status mutations may flip the
// parent board's auto-rollup, broadcast lets the sidebar follow. Returns
// { from, to } when the board actually moved so the HTTP response can
// report the transition back to the MCP tool caller.
function syncBoardStatus(
  boardId: string,
): { from: string; to: string } | null {
  const before = db
    .prepare("SELECT status FROM boards WHERE id = ?")
    .get(boardId) as { status: string } | null;
  const next = recomputeBoardStatus(boardId);
  if (!next) return null;
  broadcast(boardId, { type: "board-status-update", status: next });
  if (before && before.status !== next) {
    return { from: before.status, to: next };
  }
  return null;
}

export function handlePostToNode(body: any) {
  // 1. CC message goes in first so it appears before any status_change in
  //    the timeline.
  insertThread.run(
    body.board_id,
    body.node_id,
    "cc",
    body.message,
    new Date().toISOString(),
  );

  // 2. Status update + transition log (only when the status actually changed).
  let statusChanged = false;
  if (body.status) {
    const cur = db
      .prepare("SELECT status FROM nodes WHERE board_id = ? AND id = ?")
      .get(body.board_id, body.node_id) as { status: string } | null;
    const oldStatus = cur?.status;
    if (oldStatus !== body.status) {
      updateNodeStatus.run(body.status, body.board_id, body.node_id);
      insertThread.run(
        body.board_id,
        body.node_id,
        "system",
        `status_change:${oldStatus ?? "(unset)"}:${body.status}`,
        new Date().toISOString(),
      );
      statusChanged = true;
    }
  } else {
    // Backwards-compat fallback for clients that haven't picked up the new
    // required-status schema (shouldn't happen post-CC-restart).
    bumpStatusToDiscussing.run(body.board_id, body.node_id);
  }

  broadcast(body.board_id, {
    type: "thread-update",
    node_id: body.node_id,
    source: "cc",
  });
  if (statusChanged) {
    broadcast(body.board_id, {
      type: "status-update",
      node_id: body.node_id,
      status: body.status,
    });
  }
  const boardChange = syncBoardStatus(body.board_id);
  return boardChange
    ? { ok: true, board_status_changed: boardChange }
    : { ok: true };
}

export async function handleSubmitAnswer(body: any): Promise<
  | { ok: true; board_status_changed?: { from: string; to: string } }
  | { ok: false; error: string; reason: "no_recipient" | "timeout" }
> {
  const board = selectBoard.get(body.board_id) as Board | null;
  if (!board) {
    return { ok: false, error: "Board not found", reason: "no_recipient" };
  }

  // Reachability gate: the owning session must be alive AND attached to a CC
  // session_id (i.e. an MCP server is supposed to be polling for it).
  const owner = db
    .prepare("SELECT alive, cc_session_id FROM sessions WHERE id = ?")
    .get(board.session_id) as
    | { alive: number; cc_session_id: string | null }
    | null;
  if (!owner || owner.alive !== 1 || !owner.cc_session_id) {
    return {
      ok: false,
      error: "errors.no_recipient", // i18n key — frontend translates
      reason: "no_recipient",
    };
  }

  const now = new Date().toISOString();
  const path = buildNodePath(body.board_id, body.node_id);
  const insertResult = insertPending.run(
    board.session_id,
    body.board_id,
    body.node_id,
    path,
    body.text,
    now,
  );
  const pendingId = Number(insertResult.lastInsertRowid);

  // Poll until /poll-messages flips delivered=1, or we time out.
  const deadline = Date.now() + SUBMIT_DELIVERY_TIMEOUT_MS;
  const checkDelivered = db.prepare(
    "SELECT delivered FROM pending_messages WHERE id = ?",
  );
  while (Date.now() < deadline) {
    const row = checkDelivered.get(pendingId) as
      | { delivered: number }
      | null;
    if (row?.delivered === 1) {
      // Delivered: NOW persist into the public thread + broadcast so every
      // connected client (incl. the submitter) sees the real message.
      insertThread.run(body.board_id, body.node_id, "user", body.text, now);
      bumpStatusToDiscussing.run(body.board_id, body.node_id);
      broadcast(body.board_id, {
        type: "thread-update",
        node_id: body.node_id,
        source: "user",
      });
      const boardChange = syncBoardStatus(body.board_id);
      return boardChange
        ? { ok: true, board_status_changed: boardChange }
        : { ok: true };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Timeout: mark cancelled so a late MCP poll won't deliver a stale message
  // the user has likely retried by hand.
  db.run("UPDATE pending_messages SET cancelled = 1 WHERE id = ?", [
    pendingId,
  ]);
  return {
    ok: false,
    error: "errors.delivery_timeout",
    reason: "timeout",
  };
}

export function handlePollMessages(body: any) {
  const messages = selectPending.all(body.session_id) as any[];
  for (const m of messages) markDelivered.run(m.id);
  return { messages };
}

function broadcastUnreadAll() {
  // Tell every connected client to refetch the sidebar — unread counts may
  // have shifted on a board they're not currently viewing.
  broadcastToAll({ type: "sidebar-refresh" });
}

export function handleMarkThreadItemsRead(body: {
  thread_item_ids?: number[];
}): { ok: boolean; marked?: number } {
  const ids = body.thread_item_ids;
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, marked: 0 };
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  // Only set read_at on rows where it's still NULL — re-marking is a no-op.
  const result = db.run(
    `UPDATE thread_items SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`,
    [now, ...ids],
  );
  // Fan out per affected board so its sidebar dot recalculates. Also refresh
  // every other tab via broadcastUnreadAll().
  const boards = db
    .prepare(
      `SELECT DISTINCT board_id FROM thread_items WHERE id IN (${placeholders})`,
    )
    .all(...ids) as { board_id: string }[];
  for (const b of boards) {
    broadcast(b.board_id, { type: "unread-update" });
    broadcastUnreadAll();
  }
  return { ok: true, marked: result.changes };
}

export function handleMarkBoardRead(body: { board_id?: string }): {
  ok: boolean;
  marked?: number;
} {
  if (!body.board_id) return { ok: false };
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE thread_items SET read_at = ? WHERE board_id = ? AND read_at IS NULL",
    [now, body.board_id],
  );
  broadcast(body.board_id, { type: "unread-update" });
  broadcastUnreadAll();
  return { ok: true, marked: result.changes };
}

export const routes = {
  "/post-to-node": handlePostToNode,
  "/submit-answer": handleSubmitAnswer,
  "/poll-messages": handlePollMessages,
  "/mark-thread-items-read": handleMarkThreadItemsRead,
  "/mark-board-read": handleMarkBoardRead,
};
