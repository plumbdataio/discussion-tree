import React, { memo, useEffect, useState } from "react";
import type { ThreadItem } from "../../shared/types.ts";
import { ThreadMessage, sameRenderedThreadItem } from "./ThreadMessage.tsx";
import {
  CV_CHUNK_SIZE,
  estimateChunkHeight,
  planThreadChunks,
} from "../utils/threadChunks.ts";
import { charsPerLineForWidth } from "../utils/estimateMessageHeight.ts";

// @reusable-ui ThreadRows — USE WHEN: rendering a long chat thread's messages
// (oldest -> newest) inside a column-reverse scroller's single `.thread-rows`
// wrapper. INSTEAD OF: mapping ThreadMessage yourself, which renders every row
// fully (slow on thousands of rows) or puts content-visibility on each row
// (a per-frame visibility check per row; ~200ms per keystroke in WebKit on a
// 4,400-message thread). Deep history is grouped into content-visibility
// chunks, the newest rows render normally, and every row stays in the DOM so
// native find-in-page still works. Memoized: a parent re-render that passes
// the same `items` array does no work here.
//
// Renders a fragment — the caller owns the `.thread-rows` wrapper (and appends
// its own pending/tentative rows after this). Chunks must stay children of
// that wrapper, never direct flex items of the column-reverse scroller: there
// a skipped (size-contained) box is flex-shrunk to nothing and the view jumps
// on every pass (see the content-visibility note in style.css).

type RowProps = {
  boardId?: string;
  nodeId?: string;
  sessionId?: string;
  onExpand: (item: ThreadItem) => void;
};

// One content-visibility chunk of deep history. Memoized on the rendered
// content of each item it holds, so a new message elsewhere in the thread does
// not re-render (or re-reconcile 50 rows of) an unchanged chunk.
const ThreadChunk = memo(
  function ThreadChunk({
    items,
    gapPx,
    charsPerLine,
    ...rowProps
  }: RowProps & { items: ThreadItem[]; gapPx: number; charsPerLine: number }) {
    // A width change only re-renders this element with a new estimate (same
    // key, no remount); once the chunk has been rendered the browser's
    // remembered `auto` size wins over this value anyway.
    const est = estimateChunkHeight(
      items.map((it) => it.text),
      gapPx,
      charsPerLine,
    );
    return (
      <div
        className="thread-chunk"
        style={{ containIntrinsicSize: `auto ${est}px` }}
      >
        {items.map((it) => (
          <ThreadMessage key={it.id} item={it} {...rowProps} />
        ))}
      </div>
    );
  },
  (a, b) =>
    a.gapPx === b.gapPx &&
    a.charsPerLine === b.charsPerLine &&
    a.boardId === b.boardId &&
    a.nodeId === b.nodeId &&
    a.sessionId === b.sessionId &&
    a.onExpand === b.onExpand &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => sameRenderedThreadItem(it, b.items[i])),
);

// Characters per line for the chunk estimates, from the `.thread-rows`
// wrapper's real width: measured once mounted and again on every resize.
// State only changes when the rounded value does, so a resize that keeps the
// same chars-per-line re-renders nothing. A passive effect on purpose: the
// wrapper is this component's PARENT, whose ref is attached only after the
// children's layout effects have run (a layout effect here saw null and never
// measured). The first frame uses the fallback; chunks then re-render with the
// new estimate only (same keys, no remount) — they are off-screen history, and
// under column-reverse a size change above the viewport does not move it.
function useCharsPerLine(rowsRef?: React.RefObject<HTMLElement | null>): number {
  const [cpl, setCpl] = useState(() => charsPerLineForWidth(null));
  useEffect(() => {
    const el = rowsRef?.current;
    if (!el) return;
    const update = () => setCpl(charsPerLineForWidth(el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowsRef]);
  return cpl;
}

function ThreadRowsImpl({
  items,
  gapPx,
  rowsRef,
  ...rowProps
}: RowProps & {
  items: ThreadItem[];
  // The `.thread-rows` flex gap (px) of the caller's layout; only feeds the
  // never-rendered chunk height estimate.
  gapPx: number;
  // The caller's `.thread-rows` wrapper; its width makes the chunk estimates
  // width-aware. Omitted, a narrow fallback wrap width is assumed.
  rowsRef?: React.RefObject<HTMLElement | null>;
}) {
  const charsPerLine = useCharsPerLine(rowsRef);
  const { chunkCount, liveStart } = planThreadChunks(items.length);
  const chunks: React.ReactNode[] = [];
  for (let k = 0; k < chunkCount; k++) {
    chunks.push(
      <ThreadChunk
        // Index key: chunk k always holds the same messages (boundaries count
        // from the oldest), so its element — and the size the browser
        // remembered for it — survives new messages arriving.
        key={`chunk-${k}`}
        items={items.slice(k * CV_CHUNK_SIZE, (k + 1) * CV_CHUNK_SIZE)}
        gapPx={gapPx}
        charsPerLine={charsPerLine}
        {...rowProps}
      />,
    );
  }
  return (
    <>
      {chunks}
      {items.slice(liveStart).map((it) => (
        <ThreadMessage key={it.id} item={it} {...rowProps} />
      ))}
    </>
  );
}

export const ThreadRows = memo(ThreadRowsImpl);
