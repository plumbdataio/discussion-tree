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
// (used_percentage 0..100 + resets_at unix seconds) plus `account` = the
// session's CLAUDE_CONFIG_DIR. The user's statusline writes them to
// /tmp/claude-sl-<cc_session_id>-limits.json and this repo's
// cc-context-report-hook.sh POSTs them here. The numbers are PER-ACCOUNT (one
// subscription per config dir) — NOT machine-global: two config dirs are two
// different subscriptions with independent limits. Each session reports its own
// snapshot; we keep the latest per broker session, tagged with the account it
// came from. getUsageLimitsForAccount() combines per window over only the rows
// that share an account (so sessions on the same subscription share a value and
// an idle one shows a sibling's fresher number), while getGlobalUsageLimits()
// combines over ALL rows as an account-agnostic fallback.

// Window lengths, used only as the reset boundary when a snapshot carries a pct
// but no resets_at (see combineLimits): the window is assumed to reset one
// window-length after the report.
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// A stored snapshot is a UsageLimits plus the account it was reported under
// (null for rows reported before the account field existed / a report that
// omitted it). Only `account` is internal; the four displayed fields + set_at
// are the UsageLimits shape handed to the frontend.
type StoredUsageLimits = UsageLimits & { account: string | null };

// Keyed by broker session_id, mirroring `usages` above.
const limits = new Map<string, StoredUsageLimits>();

// Re-warm from the DB on startup so a broker restart doesn't blank the chip
// until a session re-reports on its next tool call.
for (const row of selectAllUsageLimits.all() as {
  session_id: string;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  account: string | null;
  set_at: string;
}[]) {
  limits.set(row.session_id, {
    five_hour_pct: row.five_hour_pct ?? undefined,
    five_hour_resets_at: row.five_hour_resets_at ?? undefined,
    seven_day_pct: row.seven_day_pct ?? undefined,
    seven_day_resets_at: row.seven_day_resets_at ?? undefined,
    account: row.account ?? null,
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

// account is the reporting session's CLAUDE_CONFIG_DIR. Keep a non-empty
// trimmed string; anything else (absent, non-string, blank) is stored as NULL
// and treated as "unknown account".
function cleanAccount(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function handleReportUsageLimits(body: {
  cc_session_id?: string;
  five_hour_pct?: number;
  five_hour_resets_at?: number;
  seven_day_pct?: number;
  seven_day_resets_at?: number;
  account?: string;
}): { ok: boolean; session_id?: string } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  const fiveHourPct = cleanPct(body.five_hour_pct);
  const fiveHourResetsAt = cleanResetsAt(body.five_hour_resets_at);
  const sevenDayPct = cleanPct(body.seven_day_pct);
  const sevenDayResetsAt = cleanResetsAt(body.seven_day_resets_at);
  const account = cleanAccount(body.account);
  // Reject a report that carries no usable field at all — nothing to store, and
  // it would otherwise overwrite a good row with an empty, freshly-dated one and
  // let it win the "freshest" pick with blank numbers.
  if (fiveHourPct === undefined && sevenDayPct === undefined) {
    return { ok: false };
  }
  const setAt = new Date().toISOString();
  const value: StoredUsageLimits = {
    five_hour_pct: fiveHourPct,
    five_hour_resets_at: fiveHourResetsAt,
    seven_day_pct: sevenDayPct,
    seven_day_resets_at: sevenDayResetsAt,
    account,
    set_at: setAt,
  };
  limits.set(sessionId, value);
  upsertUsageLimits.run(
    sessionId,
    fiveHourPct ?? null,
    fiveHourResetsAt ?? null,
    sevenDayPct ?? null,
    sevenDayResetsAt ?? null,
    account,
    setAt,
  );
  return { ok: true, session_id: sessionId };
}

// Combine a SUBSET of stored snapshots into one usage value. We evaluate the 5h
// and 7d windows INDEPENDENTLY across the given snapshots, driven by each
// window's own resets_at rather than a fixed age cutoff:
//
//   - A window's reported value is valid until its resets_at; before that we
//     show the latest reported value no matter how old the report is (a 7d
//     number stays good for days, so a short idle gap must not hide it).
//   - Once now passes resets_at, the window has rolled over to ~0, so we show
//     0% for it — present-but-past-reset, NOT absent.
//   - Per-window independence: a still-valid 5h from an older snapshot is shown
//     even when the newest snapshot carries only 7d. (Claude Code emits the 5h
//     window only after the first API response, so a freshly-started session
//     reports 7d-only.)
//   - This replaces the old fixed 6h cutoff, which wrongly hid the 7-day value
//     (valid for days) after a short idle gap.
//
// When a window's resets_at is absent we fall back to set_at + the window
// length as its reset boundary. Returns null only when no snapshot in the
// subset carries either window's pct — the frontend then renders no chip.
//
// Callers choose the subset: getGlobalUsageLimits() passes every row (account-
// agnostic fallback), getUsageLimitsForAccount() passes only one account's rows.
function combineLimits(entries: Iterable<StoredUsageLimits>): UsageLimits | null {
  const all = [...entries];
  type WindowResult = {
    pct: number;
    resets_at: number | undefined;
    set_at: string;
  };

  // Evaluate one window across the subset: pick the freshest snapshot that
  // carries this window's pct, then decide whether it has reset since.
  const evalWindow = (
    getPct: (v: StoredUsageLimits) => number | undefined,
    getResetsAt: (v: StoredUsageLimits) => number | undefined,
    windowLenMs: number,
  ): WindowResult | null => {
    // 1. Freshest (greatest set_at) snapshot whose pct for this window is set.
    let e: StoredUsageLimits | null = null;
    for (const v of all) {
      if (typeof getPct(v) !== "number") continue;
      if (!e || Date.parse(v.set_at) > Date.parse(e.set_at)) e = v;
    }
    if (!e) return null;

    // 2. Reset boundary in ms: the reported resets_at if present, else the
    //    report time plus one window length. An unparseable set_at with no
    //    resets_at is treated as already past reset.
    const resetsAt = getResetsAt(e);
    let boundary: number;
    if (
      typeof resetsAt === "number" &&
      Number.isFinite(resetsAt) &&
      resetsAt > 0
    ) {
      boundary = resetsAt * 1000;
    } else {
      const setAtMs = Date.parse(e.set_at);
      boundary = Number.isNaN(setAtMs) ? -Infinity : setAtMs + windowLenMs;
    }

    // 3. Past the boundary → the window has rolled over: show 0%, reset unknown.
    if (Date.now() >= boundary) {
      return { pct: 0, resets_at: undefined, set_at: e.set_at };
    }
    // Still within the window → pass the reported value (and resets_at) through.
    return { pct: getPct(e) as number, resets_at: resetsAt, set_at: e.set_at };
  };

  const five = evalWindow(
    (v) => v.five_hour_pct,
    (v) => v.five_hour_resets_at,
    FIVE_HOUR_MS,
  );
  const seven = evalWindow(
    (v) => v.seven_day_pct,
    (v) => v.seven_day_resets_at,
    SEVEN_DAY_MS,
  );

  // Neither window had any snapshot with a pct → nothing to show.
  if (!five && !seven) return null;

  // set_at: the greatest set_at among the snapshots that actually contributed.
  let setAt = "";
  for (const r of [five, seven]) {
    if (!r) continue;
    if (setAt === "" || Date.parse(r.set_at) > Date.parse(setAt)) {
      setAt = r.set_at;
    }
  }

  return {
    five_hour_pct: five ? five.pct : undefined,
    five_hour_resets_at: five ? five.resets_at : undefined,
    seven_day_pct: seven ? seven.pct : undefined,
    seven_day_resets_at: seven ? seven.resets_at : undefined,
    set_at: setAt,
  };
}

// Account-agnostic combine over EVERY stored snapshot. Kept as a fallback (the
// auto-continue rate-limit resume uses it, and sessions.ts still exposes it as
// the top-level /api/sessions value for back-compat), but a page's chip is now
// driven by getUsageLimitsForAccount so it shows ITS OWN subscription.
export function getGlobalUsageLimits(): UsageLimits | null {
  return combineLimits(limits.values());
}

// Per-account combine: the same reset-driven logic as the global getter, but
// over only the snapshots reported under `account`. This is what makes two
// subscriptions (two CLAUDE_CONFIG_DIRs) show independent numbers, and lets an
// idle session pick up a fresher value reported by a sibling on the SAME
// account. Returns null when no row for the account carries a usable pct.
export function getUsageLimitsForAccount(account: string): UsageLimits | null {
  const mine: StoredUsageLimits[] = [];
  for (const v of limits.values()) {
    if (v.account === account) mine.push(v);
  }
  if (mine.length === 0) return null;
  return combineLimits(mine);
}

// The account on the given session's OWN latest stored row (null if it has
// never reported, or reported without an account). sessions.ts uses this to
// decide which account's combined value to attach to each session row.
export function accountForSession(sessionId: string): string | null {
  return limits.get(sessionId)?.account ?? null;
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
