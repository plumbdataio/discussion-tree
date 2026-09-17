// Shared client-side state for the native subscription usage limits — Claude's
// 5h / 7d rate-limit windows, surfaced on the Claude Code statusline. These
// numbers are PER-ACCOUNT (one subscription per CLAUDE_CONFIG_DIR), so the store
// holds a map keyed by broker session_id: each session carries its OWN account's
// value (sessions on the same account already share it, resolved broker-side).
// Exactly ONE place polls — the Sidebar, from its /api/sessions fetch — and
// pushes the whole set here via setSharedUsageLimits; a page header reads its own
// session's value with useUsageLimits(sessionId) instead of running its own
// fetch. A no-arg call returns the account-agnostic global fallback.
import { useCallback, useSyncExternalStore } from "react";
import type { SessionListItem, UsageLimits } from "../../shared/types.ts";

type Listener = () => void;

// session_id -> that session's account limits (null = reported nothing yet).
let bySession: Record<string, UsageLimits | null> = {};
// Account-agnostic fallback (the /api/sessions top-level value), returned by the
// no-arg useUsageLimits() and used as the pre-load value.
let globalLimits: UsageLimits | null = null;
const listeners = new Set<Listener>();

// Only the four displayed fields matter. When none changed we keep the same
// object reference and skip notifying, so useSyncExternalStore subscribers
// don't re-render on a poll that returned identical numbers.
function sameLimits(a: UsageLimits | null, b: UsageLimits | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.five_hour_pct === b.five_hour_pct &&
    a.seven_day_pct === b.seven_day_pct &&
    a.five_hour_resets_at === b.five_hour_resets_at &&
    a.seven_day_resets_at === b.seven_day_resets_at
  );
}

// Called by the Sidebar on every successful /api/sessions poll with the full
// session list (active + inactive) and the top-level global fallback. Rebuilds
// the per-session map, REUSING the previous object reference for any session
// whose numbers didn't change so useSyncExternalStore's per-session snapshot
// stays referentially stable (no spurious re-render).
export function setSharedUsageLimits(
  sessions: Pick<SessionListItem, "id" | "usage_limits">[],
  global: UsageLimits | null,
): void {
  let changed = false;
  const next: Record<string, UsageLimits | null> = {};
  for (const s of sessions) {
    const incoming = s.usage_limits ?? null;
    const prev = bySession[s.id] ?? null;
    if (s.id in bySession && sameLimits(prev, incoming)) {
      next[s.id] = prev; // keep the old ref so the snapshot is stable
    } else {
      next[s.id] = incoming;
      changed = true;
    }
  }
  // A session that dropped out of the poll (CC restarted → new id) is gone from
  // `next`; that's a change so its subscribers fall back to null.
  if (!changed) {
    for (const id of Object.keys(bySession)) {
      if (!(id in next)) {
        changed = true;
        break;
      }
    }
  }
  if (!sameLimits(globalLimits, global)) {
    globalLimits = global;
    changed = true;
  }
  if (changed) {
    bySession = next;
    for (const l of listeners) l();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// React hook: a header re-renders when ITS session's limits change, reading the
// shared per-session value rather than fetching its own. Pass the broker
// session_id that owns the current page (board/map/diagram owner, or the
// session dashboard's id). With no id it returns the account-agnostic global
// fallback. A session id that isn't in the map yet (never reported, or the poll
// hasn't listed it) returns null rather than borrowing the global value, so a
// page never shows an unrelated subscription's numbers.
export function useUsageLimits(
  sessionId?: string | null,
): UsageLimits | null {
  const getSnapshot = useCallback(() => {
    if (sessionId) return bySession[sessionId] ?? null;
    return globalLimits;
  }, [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
