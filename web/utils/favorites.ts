// Shared client-side state for "anchors" — pinned thread items.
//
// Module-level Map keyed by thread_item_id so every <ThreadMessage>
// rendered in the page can ask "am I pinned?" in O(1) and re-render
// when the answer changes, without each component holding its own
// HTTP fetch / WS handler. Updates flow in from three sources:
//
//   1. Initial /list-favorites fetch when a BoardApp mounts (= load
//      anchors for the board owner's session so the badge appears
//      immediately).
//   2. Optimistic updates in toggleFavorite() — the icon flips before
//      the round-trip completes.
//   3. WS broadcasts (`favorite-added` / `favorite-removed`) from the
//      broker so cross-tab / cross-device tabs converge.
//
// "Session" here means the broker session_id; for v1 the UI pins
// against the board's owner session_id, since the user is operating
// the board through whichever CC owns it.
import { useSyncExternalStore } from "react";
import type { Favorite } from "../../shared/types.ts";

type Listener = () => void;

const favs = new Map<number, Favorite>();
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeFavorites(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isFavorited(threadItemId: number): boolean {
  return favs.has(threadItemId);
}

export function getFavorite(threadItemId: number): Favorite | undefined {
  return favs.get(threadItemId);
}

export function getAllFavorites(): Favorite[] {
  return Array.from(favs.values());
}

// Replace the whole store with a fresh set (used after /list-favorites
// returns). Pass merge=true to add to the existing set instead — used
// when the list-modal fans out over multiple sessions and we want to
// accumulate rather than wipe.
export function setFavorites(rows: Favorite[], merge: boolean = false) {
  if (!merge) favs.clear();
  for (const r of rows) favs.set(r.thread_item_id, r);
  notify();
}

export function applyFavoriteAdded(f: Favorite) {
  favs.set(f.thread_item_id, f);
  notify();
}

export function applyFavoriteRemoved(threadItemId: number) {
  if (favs.delete(threadItemId)) notify();
}

// Fetch /list-favorites for one session and merge into the store. Used
// by BoardApp on mount (the board owner's session) and later by the
// list-modal (one call per session-of-interest).
export async function loadFavoritesForSession(
  sessionId: string,
  merge: boolean = true,
): Promise<void> {
  try {
    const res = await fetch("/list-favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) return;
    const j = (await res.json()) as {
      ok: boolean;
      favorites?: Favorite[];
    };
    if (j.ok && Array.isArray(j.favorites)) {
      setFavorites(j.favorites, merge);
    }
  } catch {
    /* tolerate network blips — next WS event or next mount retries */
  }
}

// Toggle: returns { added: true } if the call ended up pinning, false
// if it unpinned. Optimistic on both edges; rolls back on failure.
export async function toggleFavorite(args: {
  sessionId: string;
  boardId: string;
  nodeId: string;
  threadItemId: number;
}): Promise<{ added: boolean }> {
  const existing = favs.get(args.threadItemId);
  if (existing) {
    // Optimistic remove
    favs.delete(args.threadItemId);
    notify();
    try {
      const res = await fetch("/remove-favorite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: args.sessionId,
          thread_item_id: args.threadItemId,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) throw new Error(j.error ?? "remove failed");
      return { added: false };
    } catch (e) {
      // Rollback so the icon reflects reality.
      favs.set(args.threadItemId, existing);
      notify();
      throw e;
    }
  } else {
    // Optimistic add — provisional row; the WS broadcast (or the API
    // response) replaces it with the canonical row carrying the real
    // `id` and `created_at` from the DB.
    const stub: Favorite = {
      id: -1,
      session_id: args.sessionId,
      board_id: args.boardId,
      node_id: args.nodeId,
      thread_item_id: args.threadItemId,
      created_at: new Date().toISOString(),
    };
    favs.set(args.threadItemId, stub);
    notify();
    try {
      const res = await fetch("/add-favorite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: args.sessionId,
          board_id: args.boardId,
          node_id: args.nodeId,
          thread_item_id: args.threadItemId,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        ok: boolean;
        favorite?: Favorite;
        error?: string;
      };
      if (!j.ok) throw new Error(j.error ?? "add failed");
      if (j.favorite) {
        favs.set(args.threadItemId, j.favorite);
        notify();
      }
      return { added: true };
    } catch (e) {
      favs.delete(args.threadItemId);
      notify();
      throw e;
    }
  }
}

// React hook so a single message row re-renders when its own pin state
// changes — useSyncExternalStore's selector keeps the hook from firing
// for unrelated changes to the store.
export function useFavorited(threadItemId: number): boolean {
  return useSyncExternalStore(
    (cb) => subscribeFavorites(cb),
    () => favs.has(threadItemId),
    () => false,
  );
}
