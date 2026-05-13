// Database setup, schema, migrations, and prepared-statement cache.
//
// The DB lives behind a single module-level handle reused by every handler.
// Migrations are written as `ALTER TABLE ... ADD COLUMN` wrapped in try/catch:
// SQLite errors with "duplicate column name" the second time, which is fine —
// each ALTER is essentially a one-shot side effect we want to be idempotent
// across broker restarts.

import { Database } from "bun:sqlite";
import type { ThreadSource } from "../shared/types.ts";
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
// Board-level status (active / completed / withdrawn / paused) is intentionally
// distinct from node-level statuses — a board can be "completed" even if some
// nodes still show needs-reply (the work proceeded outside the board).
safeAlter(
  "ALTER TABLE boards ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
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
export const bumpStatusToDiscussing = db.prepare(
  `UPDATE nodes SET status = 'discussing' WHERE board_id = ? AND id = ? AND status = 'pending'`,
);
export const selectNodesByBoard = db.prepare(
  `SELECT * FROM nodes WHERE board_id = ? AND deleted_at IS NULL ORDER BY position`,
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

export const insertPending = db.prepare(
  `INSERT INTO pending_messages (session_id, board_id, node_id, node_path, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
export const selectPending = db.prepare(
  `SELECT * FROM pending_messages WHERE session_id = ? AND delivered = 0 AND cancelled = 0 ORDER BY created_at`,
);
export const markDelivered = db.prepare(
  `UPDATE pending_messages SET delivered = 1 WHERE id = ?`,
);
