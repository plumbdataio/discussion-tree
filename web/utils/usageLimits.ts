// Shared client-side state for the account-global native usage limits —
// Claude's 5h / 7d subscription rate-limit windows, surfaced on the Claude
// Code statusline. These numbers are account-wide (identical across every
// session), so exactly ONE place polls them — the Sidebar, from its
// /api/sessions fetch — and pushes them here via setSharedUsageLimits; any
// header reads the single shared value with useUsageLimits() instead of
// running its own fetch.
import { useSyncExternalStore } from "react";
import type { UsageLimits } from "../../shared/types.ts";

type Listener = () => void;

let current: UsageLimits | null = null;
const listeners = new Set<Listener>();

// Only the four displayed fields matter. When none changed we keep the same
// object reference and skip notifying, so useSyncExternalStore subscribers
// don't re-render on a poll that returned identical numbers.
function sameLimits(a: UsageLimits | null, b: UsageLimits | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.five_hour_pct === b.five_hour_pct &&
    a.seven_day_pct === b.seven_day_pct &&
    a.five_hour_resets_at === b.five_hour_resets_at &&
    a.seven_day_resets_at === b.seven_day_resets_at
  );
}

// Called by the Sidebar on every successful /api/sessions poll.
export function setSharedUsageLimits(limits: UsageLimits | null): void {
  if (sameLimits(current, limits)) return;
  current = limits;
  for (const l of listeners) l();
}

export function getSharedUsageLimits(): UsageLimits | null {
  return current;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// React hook: a header re-renders when the account-global limits change,
// reading the single shared value rather than fetching its own.
export function useUsageLimits(): UsageLimits | null {
  return useSyncExternalStore(
    subscribe,
    getSharedUsageLimits,
    getSharedUsageLimits,
  );
}
