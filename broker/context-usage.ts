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

import {
  db,
  deleteContextUsage,
  deleteUsageLimits,
  selectAllContextUsage,
  selectAllUsageLimits,
  upsertContextUsage,
  upsertUsageLimits,
} from "./db.ts";
import type { UsageLimits } from "../shared/types.ts";

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

// Re-warm from the DB on startup so a broker restart (frequent during deploys)
// doesn't blank every session's meter until each one re-reports on its next
// tool call. The original set_at rides along, so the UI can dim a stale value.
for (const row of selectAllContextUsage.all() as {
  session_id: string;
  remaining_pct: number;
  set_at: string;
}[]) {
  usages.set(row.session_id, {
    remaining_pct: row.remaining_pct,
    set_at: row.set_at,
  });
}

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
  const setAt = new Date().toISOString();
  usages.set(sessionId, { remaining_pct: pct, set_at: setAt });
  upsertContextUsage.run(sessionId, pct, setAt);
  return { ok: true, session_id: sessionId };
}

export function getContextUsage(sessionId: string): ContextUsage | null {
  return usages.get(sessionId) ?? null;
}

// Drop the stored value when a session goes alive=0 / is unregistered.
// Avoids stale "78% free" stuck on a session whose CC died.
export function dropContextUsage(sessionId: string) {
  usages.delete(sessionId);
  deleteContextUsage.run(sessionId);
}

// --- Native 5h / 7d subscription-usage limits --------------------------------
// Claude Code's statusLine command delivers rate_limits.{five_hour,seven_day}
// (used_percentage 0..100 + resets_at unix seconds). The user's statusline
// writes them to /tmp/claude-sl-<cc_session_id>-limits.json and this repo's
// cc-context-report-hook.sh POSTs them here. The values are ACCOUNT-global (the
// same across every session the account runs), but each session reports its own
// snapshot; we keep the latest per broker session and surface only the freshest
// non-stale one so the frontend renders a SINGLE global chip, not one per row.

// Beyond this age a stored snapshot is considered stale and hidden: with no
// session reporting for 6h the 5h window has fully reset anyway (so its number
// would mislead) and there is nothing keeping the value current. Any live
// session doing tool calls refreshes set_at continuously, so this only hides
// the chip once the account has been idle for hours.
const USAGE_LIMITS_STALE_MS = 6 * 60 * 60 * 1000;

// Keyed by broker session_id, mirroring `usages` above.
const limits = new Map<string, UsageLimits>();

// Re-warm from the DB on startup so a broker restart doesn't blank the chip
// until a session re-reports on its next tool call.
for (const row of selectAllUsageLimits.all() as {
  session_id: string;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  set_at: string;
}[]) {
  limits.set(row.session_id, {
    five_hour_pct: row.five_hour_pct ?? undefined,
    five_hour_resets_at: row.five_hour_resets_at ?? undefined,
    seven_day_pct: row.seven_day_pct ?? undefined,
    seven_day_resets_at: row.seven_day_resets_at ?? undefined,
    set_at: row.set_at,
  });
}

// A percentage field is optional but, when present, must be a finite 0..100.
// Absent (undefined) is fine — a window resets out of the payload. Anything else
// (NaN, out of range, wrong type) is dropped to undefined.
function cleanPct(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    return undefined;
  }
  return v;
}

// resets_at is a unix epoch in SECONDS; keep it only if a plausible positive
// integer-ish number. Absent is fine.
function cleanResetsAt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

export function handleReportUsageLimits(body: {
  cc_session_id?: string;
  five_hour_pct?: number;
  five_hour_resets_at?: number;
  seven_day_pct?: number;
  seven_day_resets_at?: number;
}): { ok: boolean; session_id?: string } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  const fiveHourPct = cleanPct(body.five_hour_pct);
  const fiveHourResetsAt = cleanResetsAt(body.five_hour_resets_at);
  const sevenDayPct = cleanPct(body.seven_day_pct);
  const sevenDayResetsAt = cleanResetsAt(body.seven_day_resets_at);
  // Reject a report that carries no usable field at all — nothing to store, and
  // it would otherwise overwrite a good row with an empty, freshly-dated one and
  // let it win the "freshest" pick with blank numbers.
  if (fiveHourPct === undefined && sevenDayPct === undefined) {
    return { ok: false };
  }
  const setAt = new Date().toISOString();
  const value: UsageLimits = {
    five_hour_pct: fiveHourPct,
    five_hour_resets_at: fiveHourResetsAt,
    seven_day_pct: sevenDayPct,
    seven_day_resets_at: sevenDayResetsAt,
    set_at: setAt,
  };
  limits.set(sessionId, value);
  upsertUsageLimits.run(
    sessionId,
    fiveHourPct ?? null,
    fiveHourResetsAt ?? null,
    sevenDayPct ?? null,
    sevenDayResetsAt ?? null,
    setAt,
  );
  return { ok: true, session_id: sessionId };
}

// The single account-global usage snapshot to show: the most-recently-reported
// value across all sessions that isn't stale. null when nothing has been
// reported (or everything is stale) — the frontend then renders no chip.
export function getGlobalUsageLimits(): UsageLimits | null {
  let best: UsageLimits | null = null;
  const cutoff = Date.now() - USAGE_LIMITS_STALE_MS;
  for (const v of limits.values()) {
    const t = Date.parse(v.set_at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (!best || Date.parse(v.set_at) > Date.parse(best.set_at)) best = v;
  }
  return best;
}

// Drop a session's stored limits when it is unregistered / swept. Mirrors
// dropContextUsage; kept for symmetry so a future caller can clear both.
export function dropUsageLimits(sessionId: string) {
  limits.delete(sessionId);
  deleteUsageLimits.run(sessionId);
}

export const routes = {
  "/report-context-usage": handleReportContextUsage,
  "/report-usage-limits": handleReportUsageLimits,
};
