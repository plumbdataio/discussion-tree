// Per-CC-session context-window usage cache. CC's statusline hook (running
// outside discussion-tree) already writes the current "free %" to
// /tmp/claude-sl-<cc_session_id>-pct on every PostToolUse. A companion
// hook in this repo (scripts/cc-context-report-hook.sh) reads that file
// and POSTs the number to /report-context-usage; we keep the most-recent
// value per session in memory so the sidebar can show "Context: 78%".
//
// Memory-only: the file on disk is the source of truth from the
// statusline side, so a broker restart simply re-warms within one tool
// call per session.

import { db } from "./db.ts";

export type ContextUsage = {
  // Free %, 0..100. Matches the file written by statusline-command.sh
  // ($remaining_pct), which already subtracts the 4% safety margin.
  remaining_pct: number;
  // ISO timestamp of the last report. The UI can choose to dim the
  // value if it's older than N minutes (CC may have crashed).
  set_at: string;
};

// Keyed by broker session_id (s_xxx), NOT cc_session_id, so the
// frontend can join against handleListSessions's per-session row
// without an extra lookup.
const usages = new Map<string, ContextUsage>();

function lookupAliveSessionByCcId(ccSessionId: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
    )
    .get(ccSessionId) as { id: string } | null;
  return row?.id ?? null;
}

export function handleReportContextUsage(body: {
  cc_session_id?: string;
  remaining_pct?: number;
}): { ok: boolean; session_id?: string } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  const pct = typeof body.remaining_pct === "number" ? body.remaining_pct : NaN;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false };
  usages.set(sessionId, {
    remaining_pct: pct,
    set_at: new Date().toISOString(),
  });
  return { ok: true, session_id: sessionId };
}

export function getContextUsage(sessionId: string): ContextUsage | null {
  return usages.get(sessionId) ?? null;
}

// Drop the stored value when a session goes alive=0 / is unregistered.
// Avoids stale "78% free" stuck on a session whose CC died.
export function dropContextUsage(sessionId: string) {
  usages.delete(sessionId);
}

export const routes = {
  "/report-context-usage": handleReportContextUsage,
};
