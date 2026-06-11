// Database setup, schema, migrations, and prepared-statement cache.
//
// The DB lives behind a single module-level handle reused by every handler.
// Migrations are written as `ALTER TABLE ... ADD COLUMN` wrapped in try/catch:
// SQLite errors with "duplicate column name" the second time, which is fine —
// each ALTER is essentially a one-shot side effect we want to be idempotent
// across broker restarts.

import { Database } from "bun:sqlite";
import {
  AUTO_BOARD_STATUSES,
  isSettledNodeStatus,
  type BoardStatus,
  type NodeStatus,
  type ThreadSource,
} from "../shared/types.ts";
import { DB_PATH } from "./config.ts";

export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

// --- Schema ---

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    alive INTEGER NOT NULL DEFAULT 1
  )
`);

// Migration helper: silently ignore duplicate-column errors so re-running on
// an already-migrated DB is a no-op.
function safeAlter(sql: string) {
  try {
    db.run(sql);
  } catch {
    /* column already exists — fine */
  }
}

safeAlter("ALTER TABLE sessions ADD COLUMN alive INTEGER NOT NULL DEFAULT 1");
safeAlter("ALTER TABLE sessions ADD COLUMN cc_session_id TEXT");
safeAlter("ALTER TABLE sessions ADD COLUMN name TEXT");
// Set to an ISO timestamp when a turn ends with an API error (the StopFailure
// hook fires) — i.e. Claude Code is stuck / stopped, not working. Surfaces a
// prominent warning in the sidebar + header so the user doesn't have to watch
// the CLI to notice a stall. Cleared the instant the session shows life again
// (next tool use, normal Stop, or SessionStart re-attach).
safeAlter("ALTER TABLE sessions ADD COLUMN stalled_at TEXT");
export const setSessionStalledStmt = db.prepare(
  "UPDATE sessions SET stalled_at = ? WHERE id = ?",
);
// AND stalled_at IS NOT NULL so `changes` is 0 when nothing was actually
// cleared — lets callers skip a redundant broadcast.
export const clearSessionStalledStmt = db.prepare(
  "UPDATE sessions SET stalled_at = NULL WHERE id = ? AND stalled_at IS NOT NULL",
);
// Counter of user UI submissions that haven't been matched by a CC
// post_to_node yet. Incremented when a user_input_relay is delivered to CC,
// decremented when CC posts back into any node on a board owned by this
// session. The Stop hook reads this on idle and warns the user if the CC
// finished its turn while leaving submissions unanswered (e.g. CC replied
// in the CLI only, forgetting to mirror via post_to_node). The contract is
// best-effort — combined posts and cross-node replies can desync; the
// reset_unanswered_posts MCP tool and the /reset-unanswered endpoint exist
// for that case.
safeAlter(
  "ALTER TABLE sessions ADD COLUMN unanswered_user_posts INTEGER NOT NULL DEFAULT 0",
);
// The tmux pane id ($TMUX_PANE, e.g. "%3") + socket (first field of $TMUX) of
// the Claude Code process, captured at attach time from the MCP server's own
// env (it runs inside the same pane as CC). Present only when CC was launched
// inside tmux; null otherwise. Lets the broker inject a TUI command (e.g.
// /compact) the user triggers from the WebUI — channels can only carry user
// messages, not slash commands. Overwritten on every attach so a relaunch in a
// fresh pane stays correct.
safeAlter("ALTER TABLE sessions ADD COLUMN tmux_pane TEXT");
safeAlter("ALTER TABLE sessions ADD COLUMN tmux_socket TEXT");
export const setSessionTmux = db.prepare(
  "UPDATE sessions SET tmux_pane = ?, tmux_socket = ? WHERE id = ?",
);
// alive = 1 ONLY: a soft-deleted session's saved pane may now sit at a shell
// prompt (Claude exited), where pasting "/compact <args>" would be run by the
// shell. Never inject into a dead session.
export const selectSessionTmux = db.prepare(
  "SELECT tmux_pane, tmux_socket FROM sessions WHERE id = ? AND alive = 1",
);

db.run(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  )
`);
safeAlter(
  "ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
);
// Board-level status. "discussing" / "settled" are auto-derived from the
// constituent nodes by recomputeBoardStatus (see below). The lifecycle
// statuses "completed" / "withdrawn" / "paused" are set explicitly by the
// user / LLM via set_board_status and are NOT touched by auto-recompute.
//
// The legacy default value 'active' (pre-rename) is rewritten to either
// 'discussing' or 'settled' by the startup migration further down, based on
// the same node-rollup logic.
safeAlter(
  "ALTER TABLE boards ADD COLUMN status TEXT NOT NULL DEFAULT 'discussing'",
);
// Each cc_session_id gets at most one default board, auto-created on
// attach_cc_session — used as the casual conversation surface (1 fixed node).
safeAlter(
  "ALTER TABLE boards ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
);

db.run(`
  CREATE TABLE IF NOT EXISTS nodes (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (board_id, id)
  )
`);
// Soft-delete preserves thread history when a node is "deleted".
safeAlter("ALTER TABLE nodes ADD COLUMN deleted_at TEXT");
// Marks the special "Board log" concern + its "Structure changes" item
// that auto-record every board-structure-change request. These nodes
// must never be deletable / movable / reorderable by the user or by
// Claude, because the rest of the system assumes they're always there.
safeAlter("ALTER TABLE nodes ADD COLUMN is_log INTEGER NOT NULL DEFAULT 0");
// Marks a node as a decision-checklist node: a normal node (title /
// context / thread / status all work as usual) that ALSO carries a list
// of checklist_items — the decision-tracking property. Rendered read-only
// in the UI; items are mutated only through CC tools.
safeAlter(
  "ALTER TABLE nodes ADD COLUMN is_checklist INTEGER NOT NULL DEFAULT 0",
);

db.run(`
  CREATE TABLE IF NOT EXISTS thread_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
// read_at: NULL = unread, ISO timestamp = read. Backfill historical CC posts
// as read on first migration so users aren't drowned in legacy unreads.
try {
  db.run("ALTER TABLE thread_items ADD COLUMN read_at TEXT");
  db.run(
    "UPDATE thread_items SET read_at = created_at WHERE read_at IS NULL",
  );
} catch {
  /* column already exists — fine */
}

db.run(`
  CREATE TABLE IF NOT EXISTS pending_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_path TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    kind TEXT DEFAULT 'user_input_relay'
  )
`);
safeAlter(
  "ALTER TABLE pending_messages ADD COLUMN kind TEXT DEFAULT 'user_input_relay'",
);
// /submit-answer marks pending messages cancelled when the receiver doesn't
// ack within the timeout — so /poll-messages skips stale rows the user has
// likely retried by hand.
safeAlter(
  "ALTER TABLE pending_messages ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0",
);
// For user_input_relay, /poll-messages materializes the user's reply into its
// node thread AT delivery and stamps the new thread_items.id here, so the
// channel push can surface it to CC as message_id (lets a reply reference the
// exact human message). NULL for structure-requests / plain notes.
safeAlter("ALTER TABLE pending_messages ADD COLUMN thread_item_id INTEGER");

// Anchors (= per-session pinned thread items). The "favorites" name is the
// implementation-level term; user-facing UI calls these "anchors".
// Scoped to a session_id so multiple sessions don't see each other's pins;
// attach_cc_session carries them across CC restarts via the same reclaim
// path that handles boards / pending_messages.
//
// UNIQUE (session_id, thread_item_id) prevents the same message from being
// pinned twice in the same session — the UI treats the Anchor icon as a
// toggle so any double-tap would otherwise produce a duplicate row.
db.run(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    thread_item_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, thread_item_id)
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS favorites_by_session ON favorites(session_id, created_at DESC)`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS favorites_by_thread_item ON favorites(thread_item_id)`,
);

// Decision-checklist items. Each row is one decision tracked under a node
// flagged is_checklist=1. status ∈ pending | in-progress | done | dropped;
// drop_reason is required (enforced at the tool layer) when status='dropped'.
// source_node_id optionally links back to the node where the decision was
// made. Mutated only through CC tools (record_decision / update_decision) —
// the UI renders these read-only.
db.run(`
  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    drop_reason TEXT,
    source_node_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS checklist_items_by_node ON checklist_items(board_id, node_id, position)`,
);

// Sources for a checklist item — where the decision was actually made. One row
// per reference, so a single item can cite several places (a general-board
// chat, a node, a specific message). Each ref is one lowest-level pointer:
//   kind='board'   → ref_id = boards.id        (board_id = that same board)
//   kind='node'    → ref_id = nodes.id         (board_id = that node's board)
//   kind='message' → ref_id = thread_items.id  (board_id = that message's board)
// board_id is resolved + stored at insert so the UI can build a link without
// re-deriving it. Supersedes the single checklist_items.source_node_id
// shorthand (kept for backward compat and backfilled just below).
db.run(`
  CREATE TABLE IF NOT EXISTS checklist_item_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    board_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS checklist_item_sources_by_item ON checklist_item_sources(item_id, position)`,
);
// One-time backfill: turn every legacy source_node_id into a node source row.
// Idempotent — skips items that already have any source row — so it's safe to
// run on every boot.
db.run(`
  INSERT INTO checklist_item_sources (item_id, board_id, kind, ref_id, position, created_at)
  SELECT ci.id, ci.board_id, 'node', ci.source_node_id, 0, ci.created_at
  FROM checklist_items ci
  WHERE ci.source_node_id IS NOT NULL AND ci.source_node_id != ''
    AND NOT EXISTS (
      SELECT 1 FROM checklist_item_sources s WHERE s.item_id = ci.id
    )
`);

// --- Maps (divergent-discussion mind-map) ---
//
// A "map" is the divergence-phase counterpart to a "board" (the convergence /
// decision phase). Deliberately a SEPARATE domain from boards/nodes so the two
// terminologies stay cleanly split (a map is a general graph: 1-to-many /
// many-to-many / isolated nodes, edges drawn explicitly), while the message
// layer is REUSED: a map node's thread lives in thread_items keyed by
// board_id = map_id, node_id = map_nodes.id (or "__general__" for the map-wide
// chat). thread_items rows for a map never collide with board stats because no
// `boards` row carries a map_id. Node delete is LOGICAL (deleted_at) so the
// node's messages / edges never dangle.
db.run(`
  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  )
`);
// Map nodes carry their own free-form position (x/y) and optional persisted
// size (w/h) because the layout is spatial + stable (no auto-relayout — the
// place the user drags a node to is remembered). kind ∈ question | idea |
// research | note (selection reserved). title + context mirror a dt node so
// the same card components render it.
db.run(`
  CREATE TABLE IF NOT EXISTS map_nodes (
    map_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'idea',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    w REAL,
    h REAL,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (map_id, id)
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS map_nodes_by_map ON map_nodes(map_id)`,
);
// A map node can be flagged as a checklist node — the same mechanism a board
// node uses (is_checklist=1). It then renders its checklist_items (reused via
// board_id = map_id, node_id = map node id) read-only INSTEAD of a
// conversation thread. Mutated only through the map checklist tools.
safeAlter(
  "ALTER TABLE map_nodes ADD COLUMN is_checklist INTEGER NOT NULL DEFAULT 0",
);
// Unread tracking for checklist map nodes (a checklist node has no thread, so
// the per-message read_at mechanism doesn't apply). A monotonic version counter
// (NOT a timestamp — ms-resolution timestamps collide when a read and a change
// land in the same millisecond): checklist_version is bumped whenever the node
// becomes a checklist or an item is added/changed; checklist_read_version is
// set to the current version when the user dwells on the node (same visible
// rule as a thread). Unread = version > read_version.
safeAlter(
  "ALTER TABLE map_nodes ADD COLUMN checklist_version INTEGER NOT NULL DEFAULT 0",
);
safeAlter(
  "ALTER TABLE map_nodes ADD COLUMN checklist_read_version INTEGER NOT NULL DEFAULT 0",
);
export const setMapNodeChecklist = db.prepare(
  `UPDATE map_nodes SET is_checklist = ? WHERE map_id = ? AND id = ? AND deleted_at IS NULL`,
);
export const bumpMapChecklistVersion = db.prepare(
  `UPDATE map_nodes SET checklist_version = checklist_version + 1 WHERE map_id = ? AND id = ?`,
);
// Advance read_version only to the version the CLIENT actually observed (never
// past it — a change that landed after the client rendered stays unread — and
// never backwards). The caller passes the observed version twice.
export const setMapChecklistRead = db.prepare(
  `UPDATE map_nodes SET checklist_read_version = ?
     WHERE map_id = ? AND id = ? AND checklist_read_version < ?`,
);
// Directed edges. Both the human (drawing in the UI) and the AI (connect tool)
// create these; delete is logical so an edge whose endpoint node was logically
// deleted can still be reasoned about. from_id/to_id reference map_nodes.id.
db.run(`
  CREATE TABLE IF NOT EXISTS map_edges (
    map_id TEXT NOT NULL,
    id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (map_id, id)
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS map_edges_by_map ON map_edges(map_id)`,
);

// Grouping frames — purely-visual labelled rectangles the USER draws BEHIND the
// nodes/edges to group them (the AI never touches these, same as node layout).
// color is a free-form string (a hex value) so a colour picker can be added
// later without a schema change; the UI offers presets for now. Soft-deleted so
// it can ride the same Cmd+Z undo path as nodes/edges.
db.run(`
  CREATE TABLE IF NOT EXISTS map_frames (
    map_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    w REAL NOT NULL DEFAULT 240,
    h REAL NOT NULL DEFAULT 160,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (map_id, id)
  )
`);
db.run(
  `CREATE INDEX IF NOT EXISTS map_frames_by_map ON map_frames(map_id)`,
);
// The label's font size, in flow-coordinate px (the user drags the label corner
// to scale it so it stays readable when zoomed out). NULL = the default base
// size, applied by the frontend.
safeAlter("ALTER TABLE map_frames ADD COLUMN title_size REAL");

// --- Prepared statements ---
//
// IMPORTANT: there are intentionally NO DELETE FROM statements anywhere.
// All "remove" operations preserve the underlying conversation/thread data:
//   - sessions: soft-deleted via alive=0 (cleanStaleSessions / handleUnregister)
//   - boards:   archived=1 or status=completed (UPDATE, never DELETE)
//   - nodes:    deleted_at timestamp
//   - thread_items / pending_messages: never deleted, only flagged
// Past discussions are a permanent asset.

export const insertSession = db.prepare(
  `INSERT INTO sessions (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
);
export const updateSessionSeen = db.prepare(
  `UPDATE sessions SET last_seen = ? WHERE id = ?`,
);
export const insertBoard = db.prepare(
  `INSERT INTO boards (id, title, session_id, created_at) VALUES (?, ?, ?, ?)`,
);
export const closeBoardStmt = db.prepare(
  `UPDATE boards SET closed = 1 WHERE id = ?`,
);
export const selectBoard = db.prepare(`SELECT * FROM boards WHERE id = ?`);

export const insertNode = db.prepare(
  `INSERT INTO nodes (board_id, id, parent_id, kind, title, context, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export const updateNodeStatus = db.prepare(
  `UPDATE nodes SET status = ? WHERE board_id = ? AND id = ?`,
);
// A user posting into a node means it's actively being worked again, so
// pull it back into 'discussing'. Covers both 'pending' (never started)
// and 'needs-reply' (was flagged for the user — their reply clears that
// flag). Other statuses (adopted / rejected / etc) are deliberate verdicts
// and are left alone. `changes` on the result tells the caller whether a
// transition actually happened, so it can log it / broadcast it.
export const bumpStatusToDiscussing = db.prepare(
  `UPDATE nodes SET status = 'discussing' WHERE board_id = ? AND id = ? AND status IN ('pending', 'needs-reply')`,
);
export const selectNodesByBoard = db.prepare(
  `SELECT * FROM nodes WHERE board_id = ? AND deleted_at IS NULL ORDER BY position`,
);
export const selectChecklistItemsByNode = db.prepare(
  `SELECT * FROM checklist_items WHERE board_id = ? AND node_id = ? ORDER BY position ASC, id ASC`,
);
export const insertChecklistSource = db.prepare(
  `INSERT INTO checklist_item_sources (item_id, board_id, kind, ref_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
export const selectChecklistSourcesByItem = db.prepare(
  `SELECT * FROM checklist_item_sources WHERE item_id = ? ORDER BY position ASC, id ASC`,
);
export const selectMaxPosRoot = db.prepare(
  `SELECT MAX(position) AS max_pos FROM nodes WHERE board_id = ? AND parent_id IS NULL`,
);
export const selectMaxPosChild = db.prepare(
  `SELECT MAX(position) AS max_pos FROM nodes WHERE board_id = ? AND parent_id = ?`,
);

const insertThreadRaw = db.prepare(
  `INSERT INTO thread_items (board_id, node_id, source, text, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)`,
);

// Hides the read_at policy: user / system messages start out read (the user
// just sent them / they're auto-noise); only CC messages start unread so the
// user gets notified.
export function insertThreadItem(
  boardId: string,
  nodeId: string,
  source: ThreadSource | "system",
  text: string,
  createdAt: string,
) {
  const readAt = source === "cc" ? null : createdAt;
  return insertThreadRaw.run(boardId, nodeId, source, text, createdAt, readAt);
}

// Backwards-compat shim — keeps the old `insertThread.run(...)` call sites
// untouched as we migrate other handlers over.
export const insertThread = {
  run: (
    boardId: string,
    nodeId: string,
    source: string,
    text: string,
    createdAt: string,
  ) =>
    insertThreadItem(
      boardId,
      nodeId,
      source as ThreadSource | "system",
      text,
      createdAt,
    ),
};

export const selectThreadsByBoard = db.prepare(
  `SELECT * FROM thread_items WHERE board_id = ? ORDER BY id`,
);

// Favorites (= anchors). Insert uses INSERT OR IGNORE so the UNIQUE
// constraint on (session_id, thread_item_id) is a no-op when the user
// re-pins something already pinned; the UI treats the Anchor icon as a
// toggle so handleAddFavorite needs to be idempotent.
export const insertFavorite = db.prepare(
  `INSERT OR IGNORE INTO favorites (session_id, board_id, node_id, thread_item_id, created_at) VALUES (?, ?, ?, ?, ?)`,
);
export const removeFavoriteByThreadItem = db.prepare(
  `DELETE FROM favorites WHERE session_id = ? AND thread_item_id = ?`,
);
export const selectFavoritesBySession = db.prepare(
  `SELECT id, session_id, board_id, node_id, thread_item_id, created_at FROM favorites WHERE session_id = ? ORDER BY created_at DESC, id DESC`,
);
// Used by the frontend to know which messages render with the "anchored"
// shadow; cheap because it's keyed off the session and is small per session.
export const selectFavoriteThreadItemIdsBySession = db.prepare(
  `SELECT thread_item_id FROM favorites WHERE session_id = ?`,
);

export const insertPending = db.prepare(
  `INSERT INTO pending_messages (session_id, board_id, node_id, node_path, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
export const selectPending = db.prepare(
  `SELECT * FROM pending_messages WHERE session_id = ? AND delivered = 0 AND cancelled = 0 ORDER BY created_at`,
);
export const markDelivered = db.prepare(
  `UPDATE pending_messages SET delivered = 1 WHERE id = ?`,
);
// Links a pending message to the thread_items row created for it at delivery
// (see handlePollMessages), so message_id can ride the channel push.
export const setPendingThreadItem = db.prepare(
  `UPDATE pending_messages SET thread_item_id = ? WHERE id = ?`,
);

// --- Map prepared statements ---
export const insertMap = db.prepare(
  `INSERT INTO maps (id, session_id, title, created_at) VALUES (?, ?, ?, ?)`,
);
export const selectMap = db.prepare(
  `SELECT * FROM maps WHERE id = ? AND deleted_at IS NULL`,
);
export const selectMapsBySession = db.prepare(
  `SELECT * FROM maps WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at`,
);
export const renameMap = db.prepare(
  `UPDATE maps SET title = ? WHERE id = ?`,
);
export const archiveMapStmt = db.prepare(
  `UPDATE maps SET archived = ? WHERE id = ?`,
);
export const insertMapNode = db.prepare(
  `INSERT INTO map_nodes (map_id, id, title, context, kind, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export const selectMapNode = db.prepare(
  `SELECT * FROM map_nodes WHERE map_id = ? AND id = ? AND deleted_at IS NULL`,
);
export const selectMapNodesByMap = db.prepare(
  `SELECT * FROM map_nodes WHERE map_id = ? AND deleted_at IS NULL ORDER BY created_at`,
);
export const updateMapNodeContent = db.prepare(
  `UPDATE map_nodes SET title = ?, context = ?, kind = ? WHERE map_id = ? AND id = ?`,
);
export const updateMapNodePos = db.prepare(
  `UPDATE map_nodes SET x = ?, y = ?, w = ?, h = ? WHERE map_id = ? AND id = ?`,
);
export const softDeleteMapNode = db.prepare(
  `UPDATE map_nodes SET deleted_at = ? WHERE map_id = ? AND id = ?`,
);
export const insertMapEdge = db.prepare(
  `INSERT INTO map_edges (map_id, id, from_id, to_id, created_at) VALUES (?, ?, ?, ?, ?)`,
);
export const selectMapEdgesByMap = db.prepare(
  `SELECT * FROM map_edges WHERE map_id = ? AND deleted_at IS NULL ORDER BY created_at`,
);
export const selectMapEdgeByPair = db.prepare(
  `SELECT * FROM map_edges WHERE map_id = ? AND from_id = ? AND to_id = ? AND deleted_at IS NULL`,
);
export const softDeleteMapEdge = db.prepare(
  `UPDATE map_edges SET deleted_at = ? WHERE map_id = ? AND id = ?`,
);
// Undo for an accidental delete: clear deleted_at so the node/edge is live
// again. Because delete is logical, the row (and its messages) was never gone
// — restoring is just flipping the tombstone back off.
export const restoreMapNode = db.prepare(
  `UPDATE map_nodes SET deleted_at = NULL WHERE map_id = ? AND id = ?`,
);
export const restoreMapEdge = db.prepare(
  `UPDATE map_edges SET deleted_at = NULL WHERE map_id = ? AND id = ?`,
);

// Grouping frames (user-owned visual rectangles). Same soft-delete + restore
// shape as nodes/edges.
export const insertMapFrame = db.prepare(
  `INSERT INTO map_frames (map_id, id, title, color, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export const selectMapFramesByMap = db.prepare(
  `SELECT * FROM map_frames WHERE map_id = ? AND deleted_at IS NULL ORDER BY created_at`,
);
export const updateMapFrame = db.prepare(
  `UPDATE map_frames SET title = ?, color = ?, x = ?, y = ?, w = ?, h = ?, title_size = ? WHERE map_id = ? AND id = ?`,
);
export const softDeleteMapFrame = db.prepare(
  `UPDATE map_frames SET deleted_at = ? WHERE map_id = ? AND id = ?`,
);
export const restoreMapFrame = db.prepare(
  `UPDATE map_frames SET deleted_at = NULL WHERE map_id = ? AND id = ?`,
);

// --- Board status auto-rollup ---
//
// "discussing" and "settled" are derived from the constituent nodes; the
// broker recomputes them on every node-status / structure mutation.
// "completed" / "withdrawn" / "paused" are explicit user/LLM lifecycle
// decisions and are NOT touched here — once a board is marked completed
// the auto-rollup leaves it alone.
//
// The legacy value 'active' (pre-rename) is treated as "auto-managed" for
// the migration path so the startup loop below can rewrite it without a
// special case at every call site.

export function recomputeBoardStatus(boardId: string): BoardStatus | null {
  const cur = db
    .prepare("SELECT status FROM boards WHERE id = ?")
    .get(boardId) as { status: string } | null;
  if (!cur) return null;
  const isAuto = (AUTO_BOARD_STATUSES as readonly string[]).includes(cur.status);
  const isLegacyActive = cur.status === "active";
  if (!isAuto && !isLegacyActive) return cur.status as BoardStatus;

  // Only ITEM nodes feed the rollup. Concerns are category headers, not
  // discussion points themselves — their `status` field defaults to
  // 'pending' and most users never touch it, which would otherwise pin the
  // board at 'discussing' forever even when every item underneath has
  // landed on a verdict.
  const nodes = db
    .prepare(
      // is_log items are the auto-created "Structure changes" log node;
      // they're not part of the user's actual decision space, so they
      // shouldn't influence board-status rollup.
      "SELECT status FROM nodes WHERE board_id = ? AND kind = 'item' AND deleted_at IS NULL AND is_log = 0",
    )
    .all(boardId) as { status: string }[];
  let target: BoardStatus;
  if (nodes.length === 0) {
    // No items: empty / concern-only board. Treat as still in discussion.
    target = "discussing";
  } else {
    const allSettled = nodes.every((n) =>
      isSettledNodeStatus(n.status as NodeStatus),
    );
    target = allSettled ? "settled" : "discussing";
  }
  // Promote a settled board to "completed" once its checklist is fully
  // resolved — every checklist item done or dropped. Auto-derived like
  // settled, but "completed" is NOT in AUTO_BOARD_STATUSES, so the next
  // recompute returns early at the guard above: it promotes once and then
  // freezes (no auto-demote even if an item later reopens). A board with no
  // checklist node, or an empty checklist, never auto-completes.
  if (target === "settled") {
    const checklistNode = db
      .prepare(
        "SELECT id FROM nodes WHERE board_id = ? AND is_checklist = 1 AND deleted_at IS NULL LIMIT 1",
      )
      .get(boardId) as { id: string } | undefined;
    if (checklistNode) {
      const clItems = db
        .prepare("SELECT status FROM checklist_items WHERE board_id = ?")
        .all(boardId) as { status: string }[];
      if (
        clItems.length > 0 &&
        clItems.every((i) => i.status === "done" || i.status === "dropped")
      ) {
        target = "completed";
      }
    }
  }
  if (cur.status !== target) {
    db.run("UPDATE boards SET status = ? WHERE id = ?", [target, boardId]);
  }
  return target;
}

// One-shot migrations on broker startup:
//   1. Rewrite every legacy 'active' row using the recompute logic so
//      existing installs converge to the new `discussing` / `settled`
//      taxonomy without manual SQL.
//   2. Re-run recompute over every currently-auto-managed row too
//      (`discussing` / `settled`) so changes in the recompute rules
//      themselves (e.g. items-only judgement) propagate to data that
//      hasn't been mutated since the last broker boot.
//   3. Pin every concern node's status back to the default 'pending'.
//      Concerns are category headers — their status is ignored by the
//      rollup, never shown in the UI, and a stray non-default value
//      would drift the schema invariant the broker now enforces at
//      every set_node_status / update_node mutation.
{
  const targets = db
    .query(
      "SELECT id FROM boards WHERE status IN ('active', 'discussing', 'settled')",
    )
    .all() as { id: string }[];
  for (const b of targets) recomputeBoardStatus(b.id);
  db.run(
    "UPDATE nodes SET status = 'pending' WHERE kind = 'concern' AND status != 'pending'",
  );
}
