// HTTP surface for issue conversations.
//
// Split from issue-chat.ts so the dependency stays one-way: threads.ts imports
// the location lookup (to auto-link posts), and this file imports both — if the
// lookup itself pulled in threads.ts they would import each other, and the
// module-level migration in issue-chat.ts would run at an order nobody controls.
//
// Posting goes through the ORDINARY handlers (handleSubmitAnswer for the user,
// handlePostToNode for CC) on purpose. Delivery to the right CC, the blocking
// wait for an ack, unread dots, the unanswered-post nag and the board-status
// rollup are all things those already do correctly; a bespoke insert here would
// re-implement a subset of them and drift.

import { db } from "./db.ts";
import { ensureIssueChatNode, findIssueChatNode } from "./issue-chat.ts";
import { handlePostToNode, handleSubmitAnswer } from "./threads.ts";

type ChatItem = {
  id: number;
  source: string;
  text: string;
  created_at: string;
  read_at: string | null;
};

function readThread(boardId: string, nodeId: string): ChatItem[] {
  return db
    .prepare(
      `SELECT id, source, text, created_at, read_at
         FROM thread_items
        WHERE board_id = ? AND node_id = ?
        ORDER BY created_at, id`,
    )
    .all(boardId, nodeId) as ChatItem[];
}

// What the tracker needs to draw the conversation for one issue. Returns an
// empty thread (and a null location) when nobody has written yet — that is the
// normal state for most issues, not an error.
export function handleGetIssueChat(body: any):
  | {
      ok: true;
      location: { board_id: string; node_id: string } | null;
      session: { id: string; name: string | null; cwd: string | null; alive: number } | null;
      items: ChatItem[];
    }
  | { ok: false; error: string } {
  const issueId = String(body?.issue_id ?? "");
  const issue = db
    .prepare(
      "SELECT id, session_id FROM issues WHERE id = ? AND deleted_at IS NULL",
    )
    .get(issueId) as { id: string; session_id: string | null } | undefined;
  if (!issue) return { ok: false, error: "issue not found" };

  const location = findIssueChatNode(issueId);
  // The session is reported even with no thread yet: the composer needs to say
  // WHO would receive the message, and whether that CC is currently alive.
  const session = issue.session_id
    ? ((db
        .prepare("SELECT id, name, cwd, alive FROM sessions WHERE id = ?")
        .get(issue.session_id) as {
        id: string;
        name: string | null;
        cwd: string | null;
        alive: number;
      } | null) ?? null)
    : null;

  return {
    ok: true,
    location,
    session,
    items: location ? readThread(location.board_id, location.node_id) : [],
  };
}

// The user writing on an issue. Creates the board/node on first use, then hands
// off to the normal user-submission path — including its block-until-delivered
// behaviour, so "the CC never picked this up" surfaces here exactly as it does
// on any other board.
export async function handleSubmitIssueChat(body: any): Promise<unknown> {
  const issueId = String(body?.issue_id ?? "");
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    return { ok: false, error: "empty message", reason: "no_recipient" };
  }
  const ensured = ensureIssueChatNode(issueId);
  if (!ensured.ok) {
    return { ok: false, error: ensured.error, reason: "no_recipient" };
  }
  const result = await handleSubmitAnswer({
    board_id: ensured.location.board_id,
    node_id: ensured.location.node_id,
    text,
  });
  return { ...result, location: ensured.location };
}

// CC writing on an issue. Exists so CC can OPEN a conversation without knowing
// the board layout — once a thread exists, its replies arrive through the
// ordinary channel message and go back through post_to_node like any other.
export function handlePostIssueChat(body: any): unknown {
  const issueId = String(body?.issue_id ?? "");
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message.trim()) return { ok: false, error: "empty message" };
  const ensured = ensureIssueChatNode(issueId);
  if (!ensured.ok) return { ok: false, error: ensured.error };
  const result = handlePostToNode({
    board_id: ensured.location.board_id,
    node_id: ensured.location.node_id,
    message,
    status: body?.status,
    // The link to THIS issue is added by handlePostToNode itself (it recognises
    // an issue-chat node); extra ids are for a reply that also touches another.
    issue_ids: Array.isArray(body?.issue_ids) ? body.issue_ids : [],
  });
  // created rides back so the MCP tool can tell CC "there was no board, I made
  // one" on the very first post — the moment the workflow needs explaining.
  return { ...(result as object), location: ensured.location, created: ensured.created };
}

export const routes = {
  "/issue-chat": handleGetIssueChat,
  "/issue-chat-submit": handleSubmitIssueChat,
  "/issue-chat-post": handlePostIssueChat,
};
