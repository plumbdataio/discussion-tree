// Default conversation board: one auto-created per cc_session_id, with a
// fixed structure (1 concern → 1 item). Structural-mod handlers consult
// isDefaultBoard() and return DEFAULT_BOARD_LOCKED_ERROR rather than mutate.
//
// Seed text is stored in English in the DB; the frontend overrides display
// strings via i18n keys (default_board.title / .item_title /
// .welcome_message) when it detects is_default — so the user always sees the
// right language regardless of what's persisted.

import { db, insertNode } from "./db.ts";
import { generateId } from "./helpers.ts";

export const DEFAULT_BOARD_LOCKED_ERROR =
  "Default conversation board has a fixed structure — concerns / items cannot be added, moved, reordered, or deleted. Open a regular board for option-decision work.";

export function isDefaultBoard(boardId: string): boolean {
  const row = db
    .prepare("SELECT is_default FROM boards WHERE id = ?")
    .get(boardId) as { is_default: number } | null;
  return row?.is_default === 1;
}

export function ensureDefaultBoard(
  sessionId: string,
  ccSessionId: string,
): string {
  // Look across ALL boards owned by sessions with this cc_session_id (any
  // state — alive or soft-deleted). The reclaim path in handleAttachCCSession
  // already moved any prior default to our session_id, so this query is
  // mostly "do we have one under sessionId yet".
  const existing = db
    .prepare(
      `SELECT b.id FROM boards b
       JOIN sessions s ON b.session_id = s.id
       WHERE s.cc_session_id = ? AND b.is_default = 1
       LIMIT 1`,
    )
    .get(ccSessionId) as { id: string } | null;
  if (existing) return existing.id;

  const boardId = generateId("bd");
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO boards (id, title, session_id, created_at, is_default) VALUES (?, ?, ?, ?, 1)",
    [boardId, "Conversation", sessionId, now],
  );
  insertNode.run(
    boardId,
    "conversation",
    null,
    "concern",
    "Conversation",
    "",
    "pending",
    0,
    now,
  );
  insertNode.run(
    boardId,
    "main",
    "conversation",
    "item",
    "Conversation",
    "Posts here are delivered as direct messages to Claude Code.",
    "pending",
    0,
    now,
  );
  return boardId;
}
