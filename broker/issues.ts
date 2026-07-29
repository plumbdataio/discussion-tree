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

import { db, insertPending } from "./db.ts";
import { generateRandomId } from "./helpers.ts";
import { syncIssueChatTitle } from "./issue-chat.ts";

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

// CLOSING NEEDS THE USER'S SIGN-OFF.
//
// Set when the close was acknowledged by the user; NULL on a closed issue means
// CC finished it and the user has not seen that yet. Two problems it solves,
// and the second is the important one:
//
//  - What CC considers finished and what the user considers finished can drift
//    apart silently.
//  - With the work delegated end to end, the user never gets the moment where
//    "that one is done" registers. Nothing is ever handed back, so nothing is
//    ever remembered as complete. The approval IS that moment — which is why
//    the pending row shows what was done, rather than being a bare button.
//
// Deliberately NOT a new `state`: owner × state is a deliberate 2-axis model
// (see the tracker's design notes) and a `pending_close` value would collapse
// "what is happening to this" with "who has to act next".
{
  const fresh = safeAlterIssues("ALTER TABLE issues ADD COLUMN close_approved_at TEXT");
  if (fresh) {
    // One-time backfill, run only in the migration that adds the column: every
    // issue closed before this existed is treated as already acknowledged.
    // Asking for 23 retroactive approvals would be pure clicking — the moment
    // those were finished has passed, and re-approving them now would not put
    // anything back into anyone's memory.
    db.run(
      "UPDATE issues SET close_approved_at = closed_at WHERE closed_at IS NOT NULL",
    );
  }
}

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

// Returns true when the column was actually added, i.e. this process ran the
// migration — the only moment a one-time backfill may run. Re-running a
// backfill on every boot would keep overwriting rows that have since changed.
function safeAlterIssues(sql: string): boolean {
  try {
    db.run(sql);
    return true;
  } catch {
    /* column already present — the migration is idempotent by design */
    return false;
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
  // NULL on a closed issue = CC closed it and the user has not acknowledged
  // that yet. See the migration above for why this is a column and not a state.
  close_approved_at?: string | null;
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
  // Filed already-closed needs no sign-off: that is a record of something that
  // was finished before the issue existed (a migration, a stock-take), not work
  // being handed over. The approval exists for the TRANSITION — an issue that
  // was open and is now closed — and asking about dozens of historical rows
  // would bury the handful that mean something.
  const closedNow = state === "done" || state === "dropped" ? now : null;
  db.run(
    `INSERT INTO issues (id, title, body, owner, state, session_id, created_at, updated_at, closed_at, close_approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      String(body?.body ?? ""),
      owner,
      state,
      body?.session_id ? String(body.session_id) : null,
      now,
      now,
      closedNow,
      closedNow,
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
  // Re-homing an issue to another session. Explicit null detaches it, which is
  // how an issue that turned out not to belong anywhere stops being filtered
  // away by a session the user no longer looks at.
  if (body?.session_id !== undefined) {
    sets.push("session_id = ?");
    args.push(body.session_id ? String(body.session_id) : null);
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
    // Who is closing it decides whether it needs signing off. A close the user
    // performs is self-evidently known to them; a close CC performs is not, and
    // that gap is the entire point of the column. Reopening clears it, so a
    // second close asks again.
    sets.push("close_approved_at = ?");
    args.push(isClosed && body?.actor === "user" ? now : null);
  }
  sets.push("updated_at = ?");
  args.push(now);
  args.push(id);
  db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, args);
  const updated = selectIssue.get(id) as IssueRow;
  // The conversation node carries the issue's title, and that node is what the
  // board and the sidebar show — leaving the old wording there makes a renamed
  // issue read as a different one.
  if (body?.title !== undefined) syncIssueChatTitle(id, updated.title);
  return { ok: true, issue: updated };
}

// The user signing off on a close CC made. Separate endpoint rather than an
// update flag: it is the one write that only the user can perform, and giving
// it its own name keeps that visible at every call site.
export function handleApproveIssueClose(body: any):
  | { ok: true; issue: IssueRow }
  | { ok: false; error: string } {
  const id = String(body?.issue_id ?? "");
  const current = selectIssue.get(id) as IssueRow | undefined;
  if (!current) return { ok: false, error: "issue not found" };
  const isClosed = current.state === "done" || current.state === "dropped";
  if (!isClosed) {
    return { ok: false, error: "issue is not closed, so there is nothing to approve" };
  }
  // Idempotent: approving twice is a double-click, not an error.
  if (!current.close_approved_at) {
    db.run("UPDATE issues SET close_approved_at = ? WHERE id = ?", [nowIso(), id]);
  }
  return { ok: true, issue: selectIssue.get(id) as IssueRow };
}

// The user declining a close CC made. Distinct from a plain state edit because
// it has to REACH CC: "I think this is finished / no it isn't" is a confirmed
// disagreement, and the whole flow exists to surface exactly that. Without a
// push, the rejection is silent on CC's side and it goes on believing the work
// is done — which is the failure the approval step was added to prevent,
// surviving in the one branch nobody looked at.
export function handleRejectIssueClose(body: any):
  | { ok: true; issue: IssueRow; notified: boolean }
  | { ok: false; error: string } {
  const id = String(body?.issue_id ?? "");
  const current = selectIssue.get(id) as IssueRow | undefined;
  if (!current) return { ok: false, error: "issue not found" };
  const isClosed = current.state === "done" || current.state === "dropped";
  if (!isClosed) {
    return { ok: false, error: "issue is not closed, so there is nothing to send back" };
  }
  const now = nowIso();
  // Back to `doing`, not `todo`: being sent back means work remains on
  // something that was actively being worked, and `todo` would read as "never
  // started". closed_at and the approval both clear, so closing it again asks
  // again rather than silently inheriting the old answer.
  db.run(
    "UPDATE issues SET state = 'doing', closed_at = NULL, close_approved_at = NULL, updated_at = ? WHERE id = ?",
    [now, id],
  );

  let notified = false;
  if (current.session_id) {
    const text =
      `[discussion-tree] The user did NOT accept your close of issue ${id} — "${current.title}".\n\n` +
      `You considered this finished; they do not. That is a confirmed disagreement, not a status tweak to note and move past: something is left, and you cannot see what.\n\n` +
      `Work out what remains from the issue's own conversation (get_issue_timeline ${id}) and from the boards it was discussed on. If that does not tell you, ASK the user. Asking is correct HERE — unlike closing, which you do without asking.\n\n` +
      `The issue is back to "doing". Do not close it again until you know what was missing.`;
    insertPending.run(
      current.session_id,
      "", // no board — an issue does not live on one
      "",
      "",
      text,
      now,
      "issue_close_rejected",
    );
    notified = true;
  }
  return { ok: true, issue: selectIssue.get(id) as IssueRow, notified };
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
  //
  // A close still awaiting sign-off is an exception: it IS outstanding, just on
  // the user's side rather than CC's. Hiding it behind "include closed" would
  // put the one thing that needs their attention in the one view they never
  // open.
  if (!state && body?.include_closed !== true) {
    where.push(
      "(i.state NOT IN ('done', 'dropped') OR i.close_approved_at IS NULL)",
    );
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
  //
  // link_count too: without it the UI can only offer "read the conversation"
  // and discover on click that there isn't one — which is what happened, and
  // reads as a broken feature rather than as an issue nobody has linked yet.
  // Cheap: issue_links is keyed on (issue_id, thread_item_id), so this is an
  // index lookup per row on a table of tens.
  //
  // chat_unread: how many messages on THIS issue's own thread the user has not
  // read. The conversation is opened from the tracker, so without a count here
  // a reply written on an issue is invisible until the row is expanded by hand.
  // The node id of an issue-chat thread IS the issue id (see issue-chat.ts),
  // which is why this needs no join back through the board.
  const sql =
    "SELECT i.*, s.name AS session_name, s.cwd AS session_cwd," +
    " (SELECT COUNT(*) FROM issue_links l WHERE l.issue_id = i.id) AS link_count," +
    " (SELECT COUNT(*) FROM thread_items t JOIN boards b ON b.id = t.board_id" +
    "   WHERE b.is_issue_chat = 1 AND t.node_id = i.id) AS chat_count," +
    " (SELECT COUNT(*) FROM thread_items t JOIN boards b ON b.id = t.board_id" +
    "   WHERE b.is_issue_chat = 1 AND t.node_id = i.id" +
    "     AND t.source = 'cc' AND t.read_at IS NULL) AS chat_unread" +
    " FROM issues i LEFT JOIN sessions s ON s.id = i.session_id" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    // Oldest-updated first would bury fresh work; newest-updated first matches
    // how the user scans the list.
    " ORDER BY i.updated_at DESC";
  return { ok: true, issues: db.prepare(sql).all(...args) as IssueRow[] };
}

// The sessions an issue may be filed under. Deliberately NOT /api/sessions:
// that one carries every board and unread count for the sidebar, and this only
// needs a name to put in a dropdown.
//
// Live sessions plus any session that already owns an issue. A dead session
// with issues still has to be selectable, or its rows become unfilterable; a
// live one with none has to be, or a new issue cannot be filed against the
// session you are working in right now.
export function handleListIssueSessions(): {
  ok: true;
  sessions: { id: string; name: string | null; cwd: string | null; alive: boolean }[];
} {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.cwd, s.alive
         FROM sessions s
        WHERE s.alive = 1
           OR EXISTS (SELECT 1 FROM issues i WHERE i.session_id = s.id)
        ORDER BY s.alive DESC, COALESCE(s.name, s.cwd, s.id)`,
    )
    .all() as { id: string; name: string | null; cwd: string | null; alive: number }[];
  return {
    ok: true,
    sessions: rows.map((r) => ({
      id: r.id,
      name: r.name,
      cwd: r.cwd,
      alive: r.alive === 1,
    })),
  };
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

// Check the ids BEFORE anything is written, so a post either lands with all of
// its links or does not land at all.
//
// An unknown id is an error rather than something to quietly skip. Dropping it
// loses the link permanently AND invisibly — nobody ever finds out — whereas an
// error costs one retry with a corrected argument, which is exactly what an
// agent does with a rejection. So the thing that actually matters is that the
// rejection says WHICH id was wrong and where to look it up.
export function validateIssueIds(issueIds: unknown):
  | { ok: true; ids: string[] }
  | { ok: false; error: string } {
  // Omission is rejected, not defaulted. The point of the required parameter is
  // that posting forces the question "does this belong to an issue?" to be
  // answered — and a default answers it for you, silently and always the same
  // way. `[]` is a real answer and stays valid.
  //
  // The broker was deliberately lenient here until 2026-07-29: the MCP schema
  // already forced the decision, but sessions still running an older tool list
  // physically could not send the field, and rejecting them would have killed
  // every post they made. Tightened once all live MCP servers were confirmed
  // restarted (measured with `ps`, not assumed). The one process left on the
  // old code is an orphan whose parent CC has exited, so it never posts.
  if (issueIds === undefined || issueIds === null) {
    return {
      ok: false,
      error:
        "issue_ids is required — nothing was posted. Pass the ids of the " +
        "issues this message belongs to, or [] if it belongs to none. Every " +
        "post records this so an issue's conversation can be read as one " +
        "timeline later (get_issue_timeline); a message posted without it is " +
        "invisible to that view and nobody finds out it is missing.",
    };
  }
  if (!Array.isArray(issueIds)) {
    return { ok: false, error: "issue_ids must be an array (use [] for none)" };
  }
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of issueIds) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (selectIssue.get(id)) ids.push(id);
    else unknown.push(id);
  }
  if (unknown.length) {
    return {
      ok: false,
      error:
        `unknown issue_ids: ${unknown.join(", ")} — nothing was posted. ` +
        "Check the ids with list_issues (a deleted issue counts as unknown; " +
        "restore it first or drop it from the list), then retry.",
    };
  }
  return { ok: true, ids };
}

// Write the links for a just-posted message. Called from the post handlers
// rather than by the caller in a second round-trip, so a link can never be lost
// between "the message exists" and "someone remembered to link it". Ids are
// expected to have been validated already.
export function linkMessageToIssues(
  threadItemId: number,
  issueIds: unknown,
): number {
  const checked = validateIssueIds(issueIds);
  if (!checked.ok) return 0;
  const now = nowIso();
  for (const id of checked.ids) {
    db.run(
      "INSERT OR IGNORE INTO issue_links (issue_id, thread_item_id, created_at) VALUES (?, ?, ?)",
      [id, threadItemId, now],
    );
  }
  return checked.ids.length;
}

export function handleLinkIssueMessage(body: any):
  | { ok: true; linked: number }
  | { ok: false; error: string } {
  const messageId = Number(body?.message_id ?? body?.thread_item_id);
  if (!Number.isFinite(messageId)) return { ok: false, error: "message_id required" };
  // Checked here rather than leaning on validateIssueIds' message, which is
  // written for the posting path ("nothing was posted") and would misdescribe
  // what happened on this one.
  if (body?.issue_ids === undefined || body?.issue_ids === null) {
    return {
      ok: false,
      error:
        "issue_ids required — pass the issues to attach to this message, " +
        "or use unlink_issue_id to detach one.",
    };
  }
  const checked = validateIssueIds(body.issue_ids);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, linked: linkMessageToIssues(messageId, checked.ids) };
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

// WHERE A MESSAGE WAS SAID.
//
// thread_items.board_id is really a container id: boards, maps and diagrams all
// keep their chat in the same table, and only one of the three joins matches.
// Joining boards alone (as the review query first did) silently drops every
// map and diagram message — which is exactly the "collected almost everything"
// failure that makes an aggregated view untrustworthy.
const LOCATION_JOINS = `
         LEFT JOIN boards b ON b.id = t.board_id
         LEFT JOIN maps mp ON mp.id = t.board_id
         LEFT JOIN diagrams dg ON dg.id = t.board_id
         LEFT JOIN nodes n ON n.board_id = t.board_id AND n.id = t.node_id
         LEFT JOIN map_nodes mn ON mn.map_id = t.board_id AND mn.id = t.node_id`;

const LOCATION_COLUMNS = `
         COALESCE(b.title, mp.title, dg.title) AS container_title,
         COALESCE(n.title, mn.title) AS node_title,
         CASE WHEN b.id IS NOT NULL THEN 'board'
              WHEN mp.id IS NOT NULL THEN 'map'
              WHEN dg.id IS NOT NULL THEN 'diagram'
              ELSE 'unknown' END AS surface`;

// The session a message belongs to, whichever surface it is on.
const LOCATION_SESSION = `COALESCE(b.session_id, mp.session_id, dg.session_id)`;

type LocationRow = {
  board_id: string;
  node_id: string;
  container_title: string | null;
  node_title: string | null;
  surface: string;
};

// "board > node". The whole-surface chats have a synthetic node id that means
// nothing to a reader, so they collapse to the container's name alone.
const GENERAL_NODES = new Set(["__chat__", "__general__", "main", "default"]);

function locationPath(r: LocationRow): string {
  const container = r.container_title ?? r.board_id;
  if (r.node_title) return `${container} > ${r.node_title}`;
  if (GENERAL_NODES.has(r.node_id)) return container;
  return `${container} > ${r.node_id}`;
}

// Everything linked to one issue, in the order it was said, across every board,
// map and diagram. This is the point of collecting links at all: the value is
// not the jump, it is reading a decision's whole conversation in one column
// without knowing where any of it happened.
//
// Unlike the review API this returns FULL text — the caller is here to read,
// and one issue's thread is a few dozen messages, not a session's history.
export function handleIssueTimeline(body: any):
  | {
      ok: true;
      issue: IssueRow;
      messages: unknown[];
    }
  | { ok: false; error: string } {
  const issueId = String(body?.issue_id ?? "");
  const issue = selectIssue.get(issueId) as IssueRow | undefined;
  if (!issue) return { ok: false, error: "issue not found" };

  const rows = db
    .prepare(
      `SELECT t.id, t.board_id, t.node_id, t.source, t.text, t.created_at,
              ${LOCATION_COLUMNS}
         FROM issue_links l
         JOIN thread_items t ON t.id = l.thread_item_id
         ${LOCATION_JOINS}
        WHERE l.issue_id = ?
        ORDER BY t.created_at, t.id`,
    )
    .all(issueId) as (LocationRow & {
    id: number;
    source: string;
    text: string;
    created_at: string;
  })[];

  return {
    ok: true,
    issue,
    messages: rows.map((r) => ({
      id: r.id,
      source: r.source,
      at: r.created_at,
      text: r.text,
      surface: r.surface,
      container_id: r.board_id,
      node_id: r.node_id,
      path: locationPath(r),
    })),
  };
}

// The link-review ritual's read side: "show me what I said and what the user
// said in this window, and what it is linked to".
//
// It returns a HEAD of each message, not the message. 348 KB of full text for a
// session's history is unusable inside a context that is already nearly full,
// whereas ~3k tokens for one compaction window is nothing — and a head of 40
// characters was measured to identify a message uniquely 100% of the time for CC
// and 97% for the user. `path` is carried because identifying a message is not
// the same as remembering it, and the board/node it lived on is the cheapest,
// strongest reminder of what the exchange was about.
//
// `to` matters as much as `from`: the ritual is meant to run before a
// compaction, but when it doesn't, the window has to be recoverable afterwards
// by asking for everything up to the compact boundary. Without it that window
// would be silently lost.
export function handleReviewMessageLinks(body: any): {
  ok: true;
  from: string | null;
  to: string | null;
  total: number;
  truncated?: boolean;
  note?: string;
  messages: unknown[];
} {
  // Hooks only know the CC-side session id, so accept either.
  const sessionId = body?.session_id
    ? String(body.session_id)
    : body?.cc_session_id
      ? ((
          db
            .prepare(
              "SELECT id FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
            )
            .get(String(body.cc_session_id)) as { id: string } | null
        )?.id ?? "")
      : "";
  const headChars = Math.max(
    10,
    Math.min(500, Number(body?.head_chars) || 60),
  );
  const limit = Math.max(1, Math.min(2000, Number(body?.limit) || 100));
  // Default the window to "since this session last finished compacting" so the
  // caller never has to know its own compact boundary — it can't see one from
  // in here.
  // Across every row sharing this cc_session_id — see the note in
  // handleSessionCompactingDone. Restarting CC starts a new broker session row,
  // so a boundary stamped before the restart lives on a different row; reading
  // only this one would make the window "all of history" right after a restart.
  // Falls back to this row alone when the session has no cc_session_id yet.
  const lastCompact = sessionId
    ? (
        db
          .prepare(
            `SELECT MAX(last_compact_at) AS last_compact_at FROM sessions
              WHERE id = ?
                 OR (cc_session_id IS NOT NULL
                     AND cc_session_id = (SELECT cc_session_id FROM sessions WHERE id = ?))`,
          )
          .get(sessionId, sessionId) as {
          last_compact_at: string | null
        } | null
      )?.last_compact_at ?? null
    : null;
  const from = body?.from ? String(body.from) : lastCompact;
  const to = body?.to ? String(body.to) : null;

  const where: string[] = ["t.source IN ('user','cc')"];
  const args: string[] = [];
  if (sessionId) {
    where.push(`${LOCATION_SESSION} = ?`);
    args.push(sessionId);
  }
  if (from) {
    where.push("t.created_at >= ?");
    args.push(from);
  }
  if (to) {
    where.push("t.created_at <= ?");
    args.push(to);
  }
  if (body?.unlinked_only !== false) {
    where.push(
      "NOT EXISTS (SELECT 1 FROM issue_links l WHERE l.thread_item_id = t.id)",
    );
  }
  const rows = db
    .prepare(
      `SELECT t.id, t.board_id, t.node_id, t.source, t.created_at,
              ${LOCATION_COLUMNS},
              substr(t.text, 1, ${headChars}) AS head
         FROM thread_items t
         ${LOCATION_JOINS}
        WHERE ${where.join(" AND ")}
        ORDER BY t.created_at ${from ? "ASC" : "DESC"}
        LIMIT ${limit}`,
    )
    .all(...args) as (LocationRow & {
    id: number;
    source: string;
    created_at: string;
    head: string;
  })[];

  const linkRows = db
    .prepare(
      "SELECT thread_item_id, issue_id FROM issue_links WHERE thread_item_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(rows.map((r) => r.id))) as {
    thread_item_id: number;
    issue_id: string;
  }[];
  const byItem = new Map<number, string[]>();
  for (const l of linkRows) {
    const cur = byItem.get(l.thread_item_id) ?? [];
    cur.push(l.issue_id);
    byItem.set(l.thread_item_id, cur);
  }

  // WHICH END GETS DROPPED depends on whether a window was given, and getting
  // that backwards is worse than the cap itself.
  //
  // With a window ("review what was just compacted"), reading starts at the
  // beginning, so the query takes the oldest and any overflow is at the far
  // end — reachable by moving `from` forward.
  //
  // WITHOUT one, the caller means "what have I not linked lately". Taking the
  // oldest there answers a question nobody asked and hides the recent end
  // entirely: reported 2026-07-29 by another session that got 800 rows from
  // June and concluded nothing recent needed linking. So the query takes the
  // NEWEST and the rows are flipped back to reading order below.
  //
  // Either way the cap is announced. No pagination cursor: this endpoint only
  // returns UNLINKED messages, so linking some makes them disappear from the
  // next call — calling again is the page turn.
  const truncated = rows.length >= limit;
  if (!from) rows.reverse();
  return {
    ok: true,
    from,
    to,
    total: rows.length,
    ...(truncated
      ? {
          truncated: true,
          note: from
            ? `Stopped at the limit of ${limit}, taken from the START of the ` +
              `window — the later part is NOT included. Link these (they drop ` +
              `out of the next call) or move 'from' forward.`
            : `Stopped at the limit of ${limit}. With no window given these are ` +
              `the MOST RECENT unlinked messages; older ones are not included. ` +
              `Link these (they drop out of the next call), or pass 'from'/'to' ` +
              `to review a specific period.`,
        }
      : {}),
    messages: rows.map((r) => ({
      id: r.id,
      source: r.source,
      at: r.created_at,
      path: locationPath(r),
      surface: r.surface,
      head: r.head,
      issues: byItem.get(r.id) ?? [],
    })),
  };
}

export const routes = {
  "/create-issue": handleCreateIssue,
  "/review-message-links": handleReviewMessageLinks,
  "/link-issue-message": handleLinkIssueMessage,
  "/unlink-issue-message": handleUnlinkIssueMessage,
  "/update-issue": handleUpdateIssue,
  "/list-issues": handleListIssues,
  "/get-issue": handleGetIssue,
  "/delete-issue": handleDeleteIssue,
  "/restore-issue": handleRestoreIssue,
  "/list-issue-sessions": handleListIssueSessions,
  "/issue-timeline": handleIssueTimeline,
  "/approve-issue-close": handleApproveIssueClose,
  "/reject-issue-close": handleRejectIssueClose,
  "/get-issue-filters": handleGetIssueFilters,
  "/set-issue-filters": handleSetIssueFilters,
};
