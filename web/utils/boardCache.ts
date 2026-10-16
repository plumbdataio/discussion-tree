// Lightweight IndexedDB-backed cache for BoardView payloads.
//
// Purpose: when the browser (especially iOS Safari) discards a tab from
// memory and the user navigates back, the page reloads cold and has to
// wait on the network /api/board/<id> round-trip before rendering
// anything. With a cache hit we render the previous view immediately,
// then quietly reconcile with the fresh fetch when it arrives — same
// pattern as stale-while-revalidate, scoped to a single tab's local
// storage so it never crosses devices.
//
// Cache entries are JSON snapshots of BoardView keyed by board_id with
// a write timestamp. We bound staleness with a 7-day TTL and silently
// drop entries from before that window on read; we don't have a hard
// eviction policy beyond that because IndexedDB quota is large and
// boards aren't usually huge.

import type { BoardView } from "../../shared/types.ts";

const DB_NAME = "dt-board-cache";
const STORE = "boards";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Entry = { view: BoardView; at: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readBoardCache(
  boardId: string,
): Promise<BoardView | null> {
  try {
    const db = await openDb();
    return await new Promise<BoardView | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(boardId);
      req.onsuccess = () => {
        const v = req.result as Entry | undefined;
        if (!v) return resolve(null);
        if (Date.now() - v.at > TTL_MS) return resolve(null);
        resolve(v.view);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// Coalesced cache writes. A write structured-clones the WHOLE view (~16ms and
// a ~2.6M-character clone on the 4,600-message default board, measured
// 2026-10-16), and a single post produces 2-3 live deltas — writing each one
// was pure waste for a snapshot that only seeds the next cold start (which
// always refetches anyway). So: keep the latest view per board, write it after
// a quiet period, flush early when the tab is hidden or unloaded (the moment
// iOS may discard it), and skip a view that was already written.
export type BoardCacheWriter = {
  schedule: (boardId: string, view: BoardView) => void;
  flush: () => void;
};

export function createBoardCacheWriter(opts: {
  write: (boardId: string, view: BoardView) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): BoardCacheWriter {
  const delayMs = opts.delayMs ?? 3000;
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<string, BoardView>();
  // Views already written. Weak on purpose: holding the last view of every
  // board visited would keep each one's whole thread in memory for the life
  // of the tab.
  const written = new WeakSet<BoardView>();
  let timer: unknown = null;

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    for (const [boardId, view] of pending) {
      if (written.has(view)) continue;
      written.add(view);
      opts.write(boardId, view);
    }
    pending.clear();
  };

  const schedule = (boardId: string, view: BoardView) => {
    if (written.has(view) && !pending.has(boardId)) return;
    pending.set(boardId, view);
    // Trailing debounce: every new view pushes the write back.
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      flush();
    }, delayMs);
  };

  return { schedule, flush };
}

let sharedWriter: BoardCacheWriter | null = null;

// Queue `view` as board `boardId`'s cold-start snapshot (see
// createBoardCacheWriter). Best effort, never throws.
export function scheduleBoardCacheWrite(boardId: string, view: BoardView): void {
  if (!sharedWriter) {
    const writer = createBoardCacheWriter({
      write: (id, v) => {
        writeBoardCache(id, v).catch(() => {
          /* best effort */
        });
      },
    });
    sharedWriter = writer;
    if (typeof window !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") writer.flush();
      });
      window.addEventListener("pagehide", () => writer.flush());
    }
  }
  sharedWriter.schedule(boardId, view);
}

export async function writeBoardCache(
  boardId: string,
  view: BoardView,
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ view, at: Date.now() } as Entry, boardId);
  } catch {
    // Quota exhausted or storage disabled — caching is best-effort, so
    // failures here must never block the user-facing flow.
  }
}
