// Per-session "which Claude model is this CC running" cache.
//
// The PostToolUse hook (scripts/cc-context-report-hook.ts) reads the tail of the
// session transcript, takes the `message.model` of the latest main-thread
// assistant entry (e.g. "claude-opus-5-5"), and POSTs it to /report-model when
// it changed. We keep the latest value per broker session in memory so
// /api/sessions can expose it and the page header can render a model chip —
// useful after a `/model` switch mid-session.
//
// Same shape as context-usage.ts: in-memory Map keyed by broker session_id,
// persisted to a small table and re-warmed on startup so a broker restart does
// not blank every chip until each session's next model change. The table lives
// here (not in db.ts) because only this module touches it; it is created BEFORE
// the prepared statements below because bun:sqlite compiles a statement
// immediately and would throw "no such table" on a fresh DB otherwise.

import { db } from "./db.ts";

export type SessionModel = {
  // Raw model id as written in the transcript (e.g. "claude-opus-5-5").
  id: string;
  // ISO timestamp of the last report that set this value.
  set_at: string;
};

db.run(`
  CREATE TABLE IF NOT EXISTS session_models (
    session_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    set_at TEXT NOT NULL
  )
`);
const upsertSessionModel = db.prepare(
  `INSERT INTO session_models (session_id, model, set_at) VALUES (?, ?, ?)
   ON CONFLICT(session_id) DO UPDATE SET
     model = excluded.model, set_at = excluded.set_at`,
);
const selectAllSessionModels = db.prepare(
  `SELECT session_id, model, set_at FROM session_models`,
);
const deleteSessionModel = db.prepare(
  `DELETE FROM session_models WHERE session_id = ?`,
);

const models = new Map<string, SessionModel>();

for (const row of selectAllSessionModels.all() as {
  session_id: string;
  model: string;
  set_at: string;
}[]) {
  models.set(row.session_id, { id: row.model, set_at: row.set_at });
}

// Model ids are short ASCII tokens: first-party ("claude-opus-5-5"), dated
// ("claude-haiku-4-5-20251001"), Bedrock ("us.anthropic.claude-...-v1:0") or
// Vertex ("claude-...@20250805"). Anything else is rejected so arbitrary text
// can never reach the UI through this endpoint.
const MODEL_RE = /^[A-Za-z0-9._:@-]{1,80}$/;

export function isValidModelId(v: unknown): v is string {
  return typeof v === "string" && MODEL_RE.test(v);
}

function lookupAliveSessionByCcId(ccSessionId: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
    )
    .get(ccSessionId) as { id: string } | null;
  return row?.id ?? null;
}

export function handleReportModel(body: {
  cc_session_id?: string;
  model?: unknown;
}): { ok: boolean; session_id?: string } {
  if (!body || typeof body.cc_session_id !== "string" || !body.cc_session_id) {
    return { ok: false };
  }
  if (!isValidModelId(body.model)) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  const setAt = new Date().toISOString();
  models.set(sessionId, { id: body.model, set_at: setAt });
  upsertSessionModel.run(sessionId, body.model, setAt);
  return { ok: true, session_id: sessionId };
}

export function getSessionModel(sessionId: string): SessionModel | null {
  return models.get(sessionId) ?? null;
}

// Symmetry with dropContextUsage; not wired to any lifecycle yet.
export function dropSessionModel(sessionId: string): void {
  models.delete(sessionId);
  deleteSessionModel.run(sessionId);
}

export const routes = {
  "/report-model": handleReportModel,
};
