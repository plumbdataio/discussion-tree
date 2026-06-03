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
const emptySnapshot: ReadonlyArray<Favorite> = [];
let snapshot: ReadonlyArray<Favorite> = emptySnapshot;

function notify() {
  // Rebuild the array snapshot BEFORE notifying so any useAllFavorites()
  // subscriber that re-reads via useSyncExternalStore gets the fresh
  // value on the same tick. Doing it from a listener instead would
  // depend on Set iteration order.
  snapshot = Array.from(favs.values());
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

// Standalone remove (no toggle). Used by the anchor list modal where
// the user just clicked "Unanchor" from a row rather than the toggle
// icon on the message itself.
export async function removeFavoriteByThreadItem(args: {
  sessionId: string;
  threadItemId: number;
}): Promise<void> {
  const existing = favs.get(args.threadItemId);
  if (existing) {
    favs.delete(args.threadItemId);
    notify();
  }
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
  } catch (e) {
    if (existing) {
      favs.set(args.threadItemId, existing);
      notify();
    }
    throw e;
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

// Full-store hook used by the anchor list modal — re-renders whenever
// any pin changes, returning a fresh snapshot each time. The snapshot
// reference only rotates inside notify() so useSyncExternalStore's
// stability invariant is respected.
export function useAllFavorites(): ReadonlyArray<Favorite> {
  return useSyncExternalStore(
    (cb) => subscribeFavorites(cb),
    () => snapshot,
    () => emptySnapshot,
  );
}

// Fan-out load: fetch /list-favorites for many sessions and merge into
// the store. Used by AnchorListModal to populate the "All sessions"
// view in one mount.
export async function loadFavoritesForSessions(
  sessionIds: ReadonlyArray<string>,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const all: Favorite[] = [];
  await Promise.all(
    sessionIds.map(async (sid) => {
      try {
        const res = await fetch("/list-favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sid }),
        });
        if (!res.ok) return;
        const j = (await res.json()) as {
          ok: boolean;
          favorites?: Favorite[];
        };
        if (j.ok && Array.isArray(j.favorites)) {
          for (const f of j.favorites) all.push(f);
        }
      } catch {
        /* per-session tolerance */
      }
    }),
  );
  setFavorites(all, false);
}
