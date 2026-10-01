// /notify-session: an inbound endpoint for EXTERNAL automated notifiers (e.g. a
// local Sentry-alert relay) to reach a specific CC agent through dt.
//
// Why not the existing paths: /post-to-node writes a thread item as source "cc"
// and never reaches the agent; /submit-answer reaches the agent but records the
// text as the USER, which would hand an automated, untrusted payload the user's
// authority. This is a third kind of post: source "external", labelled with the
// relay's name, delivered through the same pending_messages -> MCP poll ->
// channel push pipeline as a user reply (kind "external_notify"; the poller frames
// it as untrusted, see server/external-notify.ts).
//
// Unlike /submit-answer this does NOT block until the CC polls: the thread item,
// the queue row and the unanswered flag are all written up front, so the relay
// gets an immediate answer and a CC that never replies keeps being nagged by the
// Stop hook (the unanswered_nodes row is the whole point — an agent that sees
// the notice but never answers on dt must not be able to let it drop silently).

import type { Board } from "../shared/types.ts";
import {
  db,
  insertExternalThreadItem,
  insertPending,
  selectBoard,
  setPendingThreadItem,
} from "./db.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
import { buildNodePath } from "./helpers.ts";
import { syncBoardStatus } from "./threads.ts";

export const EXTERNAL_NOTIFY_MAX_TEXT = 8000;
export const EXTERNAL_LABEL_MAX = 40;
export const EXTERNAL_LABEL_DEFAULT = "external";

// Reduce a caller-supplied label to a short token that is safe to splice into
// the channel reminder and the UI without any escaping: runs of characters
// outside [A-Za-z0-9._-] collapse to "-", edge dashes are trimmed, and the
// result is capped. Anything that ends up empty (or wasn't a string) becomes
// the default.
export function sanitizeSourceLabel(raw: unknown): string {
  if (typeof raw !== "string") return EXTERNAL_LABEL_DEFAULT;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, EXTERNAL_LABEL_MAX)
    .replace(/-+$/g, "");
  return cleaned || EXTERNAL_LABEL_DEFAULT;
}

export type NotifySessionError =
  | "invalid_request"
  | "board_not_found"
  | "node_not_found"
  | "invalid_target"
  | "text_too_long"
  | "no_recipient";

export type NotifySessionResult =
  | { ok: true; message_id: number; source_label: string }
  | { ok: false; error: string; reason: NotifySessionError };

export function handleNotifySession(body: any): NotifySessionResult {
  const boardId = body?.board_id;
  if (typeof boardId !== "string" || boardId.length === 0) {
    return {
      ok: false,
      error: "board_id is required (string)",
      reason: "invalid_request",
    };
  }
  const rawNode = body?.node_id;
  if (rawNode !== undefined && rawNode !== null && typeof rawNode !== "string") {
    return {
      ok: false,
      error: "node_id must be a string when given",
      reason: "invalid_request",
    };
  }
  const nodeId = rawNode ? rawNode : "main";
  const text = body?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      ok: false,
      error: "text is required (non-empty string)",
      reason: "invalid_request",
    };
  }
  if (text.length > EXTERNAL_NOTIFY_MAX_TEXT) {
    return {
      ok: false,
      error: `text is too long (${text.length} chars; max ${EXTERNAL_NOTIFY_MAX_TEXT})`,
      reason: "text_too_long",
    };
  }
  const label = sanitizeSourceLabel(body?.source_label);

  const board = selectBoard.get(boardId) as Board | null;
  if (!board) {
    return { ok: false, error: "board not found", reason: "board_not_found" };
  }

  // Same target rules as handlePostToNode: concerns and checklist nodes render
  // no thread, so a notice there would be invisible yet keep the unread dot and
  // the unanswered nag lit forever. A soft-deleted node is equally invisible.
  const target = db
    .prepare(
      "SELECT kind, is_checklist, deleted_at FROM nodes WHERE board_id = ? AND id = ?",
    )
    .get(boardId, nodeId) as
    | { kind: string; is_checklist: number; deleted_at: string | null }
    | null;
  if (!target || target.deleted_at) {
    return { ok: false, error: "node not found", reason: "node_not_found" };
  }
  if (target.kind === "concern") {
    return {
      ok: false,
      error:
        "target node is a concern (category header) and has no thread; pass an item node_id",
      reason: "invalid_target",
    };
  }
  if (target.is_checklist) {
    return {
      ok: false,
      error:
        "target node is a checklist node and has no thread; pass a normal item node_id",
      reason: "invalid_target",
    };
  }

  // Reachability gate, identical to handleSubmitAnswer: somebody must be
  // polling for this session, otherwise the notice would sit in the queue with
  // nobody to read it while the relay believes it was delivered.
  const owner = db
    .prepare("SELECT alive, cc_session_id FROM sessions WHERE id = ?")
    .get(board.session_id) as
    | { alive: number; cc_session_id: string | null }
    | null;
  if (!owner || owner.alive !== 1 || !owner.cc_session_id) {
    return { ok: false, error: "no_recipient", reason: "no_recipient" };
  }

  const now = new Date().toISOString();
  const path = buildNodePath(boardId, nodeId);

  // All three writes land together: a half-written notice (thread item without
  // the nag row, or a queue row without its thread item) is worse than none.
  const messageId = db.transaction(() => {
    // 1. The thread item, written NOW (not at delivery like a user reply), so
    //    the user sees the notice even before the CC drains it.
    const ins = insertExternalThreadItem(boardId, nodeId, text, now, label);
    const threadItemId = Number(ins.lastInsertRowid);
    // 2. The delivery row, linked to that item so handlePollMessages does not
    //    materialize a second copy (it only materializes user_input_relay /
    //    map_chat, and only while thread_item_id is NULL).
    const pend = insertPending.run(
      board.session_id,
      boardId,
      nodeId,
      path,
      text,
      now,
      "external_notify",
    );
    setPendingThreadItem.run(threadItemId, Number(pend.lastInsertRowid));
    // 3. Flag the node unanswered for the Stop-hook nag. Upsert keeps the
    //    ORIGINAL created_at so the longest-waiting node stays first. A
    //    post_to_node carrying a real message on this node clears it.
    db.run(
      `INSERT INTO unanswered_nodes (session_id, board_id, node_id, node_path, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, board_id, node_id)
       DO UPDATE SET node_path = excluded.node_path`,
      [board.session_id, boardId, nodeId, path, now],
    );
    return threadItemId;
  })();

  broadcast(boardId, {
    type: "thread-update",
    node_id: nodeId,
    source: "external",
  });
  // The node's own status is left alone; only the board-level "a fresh post
  // resurfaces a shelved board" rule applies (paused -> discussing).
  syncBoardStatus(boardId);
  // The user watches dt only: nudge every tab's sidebar so the unread dot
  // appears now rather than on the next periodic refetch.
  broadcastToAll({ type: "sidebar-refresh" });

  return { ok: true, message_id: messageId, source_label: label };
}

export const routes = {
  "/notify-session": handleNotifySession,
};
