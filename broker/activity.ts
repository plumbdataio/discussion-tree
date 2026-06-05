// In-memory activity state and the auto-activity hook plumbing.
//
// Two kinds of entries can land in `activities`:
//   - "working" — emitted by the PreToolUse hook on every CC tool call,
//     auto-cleared by the Stop hook (or by the watchdog after
//     AUTO_ACTIVITY_TIMEOUT_MS as a safety net).
//   - explicit (e.g. "blocked") — set by the LLM via /set-activity. These are
//     never overwritten or auto-cleared by the hook plumbing; only the LLM
//     can clear them.

import type { Activity, SetActivityRequest } from "../shared/types.ts";
import { db } from "./db.ts";
import { broadcastToAll } from "./ws.ts";

export const activities = new Map<string, Activity>();
const toolHeartbeats = new Map<string, number>();

// In-flight background-task counters per broker session_id. Driven from
// PreToolUse(Bash) (run_in_background:true → add) and from the CC-side
// report_bg_task_done MCP tool (→ delete). Frontend renders a BG marker
// next to the working spinner whenever the set for a session is non-empty.
//
// The keys inside each set are CC tool_use_ids, which are unique per
// invocation, so the same task can't double-count.
const bgTasks = new Map<string, Set<string>>();

function broadcastBgTasks(sessionId: string) {
  const set = bgTasks.get(sessionId);
  const count = set?.size ?? 0;
  broadcastToAll({ type: "bg-tasks-update", session_id: sessionId, count });
}

export function bgTaskCountForSession(sessionId: string): number {
  return bgTasks.get(sessionId)?.size ?? 0;
}

function broadcastActivity(sessionId: string, entry: Activity | null) {
  broadcastToAll({ type: "activity", session_id: sessionId, activity: entry });
}

function lookupAliveSessionByCcId(ccSessionId: string): string | null {
  const session = db
    .prepare(
      "SELECT id FROM sessions WHERE cc_session_id = ? AND alive = 1 ORDER BY last_seen DESC LIMIT 1",
    )
    .get(ccSessionId) as { id: string } | null;
  return session?.id ?? null;
}

export function handleSetActivity(body: SetActivityRequest) {
  const sessionId = body.session_id;
  if (!body.state) {
    activities.delete(sessionId);
    broadcastActivity(sessionId, null);
    return { ok: true, cleared: true };
  }
  const entry: Activity = {
    session_id: sessionId,
    state: body.state,
    board_id: body.board_id,
    node_id: body.node_id,
    message: body.message,
    set_at: new Date().toISOString(),
  };
  activities.set(sessionId, entry);
  broadcastActivity(sessionId, entry);
  return { ok: true, activity: entry };
}

export function handleHeartbeatTool(body: {
  cc_session_id?: string;
  tool?: string;
}): { ok: boolean } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  // Don't stomp an explicit non-working state (e.g. "blocked" set by the
  // AskUserQuestion / ExitPlanMode hook). PreToolUse hooks fire in
  // unspecified order — if heartbeat ran AFTER the blocked-on-user hook,
  // overwriting would erase the blocked badge. Same posture as
  // markWorkingFromUserSubmit.
  const cur = activities.get(sessionId);
  if (cur && cur.state !== "working") return { ok: true };
  const now = Date.now();
  toolHeartbeats.set(sessionId, now);
  const entry: Activity = {
    session_id: sessionId,
    state: "working",
    message: body.tool ?? "",
    set_at: new Date(now).toISOString(),
  };
  activities.set(sessionId, entry);
  broadcastActivity(sessionId, entry);
  return { ok: true };
}

// Mark a session "working" the instant the user submits a message through
// the UI — immediate feedback before the CC has even polled for it. The
// session is registered with the watchdog (toolHeartbeats) so the badge
// self-clears after AUTO_ACTIVITY_TIMEOUT_MS if the CC never responds; the
// normal path is the Stop hook clearing it once the CC finishes its turn.
export function markWorkingFromUserSubmit(sessionId: string) {
  // Don't stomp an explicit LLM-set state (e.g. "blocked"). Those are only
  // cleared by the LLM itself; a user submit shouldn't override them.
  const cur = activities.get(sessionId);
  if (cur && cur.state !== "working") return;
  const now = Date.now();
  toolHeartbeats.set(sessionId, now);
  const entry: Activity = {
    session_id: sessionId,
    state: "working",
    message: "",
    set_at: new Date(now).toISOString(),
  };
  activities.set(sessionId, entry);
  broadcastActivity(sessionId, entry);
}

export function handleClearToolActivity(body: { cc_session_id?: string }): {
  ok: boolean;
} {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  toolHeartbeats.delete(sessionId);
  // Only clear the hook-managed "working" state. Explicit set_activity
  // entries (e.g. "blocked") are preserved.
  const cur = activities.get(sessionId);
  if (cur && cur.state === "working") {
    activities.delete(sessionId);
    broadcastActivity(sessionId, null);
  }
  return { ok: true };
}

// PreToolUse(AskUserQuestion|ExitPlanMode) hook entry — Claude is now waiting
// on the user. Flip to "blocked" so the sidebar badge tells the user without
// them needing to look at the CLI. message carries a short preview of the
// question. cc_session_id, not session_id: hooks only know the CC side.
export function handleBlockedOnUserStart(body: {
  cc_session_id?: string;
  question?: string;
}): { ok: boolean } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  const raw = (body.question ?? "").trim();
  // Keep the badge tooltip readable — a long question would blow out the UI.
  const message = raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
  const entry: Activity = {
    session_id: sessionId,
    state: "blocked",
    message,
    set_at: new Date().toISOString(),
  };
  activities.set(sessionId, entry);
  broadcastActivity(sessionId, entry);
  return { ok: true };
}

// PostToolUse(AskUserQuestion|ExitPlanMode) hook entry — the user has
// answered (or the plan exited) and the tool call returned. Drop the blocked
// state. Only clears "blocked" so we don't stomp other states the LLM may
// have set in the meantime.
export function handleBlockedOnUserClear(body: { cc_session_id?: string }): {
  ok: boolean;
} {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  const cur = activities.get(sessionId);
  if (cur && cur.state === "blocked") {
    activities.delete(sessionId);
    broadcastActivity(sessionId, null);
  }
  return { ok: true };
}

// PreToolUse(Bash with run_in_background:true) routes the launch here.
// The CC tool_use_id is the natural task token because it's unique per
// invocation and is what `<task-notification>` carries back on
// completion, so report_bg_task_done can match by the same value.
export function handleBgTaskStart(body: {
  cc_session_id?: string;
  task_id?: string;
}): { ok: boolean; error?: string; count?: number } {
  if (!body.cc_session_id || !body.task_id) {
    return { ok: false, error: "cc_session_id and task_id required" };
  }
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false, error: "session not found" };
  let set = bgTasks.get(sessionId);
  if (!set) {
    set = new Set();
    bgTasks.set(sessionId, set);
  }
  set.add(body.task_id);
  broadcastBgTasks(sessionId);
  return { ok: true, count: set.size };
}

// CC calls this through the report_bg_task_done MCP tool after seeing a
// <task-notification status="completed" task-id=...> in its message
// stream. Accepts a list so multiple completions seen on the same turn
// can be cleared in one round-trip.
export function handleBgTaskDone(body: {
  session_id?: string;
  cc_session_id?: string;
  task_ids?: string[];
}): { ok: boolean; cleared: number; remaining: number; error?: string } {
  let sessionId: string | null = body.session_id ?? null;
  if (!sessionId && body.cc_session_id) {
    sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  }
  if (!sessionId) {
    return { ok: false, cleared: 0, remaining: 0, error: "session not found" };
  }
  if (!Array.isArray(body.task_ids)) {
    return {
      ok: false,
      cleared: 0,
      remaining: bgTasks.get(sessionId)?.size ?? 0,
      error: "task_ids array required",
    };
  }
  const set = bgTasks.get(sessionId);
  let cleared = 0;
  if (set) {
    for (const id of body.task_ids) {
      if (set.delete(id)) cleared++;
    }
    if (set.size === 0) bgTasks.delete(sessionId);
  }
  broadcastBgTasks(sessionId);
  return { ok: true, cleared, remaining: bgTasks.get(sessionId)?.size ?? 0 };
}

// Clear ALL in-flight BG tasks for one session at once. Two callers:
//   - the UI "clear" affordance on the BG marker chip (the user clicked
//     it because the count is obviously stale)
//   - the clear_bg_tasks MCP tool (the agent knows its background work
//     is all done and wants to reset a counter that report_bg_task_done
//     missed)
//
// We deliberately do NOT auto-expire BG tasks by age. From the broker's
// side a long-running background build is indistinguishable from a
// leaked counter, and the user previously had us no-op exactly this kind
// of time-based badge watchdog (see startActivityWatchdog below) because
// it cleared badges that were still relevant. Manual clear only — zero
// false positives.
export function handleBgTaskClearSession(body: {
  session_id?: string;
  cc_session_id?: string;
}): { ok: boolean; cleared: number; error?: string } {
  let sessionId: string | null = body.session_id ?? null;
  if (!sessionId && body.cc_session_id) {
    sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  }
  if (!sessionId) {
    return { ok: false, cleared: 0, error: "session not found" };
  }
  const set = bgTasks.get(sessionId);
  const cleared = set?.size ?? 0;
  bgTasks.delete(sessionId);
  broadcastBgTasks(sessionId);
  return { ok: true, cleared };
}

// Bulk clear for a set of sessions. Used when an external tool wants
// to silence every spinner across a group of CCs at once (e.g. a
// scheduled "observation mode" where the user wants the badges
// quieted until they intervene). Clears all flavours — both the
// hook-managed "working" entries and any explicit states the LLM
// set — and broadcasts an `activity` event with null per session
// so frontends drop the badge immediately.
export function handleClearActivitiesForSessions(body: {
  session_ids?: string[];
}): { ok: boolean; cleared: number; error?: string } {
  if (!Array.isArray(body.session_ids)) {
    return { ok: false, cleared: 0, error: "session_ids array required" };
  }
  let cleared = 0;
  for (const sid of body.session_ids) {
    if (activities.delete(sid)) cleared++;
    toolHeartbeats.delete(sid);
    broadcastActivity(sid, null);
  }
  return { ok: true, cleared };
}

export const routes = {
  "/set-activity": handleSetActivity,
  "/heartbeat-tool": handleHeartbeatTool,
  "/clear-tool-activity": handleClearToolActivity,
  "/clear-activities-for-sessions": handleClearActivitiesForSessions,
  "/blocked-on-user-start": handleBlockedOnUserStart,
  "/blocked-on-user-clear": handleBlockedOnUserClear,
  "/bg-task-start": handleBgTaskStart,
  "/bg-task-done": handleBgTaskDone,
  "/bg-task-clear-session": handleBgTaskClearSession,
};

// Watchdog — used to auto-clear stale "working" entries after
// AUTO_ACTIVITY_TIMEOUT_MS when neither Stop nor /clear-tool-activity
// got through. Disabled at user request: the timeout was clearing
// badges that were actually still relevant (long-running tool calls
// look idle to the watchdog), so the badge would disappear and
// reappear mid-task. Stop / clear-tool-activity / explicit overrides
// continue to clear normally; the only thing this no-op'd path lost
// is the safety net for a CC that crashes silently. Re-enable if
// stuck badges become a problem in practice.
export function startActivityWatchdog() {
  // intentionally a no-op
}
