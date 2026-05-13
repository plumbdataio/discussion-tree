// Board-level handlers: create, close (legacy), set-status, archive /
// unarchive. The structure-shape rejection (sub-items) and the cc_session_id
// requirement live here too because they're create-time invariants.

import { closeBoardStmt, db, insertBoard } from "./db.ts";
import { broadcast } from "./ws.ts";
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
  const allowed = ["active", "completed", "withdrawn", "paused"];
  if (!allowed.includes(body.status)) {
    return { ok: false, error: "invalid status: " + body.status };
  }
  db.run("UPDATE boards SET status = ? WHERE id = ?", [
    body.status,
    body.board_id,
  ]);
  // Mirror to legacy `closed` flag when the new status implies it.
  if (body.status === "completed") {
    db.run("UPDATE boards SET closed = 1 WHERE id = ?", [body.board_id]);
  }
  broadcast(body.board_id, {
    type: "board-status-update",
    status: body.status,
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

export const routes = {
  "/create-board": handleCreateBoard,
  "/close-board": handleCloseBoardReq,
  "/set-board-status": handleSetBoardStatus,
  "/archive-board": handleArchiveBoard,
  "/unarchive-board": handleUnarchiveBoard,
};
