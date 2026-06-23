// Mermaid diagram surface — a 3rd surface alongside boards & maps. One row =
// one mermaid (.mmd) source, rendered on its own page. CC manages them via MCP
// tools (upsert / get / list / delete); there is NO user upload path. Upsert
// replaces the whole source (no partial update) and broadcasts so the open page
// re-renders live.
import { db } from "./db.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
import { generateId } from "./helpers.ts";

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

export function getDiagramView(id: string) {
  const row = db.prepare("SELECT * FROM diagrams WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return { diagram: row };
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

export const routes = {
  "/upsert-diagram": handleUpsertDiagram,
  "/get-diagram": handleGetDiagram,
  "/list-diagrams": handleListDiagrams,
  "/delete-diagram": handleDeleteDiagram,
};
