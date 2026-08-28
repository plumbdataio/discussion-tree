// Module-level store of intrinsic image dimensions keyed by image URL, fed by
// each board's `image_dims` payload (see broker/helpers.ts::collectImageDims).
//
// Why a plain module store rather than a prop on MDView: MDView is memoized on
// `text` alone, deliberately — a prop that changed per parent render would
// re-parse every message's markdown on every keystroke (a measured 250ms+ perf
// bug). The <img> renderer reads dims from here at render time instead, so no
// new prop is needed and the text-only memo is preserved. Dims arrive from the
// board load BEFORE the thread renders, so they're present at first paint.
//
// Keys are full `/uploads/<board_id>/<file>` URLs, which already namespace by
// board, and uploads are immutable — so entries never collide and never need
// eviction. Merge-in only; the store only ever grows within a session.

import type { ImageDims } from "../../shared/types.ts";

const store = new Map<string, ImageDims>();

export function setImageDims(
  dims: Record<string, ImageDims> | undefined | null,
): void {
  if (!dims) return;
  for (const url in dims) {
    const d = dims[url];
    if (d && typeof d.w === "number" && typeof d.h === "number") {
      store.set(url, d);
    }
  }
}

export function getImageDims(url: string | undefined): ImageDims | undefined {
  if (!url) return undefined;
  return store.get(url);
}
