// Mermaid diagram surface — a 3rd surface alongside boards & maps. One row =
// one mermaid (.mmd) source, rendered on its own page. CC manages them via MCP
// tools (upsert / get / list / delete); there is NO user upload path. Upsert
// replaces the whole source (no partial update) and broadcasts so the open page
// re-renders live.
import { db, insertPending, insertThread } from "./db.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
import { generateId } from "./helpers.ts";
import {
  activities,
  bgTaskCountForSession,
  markWorkingFromUserSubmit,
} from "./activity.ts";
import { getContextUsage } from "./context-usage.ts";
import { SUBMIT_DELIVERY_TIMEOUT_MS } from "./config.ts";

// Synthetic node id for the diagram's right-side chat thread.
const DIAGRAM_CHAT_NODE = "__chat__";

db.run(`
  CREATE TABLE IF NOT EXISTS diagrams (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Lightweight mermaid sanity check at upsert time. A full mermaid.parse needs a
// DOM (jsdom) which is heavy in Bun, so we only reject the obvious failures:
// empty source, or a first content line that isn't a recognized diagram-type
// header. Residual parse errors surface client-side at render.
const DIAGRAM_HEADERS = [
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "mindmap",
  "timeline",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "C4Context",
];
function validateSource(src: string): string | null {
  const trimmed = (src ?? "").trim();
  if (!trimmed) return "diagram source is empty";
  const firstLine = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("%%") && !l.startsWith("---"));
  if (!firstLine) return "diagram source has no content";
  if (!DIAGRAM_HEADERS.some((h) => firstLine.startsWith(h))) {
    return `unrecognized mermaid diagram type (first line: "${firstLine.slice(0, 48)}")`;
  }
  return null;
}

// The diagram view mirrors getMapView: the diagram row + its chat thread +
// the same owner_* enrichment the board/map headers need (alive / stalled /
// compacting / session name / context usage / bg tasks / cli-send capability),
// so the diagram page renders the shared header chrome instead of a bespoke
// one. The chat thread is ThreadItem-shaped (board_id = diagram id, node_id =
// __chat__) so the frontend can render it with the same ThreadMessage/MDView
// components as a board node or the map's general chat.
export function getDiagramView(id: string) {
  const row = db.prepare("SELECT * FROM diagrams WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const thread = db
    .prepare(
      "SELECT id, board_id, node_id, source, text, created_at, read_at FROM thread_items WHERE board_id = ? AND node_id = ? ORDER BY id",
    )
    .all(id, DIAGRAM_CHAT_NODE);
  const sessionId = String((row as any).session_id ?? "");
  const ownerRow = db
    .prepare(
      "SELECT alive, name, stalled_at, compacting_at, tmux_pane FROM sessions WHERE id = ?",
    )
    .get(sessionId) as {
    alive: number;
    name: string | null;
    stalled_at: string | null;
    compacting_at: string | null;
    tmux_pane: string | null;
  } | null;
  return {
    diagram: row,
    thread,
    activity: activities.get(sessionId) ?? null,
    owner_alive: ownerRow?.alive === 1,
    owner_stalled: ownerRow?.alive === 1 && !!ownerRow?.stalled_at,
    owner_compacting: ownerRow?.alive === 1 && !!ownerRow?.compacting_at,
    owner_session_name: ownerRow?.name ?? null,
    owner_context_usage: getContextUsage(sessionId),
    owner_bg_task_count: bgTaskCountForSession(sessionId),
    owner_can_cli_send: ownerRow?.alive === 1 && !!ownerRow?.tmux_pane,
  };
}

// Create (no id / unknown id) or replace (existing id) a diagram's whole source.
export function handleUpsertDiagram(body: any) {
  const title = String(body?.title ?? "").trim() || "Untitled diagram";
  const source = String(body?.source ?? "");
  const err = validateSource(source);
  if (err) return { ok: false, error: err };
  const now = new Date().toISOString();
  let id = body?.id ? String(body.id) : "";
  if (id) {
    const existing = db.prepare("SELECT id FROM diagrams WHERE id = ?").get(id);
    if (existing) {
      db.run(
        "UPDATE diagrams SET title = ?, source = ?, updated_at = ? WHERE id = ?",
        [title, source, now, id],
      );
      broadcast(id, { type: "diagram-update" });
      broadcastToAll({ type: "sidebar-refresh" });
      return { ok: true, id };
    }
  }
  const sessionId = String(body?.session_id ?? "");
  if (!sessionId) {
    return { ok: false, error: "session_id is required to create a diagram" };
  }
  id = id || generateId("dg");
  db.run(
    "INSERT INTO diagrams (id, session_id, title, source, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    [id, sessionId, title, source, now, now],
  );
  broadcastToAll({ type: "sidebar-refresh" });
  return { ok: true, id };
}

export function handleGetDiagram(body: any) {
  const v = getDiagramView(String(body?.id ?? ""));
  if (!v) return { ok: false, error: "diagram not found" };
  return { ok: true, ...v.diagram };
}

export function handleListDiagrams(body: any) {
  const sessionId = body?.session_id ? String(body.session_id) : null;
  const rows = sessionId
    ? db
        .prepare(
          "SELECT id, title, updated_at FROM diagrams WHERE session_id = ? ORDER BY updated_at DESC",
        )
        .all(sessionId)
    : db
        .prepare("SELECT id, title, updated_at FROM diagrams ORDER BY updated_at DESC")
        .all();
  return { ok: true, diagrams: rows };
}

export function handleDeleteDiagram(body: any) {
  const id = String(body?.id ?? "");
  if (!id) return { ok: false, error: "id is required" };
  db.run("DELETE FROM diagrams WHERE id = ?", [id]);
  broadcast(id, { type: "diagram-deleted" });
  broadcastToAll({ type: "sidebar-refresh" });
  return { ok: true };
}

// Right-side chat: enqueue a pending message (kind=diagram_chat) for the owning
// CC and wait for delivery, mirroring handleMapChat. The poller materializes the
// user message into the diagram's chat thread; CC replies by upserting the
// source (live re-render) and/or posting back to this thread.
export async function handleDiagramChat(body: any) {
  const id = String(body?.diagram_id ?? "");
  const text = String(body?.text ?? "").trim();
  const row = db
    .prepare("SELECT session_id, title FROM diagrams WHERE id = ?")
    .get(id) as { session_id: string; title: string } | undefined;
  if (!row)
    return { ok: false, error: "diagram not found", reason: "no_recipient" };
  if (!text) return { ok: false, error: "text required" };
  const owner = db
    .prepare("SELECT alive, cc_session_id FROM sessions WHERE id = ?")
    .get(row.session_id) as
    | { alive: number; cc_session_id: string | null }
    | null;
  if (!owner || owner.alive !== 1 || !owner.cc_session_id) {
    return { ok: false, error: "errors.no_recipient", reason: "no_recipient" };
  }
  const now = new Date().toISOString();
  const insertResult = insertPending.run(
    row.session_id,
    id,
    DIAGRAM_CHAT_NODE,
    `${row.title} > chat`,
    text,
    now,
    "diagram_chat",
  );
  const pendingId = Number(insertResult.lastInsertRowid);
  markWorkingFromUserSubmit(row.session_id);
  const deadline = Date.now() + SUBMIT_DELIVERY_TIMEOUT_MS;
  const checkDelivered = db.prepare(
    "SELECT delivered, thread_item_id FROM pending_messages WHERE id = ?",
  );
  while (Date.now() < deadline) {
    const d = checkDelivered.get(pendingId) as
      | { delivered: number; thread_item_id: number | null }
      | null;
    if (d?.delivered === 1) {
      if (d.thread_item_id == null) {
        insertThread.run(id, DIAGRAM_CHAT_NODE, "user", text, now);
      }
      broadcast(id, {
        type: "thread-update",
        node_id: DIAGRAM_CHAT_NODE,
        source: "user",
      });
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  db.run(
    "UPDATE pending_messages SET cancelled = 1 WHERE id = ? AND delivered = 0 AND requeued = 0",
    [pendingId],
  );
  return { ok: false, error: "errors.timeout", reason: "timeout" };
}

// CC posts a text reply into the diagram's chat thread (the diagram edit itself
// goes through upsert_diagram). Broadcasts so the open page appends it live.
export function handlePostDiagramChat(body: any) {
  const id = String(body?.diagram_id ?? "");
  const message = String(body?.message ?? "");
  const row = db.prepare("SELECT id FROM diagrams WHERE id = ?").get(id);
  if (!row) return { ok: false, error: "diagram not found" };
  insertThread.run(id, DIAGRAM_CHAT_NODE, "cc", message, new Date().toISOString());
  broadcast(id, {
    type: "thread-update",
    node_id: DIAGRAM_CHAT_NODE,
    source: "cc",
  });
  return { ok: true };
}

export const routes = {
  "/diagram-chat": handleDiagramChat,
  "/post-diagram-chat": handlePostDiagramChat,
  "/upsert-diagram": handleUpsertDiagram,
  "/get-diagram": handleGetDiagram,
  "/list-diagrams": handleListDiagrams,
  "/delete-diagram": handleDeleteDiagram,
};
