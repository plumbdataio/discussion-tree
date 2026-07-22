// Read-side HTTP handlers used by the read MCP tools (list_boards /
// get_board / search_boards). These let CC pull past discussion history
// back into context — boards and threads become a queryable asset rather
// than write-only logs.
//
// Like other broker handlers, these take session_id (broker side, e.g.
// s_xxx). The MCP tool layer resolves the calling CC's session_id via
// ensureSession() and forwards it here. scope controls whether to surface
// boards owned by other sessions too.

import { db } from "./db.ts";
import { attachChecklistItems } from "./helpers.ts";

type Scope = "this_session" | "all";

function resolveScopeFilter(
  sessionId: string,
  scope: Scope,
): { sql: string; params: any[] } {
  // Always restricted to alive=1 sessions (dead sessions' boards still
  // appear in the inactive list in the UI, but for MCP queries we focus on
  // currently-live work — searching all dead sessions would drown the LLM
  // in stale context).
  if (scope === "all") {
    return { sql: "s.alive = 1", params: [] };
  }
  return {
    sql: "s.alive = 1 AND s.id = ?",
    params: [sessionId],
  };
}

export function handleListBoards(body: {
  session_id?: string;
  scope?: Scope;
}):
  | {
      ok: true;
      boards: Array<{
        id: string;
        title: string;
        status: string;
        is_default: number;
        archived: number;
        session_id: string;
        session_name: string | null;
        concern_count: number;
        item_count: number;
        last_activity: string | null;
      }>;
    }
  | { ok: false; error: string } {
  if (!body.session_id) {
    return { ok: false, error: "session_id required" };
  }
  const scope: Scope = body.scope === "all" ? "all" : "this_session";
  const filter = resolveScopeFilter(body.session_id, scope);
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.status, b.is_default, b.archived,
              b.session_id, s.name AS session_name,
              (SELECT COUNT(*) FROM nodes n
                WHERE n.board_id = b.id AND n.kind = 'concern'
                  AND n.deleted_at IS NULL) AS concern_count,
              (SELECT COUNT(*) FROM nodes n
                WHERE n.board_id = b.id AND n.kind = 'item'
                  AND n.deleted_at IS NULL) AS item_count,
              (SELECT MAX(created_at) FROM thread_items t
                WHERE t.board_id = b.id) AS last_activity
         FROM boards b
         JOIN sessions s ON s.id = b.session_id
        WHERE ${filter.sql}
        ORDER BY COALESCE(last_activity, b.created_at) DESC`,
    )
    .all(...filter.params) as Array<{
      id: string;
      title: string;
      status: string;
      is_default: number;
      archived: number;
      session_id: string;
      session_name: string | null;
      concern_count: number;
      item_count: number;
      last_activity: string | null;
    }>;
  return { ok: true, boards: rows };
}

// Default thread truncation — keep the most recent N items per node so a
// noisy thread doesn't blow up the LLM context. max_items_per_node = null
// (or omitted) keeps the default; pass a number to override, or -1 to get
// every item. node_ids narrows the result to specific nodes (useful when
// the LLM wants the thread of a single decision instead of the whole board).
const DEFAULT_THREAD_TAIL = 20;

export function handleGetBoardView(body: {
  board_id?: string;
  max_items_per_node?: number | null;
  node_ids?: string[] | null;
}):
  | {
      ok: true;
      board: any;
      nodes: any[];
      threads: Record<string, any[]>;
      thread_truncated: Record<string, number>; // node_id -> total count when truncated
    }
  | { ok: false; error: string } {
  if (!body.board_id) {
    return { ok: false, error: "board_id required" };
  }
  const board = db
    .prepare("SELECT * FROM boards WHERE id = ?")
    .get(body.board_id) as any | null;
  if (!board) {
    return { ok: false, error: "board not found" };
  }
  const nodes = db
    .prepare(
      "SELECT * FROM nodes WHERE board_id = ? AND deleted_at IS NULL ORDER BY position",
    )
    .all(body.board_id) as any[];
  // Attach checklist_items to is_checklist nodes so get_board surfaces the
  // checklist rows. The web read (getBoardView) already does this; this read
  // used to omit it, so get_board reported a checklist node as having zero
  // rows even when checklist_items held rows. The structure list always
  // includes every node, so attach regardless of any node_ids thread filter.
  attachChecklistItems(body.board_id, nodes);

  const nodeFilter = Array.isArray(body.node_ids) && body.node_ids.length > 0
    ? new Set(body.node_ids)
    : null;
  const limit =
    body.max_items_per_node === null || body.max_items_per_node === undefined
      ? DEFAULT_THREAD_TAIL
      : body.max_items_per_node;

  const threads: Record<string, any[]> = {};
  const truncated: Record<string, number> = {};

  // Pull all thread items for this board in one query, then bucket per
  // node. Avoids N+1 round trips through the prepare cache.
  const allItems = db
    .prepare(
      "SELECT * FROM thread_items WHERE board_id = ? ORDER BY created_at",
    )
    .all(body.board_id) as any[];
  const byNode: Record<string, any[]> = {};
  for (const t of allItems) {
    if (nodeFilter && !nodeFilter.has(t.node_id)) continue;
    (byNode[t.node_id] ??= []).push(t);
  }
  for (const [nodeId, items] of Object.entries(byNode)) {
    if (limit < 0 || items.length <= limit) {
      threads[nodeId] = items;
    } else {
      threads[nodeId] = items.slice(items.length - limit);
      truncated[nodeId] = items.length;
    }
  }

  return { ok: true, board, nodes, threads, thread_truncated: truncated };
}

export function handleSearchBoards(body: {
  session_id?: string;
  query?: string;
  scope?: Scope;
  limit?: number;
}):
  | {
      ok: true;
      matches: Array<{
        board_id: string;
        board_title: string;
        session_name: string | null;
        node_id: string | null;
        node_kind: string | null;
        node_title: string | null;
        thread_item_id: number | null;
        thread_item_source: string | null;
        snippet: string;
        match_in: "board_title" | "node_title" | "node_context" | "thread_text";
      }>;
    }
  | { ok: false; error: string } {
  if (!body.session_id) {
    return { ok: false, error: "session_id required" };
  }
  const q = (body.query ?? "").trim();
  if (q.length === 0) {
    return { ok: false, error: "query required" };
  }
  const scope: Scope = body.scope === "all" ? "all" : "this_session";
  const filter = resolveScopeFilter(body.session_id, scope);
  const limit = Math.max(1, Math.min(100, body.limit ?? 25));
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;

  const matches: any[] = [];

  // 1) Board title matches.
  const titleRows = db
    .prepare(
      `SELECT b.id AS board_id, b.title AS board_title, s.name AS session_name
         FROM boards b
         JOIN sessions s ON s.id = b.session_id
        WHERE ${filter.sql} AND b.title LIKE ? ESCAPE '\\'
        ORDER BY b.created_at DESC
        LIMIT ?`,
    )
    .all(...filter.params, like, limit) as any[];
  for (const r of titleRows) {
    matches.push({
      board_id: r.board_id,
      board_title: r.board_title,
      session_name: r.session_name,
      node_id: null,
      node_kind: null,
      node_title: null,
      thread_item_id: null,
      thread_item_source: null,
      snippet: r.board_title,
      match_in: "board_title",
    });
  }

  // 2) Node title / context matches.
  const nodeRows = db
    .prepare(
      `SELECT b.id AS board_id, b.title AS board_title, s.name AS session_name,
              n.id AS node_id, n.kind AS node_kind, n.title AS node_title,
              n.context AS node_context
         FROM nodes n
         JOIN boards b ON b.id = n.board_id
         JOIN sessions s ON s.id = b.session_id
        WHERE ${filter.sql} AND n.deleted_at IS NULL
          AND (n.title LIKE ? ESCAPE '\\' OR n.context LIKE ? ESCAPE '\\')
        ORDER BY n.created_at DESC
        LIMIT ?`,
    )
    .all(...filter.params, like, like, limit) as any[];
  for (const r of nodeRows) {
    const inTitle = r.node_title.includes(q);
    matches.push({
      board_id: r.board_id,
      board_title: r.board_title,
      session_name: r.session_name,
      node_id: r.node_id,
      node_kind: r.node_kind,
      node_title: r.node_title,
      thread_item_id: null,
      thread_item_source: null,
      snippet: inTitle
        ? r.node_title
        : snippet(r.node_context, q),
      match_in: inTitle ? "node_title" : "node_context",
    });
  }

  // 3) Thread text matches.
  const threadRows = db
    .prepare(
      `SELECT b.id AS board_id, b.title AS board_title, s.name AS session_name,
              t.id AS thread_item_id, t.node_id, t.source AS thread_item_source,
              t.text, n.kind AS node_kind, n.title AS node_title
         FROM thread_items t
         JOIN boards b ON b.id = t.board_id
         JOIN sessions s ON s.id = b.session_id
         JOIN nodes n ON n.board_id = t.board_id AND n.id = t.node_id
        WHERE ${filter.sql} AND n.deleted_at IS NULL
          AND t.text LIKE ? ESCAPE '\\'
        ORDER BY t.created_at DESC
        LIMIT ?`,
    )
    .all(...filter.params, like, limit) as any[];
  for (const r of threadRows) {
    matches.push({
      board_id: r.board_id,
      board_title: r.board_title,
      session_name: r.session_name,
      node_id: r.node_id,
      node_kind: r.node_kind,
      node_title: r.node_title,
      thread_item_id: r.thread_item_id,
      thread_item_source: r.thread_item_source,
      snippet: snippet(r.text, q),
      match_in: "thread_text",
    });
  }

  // Trim to overall limit; the per-category LIMIT above means we could have
  // up to 3*limit. Sort by … honestly nothing useful is available without
  // FTS scoring, so we keep the per-category insertion order (board title
  // matches first, then nodes, then threads — usually the most direct
  // answers).
  return { ok: true, matches: matches.slice(0, limit) };
}

// Build a small textual context around the first occurrence of `needle` in
// `haystack`. ~160 chars total, with a "…" prefix/suffix when the match
// isn't at the edges. Case-insensitive LIKE matched at SQL level, but for
// the snippet we use indexOf — close enough for human-readable preview.
function snippet(haystack: string, needle: string): string {
  if (!haystack) return "";
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return haystack.slice(0, 160);
  const start = Math.max(0, idx - 60);
  const end = Math.min(haystack.length, idx + needle.length + 100);
  const head = start > 0 ? "…" : "";
  const tail = end < haystack.length ? "…" : "";
  return head + haystack.slice(start, end) + tail;
}

export const routes = {
  "/list-boards": handleListBoards,
  "/get-board-view": handleGetBoardView,
  "/search-boards": handleSearchBoards,
};
