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
  setPendingThreadItem,
  updateNodeStatus,
} from "./db.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
import { onBoardSettled, onNodeSettled } from "./checklist.ts";
import { SUBMIT_DELIVERY_TIMEOUT_MS } from "./config.ts";
import { buildNodePath } from "./helpers.ts";
import { ensureBoardLogNode } from "./structure-log.ts";
import { markWorkingFromUserSubmit } from "./activity.ts";

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
    if (next === "settled") onBoardSettled(boardId);
    return { from: before.status, to: next };
  }
  return null;
}

export function handlePostToNode(body: any) {
  // Schema-level invariant (same posture as set_node_status on concerns):
  // concerns are category headers and don't render threads in the UI.
  // A post landing on a concern would be stranded — visible in the DB but
  // unreachable through the UI, and it would inflate the sidebar's unread
  // dot on a board the user can't possibly clear. Reject early.
  const target = db
    .prepare("SELECT kind, is_checklist FROM nodes WHERE board_id = ? AND id = ?")
    .get(body.board_id, body.node_id) as
    | { kind: string; is_checklist: number }
    | null;
  if (!target) {
    return { ok: false, error: "node not found" };
  }
  if (target.kind === "concern") {
    return {
      ok: false,
      error:
        "post_to_node target must be an item — concerns are category headers and don't render threads in the UI. Pick a child item, or add one with add_item.",
    };
  }
  // Same posture as concerns: a checklist node renders ONLY its checklist
  // items (no thread), so a post here would be invisible in the UI yet still
  // inflate the unread dot the user can never clear — and the CC would look
  // like it "sent a message and got no reply". Reject early. (Record decisions
  // with record_decision; converse on a different, normal node.)
  if (target.is_checklist) {
    return {
      ok: false,
      error:
        "post_to_node target is a checklist node — it shows only its checklist items, not a thread, so a reply here would be invisible to the user. Post to a different node instead; to add a checklist line use record_decision.",
    };
  }

  // Zero the owning session's unanswered counter. We treat a single CC
  // post as covering every outstanding user submission so far (the
  // "bundled-reply" pattern — the standard case when the user fires N
  // channel pushes in quick succession and the CC answers them in one
  // synthesized reply). If a FRESH user submission arrives after this
  // post, handleSubmitAnswer bumps the counter back to 1 and the Stop
  // hook nags correctly.
  //
  // This used to be `MAX(0, n - 1)` (= per-post decrement), but that
  // produced spurious nags every time the CC bundled a reply: the user
  // sent 3 submissions, the CC posted once, the counter stayed at 2,
  // and the Stop hook insisted on more replies even though there was
  // nothing left to answer. reset_unanswered_posts now serves only as
  // an escape hatch for "yield without posting" cases.
  const ownerRow = db
    .prepare("SELECT session_id FROM boards WHERE id = ?")
    .get(body.board_id) as { session_id: string } | null;
  if (ownerRow) {
    db.run("UPDATE sessions SET unanswered_user_posts = 0 WHERE id = ?", [
      ownerRow.session_id,
    ]);
  }

  // 1. CC message goes in first so it appears before any status_change in
  //    the timeline. Keep its row id — returned as message_id so the caller
  //    can reference this exact post later (e.g. as a checklist source).
  const inserted = insertThread.run(
    body.board_id,
    body.node_id,
    "cc",
    body.message,
    new Date().toISOString(),
  );
  const messageId = Number(inserted.lastInsertRowid);

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
    // Per-node checklist nudge (no-op unless the board has a checklist node).
    onNodeSettled(body.board_id, body.node_id, body.status);
  }
  const boardChange = syncBoardStatus(body.board_id);
  return boardChange
    ? { ok: true, message_id: messageId, board_status_changed: boardChange }
    : { ok: true, message_id: messageId };
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

  // Two flavors of submission share this endpoint:
  //   - user_input_relay (default): a reply targeted at a specific node, gets
  //     mirrored into that node's thread on delivery.
  //   - board_structure_request: a free-text instruction to restructure the
  //     board (add concerns/items, edit, rename). No specific node is
  //     targeted; the broker uses a synthetic node_id and skips the thread
  //     mirror so the request doesn't leave an orphan thread item.
  const kind: "user_input_relay" | "board_structure_request" =
    body.kind === "board_structure_request"
      ? "board_structure_request"
      : "user_input_relay";
  const isStructureRequest = kind === "board_structure_request";

  const now = new Date().toISOString();
  const nodeId = isStructureRequest ? "__board__" : body.node_id;
  const path = isStructureRequest
    ? board.title
    : buildNodePath(body.board_id, body.node_id);
  const insertResult = insertPending.run(
    board.session_id,
    body.board_id,
    nodeId,
    path,
    body.text,
    now,
    kind,
  );
  const pendingId = Number(insertResult.lastInsertRowid);

  // Immediate "working" feedback: the user just sent something, show the
  // badge now rather than waiting for the CC's first PreToolUse hook.
  markWorkingFromUserSubmit(board.session_id);

  // Poll until /poll-messages flips delivered=1, or we time out.
  const deadline = Date.now() + SUBMIT_DELIVERY_TIMEOUT_MS;
  const checkDelivered = db.prepare(
    "SELECT delivered, thread_item_id FROM pending_messages WHERE id = ?",
  );
  while (Date.now() < deadline) {
    const row = checkDelivered.get(pendingId) as
      | { delivered: number; thread_item_id: number | null }
      | null;
    if (row?.delivered === 1) {
      // `delivered` flips when the poller DRAINS this row, which happens before
      // its channel notification to CC is actually attempted — so the stall is
      // NOT cleared here (that would wipe the ⚠️ even if the push then throws and
      // CC never gets the "continue"). The poller clears it via /channel-pushed
      // only once the notification write resolves. See handleChannelPushed.
      // Bump the owning session's unanswered-user-post counter. Counts both
      // kinds for now — a structure request also expects an ack from CC, and
      // overcounting is recoverable via /reset-unanswered.
      db.run(
        "UPDATE sessions SET unanswered_user_posts = unanswered_user_posts + 1 WHERE id = ?",
        [board.session_id],
      );

      // board_structure_request: no node-level mirror or status bump on
      // any user content node, but we DO append the raw request text to
      // the per-board structure-change log so the user has an audit
      // trail of "what was asked + (later) what was done". The CC is
      // expected to append its own summary post on the same log node
      // after applying the changes — see server/instructions.ts.
      if (isStructureRequest) {
        const log = ensureBoardLogNode(body.board_id);
        if (log) {
          insertThread.run(body.board_id, log.nodeId, "user", body.text, now);
          broadcast(body.board_id, {
            type: "thread-update",
            node_id: log.nodeId,
            source: "user",
          });
        }
        return { ok: true };
      }
      // Delivered: handlePollMessages already materialized the user's reply
      // into the thread at the delivery moment (so its id could ride the
      // channel push as message_id). Fallback-insert only if that somehow
      // didn't happen. Either way we broadcast below so every connected
      // client (incl. the submitter) sees the real message.
      if (row.thread_item_id == null) {
        insertThread.run(body.board_id, body.node_id, "user", body.text, now);
      }
      // A user reply pulls the node back into 'discussing' from 'pending' or
      // 'needs-reply'. Capture the old status first so we can log the
      // transition + broadcast a status-update (otherwise the sidebar's
      // needs-reply badge wouldn't clear until the next poll).
      const before = db
        .prepare("SELECT status FROM nodes WHERE board_id = ? AND id = ?")
        .get(body.board_id, body.node_id) as { status: string } | null;
      const bump = bumpStatusToDiscussing.run(body.board_id, body.node_id);
      const nodeStatusChanged = bump.changes > 0;
      if (nodeStatusChanged && before) {
        insertThread.run(
          body.board_id,
          body.node_id,
          "system",
          `status_change:${before.status}:discussing`,
          now,
        );
      }
      broadcast(body.board_id, {
        type: "thread-update",
        node_id: body.node_id,
        source: "user",
      });
      if (nodeStatusChanged) {
        broadcast(body.board_id, {
          type: "status-update",
          node_id: body.node_id,
          status: "discussing",
        });
        broadcast(body.board_id, {
          type: "thread-update",
          node_id: body.node_id,
          source: "system",
        });
      }
      const boardChange = syncBoardStatus(body.board_id);
      return boardChange
        ? { ok: true, board_status_changed: boardChange }
        : { ok: true };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Timeout: mark cancelled so a late MCP poll won't deliver a stale message
  // the user has likely retried by hand. Guard on delivered=0 so a delivery
  // that landed at the buzzer (poll ran, thread item + message_id created) is
  // not clobbered. No thread-item cleanup needed: the row is only created at
  // delivery, so a timed-out (never-delivered) message left none behind.
  db.prepare(
    "UPDATE pending_messages SET cancelled = 1 WHERE id = ? AND delivered = 0",
  ).run(pendingId);
  // If the cancel was a no-op (changes === 0) the delivery won the race at the
  // buzzer, but we still don't clear the stall here: a drained row only means
  // the poller has the message, not that its channel push to CC succeeded. The
  // poller clears the stall via /channel-pushed once the notification resolves
  // (handleChannelPushed) — so a push that throws keeps the honest ⚠️.
  return {
    ok: false,
    error: "errors.delivery_timeout",
    reason: "timeout",
  };
}

export function handlePollMessages(body: any) {
  const messages = selectPending.all(body.session_id) as any[];
  for (const m of messages) {
    const kind = m.kind ?? "user_input_relay";
    // Materialize a user reply into its node's thread AT delivery and capture
    // the new thread_items.id, so it can ride this poll's channel push as
    // message_id (lets CC reference the exact human message). Only
    // user_input_relay: structure-requests mirror onto the board log node in
    // handleSubmitAnswer, and checklist/feedback notes are plain notes with no
    // thread item. handleSubmitAnswer, on seeing delivered=1, broadcasts and
    // bumps node status off this same row (and falls back to inserting the
    // thread item if for any reason this didn't run).
    // map_chat is the map equivalent: board_id holds the map_id, node_id is a
    // map node id (or MAP_GENERAL_NODE). It rides the same thread_items table,
    // so materializing here gives its reply a message_id on the channel push.
    if ((kind === "user_input_relay" || kind === "map_chat") && m.node_id) {
      const r = insertThread.run(
        m.board_id,
        m.node_id,
        "user",
        m.text,
        m.created_at,
      );
      m.thread_item_id = Number(r.lastInsertRowid);
      setPendingThreadItem.run(m.thread_item_id, m.id);
    }
    markDelivered.run(m.id);
  }
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
