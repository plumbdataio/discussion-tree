// Pure, unit-tested height estimate for a thread message, in CSS pixels.
//
// It exists only to SEED `contain-intrinsic-size` for deep-history rows that
// carry `content-visibility: auto` (see ThreadMessage `contained`). The number
// is a *placeholder* the browser reserves for a row it hasn't painted yet; the
// `auto` keyword in `contain-intrinsic-size: auto <est>px` means once a row is
// actually rendered the browser REMEMBERS its true size and reuses that from
// then on — so this estimate only matters for the very first reveal of a
// never-yet-seen row. Its whole job is to make that first reveal's correction
// SMALL (a nudge, not a 100px->800px jump), and — crucially under
// column-reverse — to err slightly TALL rather than short: a short estimate is
// what shoves later content up into the reader's eyes ("recoil"). An
// overestimate instead settles content downward (away from the eye), the
// harmless direction.
//
// Deliberately conservative-tall: a narrow chars-per-line divisor over-counts
// wrapped lines, and inline images (which render far taller than their markdown
// source) get a flat allowance.

// ~14px body font at line-height 1.5 = 21px; rounded up.
const LINE_PX = 22;
// Author label line (~18px) + vertical padding (~16px) + a small fudge.
const CHROME_PX = 42;
// Intentionally narrow so a wide row is over- (never under-) estimated. The
// default board thread is far wider than 40 chars, so this over-counts lines
// on purpose — the safe direction under column-reverse.
const CHARS_PER_LINE = 40;
// A rendered inline image (`![...](...)`) is much taller than its one line of
// markdown source. Reserve a flat block per image so a history image doesn't
// recoil on first reveal.
const IMAGE_PX = 220;
// Floor: even an empty/one-word row occupies chrome + one line.
const MIN_PX = 52;
// Ceiling: a sanity cap against a pathological multi-KB paste reserving absurd
// scroll space. Set generously so realistic messages are estimated accurately
// and only truly abnormal strings clamp (clamping caps the estimate BELOW real
// height, the recoil-prone direction, so we keep the ceiling high).
const MAX_PX = 4000;

// How many of the newest rows stay FULLY rendered (no containment) at the
// bottom of a thread — the "live region". Under column-reverse the reversed
// list's indices 0..N-1 are the newest rows and sit at the visual bottom, where
// the user actively reads and where recoil is most damaging; only rows at index
// >= this threshold ("deep history") get `content-visibility: auto`.
//
// 60 is comfortably more than a viewport of recent messages plus a scroll-up
// buffer, so the live edge is always stable; on a 3k-message board it still
// leaves ~2,980 rows contained, capturing essentially all the layout/paint
// savings. Short threads (the usual node card) fall entirely inside it, so
// containment is a no-op there.
export const LIVE_REGION_COUNT = 60;

export function estimateMessageHeight(text: string): number {
  if (!text) return MIN_PX;
  // Count rendered inline images; each gets a flat vertical allowance.
  const imageCount = (text.match(/!\[/g) ?? []).length;
  // Wrapped-line count: sum per hard-newline segment so explicit line breaks
  // and soft wrapping both add height. Adding characters can only keep or grow
  // each segment's line count, which keeps the whole estimate monotonic in
  // length.
  let lines = 0;
  for (const segment of text.split("\n")) {
    lines += Math.max(1, Math.ceil(segment.length / CHARS_PER_LINE));
  }
  const px = CHROME_PX + lines * LINE_PX + imageCount * IMAGE_PX;
  return Math.min(MAX_PX, Math.max(MIN_PX, px));
}
