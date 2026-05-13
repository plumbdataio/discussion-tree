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
import { AUTO_ACTIVITY_TIMEOUT_MS } from "./config.ts";

export const activities = new Map<string, Activity>();
const toolHeartbeats = new Map<string, number>();

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

export const routes = {
  "/set-activity": handleSetActivity,
  "/heartbeat-tool": handleHeartbeatTool,
  "/clear-tool-activity": handleClearToolActivity,
};

// Watchdog — clear stale auto-activity entries when neither Stop nor
// /clear-tool-activity got through (CC crash mid-turn etc).
export function startActivityWatchdog() {
  setInterval(() => {
    const now = Date.now();
    for (const [sid, at] of toolHeartbeats.entries()) {
      if (now - at <= AUTO_ACTIVITY_TIMEOUT_MS) continue;
      toolHeartbeats.delete(sid);
      const cur = activities.get(sid);
      if (cur && cur.state === "working") {
        activities.delete(sid);
        broadcastActivity(sid, null);
      }
    }
  }, 1000);
}
