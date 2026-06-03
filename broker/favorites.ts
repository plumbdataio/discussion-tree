// Anchor (favorites) handlers. The UI calls these "anchors" / 「アンカー」
// but the implementation level uses "favorites" to match the schema.
//
// Each session keeps its own set of pinned thread items. attach_cc_session
// reclaims them across CC restarts via the same path that handles
// boards / pending_messages — see broker/sessions.ts handleAttachCCSession.

import type { Favorite } from "../shared/types.ts";
import {
  db,
  insertFavorite,
  removeFavoriteByThreadItem,
  selectFavoritesBySession,
} from "./db.ts";
import { broadcastToAll } from "./ws.ts";

function lookupAliveSessionByCcId(ccSessionId: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
    )
    .get(ccSessionId) as { id: string } | null;
  return row?.id ?? null;
}

// Resolve the broker session_id for a request that may have come in as
// either a raw session_id or via cc_session_id (e.g. the frontend uses the
// session_id it already has; some MCP-side callers only know the CC side).
function resolveSessionId(body: {
  session_id?: string;
  cc_session_id?: string;
}): string | null {
  if (body.session_id) return body.session_id;
  if (body.cc_session_id) return lookupAliveSessionByCcId(body.cc_session_id);
  return null;
}

export function handleAddFavorite(body: {
  session_id?: string;
  cc_session_id?: string;
  board_id?: string;
  node_id?: string;
  thread_item_id?: number;
}): { ok: boolean; error?: string; favorite?: Favorite } {
  const sessionId = resolveSessionId(body);
  if (!sessionId) return { ok: false, error: "session not found" };
  if (!body.board_id || !body.node_id || body.thread_item_id == null) {
    return { ok: false, error: "missing board_id / node_id / thread_item_id" };
  }
  // Sanity: the thread item must exist on the named board. Skipping this
  // would let a typo or stale frontend cache write a permanently-broken
  // favorite that points nowhere.
  const ti = db
    .prepare(
      "SELECT id FROM thread_items WHERE id = ? AND board_id = ? AND node_id = ?",
    )
    .get(body.thread_item_id, body.board_id, body.node_id) as
    | { id: number }
    | null;
  if (!ti) return { ok: false, error: "thread item not found on that node" };

  const now = new Date().toISOString();
  // INSERT OR IGNORE — the UI treats Anchor as a toggle, so a "re-add" on
  // an already-pinned item should be a quiet no-op (still returns ok=true
  // so the frontend doesn't show an error).
  insertFavorite.run(
    sessionId,
    body.board_id,
    body.node_id,
    body.thread_item_id,
    now,
  );
  const row = db
    .prepare(
      "SELECT id, session_id, board_id, node_id, thread_item_id, created_at FROM favorites WHERE session_id = ? AND thread_item_id = ?",
    )
    .get(sessionId, body.thread_item_id) as Favorite | null;

  if (row) {
    broadcastToAll({
      type: "favorite-added",
      session_id: sessionId,
      favorite: row,
    });
  }
  return { ok: true, favorite: row ?? undefined };
}

export function handleRemoveFavorite(body: {
  session_id?: string;
  cc_session_id?: string;
  thread_item_id?: number;
}): { ok: boolean; error?: string } {
  const sessionId = resolveSessionId(body);
  if (!sessionId) return { ok: false, error: "session not found" };
  if (body.thread_item_id == null) {
    return { ok: false, error: "missing thread_item_id" };
  }
  const res = removeFavoriteByThreadItem.run(sessionId, body.thread_item_id);
  // Always broadcast even when the row didn't exist — keeps multi-tab
  // clients in sync when one tab's state thinks something's pinned that
  // another tab already removed.
  broadcastToAll({
    type: "favorite-removed",
    session_id: sessionId,
    thread_item_id: body.thread_item_id,
  });
  return { ok: res.changes > 0 || true };
}

export function handleListFavorites(body: {
  session_id?: string;
  cc_session_id?: string;
}): { ok: boolean; favorites?: Favorite[]; error?: string } {
  const sessionId = resolveSessionId(body);
  if (!sessionId) return { ok: false, error: "session not found" };
  const rows = selectFavoritesBySession.all(sessionId) as Favorite[];
  return { ok: true, favorites: rows };
}

export const routes = {
  "/add-favorite": handleAddFavorite,
  "/remove-favorite": handleRemoveFavorite,
  "/list-favorites": handleListFavorites,
};
