// The issue tracker: a cross-session ledger of outstanding work, maintained
// deliberately rather than derived from anything.
//
// WHY THIS EXISTS AT ALL — read before "improving" it. dt shipped a per-session
// "issue view" in July 2026 that PROJECTED node statuses into four lanes. It was
// never opened once, because a projection holds no information the sidebar
// doesn't already show, and nothing can be worked or closed in it. It was
// removed on 2026-07-28 (local skill: session-issue-view-removed). The invariant
// that falls out, and that this module exists to honour:
//
//   an issue row must hold something that lives NOWHERE else,
//   and closing it must mean something.
//
// So: real rows, written by CC through MCP tools and by the user through the UI.
// Derived data (e.g. the state of linked boards) may only ever be an accessory
// shown next to an issue — never the content of the view. Making the aggregate
// the main event is exactly how the projection failed.

import { db } from "./db.ts";
import { generateRandomId } from "./helpers.ts";

// Who currently holds the ball. Split from `state` on purpose: a single status
// enum with "blocked" in it loses the subject — "blocked" cannot say whether it
// is waiting on the user or on CC, and "in-progress" cannot say who is doing the
// work. Two orthogonal axes read unambiguously in every combination
// (user+todo = waiting on the user; user+doing = the user is working on it).
export const ISSUE_OWNERS = ["user", "cc", "external"] as const;
export const ISSUE_STATES = ["todo", "doing", "done", "dropped"] as const;
export type IssueOwner = (typeof ISSUE_OWNERS)[number];
export type IssueState = (typeof ISSUE_STATES)[number];

const OWNER_SET = new Set<string>(ISSUE_OWNERS);
const STATE_SET = new Set<string>(ISSUE_STATES);

db.run(`
  CREATE TABLE IF NOT EXISTS issues (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    owner       TEXT NOT NULL DEFAULT 'cc',
    state       TEXT NOT NULL DEFAULT 'todo',
    session_id  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    closed_at   TEXT
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state)");
// Deletion is LOGICAL, never physical. An issue carries the only written record
// of why something was outstanding; a stray DELETE destroys context nobody can
// reconstruct, and "I deleted the wrong one" has no undo. Rows stay; every read
// path filters deleted_at IS NULL.
safeAlterIssues("ALTER TABLE issues ADD COLUMN deleted_at TEXT");
db.run("CREATE INDEX IF NOT EXISTS idx_issues_session ON issues(session_id)");

// Which MESSAGES belong to which issue. The point is not a "jump to the board"
// link — it is being able to read one issue's conversation as a single timeline,
// no matter which board, map or diagram each part of it happened on.
//
// The unit is a message, not a node, and the relation is many-to-many. Both were
// argued through on 2026-07-28: a node-level link needs 1/6 as many decisions,
// but a single node routinely holds a one-off exchange about a different problem
// ("wait, is this…?" mid-task), and folding that into the node's issue produces
// an aggregate that looks right and isn't. A message is the smallest thing worth
// splitting; when one message genuinely covers two issues it gets two links
// rather than being cut up.
//
// This replaces an earlier, wider (issue → board | node | map | diagram) shape
// that was added speculatively and never written to. It is narrowed on purpose:
// a message already identifies its board and node, so the wider form bought
// nothing. Decision trail: dt board bd_d5a34e7f4de4f06eeba66168a50ba139.
{
  // The old table's primary key included a nullable column, so it could not
  // actually reject duplicates. It never held a row, so replacing it outright is
  // safe — but check rather than assume, and leave it alone if that ever stops
  // being true.
  const legacy = db
    .prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='issue_links' AND sql LIKE '%target_id%'",
    )
    .get() as { c: number };
  if (legacy.c > 0) {
    const rows = (
      db.prepare("SELECT COUNT(*) AS c FROM issue_links").get() as { c: number }
    ).c;
    if (rows === 0) db.run("DROP TABLE issue_links");
    else console.error(`[issues] legacy issue_links has ${rows} row(s) — left in place`);
  }
}
db.run(`
  CREATE TABLE IF NOT EXISTS issue_links (
    issue_id        TEXT NOT NULL,
    thread_item_id  INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (issue_id, thread_item_id)
  )
`);
// Reverse lookup: "which issues does this message belong to", asked once per
// message when rendering a thread.
db.run(
  "CREATE INDEX IF NOT EXISTS idx_issue_links_item ON issue_links(thread_item_id)",
);

// The cross-session view's filter state. One row, because the tracker itself is
// cross-session — there is nothing to key it by. It lives in the DB rather than
// localStorage on the user's instruction: re-picking filters in every browser is
// annoying, and wanting different filters per browser is not a real need.
db.run(`
  CREATE TABLE IF NOT EXISTS issue_filters (
    id          TEXT PRIMARY KEY,
    filters     TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )
`);

function safeAlterIssues(sql: string): void {
  try {
    db.run(sql);
  } catch {
    /* column already present — the migration is idempotent by design */
  }
}

export type IssueRow = {
  id: string;
  title: string;
  body: string;
  owner: IssueOwner;
  state: IssueState;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  // Only present on list reads (joined from sessions), and null once the
  // originating session row is gone.
  session_name?: string | null;
  session_cwd?: string | null;
  deleted_at?: string | null;
};

const selectIssue = db.prepare(
  "SELECT * FROM issues WHERE id = ? AND deleted_at IS NULL",
);

function nowIso(): string {
  return new Date().toISOString();
}

// Reject unknown enum values at the door so bad rows never reach the UI.
// null means INVALID, never "absent" — callers decide what absence means. An
// earlier version folded the two together and silently rewrote a typo'd owner
// into the default, which would have filed the issue under the wrong person
// with no error to notice.
function coerceOwner(v: unknown): IssueOwner | null {
  return typeof v === "string" && OWNER_SET.has(v) ? (v as IssueOwner) : null;
}
function coerceState(v: unknown): IssueState | null {
  return typeof v === "string" && STATE_SET.has(v) ? (v as IssueState) : null;
}

export function handleCreateIssue(body: any):
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string } {
  const title = String(body?.title ?? "").trim();
  if (!title) return { ok: false, error: "title required" };
  const owner = body?.owner === undefined ? "cc" : coerceOwner(body.owner);
  if (!owner) return { ok: false, error: `owner must be one of ${ISSUE_OWNERS.join(" / ")}` };
  const state = body?.state === undefined ? "todo" : coerceState(body.state);
  if (!state) return { ok: false, error: `state must be one of ${ISSUE_STATES.join(" / ")}` };

  const now = nowIso();
  const id = generateRandomId("iss");
  db.run(
    `INSERT INTO issues (id, title, body, owner, state, session_id, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      String(body?.body ?? ""),
      owner,
      state,
      body?.session_id ? String(body.session_id) : null,
      now,
      now,
      state === "done" || state === "dropped" ? now : null,
    ],
  );
  return { ok: true, issue: selectIssue.get(id) as IssueRow };
}

export function handleUpdateIssue(body: any):
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string } {
  const id = String(body?.issue_id ?? body?.id ?? "");
  const current = selectIssue.get(id) as IssueRow | undefined;
  if (!current) return { ok: false, error: "issue not found" };

  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (body?.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) return { ok: false, error: "title cannot be empty" };
    sets.push("title = ?");
    args.push(t);
  }
  if (body?.body !== undefined) {
    sets.push("body = ?");
    args.push(String(body.body));
  }
  if (body?.owner !== undefined) {
    const owner = coerceOwner(body.owner);
    if (!owner) return { ok: false, error: `owner must be one of ${ISSUE_OWNERS.join(" / ")}` };
    sets.push("owner = ?");
    args.push(owner);
  }
  let nextState: IssueState = current.state;
  if (body?.state !== undefined) {
    const state = coerceState(body.state);
    if (!state) return { ok: false, error: `state must be one of ${ISSUE_STATES.join(" / ")}` };
    nextState = state;
    sets.push("state = ?");
    args.push(state);
  }
  if (sets.length === 0) return { ok: true, issue: current };

  // closed_at tracks the CLOSED/OPEN edge, not every write: stamp it when the
  // issue first lands on done/dropped, clear it if it reopens. Without the edge
  // check, editing the body of a closed issue would keep moving its close time.
  const wasClosed = current.state === "done" || current.state === "dropped";
  const isClosed = nextState === "done" || nextState === "dropped";
  const now = nowIso();
  if (isClosed !== wasClosed) {
    sets.push("closed_at = ?");
    args.push(isClosed ? now : null);
  }
  sets.push("updated_at = ?");
  args.push(now);
  args.push(id);
  db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, args);
  return { ok: true, issue: selectIssue.get(id) as IssueRow };
}

export function handleListIssues(body: any): {
  ok: true;
  issues: IssueRow[];
} {
  const where: string[] = [];
  const args: string[] = [];
  const owner = coerceOwner(body?.owner);
  if (owner) {
    where.push("i.owner = ?");
    args.push(owner);
  }
  const state = coerceState(body?.state);
  if (state) {
    where.push("i.state = ?");
    args.push(state);
  }
  if (body?.session_id) {
    where.push("i.session_id = ?");
    args.push(String(body.session_id));
  }
  // Reverse lookup: which issues does this message belong to. Used when
  // rendering a thread, and by the timeline view in the other direction.
  if (body?.linked_to_message !== undefined) {
    where.push(
      "EXISTS (SELECT 1 FROM issue_links l WHERE l.issue_id = i.id AND l.thread_item_id = ?)",
    );
    args.push(String(body.linked_to_message));
  }
  // Default view = what is actually outstanding. Closed issues are opt-in, so
  // the list answers "what is on my plate" without a filter dance every time.
  if (!state && body?.include_closed !== true) {
    where.push("i.state NOT IN ('done', 'dropped')");
  }
  // Deleted rows are opt-in too, so the UI can offer a bin to restore from.
  // Without a way to see them, a logical delete is a physical one as far as the
  // user is concerned.
  where.push(
    body?.include_deleted === true
      ? "1 = 1"
      : "i.deleted_at IS NULL",
  );
  // session_name comes along so the cross-session view can say WHICH session an
  // issue came from without a second round-trip per row.
  const sql =
    "SELECT i.*, s.name AS session_name, s.cwd AS session_cwd" +
    " FROM issues i LEFT JOIN sessions s ON s.id = i.session_id" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    // Oldest-updated first would bury fresh work; newest-updated first matches
    // how the user scans the list.
    " ORDER BY i.updated_at DESC";
  return { ok: true, issues: db.prepare(sql).all(...args) as IssueRow[] };
}

const DEFAULT_FILTER_ID = "default";

export function handleGetIssueFilters(): { ok: true; filters: unknown } {
  const row = db
    .prepare("SELECT filters FROM issue_filters WHERE id = ?")
    .get(DEFAULT_FILTER_ID) as { filters: string } | undefined;
  if (!row) return { ok: true, filters: null };
  try {
    return { ok: true, filters: JSON.parse(row.filters) };
  } catch {
    // A corrupt blob must not break the view — fall back to "no saved filters"
    // and let the next save overwrite it.
    return { ok: true, filters: null };
  }
}

export function handleSetIssueFilters(body: any):
  | { ok: true }
  | { ok: false; error: string } {
  if (body?.filters === undefined) return { ok: false, error: "filters required" };
  db.run(
    `INSERT INTO issue_filters (id, filters, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET filters = excluded.filters, updated_at = excluded.updated_at`,
    [DEFAULT_FILTER_ID, JSON.stringify(body.filters), nowIso()],
  );
  return { ok: true };
}

export function handleGetIssue(body: any):
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string } {
  const issue = selectIssue.get(String(body?.issue_id ?? body?.id ?? "")) as
    | IssueRow
    | undefined;
  return issue ? { ok: true, issue } : { ok: false, error: "issue not found" };
}

export function handleDeleteIssue(body: any):
  | { ok: true }
  | { ok: false; error: string } {
  const id = String(body?.issue_id ?? body?.id ?? "");
  if (!selectIssue.get(id)) return { ok: false, error: "issue not found" };
  // Logical: the row (and its links) stay, so a mistaken delete is one
  // restore_issue away and the reasoning written in `body` is never lost.
  db.run("UPDATE issues SET deleted_at = ?, updated_at = ? WHERE id = ?", [
    nowIso(),
    nowIso(),
    id,
  ]);
  return { ok: true };
}

export function handleRestoreIssue(body: any):
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string } {
  const id = String(body?.issue_id ?? body?.id ?? "");
  const row = db
    .prepare("SELECT id FROM issues WHERE id = ? AND deleted_at IS NOT NULL")
    .get(id);
  if (!row) return { ok: false, error: "no deleted issue with that id" };
  db.run("UPDATE issues SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
    nowIso(),
    id,
  ]);
  return { ok: true, issue: selectIssue.get(id) as IssueRow };
}

// Attach a just-posted message to zero or more issues. Called from the post
// handlers rather than by the caller in a second round-trip, so a link can never
// be lost between "the message exists" and "someone remembered to link it".
//
// Unknown ids are dropped rather than raising: a post must not fail because of a
// stale issue id — losing the message is far worse than losing the link. The
// count of accepted links comes back so the caller can tell the difference.
export function linkMessageToIssues(
  threadItemId: number,
  issueIds: unknown,
): number {
  if (!Array.isArray(issueIds) || issueIds.length === 0) return 0;
  const now = nowIso();
  let linked = 0;
  for (const raw of issueIds) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (!selectIssue.get(id)) continue;
    db.run(
      "INSERT OR IGNORE INTO issue_links (issue_id, thread_item_id, created_at) VALUES (?, ?, ?)",
      [id, threadItemId, now],
    );
    linked++;
  }
  return linked;
}

export function handleLinkIssueMessage(body: any):
  | { ok: true; linked: number }
  | { ok: false; error: string } {
  const messageId = Number(body?.message_id ?? body?.thread_item_id);
  if (!Number.isFinite(messageId)) return { ok: false, error: "message_id required" };
  return { ok: true, linked: linkMessageToIssues(messageId, body?.issue_ids) };
}

export function handleUnlinkIssueMessage(body: any):
  | { ok: true; unlinked: number }
  | { ok: false; error: string } {
  const messageId = Number(body?.message_id ?? body?.thread_item_id);
  if (!Number.isFinite(messageId)) return { ok: false, error: "message_id required" };
  const id = String(body?.issue_id ?? "");
  const res = id
    ? db.run("DELETE FROM issue_links WHERE issue_id = ? AND thread_item_id = ?", [id, messageId])
    : db.run("DELETE FROM issue_links WHERE thread_item_id = ?", [messageId]);
  return { ok: true, unlinked: res.changes };
}

export const routes = {
  "/create-issue": handleCreateIssue,
  "/link-issue-message": handleLinkIssueMessage,
  "/unlink-issue-message": handleUnlinkIssueMessage,
  "/update-issue": handleUpdateIssue,
  "/list-issues": handleListIssues,
  "/get-issue": handleGetIssue,
  "/delete-issue": handleDeleteIssue,
  "/restore-issue": handleRestoreIssue,
  "/get-issue-filters": handleGetIssueFilters,
  "/set-issue-filters": handleSetIssueFilters,
};
