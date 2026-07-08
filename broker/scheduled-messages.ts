// Timer send: schedule a composer message to be delivered to a board node at a
// future time. A broker interval fires the due ones by submitting them exactly
// as if the user had typed and sent them (handleSubmitAnswer), so the owning CC
// receives them through the normal channel. Rows are durable (sqlite) so a
// scheduled message survives a broker restart — anything whose time passed while
// the broker was down fires on the next tick. Sent rows keep sent_at for history.
import { db } from "./db.ts";
import { generateId } from "./helpers.ts";
import { handleSubmitAnswer } from "./threads.ts";
import { broadcastToAll } from "./ws.ts";

db.run(`
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    text TEXT NOT NULL,
    fire_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
  )
`);
db.run(
  "CREATE INDEX IF NOT EXISTS idx_sched_pending ON scheduled_messages (sent_at, fire_at)",
);

const insertStmt = db.prepare(
  "INSERT INTO scheduled_messages (id, session_id, board_id, node_id, text, fire_at, created_at) VALUES (?,?,?,?,?,?,?)",
);
const sessionForBoard = db.prepare("SELECT session_id FROM boards WHERE id = ?");
const listBySessionStmt = db.prepare(
  "SELECT id, board_id, node_id, text, fire_at, created_at FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL ORDER BY fire_at",
);
const listByBoardStmt = db.prepare(
  "SELECT id, board_id, node_id, text, fire_at, created_at FROM scheduled_messages WHERE board_id = ? AND sent_at IS NULL ORDER BY fire_at",
);
// Cross-session view: every still-pending reservation on the machine, with the
// owning session name + target board title joined in so the list can show WHERE
// each one is headed. Powers the reservations-list modal (opened from the
// sidebar clock or the header button). Ordered by fire time, soonest first.
const listAllPendingStmt = db.prepare(`
  SELECT sm.id, sm.session_id, sm.board_id, sm.node_id, sm.text, sm.fire_at, sm.created_at,
         s.name AS session_name, b.title AS board_title, b.is_default AS board_is_default
  FROM scheduled_messages sm
  LEFT JOIN sessions s ON s.id = sm.session_id
  LEFT JOIN boards b ON b.id = sm.board_id
  WHERE sm.sent_at IS NULL
  ORDER BY sm.fire_at
`);
const cancelStmt = db.prepare(
  "DELETE FROM scheduled_messages WHERE id = ? AND sent_at IS NULL",
);
const updateStmt = db.prepare(
  "UPDATE scheduled_messages SET text = ?, fire_at = ? WHERE id = ? AND sent_at IS NULL",
);
const dueStmt = db.prepare(
  "SELECT id, board_id, node_id, text FROM scheduled_messages WHERE sent_at IS NULL AND fire_at <= ? ORDER BY fire_at",
);
const markSentStmt = db.prepare(
  "UPDATE scheduled_messages SET sent_at = ? WHERE id = ?",
);
const pendingCountStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL",
);

// Count of still-pending (unfired) scheduled messages for a session — powers the
// sidebar badge and the header banner. Safe to import from sessions.ts (no cycle);
// helpers.ts uses its own lazy copy to avoid a helpers↔threads↔scheduled cycle.
export function pendingScheduledCountForSession(sessionId: string): number {
  return (
    (pendingCountStmt.get(sessionId) as { n: number } | undefined)?.n ?? 0
  );
}

function handleScheduleMessage(body: any) {
  const board_id = String(body?.board_id ?? "");
  const node_id = String(body?.node_id ?? "");
  const text = String(body?.text ?? "").trim();
  const when = new Date(String(body?.fire_at ?? ""));
  if (!board_id || !node_id)
    return { ok: false, error: "board_id and node_id are required" };
  if (!text) return { ok: false, error: "message text is empty" };
  if (isNaN(when.getTime()))
    return { ok: false, error: "invalid fire_at (need an ISO timestamp)" };
  const srow = sessionForBoard.get(board_id) as
    | { session_id: string }
    | undefined;
  const id = generateId("sm");
  insertStmt.run(
    id,
    srow?.session_id ?? "",
    board_id,
    node_id,
    text,
    when.toISOString(),
    new Date().toISOString(),
  );
  broadcastToAll({ type: "scheduled-messages-update" });
  return { ok: true, id, fire_at: when.toISOString() };
}

function handleListScheduledMessages(body: any) {
  const session_id = body?.session_id ? String(body.session_id) : null;
  const board_id = body?.board_id ? String(body.board_id) : null;
  const scheduled = session_id
    ? listBySessionStmt.all(session_id)
    : board_id
      ? listByBoardStmt.all(board_id)
      : [];
  return { ok: true, scheduled };
}

function handleListAllScheduledMessages() {
  return { ok: true, scheduled: listAllPendingStmt.all() };
}

function handleCancelScheduledMessage(body: any) {
  const id = String(body?.id ?? "");
  if (!id) return { ok: false, error: "id is required" };
  const res = cancelStmt.run(id);
  if (res.changes > 0) broadcastToAll({ type: "scheduled-messages-update" });
  return { ok: res.changes > 0 };
}

function handleUpdateScheduledMessage(body: any) {
  const id = String(body?.id ?? "");
  const text = String(body?.text ?? "").trim();
  const when = new Date(String(body?.fire_at ?? ""));
  if (!id) return { ok: false, error: "id is required" };
  if (!text) return { ok: false, error: "message text is empty" };
  if (isNaN(when.getTime()))
    return { ok: false, error: "invalid fire_at (need an ISO timestamp)" };
  const res = updateStmt.run(text, when.toISOString(), id);
  if (res.changes > 0) broadcastToAll({ type: "scheduled-messages-update" });
  return { ok: res.changes > 0, fire_at: when.toISOString() };
}

// Deliver every message whose fire_at has passed. Called on a broker interval.
// The submit is fire-and-forget (a delivery timeout — CC offline / parked — is
// fine: the message is queued and picked up when it next polls), and we stamp
// sent_at immediately so a slow delivery can't re-fire it on the next tick.
let firing = false;
export function fireDueScheduledMessages(): void {
  if (firing) return;
  firing = true;
  try {
    const now = new Date().toISOString();
    const due = dueStmt.all(now) as {
      id: string;
      board_id: string;
      node_id: string;
      text: string;
    }[];
    for (const m of due) {
      markSentStmt.run(new Date().toISOString(), m.id);
      void handleSubmitAnswer({
        board_id: m.board_id,
        node_id: m.node_id,
        text: m.text,
        via_timer: true,
      }).catch(() => {});
    }
    if (due.length > 0) broadcastToAll({ type: "scheduled-messages-update" });
  } finally {
    firing = false;
  }
}

export const routes = {
  "/schedule-message": handleScheduleMessage,
  "/list-scheduled-messages": handleListScheduledMessages,
  "/list-all-scheduled-messages": handleListAllScheduledMessages,
  "/cancel-scheduled-message": handleCancelScheduledMessage,
  "/update-scheduled-message": handleUpdateScheduledMessage,
};
