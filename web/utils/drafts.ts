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

export function useDraft(
  boardId: string,
  nodeId: string,
): [string, DraftSetter, () => void] {
  const [value, setValue] = useState<string>(() => read(boardId, nodeId));
  // Re-hydrate when the (board, node) changes — typical when a parent
  // remounts the textarea for a different node without a full route swap.
  const lastKey = useRef(key(boardId, nodeId));
  useEffect(() => {
    const k = key(boardId, nodeId);
    if (lastKey.current !== k) {
      lastKey.current = k;
      setValue(read(boardId, nodeId));
    }
  }, [boardId, nodeId]);

  const update = (next: string | ((prev: string) => string)) => {
    setValue((cur) => {
      const resolved = typeof next === "function" ? next(cur) : next;
      write(boardId, nodeId, resolved);
      return resolved;
    });
  };
  const clear = () => {
    setValue("");
    clearDraft(boardId, nodeId);
  };
  return [value, update, clear];
}
