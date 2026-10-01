// Shared client-side store for each session's current Claude model (the raw id
// the broker exposes as SessionListItem.model). Like usageLimits.ts, exactly ONE
// place polls — the Sidebar, from its /api/sessions fetch — and pushes the set
// here via setSharedSessionModels; a page header reads its owner session's
// model with useSessionModel(sessionId) instead of fetching on its own.
import { useCallback, useSyncExternalStore } from "react";
import type { SessionListItem } from "../../shared/types.ts";

type Listener = () => void;

// session_id -> raw model id (null = not reported yet).
let bySession: Record<string, string | null> = {};
const listeners = new Set<Listener>();

export function setSharedSessionModels(
  sessions: Pick<SessionListItem, "id" | "model">[],
): void {
  let changed = false;
  const next: Record<string, string | null> = {};
  for (const s of sessions) {
    const id = s.model?.id ?? null;
    next[s.id] = id;
    if (!(s.id in bySession) || bySession[s.id] !== id) changed = true;
  }
  if (!changed) {
    for (const id of Object.keys(bySession)) {
      if (!(id in next)) {
        changed = true;
        break;
      }
    }
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

// The raw model id of `sessionId`, or null when unknown / not yet polled.
// Snapshots are strings, so an unchanged poll never re-renders the caller.
export function useSessionModel(sessionId?: string | null): string | null {
  const getSnapshot = useCallback(
    () => (sessionId ? (bySession[sessionId] ?? null) : null),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
