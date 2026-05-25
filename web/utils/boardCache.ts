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
