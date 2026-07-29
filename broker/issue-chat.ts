// Talking ON an issue.
//
// The tracker could already SHOW an issue's conversation (get_issue_timeline
// reads messages linked from anywhere), but there was nowhere to HAVE one: the
// user had to pick some board, which meant deciding where this thought belonged
// before writing it — and that decision alone was enough to stop the thought.
// So each issue gets a conversation of its own.
//
// Shape, redesigned 2026-07-29 (dt board bd_vlap7p27, five rounds with the
// user), replacing an earlier "one shared, hidden board with a node per issue":
//
//   - An issue's conversation lives on an ORDINARY tree board — no special kind,
//     no is_issue_chat flag, shown in the sidebar and searched like any other. A
//     board with a single concern + single node behaves exactly like the general
//     board (one serial thread); add concerns / nodes to branch it into a tree
//     when a discussion needs it.
//   - The ISSUE remembers where its conversation is: issues.chat_board_id /
//     chat_node_id (both null until the first message). We look the thread up
//     THROUGH the issue, never by searching boards for the issue id — two boards
//     could carry the same issue id and there would be no way to say which is the
//     real one. The pointer on the issue is the single source of truth.
//   - NOTHING is created until somebody actually writes. An issue with no
//     conversation has no board and no node.
//   - No new concepts: an ordinary board with ordinary nodes, so delivery,
//     unread dots, the timeline and the Stop-hook nag all keep working without
//     knowing anything about issues.
//
// Auto-linking a post here to its issue is the reverse of the pointer: given a
// (board, node), find the issue whose chat_board_id / chat_node_id match. That
// is the ONE path by which the user's own messages get attached to an issue.
//
// Rejected (again): posting into the general board — it contaminates the serial
// order of that thread. Rejected: a boards.issue_ids tag for "this board belongs
// wholesale to an issue" — the timeline already gathers a conversation from
// message-level issue_links, so the tag bought nothing; add it if a real need
// appears.

import { db, insertNode } from "./db.ts";
import { generateId } from "./helpers.ts";

export interface IssueChatLocation {
  board_id: string;
  node_id: string;
}

type IssueBrief = {
  id: string;
  title: string;
  session_id: string | null;
  chat_board_id: string | null;
  chat_node_id: string | null;
};

// Prepared inside the call, not at module level: issues.ts imports this file, so
// this module is evaluated BEFORE the CREATE TABLE / ADD COLUMN at the top of
// that one, and a statement prepared now would compile against columns that do
// not exist yet.
function selectIssueBrief(issueId: string): IssueBrief | undefined {
  return db
    .prepare(
      "SELECT id, title, session_id, chat_board_id, chat_node_id FROM issues WHERE id = ? AND deleted_at IS NULL",
    )
    .get(issueId) as IssueBrief | undefined;
}

// Where an issue's conversation lives NOW, straight off the issue's own pointer.
// Null when nobody has written there yet, or the pointed-at node was deleted by
// hand (nothing to show until a fresh post recreates it).
//
// Read-only: the tracker asks this on every render, and rendering must not
// create rows.
export function findIssueChatNode(issueId: string): IssueChatLocation | null {
  const issue = selectIssueBrief(issueId);
  if (!issue || !issue.chat_board_id || !issue.chat_node_id) return null;
  const node = db
    .prepare(
      "SELECT 1 FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL",
    )
    .get(issue.chat_board_id, issue.chat_node_id);
  return node
    ? { board_id: issue.chat_board_id, node_id: issue.chat_node_id }
    : null;
}

// The reverse: which issue is this (board, node) the conversation of. Used to
// auto-link a post to its issue. Matches on the pointer pair, so an ordinary
// node that merely shares an id can never be mistaken for one.
export function issueOfChatNode(
  boardId: string,
  nodeId: string,
): string | null {
  const row = db
    .prepare(
      "SELECT id FROM issues WHERE chat_board_id = ? AND chat_node_id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .get(boardId, nodeId) as { id: string } | undefined;
  return row?.id ?? null;
}

// Create the board / concern / node as needed, and record the pointer on the
// issue. Called on the first post only.
export function ensureIssueChatNode(
  issueId: string,
):
  | { ok: true; location: IssueChatLocation; created: boolean }
  | { ok: false; error: string } {
  const issue = selectIssueBrief(issueId);
  if (!issue) return { ok: false, error: "issue not found" };

  // Pointer already set: reuse the existing conversation.
  if (issue.chat_board_id && issue.chat_node_id) {
    const existing = db
      .prepare("SELECT deleted_at FROM nodes WHERE board_id = ? AND id = ?")
      .get(issue.chat_board_id, issue.chat_node_id) as
      | { deleted_at: string | null }
      | undefined;
    if (existing && existing.deleted_at === null) {
      return {
        ok: true,
        location: {
          board_id: issue.chat_board_id,
          node_id: issue.chat_node_id,
        },
        created: false,
      };
    }
    // The node was deleted by hand. Un-delete it rather than stranding the
    // earlier conversation under a node nobody can reach — delete is logical, so
    // the messages are still there.
    if (existing) {
      db.run(
        "UPDATE nodes SET deleted_at = NULL, title = ? WHERE board_id = ? AND id = ?",
        [issue.title, issue.chat_board_id, issue.chat_node_id],
      );
      return {
        ok: true,
        location: {
          board_id: issue.chat_board_id,
          node_id: issue.chat_node_id,
        },
        created: true,
      };
    }
    // Pointer set but the node row is gone entirely (nodes are never hard-
    // deleted, so this should not happen) — fall through and make a fresh board.
  }

  // No session means there is nobody to deliver to. Rather than picking one and
  // sending the message to a CC that has never heard of this issue, say so — the
  // caller can assign the issue to a session and try again.
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

  // A brand-new ORDINARY board: one concern, one item. One concern/one item is a
  // single serial thread — the same as the general board — and the user can add
  // more later to branch it into a tree. The board and the item both carry the
  // issue's title so the sidebar and the tree name the issue.
  const now = new Date().toISOString();
  const boardId = generateId("bd");
  const concernId = generateId("nd");
  const nodeId = generateId("nd");
  db.run(
    "INSERT INTO boards (id, title, session_id, created_at) VALUES (?, ?, ?, ?)",
    [boardId, issue.title, issue.session_id, now],
  );
  insertNode.run(
    boardId,
    concernId,
    null,
    "concern",
    issue.title,
    "",
    "pending",
    0,
    now,
  );
  insertNode.run(
    boardId,
    nodeId,
    concernId,
    "item",
    issue.title,
    "",
    "pending",
    0,
    now,
  );
  db.run("UPDATE issues SET chat_board_id = ?, chat_node_id = ? WHERE id = ?", [
    boardId,
    nodeId,
    issueId,
  ]);

  return {
    ok: true,
    location: { board_id: boardId, node_id: nodeId },
    created: true,
  };
}

// Keep the conversation's titles in step with the issue's. The node title is
// what the board tree and the timeline path show; the BOARD title is what the
// sidebar shows — but only when the board is dedicated to this one issue. A
// board several issues point to (the migrated legacy one) keeps its own title;
// renaming it to one issue's wording would mislabel the others.
export function syncIssueChatTitle(issueId: string, title: string): void {
  const at = findIssueChatNode(issueId);
  if (!at) return;
  db.run("UPDATE nodes SET title = ? WHERE board_id = ? AND id = ?", [
    title,
    at.board_id,
    at.node_id,
  ]);
  const others = db
    .prepare(
      "SELECT COUNT(*) AS c FROM issues WHERE chat_board_id = ? AND deleted_at IS NULL",
    )
    .get(at.board_id) as { c: number };
  if (others.c === 1) {
    db.run("UPDATE boards SET title = ? WHERE id = ?", [title, at.board_id]);
  }
}
