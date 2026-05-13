// Session lifecycle handlers (register / heartbeat / unregister) and the
// CC-side identity binding (attach_cc_session) that is the load-bearing
// mechanism for surviving MCP-server restarts. handleListSessions also lives
// here — it stitches together sessions, boards, node stats, and unread
// counts into the shape the sidebar / dashboards expect.

import { activities } from "./activity.ts";
import { db, insertSession, updateSessionSeen } from "./db.ts";
import { ensureDefaultBoard } from "./default-board.ts";
import { generateId } from "./helpers.ts";
import { onSessionsChanged } from "./power.ts";

export function handleRegister(body: any) {
  const id = generateId("s");
  const now = new Date().toISOString();
  insertSession.run(id, body.pid, body.cwd, now, now);
  onSessionsChanged();
  return { session_id: id };
}

export function handleHeartbeat(body: any) {
  updateSessionSeen.run(new Date().toISOString(), body.session_id);
  return { ok: true };
}

export function handleUnregister(body: any) {
  // Soft-delete only: keep the row so the cc_session_id binding survives,
  // letting future MCP restarts reclaim boards via attach_cc_session. Fully
  // deleting the row would orphan all boards / messages tied to it.
  db.run("UPDATE sessions SET alive = 0 WHERE id = ?", [body.session_id]);
  onSessionsChanged();
  return { ok: true };
}

export function handleAttachCCSession(body: any) {
  // Bind the broker session to a stable CC-side session_id, then reclaim
  // boards / pending messages from any prior dead broker session that shared
  // the same cc_session_id (the proper restart path), or — as a secondary
  // fallback — orphaned boards under the same cwd that never bound a
  // cc_session_id at all.
  const sessionId = body.session_id as string;
  const ccId = body.cc_session_id as string;

  const me = db
    .prepare("SELECT cwd FROM sessions WHERE id = ?")
    .get(sessionId) as { cwd: string } | null;

  db.run("UPDATE sessions SET cc_session_id = ? WHERE id = ?", [
    ccId,
    sessionId,
  ]);

  const reclaimed = {
    boards: 0,
    messages: 0,
    orphan_boards: 0,
    orphan_messages: 0,
  };

  // Primary reclaim — same cc_session_id, attach was called before the prior
  // MCP died.
  const deadSessions = db
    .prepare("SELECT id FROM sessions WHERE alive = 0 AND cc_session_id = ?")
    .all(ccId) as { id: string }[];
  if (deadSessions.length > 0) {
    const deadIds = deadSessions.map((s) => s.id);
    const placeholders = deadIds.map(() => "?").join(",");
    const b = db.run(
      `UPDATE boards SET session_id = ? WHERE session_id IN (${placeholders})`,
      [sessionId, ...deadIds],
    );
    const m = db.run(
      `UPDATE pending_messages SET session_id = ? WHERE delivered = 0 AND session_id IN (${placeholders})`,
      [sessionId, ...deadIds],
    );
    reclaimed.boards = b.changes;
    reclaimed.messages = m.changes;
  }

  // Secondary reclaim — same cwd, never bound. Limited to same cwd so we
  // don't pull boards from a different project.
  if (me?.cwd) {
    const orphanSessions = db
      .prepare(
        "SELECT id FROM sessions WHERE alive = 0 AND cc_session_id IS NULL AND cwd = ?",
      )
      .all(me.cwd) as { id: string }[];
    if (orphanSessions.length > 0) {
      const orphanIds = orphanSessions.map((s) => s.id);
      const placeholders = orphanIds.map(() => "?").join(",");
      const b = db.run(
        `UPDATE boards SET session_id = ? WHERE session_id IN (${placeholders})`,
        [sessionId, ...orphanIds],
      );
      const m = db.run(
        `UPDATE pending_messages SET session_id = ? WHERE delivered = 0 AND session_id IN (${placeholders})`,
        [sessionId, ...orphanIds],
      );
      reclaimed.orphan_boards = b.changes;
      reclaimed.orphan_messages = m.changes;
    }
  }

  if (
    reclaimed.boards +
      reclaimed.messages +
      reclaimed.orphan_boards +
      reclaimed.orphan_messages >
    0
  ) {
    console.error(
      `[broker] attach_cc_session ${ccId}: reclaimed boards=${reclaimed.boards} messages=${reclaimed.messages} orphan_boards=${reclaimed.orphan_boards} orphan_messages=${reclaimed.orphan_messages}`,
    );
  }

  // Same cc_session_id ⇒ same default board (carried forward via the reclaim
  // above). Only fresh cc_session_ids get a brand-new one.
  ensureDefaultBoard(sessionId, ccId);

  return { ok: true, reclaimed };
}

export function handleSetSessionName(body: any) {
  db.run("UPDATE sessions SET name = ? WHERE id = ?", [
    body.name,
    body.session_id,
  ]);
  return { ok: true };
}

export function handleAttachToBoard(body: any) {
  // Take ownership of a board for this session, redirecting future user
  // submissions and any undelivered pending messages.
  db.run("UPDATE boards SET session_id = ? WHERE id = ?", [
    body.session_id,
    body.board_id,
  ]);
  db.run(
    "UPDATE pending_messages SET session_id = ? WHERE delivered = 0 AND board_id = ?",
    [body.session_id, body.board_id],
  );
  return { ok: true };
}

export function handleListSessions() {
  type SessionRow = {
    id: string;
    pid: number;
    cwd: string;
    name: string | null;
    alive: number;
    cc_session_id: string | null;
  };

  const aliveSessions = db
    .prepare(
      "SELECT id, pid, cwd, name, alive, cc_session_id FROM sessions WHERE alive = 1 ORDER BY registered_at",
    )
    .all() as SessionRow[];

  // Inactive sessions are kept around (alive=0) so the user can browse
  // historical conversations. Surface only those that own at least one
  // non-archived board — empty husks aren't interesting.
  const inactiveSessions = db
    .prepare(
      `SELECT id, pid, cwd, name, alive, cc_session_id
       FROM sessions
       WHERE alive = 0
         AND id IN (SELECT DISTINCT session_id FROM boards WHERE archived = 0)
       ORDER BY last_seen DESC`,
    )
    .all() as SessionRow[];

  const enrichBoards = (
    rows: {
      id: string;
      title: string;
      closed: number;
      status: string;
      is_default: number;
    }[],
  ) =>
    rows.map((b) => {
      const stats = db
        .prepare(
          "SELECT status, COUNT(*) AS cnt FROM nodes WHERE board_id = ? AND deleted_at IS NULL GROUP BY status",
        )
        .all(b.id) as { status: string; cnt: number }[];
      const counts: Record<string, number> = {};
      for (const r of stats) counts[r.status] = r.cnt;
      const open =
        (counts.pending ?? 0) +
        (counts.discussing ?? 0) +
        (counts["needs-reply"] ?? 0);
      const decided =
        (counts.adopted ?? 0) +
        (counts.agreed ?? 0) +
        (counts.rejected ?? 0) +
        (counts.resolved ?? 0);
      const total = Object.values(counts).reduce((a, c) => a + c, 0);
      // Unread = CC-authored thread items with NULL read_at, restricted to
      // nodes that haven't been soft-deleted.
      const unreadRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM thread_items t
           JOIN nodes n ON n.board_id = t.board_id AND n.id = t.node_id
           WHERE t.board_id = ?
             AND t.read_at IS NULL
             AND t.source = 'cc'
             AND n.deleted_at IS NULL`,
        )
        .get(b.id) as { cnt: number };
      return {
        ...b,
        stats: {
          open,
          decided,
          needs_reply: counts["needs-reply"] ?? 0,
          total,
        },
        unread_count: unreadRow.cnt,
      };
    });

  const buildItem = (s: SessionRow) => {
    const activeBoards = db
      .prepare(
        "SELECT id, title, closed, status, is_default FROM boards WHERE session_id = ? AND archived = 0 ORDER BY is_default DESC, created_at",
      )
      .all(s.id) as {
      id: string;
      title: string;
      closed: number;
      status: string;
      is_default: number;
    }[];
    const archivedBoards = db
      .prepare(
        "SELECT id, title, closed, status, is_default FROM boards WHERE session_id = ? AND archived = 1 ORDER BY created_at",
      )
      .all(s.id) as {
      id: string;
      title: string;
      closed: number;
      status: string;
      is_default: number;
    }[];
    // Include the live activity entry (if any) so the sidebar can render a
    // per-session indicator without needing a separate poll. The WS activity
    // events still drive instant updates; this is the initial value + a
    // self-healing fallback for tabs that miss a WS frame.
    const activity = activities.get(s.id) ?? null;
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      alive: s.alive,
      cc_session_id: s.cc_session_id,
      activity,
      boards: enrichBoards(activeBoards),
      archived_boards: enrichBoards(archivedBoards),
    };
  };

  return {
    sessions: aliveSessions.map(buildItem),
    inactive_sessions: inactiveSessions.map(buildItem),
  };
}

// Periodic sweep: for each alive session, check whether its PID is still
// running. If not, soft-delete (alive=0) so the session moves to the
// inactive list and its boards can be reclaimed by a future cc_session_id
// attach.
export function cleanStaleSessions() {
  const sessions = db
    .query("SELECT id, pid FROM sessions WHERE alive = 1")
    .all() as { id: string; pid: number }[];
  let changed = false;
  for (const s of sessions) {
    try {
      process.kill(s.pid, 0);
    } catch {
      db.run("UPDATE sessions SET alive = 0 WHERE id = ?", [s.id]);
      changed = true;
    }
  }
  if (changed) onSessionsChanged();
}

// Route table — path-to-handler map merged by broker.ts. Each module owns
// its endpoints and broker.ts never needs to be touched when a new one is
// added.
export const routes = {
  "/register": handleRegister,
  "/heartbeat": handleHeartbeat,
  "/unregister": handleUnregister,
  "/attach-cc-session": handleAttachCCSession,
  "/attach-to-board": handleAttachToBoard,
  "/set-session-name": handleSetSessionName,
};
