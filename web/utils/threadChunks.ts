// Pure, unit-tested plan for how a long chat thread is split into
// content-visibility chunks (see ThreadRows.tsx for the rendering side).
//
// WHY CHUNKS, NOT ROWS: `content-visibility: auto` makes the browser decide,
// on EVERY rendering update, whether each such element is near the viewport.
// With the property on every deep-history row, a 4,400-message thread meant
// ~4,350 visibility checks per frame — and typing in the composer produces a
// frame per keystroke. Measured 2026-10-14 on that thread (bd_vlap7p27):
// WebKit ~200ms per keystroke (an iPhone SE2 ~0.5s), Chromium at 6x CPU
// throttle spent ~52ms in the visibility (intersection) step alone. Grouping
// the same rows into chunks of CV_CHUNK_SIZE and putting the property on the
// CHUNK cuts the number of checked elements by that factor (WebKit 200ms ->
// 30ms, Chromium 52ms -> 2ms in the prototype) while still skipping layout +
// paint for everything off-screen. Every row stays in the DOM (native Ctrl+F
// must keep finding old messages — DOM removal / virtualization was rejected).
//
// BOUNDARIES COUNT FROM THE OLDEST MESSAGE: chunk k always holds messages
// [k*N, (k+1)*N). Appending new messages therefore never moves an existing
// boundary, so an already-rendered chunk keeps its remembered size
// (`contain-intrinsic-size: auto`) and its React subtree. The live region (the
// newest rows, rendered with no containment at all) starts at the first chunk
// boundary that leaves at least LIVE_REGION_COUNT rows below it, so it holds
// between LIVE_REGION_COUNT and LIVE_REGION_COUNT + N - 1 rows; once enough new
// messages arrive, its oldest N rows become a new, complete chunk.

import { LIVE_REGION_COUNT, estimateMessageHeight } from "./estimateMessageHeight.ts";

// Rows per content-visibility chunk. 50 keeps a chunk around a few screens
// tall (so revealing one is cheap) while dividing the per-frame visibility
// checks by 50; 200 measured no better in WebKit.
export const CV_CHUNK_SIZE = 50;

export interface ThreadChunkPlan {
  // Number of full chunks; chunk k covers rows [k*chunkSize, (k+1)*chunkSize).
  chunkCount: number;
  // Index of the first live-region row (== chunkCount * chunkSize).
  liveStart: number;
}

export function planThreadChunks(
  length: number,
  liveCount: number = LIVE_REGION_COUNT,
  chunkSize: number = CV_CHUNK_SIZE,
): ThreadChunkPlan {
  const deep = Math.max(0, length - liveCount);
  const chunkCount = Math.floor(deep / chunkSize);
  return { chunkCount, liveStart: chunkCount * chunkSize };
}

// Seed for a chunk's `contain-intrinsic-size: auto <px>`: the per-message
// estimates (which err tall on purpose, see estimateMessageHeight.ts) plus the
// flex gaps between the rows. Only used until the chunk is first rendered;
// after that the browser remembers its real height.
// `charsPerLine` comes from the thread's measured width
// (charsPerLineForWidth); omitted, the narrow fallback applies.
export function estimateChunkHeight(
  texts: string[],
  gapPx: number,
  charsPerLine?: number,
): number {
  let px = 0;
  for (const text of texts) px += estimateMessageHeight(text, charsPerLine);
  return px + Math.max(0, texts.length - 1) * gapPx;
}
