// Talking ON an issue.
//
// The tracker could already show an issue's conversation (get_issue_timeline
// reads messages linked from anywhere), but there was nowhere to HAVE one: the
// user had to pick some board, which meant deciding where this particular
// thought belonged before writing it — and that decision alone was enough to
// stop the thought. So each issue gets a thread of its own.
//
// Shape, decided 2026-07-29 (dt board bd_vlap7p27, gate item i4):
//
//   - ONE dedicated board, with one NODE per issue. Not one board per issue.
//   - The node id IS the issue id, so the mapping needs no table and the
//     reverse lookup ("which issue is this thread about") is free — which is
//     what lets every post here be linked to its issue automatically.
//   - NOTHING is created until somebody actually writes. An issue with no
//     conversation has no board and no node; a table of zero rows is not worth
//     creating (the user's words).
//   - No new concepts: this is an ordinary board with ordinary nodes and
//     ordinary threads, so delivery, unread dots, the timeline and the Stop-hook
//     nag all keep working without knowing about issues at all.
//
// Rejected: posting into the general conversation board. It would contaminate
// the serial order of that thread — a running conversation interleaved with
// unrelated issue chatter stops being readable. A dedicated board can also be
// detached wholesale if this experiment is abandoned.
//
// ONE PER SESSION, not one globally. An issue belongs to the session that filed
// it, and /submit-answer delivers to the OWNING SESSION of the board it was
// posted on. A single global board would hand every issue's conversation to
// whichever CC happened to own that board, so a message about a cv issue would
// be delivered to the dt session and the cv session would never hear about it.
// Keying the board by the issue's session keeps "who is being talked to"
// truthful, and each session's board shows up under that session in the
// sidebar, where it belongs.

import { db, insertNode } from "./db.ts";
import { generateId } from "./helpers.ts";

// Seeded in English and overridden in the UI via i18n (same approach as the
// default conversation board) — DB text can't be re-translated later.
const BOARD_TITLE = "Issue conversations";
const CONCERN_ID = "issues";
const CONCERN_TITLE = "Issues";

// The `boards.is_issue_chat` column is declared in db.ts, not here — issue
// queries join against it, so it has to exist regardless of whether this module
// was imported.

export interface IssueChatLocation {
  board_id: string;
  node_id: string;
}

type IssueBrief = {
  id: string;
  title: string;
  session_id: string | null;
};

// Prepared inside the call, not at module level: issues.ts imports this file,
// so this module is evaluated BEFORE the CREATE TABLE at the top of that one,
// and a statement prepared now would be compiled against a table that does not
// exist yet.
function selectIssueBrief(issueId: string): IssueBrief | undefined {
  return db
    .prepare(
      "SELECT id, title, session_id FROM issues WHERE id = ? AND deleted_at IS NULL",
    )
    .get(issueId) as IssueBrief | undefined;
}

// Where an issue's conversation lives, or null when nobody has written yet.
// Read-only on purpose: the tracker asks this on every render, and rendering a
// list must not create rows.
export function findIssueChatNode(issueId: string): IssueChatLocation | null {
  const row = db
    .prepare(
      `SELECT n.board_id, n.id AS node_id
         FROM nodes n
         JOIN boards b ON b.id = n.board_id
        WHERE b.is_issue_chat = 1 AND n.id = ? AND n.deleted_at IS NULL
        LIMIT 1`,
    )
    .get(issueId) as IssueChatLocation | undefined;
  return row ?? null;
}

// The reverse: which issue is this thread about. Cheap because the node id is
// the issue id — the only cost is confirming the board is an issue-chat board,
// so an ordinary node that happens to be named like an issue can't be mistaken
// for one.
export function issueOfChatNode(
  boardId: string,
  nodeId: string,
): string | null {
  if (typeof nodeId !== "string" || !nodeId.startsWith("iss_")) return null;
  const row = db
    .prepare("SELECT is_issue_chat FROM boards WHERE id = ?")
    .get(boardId) as { is_issue_chat: number } | undefined;
  return row?.is_issue_chat === 1 ? nodeId : null;
}

// Create the board / concern / node as needed. Called on the first post only.
export function ensureIssueChatNode(
  issueId: string,
):
  | { ok: true; location: IssueChatLocation; created: boolean }
  | { ok: false; error: string } {
  const issue = selectIssueBrief(issueId);
  if (!issue) return { ok: false, error: "issue not found" };

  const existing = findIssueChatNode(issueId);
  if (existing) return { ok: true, location: existing, created: false };

  // No session means there is nobody to deliver to. Rather than picking one and
  // sending the message to a CC that has never heard of this issue, say so —
  // the caller can assign the issue to a session and try again.
  if (!issue.session_id) {
    return {
      ok: false,
      error:
        "this issue is not filed under any session, so there is no CC to talk to — set its session first",
    };
  }
  const session = db
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .get(issue.session_id) as { id: string } | undefined;
  if (!session) {
    return { ok: false, error: "the session this issue belongs to is gone" };
  }

  const now = new Date().toISOString();
  let boardId = (
    db
      .prepare(
        "SELECT id FROM boards WHERE session_id = ? AND is_issue_chat = 1 LIMIT 1",
      )
      .get(issue.session_id) as { id: string } | undefined
  )?.id;

  if (!boardId) {
    boardId = generateId("bd");
    db.run(
      "INSERT INTO boards (id, title, session_id, created_at, is_issue_chat) VALUES (?, ?, ?, ?, 1)",
      [boardId, BOARD_TITLE, issue.session_id, now],
    );
    insertNode.run(
      boardId,
      CONCERN_ID,
      null,
      "concern",
      CONCERN_TITLE,
      "",
      "pending",
      0,
      now,
    );
  }

  // A node deleted by hand is still in the table (deletion is logical), and its
  // id is fixed as the issue id — so re-inserting would hit the primary key and
  // fail. Un-delete instead, which also brings the earlier conversation back
  // rather than stranding it under a node nobody can reach.
  const buried = db
    .prepare(
      "SELECT id FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NOT NULL",
    )
    .get(boardId, issueId) as { id: string } | undefined;
  if (buried) {
    db.run(
      "UPDATE nodes SET deleted_at = NULL, title = ? WHERE board_id = ? AND id = ?",
      [issue.title, boardId, issueId],
    );
    return {
      ok: true,
      location: { board_id: boardId, node_id: issueId },
      created: true,
    };
  }

  // Newest issue first: a conversation that starts now is the one being read
  // now, and the alternative (append at the end) buries it under every issue
  // ever discussed.
  db.run(
    "UPDATE nodes SET position = position + 1 WHERE board_id = ? AND parent_id = ? AND deleted_at IS NULL",
    [boardId, CONCERN_ID],
  );
  insertNode.run(
    boardId,
    issueId,
    CONCERN_ID,
    "item",
    issue.title,
    "",
    "pending",
    0,
    now,
  );

  return { ok: true, location: { board_id: boardId, node_id: issueId }, created: true };
}

// Keep the node's title in step with the issue's. The node title is what the
// board and the sidebar show, so leaving it at the original wording makes a
// renamed issue look like a different one.
export function syncIssueChatTitle(issueId: string, title: string): void {
  const at = findIssueChatNode(issueId);
  if (!at) return;
  db.run("UPDATE nodes SET title = ? WHERE board_id = ? AND id = ?", [
    title,
    at.board_id,
    at.node_id,
  ]);
}
