// Pure, unit-tested height estimate for a thread message, in CSS pixels.
//
// It exists only to SEED `contain-intrinsic-size` for the deep-history chunks
// that carry `content-visibility: auto` (summed per chunk, see threadChunks.ts
// / ThreadRows.tsx). The number is a *placeholder* the browser reserves for a
// chunk it hasn't painted yet; the `auto` keyword in
// `contain-intrinsic-size: auto <est>px` means once a chunk is
// actually rendered the browser REMEMBERS its true size and reuses that from
// then on — so this estimate only matters for the very first reveal of a
// never-yet-seen chunk. Its whole job is to make that first reveal's correction
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
// Fallback wrap width, used only while the thread's real width is unknown
// (before the first measurement, or where ResizeObserver is missing).
// Intentionally narrow so a wide row is over- (never under-) estimated.
export const FALLBACK_CHARS_PER_LINE = 40;
// Assumed width of one Latin character at the thread's 13-14px body font. A
// typical sans-serif averages ~6.5-7px there; rounding UP counts slightly more
// wrapped lines, keeping the estimate on the tall (safe) side.
const LATIN_CHAR_PX = 7.5;
// Horizontal padding of a row (8px 12px on the default board; 6px 10px on
// item cards), subtracted from the measured wrapper width.
const ROW_PADDING_X_PX = 24;
// Never assume fewer than this many characters fit on a line, even in a very
// narrow thread (keeps the estimate from exploding on a tiny pane).
const MIN_CHARS_PER_LINE = 16;
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
// bottom of a thread — the "live region". The newest N rows sit at the visual
// bottom, where the user actively reads and where recoil is most damaging; only
// rows older than that ("deep history", index < length - N in the oldest-first
// list) are grouped into `content-visibility: auto` chunks — and since chunk
// boundaries count from the oldest message, the actual live region is this
// many rows plus up to one chunk's worth (see threadChunks.ts).
//
// 60 is comfortably more than a viewport of recent messages plus a scroll-up
// buffer, so the live edge is always stable; on a 3k-message board it still
// leaves ~2,980 rows contained, capturing essentially all the layout/paint
// savings. Short threads (the usual node card) fall entirely inside it, so
// containment is a no-op there.
export const LIVE_REGION_COUNT = 60;

// Characters (in Latin-character units) that fit on one line of a row whose
// `.thread-rows` wrapper is `contentWidthPx` wide. Without a usable width it
// falls back to FALLBACK_CHARS_PER_LINE.
//
// WHY WIDTH-AWARE (2026-10-14): the content-visibility chunks are sized by the
// SUM of 50 estimates. With the fixed 40-char divisor a 1440px-wide default
// board was overestimated by thousands of px per chunk, so wheeling DOWN into a
// never-rendered chunk (after a jump into deep history) moved the view by up to
// ~9,000px at once when the chunk's real size replaced the estimate.
export function charsPerLineForWidth(contentWidthPx: number | null | undefined): number {
  if (!contentWidthPx || !Number.isFinite(contentWidthPx) || contentWidthPx <= 0)
    return FALLBACK_CHARS_PER_LINE;
  return Math.max(
    MIN_CHARS_PER_LINE,
    Math.floor((contentWidthPx - ROW_PADDING_X_PX) / LATIN_CHAR_PX),
  );
}

// Wide (CJK / fullwidth) characters take about two Latin characters of width.
// Ranges: CJK symbols + kana, CJK ideographs (incl. extension A), Hangul,
// compatibility ideographs, fullwidth forms. Written as escapes on purpose.
const WIDE_CHARS =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

function lineUnits(segment: string): number {
  const wide = segment.match(WIDE_CHARS)?.length ?? 0;
  return segment.length + wide;
}

export function estimateMessageHeight(
  text: string,
  charsPerLine: number = FALLBACK_CHARS_PER_LINE,
): number {
  if (!text) return MIN_PX;
  // Count rendered inline images; each gets a flat vertical allowance.
  const imageCount = (text.match(/!\[/g) ?? []).length;
  // Wrapped-line count: sum per hard-newline segment so explicit line breaks
  // and soft wrapping both add height. Adding characters can only keep or grow
  // each segment's line count, which keeps the whole estimate monotonic in
  // length.
  let lines = 0;
  for (const segment of text.split("\n")) {
    lines += Math.max(1, Math.ceil(lineUnits(segment) / charsPerLine));
  }
  const px = CHROME_PX + lines * LINE_PX + imageCount * IMAGE_PX;
  return Math.min(MAX_PX, Math.max(MIN_PX, px));
}
