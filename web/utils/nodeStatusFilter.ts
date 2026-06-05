// Local-state hook for per-board node status filtering. Mirrors the
// sidebar's BoardStatusFilter shape but at the node level — UI shows
// only items whose status the user has left enabled. State is
// persisted to localStorage under a PER-BOARD key (the board id is
// part of the key) so each board remembers its own filter
// independently. Default is "everything visible" so a board the user
// hasn't filtered yet shows in full.

import { useEffect, useState } from "react";
import { NODE_STATUSES } from "./constants.ts";
import type { NodeStatus } from "../../shared/types.ts";

const LS_PREFIX = "dt-node-status-filter:";
function lsKey(boardId: string): string {
  return LS_PREFIX + boardId;
}

export type NodeStatusFilter = Record<NodeStatus, boolean>;

function defaultFilter(): NodeStatusFilter {
  const out = {} as NodeStatusFilter;
  for (const s of NODE_STATUSES) out[s] = true;
  return out;
}

function readLS(boardId: string): NodeStatusFilter {
  try {
    const raw = localStorage.getItem(lsKey(boardId));
    if (!raw) return defaultFilter();
    const parsed = JSON.parse(raw) as Partial<NodeStatusFilter>;
    const out = defaultFilter();
    for (const s of NODE_STATUSES) {
      if (typeof parsed[s] === "boolean") out[s] = parsed[s] as boolean;
    }
    return out;
  } catch {
    return defaultFilter();
  }
}

function writeLS(boardId: string, value: NodeStatusFilter) {
  try {
    localStorage.setItem(lsKey(boardId), JSON.stringify(value));
  } catch {
    /* private mode etc */
  }
}

// Per-board cache + a single subscriber set. notify() wakes every
// observer; each one re-reads its own board's slice, so a cross-board
// notification is harmless — a page only ever renders one board's
// filter at a time, so the extra re-render is a no-op for everyone
// looking at a different board.
const cachedByBoard = new Map<string, NodeStatusFilter>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function useNodeStatusFilter(
  boardId: string,
): [NodeStatusFilter, (status: NodeStatus, value: boolean) => void, () => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  let cached = cachedByBoard.get(boardId);
  if (!cached) {
    cached = readLS(boardId);
    cachedByBoard.set(boardId, cached);
  }
  const setOne = (status: NodeStatus, value: boolean) => {
    const next = { ...cached!, [status]: value };
    cachedByBoard.set(boardId, next);
    writeLS(boardId, next);
    notify();
  };
  const reset = () => {
    const next = defaultFilter();
    cachedByBoard.set(boardId, next);
    writeLS(boardId, next);
    notify();
  };
  return [cached, setOne, reset];
}

export function isNodeVisible(
  status: NodeStatus,
  filter: NodeStatusFilter,
): boolean {
  return filter[status] !== false;
}
