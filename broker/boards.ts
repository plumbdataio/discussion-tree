// Board-level handlers: create, close (legacy), set-status, archive /
// unarchive. The structure-shape rejection (sub-items) and the cc_session_id
// requirement live here too because they're create-time invariants.

import {
  closeBoardStmt,
  db,
  insertBoard,
  recomputeBoardStatus,
} from "./db.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
import { PUBLIC_URL } from "./config.ts";
import {
  generateId,
  insertNodesRecursive,
  structureHasSubItems,
} from "./helpers.ts";

export function handleCreateBoard(body: any):
  | { board_id: string; url: string }
  | { error: string } {
  // create_board requires a cc_session_id binding so the board's ownership
  // survives a future MCP-server restart. Without it the broker has no way
  // to reclaim the board on attach_cc_session and the board orphans.
  const session = db
    .prepare("SELECT cc_session_id FROM sessions WHERE id = ?")
    .get(body.session_id) as { cc_session_id: string | null } | null;
  if (!session) {
    return { error: "Unknown session — register first" };
  }
  if (!session.cc_session_id) {
    return {
      error:
        "Refusing create_board: this MCP session has not yet been bound to a CC session_id. Call attach_cc_session(<your CC session_id from SessionStart>) FIRST so the board survives CC restarts. Otherwise this board would orphan after the next restart.",
    };
  }

  if (structureHasSubItems(body.structure)) {
    return {
      error:
        "Refusing create_board: sub-items (items nested under items) are not supported. Boards are 2-level (concern → items). Either flatten the structure or split into multiple concerns.",
    };
  }

  const boardId = generateId("bd");
  const now = new Date().toISOString();
  insertBoard.run(boardId, body.structure.title, body.session_id, now);
  insertNodesRecursive(
    boardId,
    null,
    "concern",
    body.structure.concerns ?? [],
  );
  return {
    board_id: boardId,
    url: `${PUBLIC_URL}/board/${boardId}`,
  };
}

// Legacy alias: close_board === set_board_status('completed') + flip the
// closed flag for backward compat.
export function handleCloseBoardReq(body: any) {
  closeBoardStmt.run(body.board_id);
  db.run("UPDATE boards SET status = 'completed' WHERE id = ?", [
    body.board_id,
  ]);
  broadcast(body.board_id, { type: "closed" });
  broadcast(body.board_id, {
    type: "board-status-update",
    status: "completed",
  });
  return { ok: true };
}

export function handleSetBoardStatus(body: any) {
  // "discussing" / "settled" are normally auto-derived from node statuses
  // (see broker/db.ts:recomputeBoardStatus), so explicit set calls for
  // those values will be quickly overwritten on the next node mutation —
  // they're accepted for completeness but rarely useful.
  const allowed = [
    "discussing",
    "settled",
    "completed",
    "withdrawn",
    "paused",
  ];
  // Backwards-compat: callers that still pass the legacy "active" value
  // are silently normalized to "discussing" (the closest match in the new
  // taxonomy).
  let next = body.status;
  if (next === "active") next = "discussing";
  if (!allowed.includes(next)) {
    return { ok: false, error: "invalid status: " + body.status };
  }
  db.run("UPDATE boards SET status = ? WHERE id = ?", [next, body.board_id]);
  // Mirror to legacy `closed` flag when the new status implies it.
  if (next === "completed") {
    db.run("UPDATE boards SET closed = 1 WHERE id = ?", [body.board_id]);
  }
  broadcast(body.board_id, {
    type: "board-status-update",
    status: next,
  });
  return { ok: true };
}

export function handleArchiveBoard(body: any) {
  db.run("UPDATE boards SET archived = 1 WHERE id = ?", [body.board_id]);
  return { ok: true };
}

export function handleUnarchiveBoard(body: any) {
  db.run("UPDATE boards SET archived = 0 WHERE id = ?", [body.board_id]);
  return { ok: true };
}

// Rename a board. The default conversation board is excluded: its title is a
// localized fixed label in the UI (it ignores the stored title), so renaming
// it would do nothing visible — reject it with a clear message instead.
export function handleRenameBoard(body: any) {
  const boardId = String(body?.board_id ?? "");
  const title = String(body?.title ?? "").trim();
  if (!boardId || !title) {
    return { ok: false, error: "board_id and a non-empty title are required" };
  }
  const board = db
    .prepare("SELECT is_default FROM boards WHERE id = ?")
    .get(boardId) as { is_default: number } | undefined;
  if (!board) return { ok: false, error: "board not found" };
  if (board.is_default) {
    return {
      ok: false,
      error:
        "the default conversation board's title is a fixed localized label and can't be renamed.",
    };
  }
  db.run("UPDATE boards SET title = ? WHERE id = ?", [title, boardId]);
  // Board header (document title + breadcrumb) refetches on a board update;
  // the sidebar shows board titles too, so nudge it.
  broadcast(boardId, { type: "structure-update" });
  broadcastToAll({ type: "sidebar-refresh" });
  return { ok: true };
}

// Toggle the per-board automatic status rollup. Off freezes the board status so
// a status-tracking board doesn't auto-flip to settled (and vanish behind the
// sidebar filter) once all its nodes are marked done. On re-enable we recompute
// immediately so the frozen status catches up to the current node states.
export function handleSetBoardAutoStatus(body: any) {
  const boardId = String(body?.board_id ?? "");
  if (!boardId) return { ok: false, error: "board_id is required" };
  const enabled = body?.enabled ? 1 : 0;
  db.run("UPDATE boards SET auto_status_sync = ? WHERE id = ?", [
    enabled,
    boardId,
  ]);
  if (enabled) {
    // Re-enabling: catch the frozen status up to the current node rollup.
    const next = recomputeBoardStatus(boardId);
    if (next) broadcast(boardId, { type: "board-status-update", status: next });
  }
  // The board header renders the toggle state; nudge a board refetch. The
  // sidebar filters on board status, so refresh it too.
  broadcast(boardId, { type: "structure-update" });
  broadcastToAll({ type: "sidebar-refresh" });
  return { ok: true, auto_status_sync: enabled };
}

export const routes = {
  "/create-board": handleCreateBoard,
  "/close-board": handleCloseBoardReq,
  "/set-board-status": handleSetBoardStatus,
  "/set-board-auto-status": handleSetBoardAutoStatus,
  "/rename-board": handleRenameBoard,
  "/archive-board": handleArchiveBoard,
  "/unarchive-board": handleUnarchiveBoard,
};
