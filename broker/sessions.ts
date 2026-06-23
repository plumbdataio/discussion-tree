// Session lifecycle handlers (register / heartbeat / unregister) and the
// CC-side identity binding (attach_cc_session) that is the load-bearing
// mechanism for surviving MCP-server restarts. handleListSessions also lives
// here — it stitches together sessions, boards, node stats, and unread
// counts into the shape the sidebar / dashboards expect.

import {
  activities,
  bgTaskCountForSession,
  clearCompacting,
  clearStall,
  scheduledSendAtForSession,
} from "./activity.ts";
import { getContextUsage } from "./context-usage.ts";
import {
  db,
  insertSession,
  insertThread,
  selectCliHistory,
  selectSessionTmux,
  setSessionCcPid,
  setSessionTmux,
  updateSessionSeen,
  upsertCliHistory,
} from "./db.ts";
import { ensureDefaultBoard } from "./default-board.ts";
import { generateId } from "./helpers.ts";
import { onSessionsChanged } from "./power.ts";
import { broadcast, broadcastToAll } from "./ws.ts";

// Board / map ids owned by the given (about-to-be-reclaimed) sessions. Collected
// BEFORE the reclaim UPDATE moves them, so afterwards we can nudge any open
// board/map clients to refetch — otherwise they keep the OLD (now dead) owner
// session_id in their snapshot and e.g. the CLI command-send button targets the
// dead session until an unrelated update or a manual reload.
function ownedBoardsAndMaps(deadIds: string[]): {
  boards: string[];
  maps: string[];
} {
  if (!deadIds.length) return { boards: [], maps: [] };
  const ph = deadIds.map(() => "?").join(",");
  const boards = (
    db.prepare(`SELECT id FROM boards WHERE session_id IN (${ph})`).all(
      ...deadIds,
    ) as { id: string }[]
  ).map((r) => r.id);
  const maps = (
    db.prepare(`SELECT id FROM maps WHERE session_id IN (${ph})`).all(
      ...deadIds,
    ) as { id: string }[]
  ).map((r) => r.id);
  return { boards, maps };
}

export function handleRegister(body: any) {
  const id = generateId("s");
  const now = new Date().toISOString();
  insertSession.run(id, body.pid, body.cwd, now, now);
  // cc_pid = the owning Claude Code process's PID (the dt MCP server's
  // process.ppid). A sibling MCP server under the same CC (e.g. claude-peers)
  // can mark this session working via /heartbeat-cc-pid using only this shared
  // id. Optional / best-effort: older MCP servers don't send it.
  if (typeof body.cc_pid === "number") {
    setSessionCcPid.run(body.cc_pid, id);
  }
  onSessionsChanged();
  return { session_id: id };
}

export function handleHeartbeat(body: any) {
  updateSessionSeen.run(new Date().toISOString(), body.session_id);
  // Mirror back the cc_session_id binding so the MCP server can run a
  // cheap self-healing check on every heartbeat — if it sees null here
  // (= auto-attach never made it through) it knows to retry. Single
  // already-prepared SELECT, no extra round-trip.
  const row = db
    .prepare("SELECT cc_session_id FROM sessions WHERE id = ?")
    .get(body.session_id) as { cc_session_id: string | null } | undefined;
  return { ok: true, cc_session_id: row?.cc_session_id ?? null };
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
  // Capture the CC process's tmux pane/socket (the MCP server reads these from
  // its own env and forwards them). Overwrite on every attach so a relaunch in
  // a fresh pane stays correct; null when CC wasn't started inside tmux.
  setSessionTmux.run(
    body.tmux_pane ? String(body.tmux_pane) : null,
    body.tmux_socket ? String(body.tmux_socket) : null,
    sessionId,
  );
  // A fresh SessionStart / re-attach means Claude Code is back — clear any
  // stall warning left over from an API-error stop in the previous run, and
  // self-heal a compacting badge if the post-compact hook didn't clear it.
  clearStall(sessionId);
  clearCompacting(sessionId);

  const reclaimed = {
    boards: 0,
    messages: 0,
    orphan_boards: 0,
    orphan_messages: 0,
  };
  // Open board/map clients to nudge once the reclaim is done (see comment on
  // ownedBoardsAndMaps).
  const refreshTargets = { boards: [] as string[], maps: [] as string[] };

  // Primary reclaim — same cc_session_id, attach was called before the prior
  // MCP died.
  const deadSessions = db
    .prepare(
      "SELECT id, name FROM sessions WHERE alive = 0 AND cc_session_id = ? ORDER BY last_seen DESC",
    )
    .all(ccId) as { id: string; name: string | null }[];
  if (deadSessions.length > 0) {
    const deadIds = deadSessions.map((s) => s.id);
    const before = ownedBoardsAndMaps(deadIds);
    refreshTargets.boards.push(...before.boards);
    refreshTargets.maps.push(...before.maps);
    const placeholders = deadIds.map(() => "?").join(",");
    const b = db.run(
      `UPDATE boards SET session_id = ? WHERE session_id IN (${placeholders})`,
      [sessionId, ...deadIds],
    );
    const m = db.run(
      `UPDATE pending_messages SET session_id = ? WHERE delivered = 0 AND session_id IN (${placeholders})`,
      [sessionId, ...deadIds],
    );
    // Anchors (favorites) follow the same reclaim path so they survive a CC
    // restart that triggers a new broker session row. Same posture as
    // boards / pending_messages: the user's pin set is tied to the CC's
    // logical identity, not to the underlying broker row id.
    db.run(
      `UPDATE favorites SET session_id = ? WHERE session_id IN (${placeholders})`,
      [sessionId, ...deadIds],
    );
    // Maps follow the same reclaim path. Without this, a CC restart orphans
    // every map: list_maps (keyed by the new session id) finds none, and
    // /map-chat rejects submissions because the recorded owner session is now
    // dead. A map's owner is the CC's logical identity, not the broker row.
    db.run(
      `UPDATE maps SET session_id = ? WHERE session_id IN (${placeholders})`,
      [sessionId, ...deadIds],
    );
    reclaimed.boards = b.changes;
    reclaimed.messages = m.changes;

    // Carry the human-readable session name forward — without this, every CC
    // restart erases the name the user set in the sidebar. Use the most-recent
    // dead session's name (ORDER BY last_seen DESC above) and only fill if the
    // new session hasn't set its own name yet.
    const inheritedName = deadSessions.find((s) => s.name)?.name ?? null;
    if (inheritedName) {
      db.run("UPDATE sessions SET name = ? WHERE id = ? AND name IS NULL", [
        inheritedName,
        sessionId,
      ]);
    }
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
      const before = ownedBoardsAndMaps(orphanIds);
      refreshTargets.boards.push(...before.boards);
      refreshTargets.maps.push(...before.maps);
      const placeholders = orphanIds.map(() => "?").join(",");
      const b = db.run(
        `UPDATE boards SET session_id = ? WHERE session_id IN (${placeholders})`,
        [sessionId, ...orphanIds],
      );
      const m = db.run(
        `UPDATE pending_messages SET session_id = ? WHERE delivered = 0 AND session_id IN (${placeholders})`,
        [sessionId, ...orphanIds],
      );
      db.run(
        `UPDATE maps SET session_id = ? WHERE session_id IN (${placeholders})`,
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

  // Nudge any open board/map clients whose owner just changed to this session,
  // so their snapshot (board.session_id, owner_can_cli_send, …) refreshes
  // instead of pointing at the dead session. Board clients fall through to
  // fetchBoard() on an unrecognized type; map clients refetch on any frame.
  for (const id of new Set(refreshTargets.boards)) {
    broadcast(id, { type: "board-owner-changed" });
  }
  for (const id of new Set(refreshTargets.maps)) {
    broadcast(id, { type: "map-owner-changed" });
  }

  // Nudge the sidebar on EVERY attach (not just reclaims). The session list is
  // gated behind a ~10s /api/sessions poll, so a freshly-bound session — and
  // the default board that lets the user start typing — would otherwise take up
  // to 10s to appear. owner_alive drives the input's enabled state, so this is
  // what makes "unbound session → bound → input becomes possible" feel instant.
  // The sidebar's only socket is GlobalBanner's /ws/_banner, which broadcast()
  // (board/map-scoped) never reaches — so this must be broadcastToAll.
  broadcastToAll({ type: "sidebar-refresh" });

  return { ok: true, reclaimed };
}

export function handleSetSessionName(body: any) {
  db.run("UPDATE sessions SET name = ? WHERE id = ?", [
    body.name,
    body.session_id,
  ]);
  return { ok: true };
}

// How many consecutive stops we'll block on the SAME unanswered count before
// giving up (so a CC that genuinely can't post can't infinite-loop the turn).
const MAX_NAG_STREAK = 8;

// Read the unanswered-user-post counter for the alive session bound to a CC
// session_id, and decide whether the Stop hook should block. The hook blocks
// EVERY stop while count>0 (count>0 means the user's latest message is still
// unanswered, regardless of how many round-trips happened) — but we cap the
// number of consecutive blocks at the SAME count via a streak, so a stuck CC
// eventually yields and the user can step in. A changing count (new delivery /
// a post) resets the streak and re-arms the nag.
export function handleGetUnansweredPosts(body: {
  cc_session_id?: string;
}): {
  ok: boolean;
  count: number;
  block?: boolean;
  nodes?: { board_id: string; node_id: string; node_path: string }[];
  session_id?: string;
} {
  if (!body.cc_session_id) return { ok: false, count: 0 };
  const row = db
    .prepare(
      "SELECT id, unanswered_nag_streak, unanswered_nag_sig FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
    )
    .get(body.cc_session_id) as
    | {
        id: string;
        unanswered_nag_streak: number;
        unanswered_nag_sig: string;
      }
    | null;
  if (!row) return { ok: false, count: 0 };

  // Per-node: the unanswered set is the rows in unanswered_nodes for this
  // session. The nag names these nodes so the CC knows exactly which user
  // submissions are still unreplied (oldest first).
  const nodes = db
    .prepare(
      "SELECT board_id, node_id, node_path FROM unanswered_nodes WHERE session_id = ? ORDER BY created_at ASC",
    )
    .all(row.id) as { board_id: string; node_id: string; node_path: string }[];
  const count = nodes.length;
  if (count <= 0) {
    // Nothing pending — clear any streak so the next backlog starts fresh.
    if (row.unanswered_nag_streak !== 0 || row.unanswered_nag_sig !== "") {
      db.run(
        "UPDATE sessions SET unanswered_nag_streak = 0, unanswered_nag_count = 0, unanswered_nag_sig = '' WHERE id = ?",
        [row.id],
      );
    }
    return { ok: true, count: 0, block: false, nodes: [], session_id: row.id };
  }

  // Hang-safety streak keys on the SET signature (sorted "board:node" keys), NOT
  // the count: same set as last stop ⇒ continue the streak; ANY membership change
  // (a reply cleared one node, a delivery added another — even if the count is
  // unchanged) ⇒ fresh situation, restart at 1, so the give-up cap can't get
  // stuck on a stale set and silently swallow a brand-new unanswered node.
  const sig = nodes
    .map((n) => `${n.board_id}:${n.node_id}`)
    .sort()
    .join("|");
  const streak =
    sig === row.unanswered_nag_sig ? row.unanswered_nag_streak + 1 : 1;
  db.run(
    "UPDATE sessions SET unanswered_nag_streak = ?, unanswered_nag_count = ?, unanswered_nag_sig = ? WHERE id = ?",
    [streak, count, sig, row.id],
  );
  const block = streak <= MAX_NAG_STREAK;
  return { ok: true, count, block, nodes, session_id: row.id };
}

// Force the unanswered counter to zero. Two ways in: cc_session_id (the hook
// path) or session_id (the MCP tool path). Used when the counter drifted out
// of sync (bundled CC replies, manual UI activity, etc).
export function handleResetUnansweredPosts(body: {
  cc_session_id?: string;
  session_id?: string;
}): { ok: boolean; session_id?: string } {
  let sessionId: string | null = body.session_id ?? null;
  if (!sessionId && body.cc_session_id) {
    const row = db
      .prepare(
        "SELECT id FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
      )
      .get(body.cc_session_id) as { id: string } | null;
    sessionId = row?.id ?? null;
  }
  if (!sessionId) return { ok: false };
  // Drop the whole per-node unanswered set for this session — the explicit
  // "I've handled these (or won't), yield anyway" escape. Clear the nag streak
  // too (see handlePostToNode) so a fresh submission after a capped backlog
  // re-arms the Stop-hook nag. The legacy unanswered_user_posts int is kept at 0
  // for backward-compat but is no longer the nag's source of truth.
  db.run("DELETE FROM unanswered_nodes WHERE session_id = ?", [sessionId]);
  db.run(
    "UPDATE sessions SET unanswered_user_posts = 0, unanswered_nag_streak = 0, unanswered_nag_count = 0, unanswered_nag_sig = '' WHERE id = ?",
    [sessionId],
  );
  return { ok: true, session_id: sessionId };
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
    stalled_at: string | null;
    compacting_at: string | null;
  };

  // Hide alive husks: a bare registration (a CC whose SessionStart hook
  // registered it but that never attached to DT) owns ZERO boards and clutters
  // the active list forever while its pid lives. Show an alive session only if
  // it has a name OR at least one non-archived board (attaching always creates
  // the default board, so any genuinely-in-use session qualifies immediately).
  const aliveSessions = db
    .prepare(
      `SELECT id, pid, cwd, name, alive, cc_session_id, stalled_at, compacting_at
       FROM sessions
       WHERE alive = 1
         AND (
           name IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM boards b
             WHERE b.session_id = sessions.id AND b.archived = 0
           )
           OR EXISTS (
             SELECT 1 FROM maps m
             WHERE m.session_id = sessions.id AND m.deleted_at IS NULL
           )
         )
       ORDER BY registered_at`,
    )
    .all() as SessionRow[];

  // Inactive sessions are kept around (alive=0) so the user can browse
  // historical conversations. Surface only those that actually hold content:
  // a non-default board, OR a default/general board that has at least one
  // message. A CC that started and exited without ever conversing (in the CLI
  // or DT) owns only its auto-created, empty default board — that's a husk and
  // would otherwise linger in the sidebar after the stale sweep flips it to
  // alive=0.
  const inactiveSessions = db
    .prepare(
      `SELECT id, pid, cwd, name, alive, cc_session_id, stalled_at, compacting_at
       FROM sessions
       WHERE alive = 0
         AND (
           EXISTS (
             SELECT 1 FROM boards b
             WHERE b.session_id = sessions.id AND b.archived = 0
               AND (
                 b.is_default = 0
                 OR EXISTS (SELECT 1 FROM thread_items t WHERE t.board_id = b.id)
               )
           )
           OR EXISTS (
             SELECT 1 FROM maps m
             WHERE m.session_id = sessions.id AND m.deleted_at IS NULL
           )
         )
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
      // Count decision ITEMS only — concerns are category headers, not
      // decisions, so counting them inflated the unsettled / total badge
      // (e.g. an empty default board showed 2/2: its lone "conversation"
      // concern + "main" item). Same kind='item' restriction as the unread
      // count below.
      const stats = db
        .prepare(
          "SELECT status, COUNT(*) AS cnt FROM nodes WHERE board_id = ? AND deleted_at IS NULL AND kind = 'item' GROUP BY status",
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
      // nodes that are alive AND items (kind='item'). Concerns are
      // category headers — the UI doesn't render a thread on them, so a
      // thread item stranded on a concern would leave the sidebar's
      // unread dot stuck on a board the user can't possibly clear.
      // post_to_node also rejects concern targets to prevent new ones.
      const unreadRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM thread_items t
           JOIN nodes n ON n.board_id = t.board_id AND n.id = t.node_id
           WHERE t.board_id = ?
             AND t.read_at IS NULL
             AND t.source = 'cc'
             AND n.deleted_at IS NULL
             AND n.kind = 'item'`,
        )
        .get(b.id) as { cnt: number };
      // The default/general board is a chat, not a decision board — the
      // unsettled/total metric doesn't apply to it (its single "main" item is
      // always pending/discussing). Zero it so an empty session doesn't read
      // as "1 unsettled". Unread (new messages) is still tracked above.
      const isDefault = b.is_default === 1;
      return {
        ...b,
        stats: {
          open: isDefault ? 0 : open,
          decided: isDefault ? 0 : decided,
          needs_reply: isDefault ? 0 : counts["needs-reply"] ?? 0,
          total: isDefault ? 0 : total,
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
    const context_usage = getContextUsage(s.id);
    // Maps (divergence surface) owned by this session. node_count + unread are
    // computed cheaply; map messages live in thread_items keyed by the map_id.
    const mapRows = db
      .prepare(
        "SELECT id, title, archived FROM maps WHERE session_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY created_at",
      )
      .all(s.id) as { id: string; title: string; archived: number }[];
    const maps = mapRows.map((m) => {
      const nodeCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM map_nodes WHERE map_id = ? AND deleted_at IS NULL",
          )
          .get(m.id) as { cnt: number }
      ).cnt;
      const unread = (
        db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM thread_items WHERE board_id = ? AND read_at IS NULL AND source = 'cc'",
          )
          .get(m.id) as { cnt: number }
      ).cnt;
      // Checklist nodes have no thread; their node-level unread (changed since
      // last viewed) counts toward the badge too, for parity with threads.
      const checklistUnread = (
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM map_nodes
              WHERE map_id = ? AND deleted_at IS NULL AND is_checklist = 1
                AND checklist_version > checklist_read_version`,
          )
          .get(m.id) as { cnt: number }
      ).cnt;
      return {
        id: m.id,
        title: m.title,
        archived: m.archived,
        node_count: nodeCount,
        unread_count: unread + checklistUnread,
      };
    });
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      alive: s.alive,
      cc_session_id: s.cc_session_id,
      // A dead session can't be "stalled" — only flag alive ones.
      stalled: s.alive === 1 && !!s.stalled_at,
      // Likewise a dead session can't be mid-compaction.
      compacting: s.alive === 1 && !!s.compacting_at,
      activity,
      context_usage,
      bg_task_count: bgTaskCountForSession(s.id),
      scheduled_send_at: scheduledSendAtForSession(s.id),
      boards: enrichBoards(activeBoards),
      archived_boards: enrichBoards(archivedBoards),
      maps,
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

// --- CLI command injection via tmux (opt-in) -------------------------------
// channels inject at the user-message layer, so a slash command (e.g. /compact)
// sent through them is consumed as plain text. To trigger a real TUI command
// from the WebUI we type it into the CC pane via tmux. The pane/socket were
// captured at attach time (see handleAttachCCSession). This is gated behind a
// per-browser opt-in setting on the client; the broker independently enforces
// an allowlist + the "session is busy" guard so it can never send something
// unexpected.
const CLI_ALLOWED_COMMANDS = new Set(["/compact"]);

// Run a tmux subprocess (argv — no shell, so the buffer text can't inject).
// Optionally pipe `input` to stdin (used by load-buffer to carry arbitrary,
// possibly multiline, text without ARG_MAX limits).
async function runTmux(
  argv: string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: input != null ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (input != null && proc.stdin) {
      proc.stdin.write(input);
      await proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout };
  } catch {
    // tmux not installed / spawn failed — treat as "command unavailable" so the
    // caller reports pane_gone rather than the broker 500-ing.
    return { code: 127, stdout: "" };
  }
}

// Shells we must NOT paste a command into — if the pane's foreground process is
// one of these, Claude has exited and a shell took over (the session row can
// still be alive=1 for up to one watchdog sweep). Pasting "/compact …\n" there
// would run it as shell input. Allowlisting "claude" instead is too brittle
// (the binary can present as node etc.), so we denylist shells.
const PANE_SHELLS = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "tcsh",
  "csh",
  "ksh",
]);

// Look up the pane: returns "missing" if the pane id is gone, "shell" if a
// shell now owns it (Claude exited), or "ok". One list-panes call carries both
// the id and its foreground command.
async function probePane(
  base: string[],
  pane: string,
): Promise<"ok" | "missing" | "shell"> {
  const { code, stdout } = await runTmux([
    ...base,
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{pane_current_command}",
  ]);
  if (code !== 0) return "missing";
  for (const line of stdout.split("\n")) {
    const [id, cmd] = line.split("\t");
    if (id?.trim() === pane) {
      return PANE_SHELLS.has((cmd ?? "").trim()) ? "shell" : "ok";
    }
  }
  return "missing";
}

// Monotonic buffer-name counter so concurrent /cli-send calls never share a
// tmux buffer (a shared name + `-d` lets one request paste another's args).
let cliSendSeq = 0;

// Delay between the paste and the submit Enter. The CC TUI ingests a bracketed
// paste asynchronously; if Enter arrives before it has settled, the keystroke
// lands inside/before the paste and is dropped — the text appears but never
// submits (observed against the real CC TUI). Wait a beat so Enter is a clean,
// separate submit. Tunable via env for slow terminals.
const CLI_SEND_ENTER_DELAY_MS =
  Number(process.env.DT_CLI_SEND_ENTER_DELAY_MS) || 250;

// Paste the text into the pane as ONE bracketed paste (so a multiline prompt
// arrives intact — newlines stay input, not submit), then press Enter. Mirrors
// exactly what a human does: paste the /compact block, hit Enter.
async function sendToPane(
  base: string[],
  pane: string,
  text: string,
): Promise<void> {
  const buf = `dt-cli-send-${++cliSendSeq}`;
  await runTmux([...base, "load-buffer", "-b", buf, "-"], text);
  await runTmux([...base, "paste-buffer", "-t", pane, "-b", buf, "-p", "-d"]);
  await new Promise((r) => setTimeout(r, CLI_SEND_ENTER_DELAY_MS));
  await runTmux([...base, "send-keys", "-t", pane, "Enter"]);
}

// The session's default (conversation) board — where a sent CLI command is
// logged as a green "system command" notice so the user has a record of it.
const selectDefaultBoardForCliNotice = db.prepare(
  "SELECT id FROM boards WHERE session_id = ? AND is_default = 1 LIMIT 1",
);

export async function handleCliSend(body: any) {
  const sessionId = String(body?.session_id ?? "");
  const command = String(body?.command ?? "");
  const args = typeof body?.args === "string" ? body.args : "";
  if (!CLI_ALLOWED_COMMANDS.has(command)) {
    return { ok: false, error: "command_not_allowed" };
  }
  const sess = selectSessionTmux.get(sessionId) as
    | { tmux_pane: string | null; tmux_socket: string | null }
    | undefined;
  if (!sess) return { ok: false, error: "session_not_found" };
  if (!sess.tmux_pane) return { ok: false, error: "no_tmux_pane" };
  // Refuse while CC isn't idle: "working" (mid-turn spinner) eats the command as
  // a chat message; "blocked" (AskUserQuestion / ExitPlanMode) eats it as the
  // tool's answer. Either way the slash command wouldn't be interpreted.
  const state = activities.get(sessionId)?.state;
  if (state === "working" || state === "blocked") {
    return { ok: false, error: "session_busy" };
  }
  const base = sess.tmux_socket
    ? ["tmux", "-S", sess.tmux_socket]
    : ["tmux"];
  // A killed tmux server / closed pane leaves a stale id; a shell now owning the
  // pane means Claude exited (and pasting would run in the shell) — refuse both.
  const probe = await probePane(base, sess.tmux_pane);
  if (probe === "missing") return { ok: false, error: "pane_gone" };
  if (probe === "shell") return { ok: false, error: "pane_not_claude" };
  const text = args.trim() ? `${command} ${args}` : command;
  await sendToPane(base, sess.tmux_pane, text);
  // Log the issued command on the session's default (conversation) board as a
  // "system command" notice (source=system, NOT a user message) so the user has
  // a record of it — rendered as a pale-green chip. Best-effort: a session with
  // no default board just skips this. Only the command name is recorded, not the
  // (possibly long) args.
  const def = selectDefaultBoardForCliNotice.get(sessionId) as
    | { id: string }
    | undefined;
  if (def) {
    insertThread.run(
      def.id,
      "main",
      "system",
      `cli_command:${command}`,
      new Date().toISOString(),
    );
    broadcast(def.id, {
      type: "thread-update",
      node_id: "main",
      source: "system",
    });
  }
  // Remember the args so the user can re-pick them later. Dedup by exact text
  // (upsert just bumps last_used_at). The default arg is empty, so only
  // deliberately-typed prompts get saved — no baked-in personal default.
  if (args.trim()) {
    upsertCliHistory.run(command, args, new Date().toISOString());
  }
  return { ok: true };
}

// The de-duplicated history of args used with a given CLI command (newest
// first), so the WebUI command modal can offer past prompts to re-use.
export function handleCliHistory(body: any) {
  const command = String(body?.command ?? "");
  if (!CLI_ALLOWED_COMMANDS.has(command)) {
    return { ok: false, error: "command_not_allowed" };
  }
  const history = selectCliHistory.all(command) as {
    args: string;
    last_used_at: string;
  }[];
  return { ok: true, history };
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
  "/get-unanswered": handleGetUnansweredPosts,
  "/reset-unanswered": handleResetUnansweredPosts,
  "/cli-send": handleCliSend,
  "/cli-history": handleCliHistory,
};
