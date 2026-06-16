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
import {
  clearSessionCompactingStmt,
  clearSessionStalledStmt,
  clearSessionStalledBeforeStmt,
  db,
  selectAliveSessionByCcPid,
  setSessionCompactingStmt,
  setSessionStalledStmt,
} from "./db.ts";
import { broadcastToAll } from "./ws.ts";

export const activities = new Map<string, Activity>();
const toolHeartbeats = new Map<string, number>();

// Auto-continue: when a session stalls on an API error (StopFailure), nudge it
// back to life by injecting a "continue" through the channel after a short
// delay — UNLESS it recovers on its own first (clearStall cancels the timer).
// Hook-driven (not /usage API scraping), so unlike the 5h auto-resume in the
// external cc-usage bridge this can live in dt itself. The delay lets a
// transient "temporarily limiting requests" 429 clear before we resume; it's
// harmless if it ever fires for a 5h cap (the message just waits at the choice
// prompt and is picked up once a choice is made).
const autoContinueTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTO_CONTINUE_DELAY_MS = Number(process.env.DT_AUTO_CONTINUE_MS) || 30_000;
const selectDefaultBoardForSession = db.prepare(
  "SELECT id FROM boards WHERE session_id = ? AND is_default = 1 LIMIT 1",
);
const selectSessionStalledAt = db.prepare(
  "SELECT stalled_at FROM sessions WHERE id = ?",
);

function scheduleAutoContinue(sessionId: string): void {
  const prev = autoContinueTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  autoContinueTimers.set(
    sessionId,
    setTimeout(() => {
      autoContinueTimers.delete(sessionId);
      // Re-check right before enqueueing: if the session recovered between this
      // timer firing and now, clearStall already cleared stalled_at but can no
      // longer cancel us (we're out of the map) — so don't nudge a live session
      // into a duplicate turn.
      const stalled = (
        selectSessionStalledAt.get(sessionId) as { stalled_at: string | null } | null
      )?.stalled_at;
      if (!stalled) return;
      const row = selectDefaultBoardForSession.get(sessionId) as
        | { id: string }
        | null;
      if (!row) return;
      // Dynamic import avoids a static cycle (threads.ts imports this module).
      // Same channel path the cc-usage bridge uses for the 5h auto-resume; a
      // delivery timeout (CC alive but parked at a choice prompt) is fine — the
      // message is queued and picked up when it resumes.
      void import("./threads.ts")
        .then((m) =>
          m.handleSubmitAnswer({
            board_id: row.id,
            node_id: "main",
            text: "continue",
          }),
        )
        .catch(() => {});
    }, AUTO_CONTINUE_DELAY_MS),
  );
}

function cancelAutoContinue(sessionId: string): void {
  const t = autoContinueTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    autoContinueTimers.delete(sessionId);
  }
}

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

// Scheduled-send markers: broker session_id → ISO fire time of a message an
// external scheduler intends to send to that session later. The broker never
// sends anything itself; this is purely advisory state so the sidebar can
// show a "scheduled send" marker (paper-plane + clock). Set via
// /set-session-schedule-marker, cleared via /clear-session-schedule-marker
// (on send or cancel). In-memory only — a marker is transient by nature and
// not worth persisting across a broker restart.
const scheduledSendAt = new Map<string, string>();

export function scheduledSendAtForSession(sessionId: string): string | null {
  return scheduledSendAt.get(sessionId) ?? null;
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

// --- Stall (Claude Code stopped on an API error) ---------------------------
// stalled_at lives on the sessions row; the sidebar / header read it via
// /api/sessions + the board/map view. A "sidebar-refresh" broadcast nudges
// every client to refetch so the warning appears (or clears) instantly.

// The StopFailure hook fires when a turn ends with an API error (rate limit,
// "retry also failed", auth, …). Message-agnostic by design: ANY error-stop
// raises the SAME warning. Mark the owning session stalled.
export function handleSessionStalled(body: {
  cc_session_id?: string;
}): { ok: boolean } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  setSessionStalledStmt.run(new Date().toISOString(), sessionId);
  // A stalled session is NOT working. StopFailure fires instead of Stop, so the
  // normal clear path (handleClearToolActivity) never runs and the last
  // PreToolUse heartbeat would leave a "working" badge spinning next to the
  // stall warning. Clear the hook-managed working state here (but leave an
  // explicit LLM-set state like "blocked" alone, same posture as the Stop hook).
  toolHeartbeats.delete(sessionId);
  const cur = activities.get(sessionId);
  if (cur && cur.state === "working") {
    activities.delete(sessionId);
    broadcastActivity(sessionId, null);
  }
  broadcastToAll({ type: "session-stall-update" });
  scheduleAutoContinue(sessionId);
  return { ok: true };
}

// Clear the stall the moment a session shows life again — called from the
// tool heartbeat (PreToolUse), the tool-activity clear (normal Stop), and
// the SessionStart re-attach. Broadcasts only when something actually
// changed (the prepared statement's WHERE guards that).
export function clearStall(sessionId: string): void {
  const res = clearSessionStalledStmt.run(sessionId);
  if (res.changes > 0) {
    cancelAutoContinue(sessionId); // recovered on its own — don't nudge it
    broadcastToAll({ type: "session-stall-update" });
  }
}

// Time-guarded variant: clear only a stall recorded BEFORE `pushedAt` — the
// instant a channel push to this session provably resolved (so CC was alive
// then). An older stall is stale and clears; a stall recorded after the push
// (a fresh failure the push didn't cause) survives a delayed ack. Same cancel +
// broadcast as clearStall when it actually clears.
export function clearStallBefore(sessionId: string, pushedAt: string): void {
  const res = clearSessionStalledBeforeStmt.run(sessionId, pushedAt);
  if (res.changes > 0) {
    cancelAutoContinue(sessionId);
    broadcastToAll({ type: "session-stall-update" });
  }
}

// --- Compacting (Claude Code is compressing its context) -------------------
// compacting_at lives on the sessions row; the sidebar / header read it via
// /api/sessions + the board/map view. Driven by the PreCompact hook (set) and
// cleared on resume (the post-compact SessionStart hook) or as a self-heal by
// the next tool heartbeat / re-attach. A "session-compacting-update" broadcast
// nudges every client to refetch so the badge appears (or clears) instantly.

// PreCompact hook entry — Claude Code is about to compact (manual /compact or
// an auto-compaction). Flag the owning session so the UI shows a "compacting"
// badge for the duration. cc_session_id, not session_id: hooks only know the
// CC side.
export function handleSessionCompacting(body: {
  cc_session_id?: string;
}): { ok: boolean } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  setSessionCompactingStmt.run(new Date().toISOString(), sessionId);
  // Compaction runs no tools, so the last PreToolUse heartbeat would leave a
  // "working" badge spinning the whole time. Clear the hook-managed working
  // state (but leave an explicit LLM-set state like "blocked" alone, same
  // posture as the Stop / stall paths) so only the compacting badge shows.
  toolHeartbeats.delete(sessionId);
  const cur = activities.get(sessionId);
  if (cur && cur.state === "working") {
    activities.delete(sessionId);
    broadcastActivity(sessionId, null);
  }
  broadcastToAll({ type: "session-compacting-update" });
  return { ok: true };
}

// Clear the compacting flag — called from the post-compact SessionStart hook
// (the deterministic path) and, as a self-heal, from the tool heartbeat and
// re-attach (so an aborted/cancelled compaction never leaves the badge stuck).
// Broadcasts only when something actually changed (the prepared statement's
// WHERE guards that).
export function clearCompacting(sessionId: string): void {
  const res = clearSessionCompactingStmt.run(sessionId);
  if (res.changes > 0) {
    broadcastToAll({ type: "session-compacting-update" });
  }
}

// Post-compact SessionStart hook entry — compaction finished and the session
// resumed. Clear the badge.
export function handleSessionCompactingDone(body: {
  cc_session_id?: string;
}): { ok: boolean } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  clearCompacting(sessionId);
  return { ok: true };
}

// --- Self-heal re-attach (transient UI cue) --------------------------------
// The MCP server's heartbeat self-healing loop re-bound a session whose broker
// binding had been lost (selfHealAttachOnce succeeded). Broadcast a one-shot
// signal so the sidebar can flash a brief spinner for that session — the human
// sees the recovery too, not just the agent (which gets a channel notice).
// Purely transient: NO DB state, no badge to clear; the client self-clears the
// flash after a few seconds. Distinct from a plain attach, which the broker
// can't tell apart from a self-heal — only the MCP server knows, so it POSTs
// here exclusively on the self-heal path.
export function handleSessionReattached(body: {
  cc_session_id?: string;
}): { ok: boolean } {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  broadcastToAll({ type: "session-reattached", session_id: sessionId });
  return { ok: true };
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
  // A tool firing means the session is alive again — clear any stall warning,
  // and self-heal a compacting badge a missed post-compact hook left stuck.
  clearStall(sessionId);
  clearCompacting(sessionId);
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

// A sibling MCP server living under the SAME Claude Code (e.g. claude-peers)
// received an inbound peer message and pushed it into this CC — a turn it
// triggered that dt has no hook for (channel pushes don't fire any hook, and
// UserPromptSubmit doesn't fire for MCP-injected turns). The sibling can't know
// our cc_session_id, but it shares the CC's PID, so it pings here with cc_pid
// to light the "working" spinner for that turn. Resolves cc_pid -> the one
// alive session and reuses the user-submit working mark (the turn's Stop hook
// clears it as usual). Best-effort: unknown / non-numeric pid is a no-op.
export function handleHeartbeatCcPid(body: { cc_pid?: number }): {
  ok: boolean;
} {
  if (typeof body.cc_pid !== "number") return { ok: false };
  const row = selectAliveSessionByCcPid.get(body.cc_pid) as
    | { id: string }
    | null;
  if (!row) return { ok: false };
  markWorkingFromUserSubmit(row.id);
  return { ok: true };
}

// The per-CC MCP poller just pushed a channel message to this session and the
// `notifications/claude/channel` write RESOLVED. That's the strongest signal dt
// has that the session is alive and about to process a turn — stronger than the
// broker-side `delivered` flag, which flips when the poller DRAINS the queue,
// before the stdio notification is even attempted. So the stall warning (and
// the pending auto-continue nudge) is cleared here, tied to push-success,
// rather than in handleSubmitAnswer on the delivered flag: a push that throws
// (transport hiccup, CC restarting) now leaves the honest stalled state instead
// of wiping a ⚠️ on a session that never actually received the "continue".
// Residual: a resolved stdio write proves CC got the bytes, not that the LLM
// accepted them — but a tool-less thinking turn fires no hook, so this is the
// best available signal (the same inherent ceiling as stall detection itself).
// session_id is the broker id the poller already holds. `pushed_at` is the
// instant the channel notification RESOLVED (captured by the poller, not at
// ack-processing time — so a delayed ack still carries the early push moment).
// Clear only a stall older than that moment: the push proves CC was alive then,
// so any earlier stall is stale; a stall recorded after the push (the pushed
// turn then failed) is a fresh problem this ack must not wipe — that's the race
// where a delayed ack would otherwise cancel a live session's auto-continue.
// Missing pushed_at is a no-op. Idempotent, so a duplicate ack per drain is
// harmless. (Symmetric residual, both benign: a stall in the drain→resolve gap
// clears; a same-millisecond collision lingers to the turn's natural Stop.)
export function handleChannelPushed(body: {
  session_id?: string;
  pushed_at?: string | null;
}): {
  ok: boolean;
} {
  if (!body.session_id) return { ok: false };
  if (body.pushed_at) clearStallBefore(body.session_id, body.pushed_at);
  return { ok: true };
}

export function handleClearToolActivity(body: { cc_session_id?: string }): {
  ok: boolean;
} {
  if (!body.cc_session_id) return { ok: false };
  const sessionId = lookupAliveSessionByCcId(body.cc_session_id);
  if (!sessionId) return { ok: false };
  // A normal turn end (Stop hook) means the session recovered — clear any
  // stall. (On an API-error stop the StopFailure hook fires instead of Stop,
  // so this only runs on a clean finish.) Also self-heal a stuck compacting
  // badge in case the post-compact hook didn't reach the broker.
  clearStall(sessionId);
  clearCompacting(sessionId);
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

// Clears one or more in-flight BG tasks by the tool_use_id they were
// registered under (handleBgTaskStart). Two callers now:
//   - the bg-task-reconcile Stop hook, which scrapes the transcript each turn
//     end for completed <task-notification> blocks and clears their
//     <tool-use-id> values automatically (the reliable path), and
//   - the report_bg_task_done MCP tool (same-turn fast-path).
// NOTE the completion notification carries BOTH a short <task-id> and the
// <tool-use-id> — only the latter matches what we registered, so both callers
// must send the tool_use_id. Accepts a list so several completions clear in
// one round-trip; unknown ids are silently ignored (idempotent).
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

// Register a scheduled-send marker for a set of sessions. Generic utility:
// an external scheduler that intends to deliver a message to these sessions
// at `fire_at` calls this so the sidebar can surface the pending send.
export function handleSetScheduleMarker(body: {
  session_ids?: string[];
  fire_at?: string;
}): { ok: boolean; set: number; error?: string } {
  if (!Array.isArray(body.session_ids) || !body.fire_at) {
    return {
      ok: false,
      set: 0,
      error: "session_ids array and fire_at required",
    };
  }
  let set = 0;
  for (const sid of body.session_ids) {
    scheduledSendAt.set(sid, body.fire_at);
    set++;
  }
  if (set > 0) broadcastToAll({ type: "schedule-marker-update" });
  return { ok: true, set };
}

// Clear scheduled-send markers (the message went out, or the schedule was
// cancelled). Silently ignores sessions that had no marker.
export function handleClearScheduleMarker(body: {
  session_ids?: string[];
}): { ok: boolean; cleared: number; error?: string } {
  if (!Array.isArray(body.session_ids)) {
    return { ok: false, cleared: 0, error: "session_ids array required" };
  }
  let cleared = 0;
  for (const sid of body.session_ids) {
    if (scheduledSendAt.delete(sid)) cleared++;
  }
  if (cleared > 0) broadcastToAll({ type: "schedule-marker-update" });
  return { ok: true, cleared };
}

export const routes = {
  "/set-activity": handleSetActivity,
  "/heartbeat-tool": handleHeartbeatTool,
  "/heartbeat-cc-pid": handleHeartbeatCcPid,
  "/channel-pushed": handleChannelPushed,
  "/clear-tool-activity": handleClearToolActivity,
  "/session-stalled": handleSessionStalled,
  "/session-compacting": handleSessionCompacting,
  "/session-compacting-done": handleSessionCompactingDone,
  "/session-reattached": handleSessionReattached,
  "/clear-activities-for-sessions": handleClearActivitiesForSessions,
  "/blocked-on-user-start": handleBlockedOnUserStart,
  "/blocked-on-user-clear": handleBlockedOnUserClear,
  "/bg-task-start": handleBgTaskStart,
  "/bg-task-done": handleBgTaskDone,
  "/bg-task-clear-session": handleBgTaskClearSession,
  "/set-session-schedule-marker": handleSetScheduleMarker,
  "/clear-session-schedule-marker": handleClearScheduleMarker,
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
