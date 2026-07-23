// Per-session issue aggregation for the "issues" view (Phase 1 / variant A):
// project every item node the session owns into a flat, status-bucketed list
// so the user can see — in one place, per session — what is outstanding and
// especially what is WAITING ON THEM (needs-reply). This is a pure read /
// projection: it invents no new data, it just re-shapes existing node statuses
// (the same statuses the sidebar already surfaces), so it can't drift from the
// boards it mirrors. Checklists are deliberately excluded here — a "ToDo-flagged
// checklist" aggregation is the separate Phase 2 (variant B).

import { db } from "./db.ts";

export type IssueLane = "wait" | "prog" | "todo" | "done";

export type SessionIssue = {
  board_id: string;
  board_title: string;
  is_default: number;
  board_status: string;
  board_closed: number;
  node_id: string;
  title: string;
  status: string;
  lane: IssueLane;
  updated_at: string | null;
};

// dt node statuses → 4 lanes. needs-reply is the actionable "waiting on you"
// signal; pending is not-started; the settled verdicts collapse into done;
// everything else in flight (discussing) is in-progress.
const SETTLED = new Set(["adopted", "agreed", "rejected", "resolved", "done"]);
export function laneForStatus(status: string): IssueLane {
  if (status === "needs-reply") return "wait";
  if (status === "pending") return "todo";
  if (SETTLED.has(status)) return "done";
  return "prog";
}

// Item nodes across the session's non-archived boards. Excludes concerns (not
// repliable), the per-board audit log item (is_log), and checklist nodes
// (is_checklist — that's Phase 2). Ordered newest-activity first.
const selectIssues = db.prepare(`
  SELECT n.board_id                             AS board_id,
         b.title                                AS board_title,
         b.is_default                           AS is_default,
         b.status                               AS board_status,
         b.closed                               AS board_closed,
         n.id                                   AS node_id,
         n.title                                AS title,
         n.status                               AS status,
         (SELECT MAX(created_at) FROM thread_items t
           WHERE t.board_id = n.board_id AND t.node_id = n.id) AS last_activity,
         n.created_at                           AS created_at
    FROM nodes n
    JOIN boards b ON b.id = n.board_id
   WHERE b.session_id = ?
     AND b.archived = 0
     AND n.kind = 'item'
     AND n.deleted_at IS NULL
     AND n.is_log = 0
     AND n.is_checklist = 0
   ORDER BY COALESCE(
     (SELECT MAX(created_at) FROM thread_items t
       WHERE t.board_id = n.board_id AND t.node_id = n.id),
     n.created_at) DESC
`);

const selectSessionName = db.prepare("SELECT name FROM sessions WHERE id = ?");

export function getSessionIssues(sessionId: string): {
  ok: boolean;
  session_id: string;
  session_name: string | null;
  issues: SessionIssue[];
  counts: Record<IssueLane, number>;
  filters: unknown;
} {
  const sess = selectSessionName.get(sessionId) as { name: string | null } | null;
  const rows = selectIssues.all(sessionId) as Array<{
    board_id: string;
    board_title: string;
    is_default: number;
    board_status: string;
    board_closed: number;
    node_id: string;
    title: string;
    status: string;
    last_activity: string | null;
    created_at: string | null;
  }>;
  const issues: SessionIssue[] = rows.map((r) => ({
    board_id: r.board_id,
    board_title: r.board_title,
    is_default: r.is_default,
    board_status: r.board_status,
    board_closed: r.board_closed,
    node_id: r.node_id,
    title: r.title,
    status: r.status,
    lane: laneForStatus(r.status),
    updated_at: r.last_activity ?? r.created_at ?? null,
  }));
  const counts: Record<IssueLane, number> = { wait: 0, prog: 0, todo: 0, done: 0 };
  for (const i of issues) counts[i.lane]++;
  return {
    ok: true,
    session_id: sessionId,
    session_name: sess?.name ?? null,
    issues,
    counts,
    filters: getSessionIssueFilters(sessionId),
  };
}

// --- Per-session filter persistence -----------------------------------------
// The issue view's filters (which lanes to show, whether to include
// closed/settled boards, an optional "updated within" cutoff) are saved PER
// SESSION in the DB — not localStorage — so the same session shows the same
// view across browsers/devices (the user rarely wants a different filter per
// browser, and re-setting it everywhere is a chore). The blob is opaque to the
// broker: the client owns the shape; we just store and hand back the JSON.
db.run(`
  CREATE TABLE IF NOT EXISTS session_issue_filters (
    session_id TEXT PRIMARY KEY,
    filters    TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
const selectFilters = db.prepare(
  "SELECT filters FROM session_issue_filters WHERE session_id = ?",
);
const upsertFilters = db.prepare(
  `INSERT INTO session_issue_filters (session_id, filters, updated_at)
   VALUES (?, ?, ?)
   ON CONFLICT(session_id)
     DO UPDATE SET filters = excluded.filters, updated_at = excluded.updated_at`,
);

export function getSessionIssueFilters(sessionId: string): unknown {
  const row = selectFilters.get(sessionId) as { filters: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.filters);
  } catch {
    return null;
  }
}

export function handleSetSessionIssueFilters(body: {
  session_id?: string;
  filters?: unknown;
}): { ok: boolean; error?: string } {
  if (!body.session_id) return { ok: false, error: "session_id required" };
  if (body.filters === undefined) {
    return { ok: false, error: "filters required" };
  }
  upsertFilters.run(
    body.session_id,
    JSON.stringify(body.filters),
    new Date().toISOString(),
  );
  return { ok: true };
}

export const routes = {
  "/session-issue-filters": handleSetSessionIssueFilters,
};
