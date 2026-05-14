// Per-(board, node) draft persistence for unsent textarea content.
// Each textarea writes to localStorage as the user types so a refresh,
// SPA navigation, or accidental tab close doesn't lose the in-flight
// reply. Cleared once the message ships successfully.

import { useEffect, useRef, useState } from "react";

const PREFIX = "dt-draft";

function key(boardId: string, nodeId: string): string {
  return `${PREFIX}:${boardId}:${nodeId}`;
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
const WRITE_DEBOUNCE_MS = 300;

export function useDraft(
  boardId: string,
  nodeId: string,
): [string, DraftSetter, () => void] {
  const [value, setValue] = useState<string>(() => read(boardId, nodeId));
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

  const update = (next: string | ((prev: string) => string)) => {
    setValue((cur) => {
      const resolved = typeof next === "function" ? next(cur) : next;
      pendingWrite.current = { boardId, nodeId, value: resolved };
      if (writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(
        () => flushRef.current(),
        WRITE_DEBOUNCE_MS,
      );
      return resolved;
    });
  };
  const clear = () => {
    if (writeTimer.current) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    pendingWrite.current = null;
    setValue("");
    clearDraft(boardId, nodeId);
  };
  return [value, update, clear];
}
