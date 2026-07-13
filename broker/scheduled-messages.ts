// Timer send: schedule a composer message to be delivered to a board node at a
// future time. A broker interval fires the due ones by submitting them exactly
// as if the user had typed and sent them (handleSubmitAnswer), so the owning CC
// receives them through the normal channel. Rows are durable (sqlite) so a
// scheduled message survives a broker restart — anything whose time passed while
// the broker was down fires on the next tick. Sent rows keep sent_at for history.
import { db } from "./db.ts";
import { generateId } from "./helpers.ts";
import { handleSubmitAnswer } from "./threads.ts";
import { handleMapChat } from "./maps.ts";
import { handleDiagramChat } from "./diagrams.ts";
import { broadcastToAll } from "./ws.ts";

// A reservation can target any of the three chat surfaces. board_id holds the
// CONTAINER id (board / map / diagram) and node_id the node within it (a board
// node, a map node or "__general__", or the diagram chat node) — the surface
// column says which delivery path fires it.
type Surface = "board" | "map" | "diagram";
const SURFACES: Surface[] = ["board", "map", "diagram"];
function asSurface(v: unknown): Surface {
  return SURFACES.includes(v as Surface) ? (v as Surface) : "board";
}

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
// confirm_armed: 1 while this reservation should still trigger the "you have a
// pending timer send — send this live message now?" confirm. New rows default
// to 1 (armed); showing the confirm once disarms ALL of a session's pending
// rows, and a fresh reservation re-arms naturally. (Idempotent add.)
try {
  db.run(
    "ALTER TABLE scheduled_messages ADD COLUMN confirm_armed INTEGER NOT NULL DEFAULT 1",
  );
} catch {
  /* column already exists */
}
// surface: which chat surface this reservation fires into (board / map /
// diagram). Existing rows predate timer-on-map/diagram, so they default to
// "board". (Idempotent add.)
try {
  db.run(
    "ALTER TABLE scheduled_messages ADD COLUMN surface TEXT NOT NULL DEFAULT 'board'",
  );
} catch {
  /* column already exists */
}

const insertStmt = db.prepare(
  "INSERT INTO scheduled_messages (id, session_id, board_id, node_id, text, fire_at, created_at, surface) VALUES (?,?,?,?,?,?,?,?)",
);
const sessionForBoard = db.prepare("SELECT session_id FROM boards WHERE id = ?");
const sessionForMap = db.prepare("SELECT session_id FROM maps WHERE id = ?");
const sessionForDiagram = db.prepare(
  "SELECT session_id FROM diagrams WHERE id = ?",
);
const listBySessionStmt = db.prepare(
  "SELECT id, board_id, node_id, text, fire_at, created_at, surface FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL ORDER BY fire_at",
);
const listByBoardStmt = db.prepare(
  "SELECT id, board_id, node_id, text, fire_at, created_at, surface FROM scheduled_messages WHERE board_id = ? AND sent_at IS NULL ORDER BY fire_at",
);
// Cross-session view: every still-pending reservation on the machine, with the
// owning session name + target container title joined in so the list can show
// WHERE each one is headed. The container can be a board, a map, or a diagram —
// board_id holds whichever id, so we LEFT JOIN all three and COALESCE the title.
// Powers the reservations-list modal (opened from the sidebar clock or the
// header button). Ordered by fire time, soonest first.
const listAllPendingStmt = db.prepare(`
  SELECT sm.id, sm.session_id, sm.board_id, sm.node_id, sm.text, sm.fire_at, sm.created_at, sm.surface,
         s.name AS session_name,
         COALESCE(b.title, mp.title, dg.title) AS board_title,
         COALESCE(b.is_default, 0) AS board_is_default
  FROM scheduled_messages sm
  LEFT JOIN sessions s ON s.id = sm.session_id
  LEFT JOIN boards b ON b.id = sm.board_id
  LEFT JOIN maps mp ON mp.id = sm.board_id
  LEFT JOIN diagrams dg ON dg.id = sm.board_id
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
  "SELECT id, board_id, node_id, text, surface FROM scheduled_messages WHERE sent_at IS NULL AND fire_at <= ? ORDER BY fire_at",
);
const markSentStmt = db.prepare(
  "UPDATE scheduled_messages SET sent_at = ? WHERE id = ?",
);
const pendingCountStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL",
);
const armedCountStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL AND confirm_armed = 1",
);
const disarmStmt = db.prepare(
  "UPDATE scheduled_messages SET confirm_armed = 0 WHERE session_id = ? AND sent_at IS NULL",
);

// Whether the "you have a pending timer send — send this live message now?"
// confirm should fire for a session: true iff it has >=1 pending reservation
// still armed. Powers the board view's owner_timer_confirm_armed flag.
export function armedConfirmCountForSession(sessionId: string): number {
  return (armedCountStmt.get(sessionId) as { n: number } | undefined)?.n ?? 0;
}

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
  const surface = asSurface(body?.surface);
  const when = new Date(String(body?.fire_at ?? ""));
  if (!board_id || !node_id)
    return { ok: false, error: "board_id and node_id are required" };
  if (!text) return { ok: false, error: "message text is empty" };
  if (isNaN(when.getTime()))
    return { ok: false, error: "invalid fire_at (need an ISO timestamp)" };
  // Resolve the owning session from whichever container this surface targets, so
  // the sidebar badge / confirm counts (keyed by session_id) work on all three.
  const lookup =
    surface === "map"
      ? sessionForMap
      : surface === "diagram"
        ? sessionForDiagram
        : sessionForBoard;
  const srow = lookup.get(board_id) as { session_id: string } | undefined;
  const id = generateId("sm");
  insertStmt.run(
    id,
    srow?.session_id ?? "",
    board_id,
    node_id,
    text,
    when.toISOString(),
    new Date().toISOString(),
    surface,
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

// The confirm was shown once for this session — disarm ALL its pending
// reservations so it won't fire again until a fresh reservation re-arms.
function handleTimerConfirmAck(body: any) {
  const session_id = String(body?.session_id ?? "");
  if (!session_id) return { ok: false, error: "session_id is required" };
  disarmStmt.run(session_id);
  return { ok: true };
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
      surface: Surface;
    }[];
    for (const m of due) {
      markSentStmt.run(new Date().toISOString(), m.id);
      // Deliver through the surface's own user->CC path so it arrives exactly
      // like a live message there (board=user_input_relay, map=map_chat,
      // diagram=diagram_chat). via_timer tags it so the poller appends the
      // "user is likely away" footer regardless of surface. Fire-and-forget: an
      // offline owner drops it the same on every surface (all three gate on
      // alive), which matches the pre-existing board behavior.
      if (m.surface === "map") {
        void handleMapChat({
          map_id: m.board_id,
          node_id: m.node_id,
          text: m.text,
          via_timer: true,
        }).catch(() => {});
      } else if (m.surface === "diagram") {
        void handleDiagramChat({
          diagram_id: m.board_id,
          text: m.text,
          via_timer: true,
        }).catch(() => {});
      } else {
        void handleSubmitAnswer({
          board_id: m.board_id,
          node_id: m.node_id,
          text: m.text,
          via_timer: true,
        }).catch(() => {});
      }
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
  "/timer-confirm-ack": handleTimerConfirmAck,
};
