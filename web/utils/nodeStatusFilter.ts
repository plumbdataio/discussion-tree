// Local-state hook for per-board node status filtering. Mirrors the
// sidebar's BoardStatusFilter shape but at the node level — UI shows
// only items whose status the user has left enabled. State is
// persisted to localStorage under a single key shared across all
// boards so the user's filter selection follows them around. Default
// is "everything visible" so a first-time user sees the full board.

import { useEffect, useState } from "react";
import { NODE_STATUSES } from "./constants.ts";
import type { NodeStatus } from "../../shared/types.ts";

const LS_KEY = "dt-node-status-filter";

export type NodeStatusFilter = Record<NodeStatus, boolean>;

function defaultFilter(): NodeStatusFilter {
  const out = {} as NodeStatusFilter;
  for (const s of NODE_STATUSES) out[s] = true;
  return out;
}

function readLS(): NodeStatusFilter {
  try {
    const raw = localStorage.getItem(LS_KEY);
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

function writeLS(value: NodeStatusFilter) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(value));
  } catch {
    /* private mode etc */
  }
}

// Single-tab subscriber set so the toggle in the header and any other
// observer (concerns layout) stay in sync without prop drilling.
const listeners = new Set<() => void>();
let cached: NodeStatusFilter | null = null;

function notify() {
  for (const l of listeners) l();
}

export function useNodeStatusFilter(): [
  NodeStatusFilter,
  (status: NodeStatus, value: boolean) => void,
  () => void,
] {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  if (!cached) cached = readLS();
  const setOne = (status: NodeStatus, value: boolean) => {
    cached = { ...cached!, [status]: value };
    writeLS(cached);
    notify();
  };
  const reset = () => {
    cached = defaultFilter();
    writeLS(cached);
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
