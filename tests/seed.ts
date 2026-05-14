#!/usr/bin/env bun
/**
 * Build a deterministic SQLite database used as the fixture for visual
 * regression tests. Mirrors the schema applied by broker.ts (post-migration
 * shape, no legacy columns) and inserts a curated set of boards covering
 * layout edge cases.
 *
 * Usage:
 *   DISCUSSION_TREE_DB=tests/test.db bun tests/seed.ts
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";

const DB_PATH = process.env.DISCUSSION_TREE_DB ?? "tests/test.db";

// Reset the file so repeated runs are idempotent.
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(`${DB_PATH}-journal`, { force: true });
fs.rmSync(`${DB_PATH}-wal`, { force: true });
fs.rmSync(`${DB_PATH}-shm`, { force: true });

const db = new Database(DB_PATH);
// Stay on the default journal mode here. The broker switches the file to WAL
// when it opens the DB; if seed leaves the DB in WAL mode without a final
// checkpoint, the residual `-wal` / `-shm` files cause disk I/O errors when
// the broker re-opens.
db.run("PRAGMA foreign_keys = ON");

// --- Schema (post-migration form) ---

db.run(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    alive INTEGER NOT NULL DEFAULT 1,
    cc_session_id TEXT,
    name TEXT
  )
`);

db.run(`
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  )
`);

db.run(`
  CREATE TABLE nodes (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (board_id, id)
  )
`);

db.run(`
  CREATE TABLE thread_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE pending_messages (
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

// --- Deterministic timestamps so screenshots are stable. ---
const T0 = "2026-05-01T00:00:00.000Z";
const T1 = "2026-05-01T01:00:00.000Z";
const T2 = "2026-05-01T02:00:00.000Z";

// --- Seed data ---

const insertSession = db.prepare(
  "INSERT INTO sessions (id, pid, cwd, registered_at, last_seen, alive, cc_session_id, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertBoard = db.prepare(
  "INSERT INTO boards (id, title, session_id, created_at, archived, status) VALUES (?, ?, ?, ?, ?, ?)",
);
const insertNode = db.prepare(
  "INSERT INTO nodes (board_id, id, parent_id, kind, title, context, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertThread = db.prepare(
  "INSERT INTO thread_items (board_id, node_id, source, text, created_at) VALUES (?, ?, ?, ?, ?)",
);

// Session: alive, named, attached to a cc id.
insertSession.run(
  "s_test",
  99999,
  "/Users/test/discussion-tree",
  T0,
  T0,
  1,
  "cc-test-uuid",
  "test session",
);

// Board 1: complex (3 concerns with mixed item counts and statuses).
insertBoard.run("bd_complex", "API design review", "s_test", T0, 0, "active");

// Concern A: 3 items with varied statuses, one having a thread.
insertNode.run(
  "bd_complex",
  "auth",
  null,
  "concern",
  "Authentication scheme",
  "JWT vs session etc.",
  "discussing",
  0,
  T0,
);
insertNode.run(
  "bd_complex",
  "auth-jwt",
  "auth",
  "item",
  "Adopt JWT",
  "Stateless, easy to scale. Sent as `Authorization: Bearer ...`.",
  "adopted",
  0,
  T0,
);
insertNode.run(
  "bd_complex",
  "auth-session",
  "auth",
  "item",
  "Adopt server-side session",
  "Backed by redis. Logout takes effect immediately.",
  "rejected",
  1,
  T0,
);
insertNode.run(
  "bd_complex",
  "auth-refresh",
  "auth",
  "item",
  "Refresh-token storage",
  "Pick between httpOnly cookie / localStorage. **Cookie wins on XSS grounds**.",
  "needs-reply",
  2,
  T0,
);

// Concern B: 2 items with thread messages on one of them.
insertNode.run(
  "bd_complex",
  "errors",
  null,
  "concern",
  "Error design",
  "Unify the shape of API error responses",
  "discussing",
  1,
  T0,
);
insertNode.run(
  "bd_complex",
  "err-shape",
  "errors",
  "item",
  "Error response shape",
  "Standardize on `{ code, message, details }`",
  "agreed",
  0,
  T0,
);
insertNode.run(
  "bd_complex",
  "err-codes",
  "errors",
  "item",
  "Error code taxonomy",
  "Numeric vs string SLUG",
  "discussing",
  1,
  T0,
);

// Concern C: 1 item only — exercises .items-row.single styling.
insertNode.run(
  "bd_complex",
  "perf",
  null,
  "concern",
  "Performance",
  "",
  "pending",
  2,
  T0,
);
insertNode.run(
  "bd_complex",
  "perf-cache",
  "perf",
  "item",
  "L1 cache strategy",
  "",
  "pending",
  0,
  T0,
);

// Threads on auth-jwt (mix of user / cc / system).
insertThread.run(
  "bd_complex",
  "auth-jwt",
  "user",
  "JWT sounds good. Expiry: 1 hour + refresh.",
  T1,
);
insertThread.run(
  "bd_complex",
  "auth-jwt",
  "cc",
  "Got it. Short expiry + refresh combo it is. RS256 OK?",
  T1,
);
insertThread.run(
  "bd_complex",
  "auth-jwt",
  "system",
  "status_change:discussing:adopted",
  T1,
);
insertThread.run(
  "bd_complex",
  "auth-jwt",
  "user",
  "RS256 is fine. Key management via KMS.",
  T2,
);

// Board 2: single concern × single item — minimal layout.
insertBoard.run("bd_minimal", "Single-item board", "s_test", T0, 0, "active");
insertNode.run(
  "bd_minimal",
  "only",
  null,
  "concern",
  "The only concern",
  "Context is also a simple one-liner",
  "pending",
  0,
  T0,
);
insertNode.run(
  "bd_minimal",
  "only-item",
  "only",
  "item",
  "The only item",
  "No thread yet",
  "pending",
  0,
  T0,
);

// Board 3: archived (should be hidden from sidebar / dashboard, visible via the
// "Archived" toggle).
insertBoard.run(
  "bd_archived",
  "Archived test",
  "s_test",
  T0,
  1,
  "withdrawn",
);
insertNode.run(
  "bd_archived",
  "x",
  null,
  "concern",
  "Withdrawn discussion",
  "",
  "rejected",
  0,
  T0,
);

console.log(`Seeded: ${DB_PATH}`);
db.close();
