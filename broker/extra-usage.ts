// Validation + staleness for the optional EXTRA usage windows (beyond the
// native 5h / 7d) that a user's statusline setup may supply. dt does not know
// where they come from: each is just { label, pct, resets_at }. Kept free of DB
// imports so it is unit-testable in isolation.

import type { ExtraUsageWindow } from "../shared/types.ts";

export const MAX_EXTRA_WINDOWS = 4;
export const MAX_EXTRA_LABEL_LEN = 16;
// A window without a reset time is assumed to last at most this long after the
// report (the longest native window), then dropped.
const NO_RESET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// resets_at may arrive as unix epoch seconds, epoch milliseconds, or an ISO
// string; normalize to whole SECONDS. Anything else → undefined.
export function normalizeResetsAt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // > 1e12 can only be milliseconds (1e12 s is the year 33658).
    return Math.floor(v > 1e12 ? v / 1000 : v);
  }
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v.trim());
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return undefined;
}

// Validate a raw `extra` payload. Returns:
//   - undefined when the field is absent / not an array (= "no information",
//     so an older snapshot's windows may still be used), or
//   - a cleaned array (possibly EMPTY = "the source says there are none").
// Each entry needs a non-empty string label and a finite 0..100 pct; invalid
// entries are skipped. Labels are trimmed and capped; duplicates (by label)
// keep the first; at most MAX_EXTRA_WINDOWS entries are kept.
export function cleanExtraWindows(v: unknown): ExtraUsageWindow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ExtraUsageWindow[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (out.length >= MAX_EXTRA_WINDOWS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.label !== "string") continue;
    const label = r.label.trim().slice(0, MAX_EXTRA_LABEL_LEN).trim();
    if (!label || seen.has(label)) continue;
    const pct = r.pct;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      continue;
    }
    seen.add(label);
    const resets_at = normalizeResetsAt(r.resets_at);
    out.push(resets_at === undefined ? { label, pct } : { label, pct, resets_at });
  }
  return out;
}

// Drop windows whose reset time has passed (the value no longer applies), and
// windows with no reset time once the report is older than NO_RESET_MAX_AGE_MS.
export function liveExtraWindows(
  windows: ExtraUsageWindow[],
  setAt: string,
  now: number = Date.now(),
): ExtraUsageWindow[] {
  const setAtMs = Date.parse(setAt);
  return windows.filter((w) => {
    if (typeof w.resets_at === "number") return now < w.resets_at * 1000;
    return Number.isFinite(setAtMs) && now < setAtMs + NO_RESET_MAX_AGE_MS;
  });
}
