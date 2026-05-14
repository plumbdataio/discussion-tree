// Per-board concern-card height override, persisted to sessionStorage.
//
// Why sessionStorage and not localStorage: the value is a per-viewing-session
// layout preference, not a long-lived setting. With localStorage we'd
// accumulate entries indefinitely (one per board the user ever opened),
// since there's no eviction path. sessionStorage is cleared when the tab
// closes, which matches the lifecycle of the layout choice itself.
//
// The hook also fans changes out to other ConcernColumn instances in the
// same window via a CustomEvent, since multiple columns on the same board
// must show the same height for the layout to look coherent.

import { useEffect, useState } from "react";

const PREFIX = "dt-concern-height";
const SYNC_EVENT = "dt-concern-height-update";

function storageKey(boardId: string): string {
  return `${PREFIX}:${boardId}`;
}

function read(boardId: string): number | null {
  if (typeof window === "undefined" || !boardId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(boardId));
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function write(boardId: string, value: number | null) {
  if (typeof window === "undefined" || !boardId) return;
  try {
    const key = storageKey(boardId);
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(Math.round(value)));
    window.dispatchEvent(
      new CustomEvent(SYNC_EVENT, { detail: { boardId, value } }),
    );
  } catch {
    /* quota / disabled — fail silently */
  }
}

// useConcernHeight(boardId) returns [overrideHeight, setOverrideHeight].
// overrideHeight is null when the user hasn't manually resized — components
// should fall back to their natural / auto sizing in that case. Pass null
// to setOverrideHeight to clear the override and return to auto.
export function useConcernHeight(
  boardId: string | null,
): [number | null, (next: number | null) => void] {
  const [value, setValue] = useState<number | null>(() =>
    boardId ? read(boardId) : null,
  );

  // Re-hydrate when boardId changes (SPA navigation between boards).
  useEffect(() => {
    setValue(boardId ? read(boardId) : null);
  }, [boardId]);

  // Listen for in-window updates so sibling columns reflect each other's
  // resize in real time without a route reload.
  useEffect(() => {
    if (!boardId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.boardId === boardId) setValue(detail.value ?? null);
    };
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, [boardId]);

  const update = (next: number | null) => {
    if (!boardId) return;
    setValue(next);
    write(boardId, next);
  };
  return [value, update];
}
