// How long the node this message landed on had been silent.
//
// CC has no clock: the only time it sees is the `sent_at` on each channel
// message, and reading two of them to subtract is not something it does
// unprompted. So a reply that arrives after a three-hour break is answered with
// the context of three hours ago — the thread has moved on, the working state
// is stale, and nothing on the message says so.
//
// Reported only when the silence is long enough to change how the message
// should be handled. A `since_last_message` on every message would be a value
// that is almost always "40s", and a field that is nearly always noise stops
// being read — the same reason the connection banner waits before speaking.

/** Below this, the gap is just the rhythm of a conversation. */
export const GAP_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Human-shaped, coarse on purpose: "4h" and "4h12m" lead to the same decision,
 * and the number is a cue to re-read, not a measurement.
 */
export function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * The gap to report for a message, or null when there is nothing worth saying:
 * no previous message on this node, an unparseable timestamp, or a silence
 * shorter than the threshold.
 *
 * `now` is injected so this is testable without freezing the clock.
 */
export function gapSince(
  prevMessageAt: unknown,
  sentAt: unknown,
  thresholdMs: number = GAP_THRESHOLD_MS,
): string | null {
  if (typeof prevMessageAt !== "string" || typeof sentAt !== "string") {
    return null;
  }
  const prev = Date.parse(prevMessageAt);
  const now = Date.parse(sentAt);
  if (!Number.isFinite(prev) || !Number.isFinite(now)) return null;
  const ms = now - prev;
  if (ms < thresholdMs) return null;
  return formatGap(ms);
}
