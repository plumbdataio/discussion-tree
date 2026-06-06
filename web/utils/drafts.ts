// Per-(board, node) draft persistence for unsent textarea content.
// Each textarea writes to localStorage as the user types so a refresh,
// SPA navigation, or accidental tab close doesn't lose the in-flight
// reply. Cleared once the message ships successfully.

import { useEffect, useRef, useState } from "react";

const PREFIX = "dt-draft";
// Same-tab live sync: when one useDraft instance edits, siblings bound to the
// same (board, node) key update immediately (e.g. the node-modal preview and
// the underlying ItemCard share a draft — typing in one must show in the
// other without a reload). localStorage's own `storage` event only fires in
// OTHER tabs, so we broadcast within the tab ourselves.
const SYNC_EVENT = "dt-draft-sync";

function key(boardId: string, nodeId: string): string {
  return `${PREFIX}:${boardId}:${nodeId}`;
}

function broadcast(k: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { key: k, value } }));
  } catch {
    /* ignore */
  }
}

function read(boardId: string, nodeId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(key(boardId, nodeId)) ?? "";
  } catch {
    return "";
  }
}

function write(boardId: string, nodeId: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(key(boardId, nodeId), value);
    else localStorage.removeItem(key(boardId, nodeId));
  } catch {
    /* quota / disabled — fail silently rather than block the keystroke */
  }
}

export function clearDraft(boardId: string, nodeId: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key(boardId, nodeId));
  } catch {
    /* ignore */
  }
}

// useDraft(boardId, nodeId) returns a [value, setValue] pair backed by
// localStorage for the given (board, node). The first render hydrates from
// storage; subsequent setValue calls write through. Pass empty string to
// `setValue` (or call clearDraft externally) when sending succeeds.
type DraftSetter = (next: string | ((prev: string) => string)) => void;

// Debounce window for the localStorage write. Typing only touches React
// state; the actual setItem is deferred until input pauses for this long.
// Set generously (1s) so a fast typist's brief pauses don't trigger a
// write mid-burst — the write only needs to land before the tab closes /
// the card unmounts, both of which flush explicitly.
const WRITE_DEBOUNCE_MS = 1000;

export function useDraft(
  boardId: string,
  nodeId: string,
): [string, DraftSetter, () => void] {
  const [value, setValue] = useState<string>(() => read(boardId, nodeId));
  // Mirror the latest value in a ref so the sync listener can skip its own
  // broadcasts (and no-ops) without re-subscribing on every keystroke.
  const valueRef = useRef(value);
  valueRef.current = value;
  // Re-hydrate when the (board, node) changes — typical when a parent
  // remounts the textarea for a different node without a full route swap.
  const lastKey = useRef(key(boardId, nodeId));

  // Debounced write state. `write(...)` (a synchronous localStorage.setItem)
  // used to run on every keystroke — fine when localStorage is small, but a
  // long draft against a busy storage area adds visible per-keystroke
  // latency. Now keystrokes only update React state; pendingWrite holds the
  // (board, node, value) the timer will flush once typing pauses.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWrite = useRef<{
    boardId: string;
    nodeId: string;
    value: string;
  } | null>(null);

  // flush lives in a ref so it has a stable identity across renders but
  // always sees the latest refs. Writes the pending value immediately and
  // cancels the timer.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    const pw = pendingWrite.current;
    if (pw) {
      write(pw.boardId, pw.nodeId, pw.value);
      pendingWrite.current = null;
    }
  };

  useEffect(() => {
    const k = key(boardId, nodeId);
    if (lastKey.current !== k) {
      // Switching cards: flush the previous key's pending write before
      // re-hydrating, otherwise the debounce window could drop unsaved text.
      flushRef.current();
      lastKey.current = k;
      setValue(read(boardId, nodeId));
    }
  }, [boardId, nodeId]);

  // The debounce window must not be able to swallow the final edit: flush
  // on unmount and on tab close.
  useEffect(() => {
    const onBeforeUnload = () => flushRef.current();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      flushRef.current();
    };
  }, []);

  // Same-tab live sync: adopt a sibling instance's edit for the same key.
  // The originator's own broadcast is skipped (value already matches its ref).
  useEffect(() => {
    const k = key(boardId, nodeId);
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key: string; value: string };
      if (!detail || detail.key !== k) return;
      if (detail.value === valueRef.current) return;
      valueRef.current = detail.value;
      setValue(detail.value);
    };
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  }, [boardId, nodeId]);

  const update = (next: string | ((prev: string) => string)) => {
    const resolved =
      typeof next === "function" ? next(valueRef.current) : next;
    valueRef.current = resolved;
    setValue(resolved);
    pendingWrite.current = { boardId, nodeId, value: resolved };
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => flushRef.current(), WRITE_DEBOUNCE_MS);
    broadcast(key(boardId, nodeId), resolved);
  };
  const clear = () => {
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    pendingWrite.current = null;
    valueRef.current = "";
    setValue("");
    clearDraft(boardId, nodeId);
    broadcast(key(boardId, nodeId), "");
  };
  return [value, update, clear];
}
