import type { DependencyList, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

// Snap a scroll container to its end (or start) on mount and whenever
// `deps` change. That is ALL the JavaScript the chat surfaces need.
//
// The hard parts — keeping the bottom pinned as new messages arrive,
// and leaving the user alone when they've scrolled up to read history
// — are handled purely by `flex-direction: column-reverse` in CSS.
// Under column-reverse the scroll origin sits at the visual bottom, so
// a freshly-prepended newest message grows the list upward without
// moving the viewport while the user is at the bottom, and doesn't
// touch their position once they've scrolled away from it. No JS
// chase loop, no scroll-event bookkeeping, no engine-specific follow
// heuristics — the layout does it.
//
// This hook only covers what CSS can't: the initial mount position,
// and an explicit re-snap when `deps` change (e.g. the user sends a
// message while scrolled up and we want their own post in view).
//
//   to        "end" (default) = visual bottom (chat); "start" =
//             visual top (list views, e.g. anchor-list newest-first).
//   reversed  selects the bottom-pinning mechanism for column-reverse
//             containers — scrollIntoView on the first DOM child is
//             the only convention-free way to reach the visual bottom
//             when engines disagree on what scrollTop means under
//             column-reverse.
//   followCount  the number of rows in the thread. When it grows, the
//             new rows are followed ONLY if the user was already at the
//             bottom; if they had scrolled up to read, the rows they were
//             looking at are held exactly where they were (the ▼ button
//             lights up instead — see ScrollToBottomButton's itemCount).
//             Jumping a reader away from an older message to show a new
//             one was the complaint this exists for.
//
// Distance (px) from the newest message that still counts as "at the
// bottom". Shared with ScrollToBottomButton so both agree on the state.
export const AT_BOTTOM_SLACK_PX = 100;

export function isScrolledToBottom(el: HTMLElement, reversed: boolean): boolean {
  // Under column-reverse engines disagree on the sign of scrollTop at the
  // visual bottom's far side; |scrollTop| small == near the visual bottom.
  return reversed
    ? Math.abs(el.scrollTop) <= AT_BOTTOM_SLACK_PX
    : el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_SLACK_PX;
}

// Offset of the content's top edge inside the scroll viewport. Comparing it
// before and after new rows render tells how far the visible rows moved.
function contentTop(el: HTMLElement): number | null {
  const c = el.firstElementChild as HTMLElement | null;
  if (!c) return null;
  return c.getBoundingClientRect().top - el.getBoundingClientRect().top;
}

export function useSnapToBottom(
  ref: RefObject<HTMLElement | null>,
  opts: {
    reversed?: boolean;
    to?: "end" | "start";
    deps?: DependencyList;
    // When false the snap is skipped entirely — e.g. a modal that opens
    // scrolled to a specific message instead of the bottom.
    enabled?: boolean;
    followCount?: number;
  } = {},
) {
  const {
    reversed = false,
    to = "end",
    deps = [],
    enabled = true,
    followCount,
  } = opts;
  const atBottomRef = useRef(true);
  const countRef = useRef(followCount);
  const prevTopRef = useRef<number | null>(null);
  // Render phase: the DOM still shows the OLD rows here, so this is the one
  // place the reader's position before the new rows can be measured.
  if (followCount !== countRef.current && prevTopRef.current == null) {
    const el = ref.current;
    prevTopRef.current = el ? contentTop(el) : null;
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = isScrolledToBottom(el, reversed);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref, reversed]);

  useLayoutEffect(() => {
    if (followCount === countRef.current) return;
    const grew = (followCount ?? 0) > (countRef.current ?? 0);
    countRef.current = followCount;
    const prevTop = prevTopRef.current;
    prevTopRef.current = null;
    const el = ref.current;
    if (!el || !grew) return;
    if (atBottomRef.current) {
      // Column-reverse keeps the bottom pinned by itself.
      if (!reversed) el.scrollTop = el.scrollHeight;
      return;
    }
    if (prevTop == null) return;
    const now = contentTop(el);
    if (now == null) return;
    const moved = now - prevTop;
    if (Math.abs(moved) < 1) return;
    // Scroll back by the amount the rows moved. The sign convention of
    // scrollTop differs between engines under column-reverse, so try one
    // direction and flip if it made things worse.
    const before = el.scrollTop;
    el.scrollTop = before + moved;
    const after = contentTop(el);
    if (after != null && Math.abs(after - prevTop) > Math.abs(moved) / 2) {
      el.scrollTop = before - moved;
    }
  }, [followCount]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const snap = () => {
      if (to === "start") {
        el.scrollTop = 0;
      } else if (reversed) {
        const first = el.firstElementChild as HTMLElement | null;
        first?.scrollIntoView({ block: "end" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    };
    snap();
    // One more pass after layout settles so late image / font
    // hydration that grows a row doesn't leave us a few pixels short.
    const raf = requestAnimationFrame(snap);
    return () => cancelAnimationFrame(raf);
  }, deps);
}

// Id of the newest row the user posted themselves. Surfaces without a
// "sending…" placeholder put it in `deps` so the user's own post is brought
// into view even when they were scrolled up (others' posts are not).
export function lastOwnItemId(
  items: readonly { id: number; source: string }[],
): number | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.source === "user") return items[i]!.id;
  }
  return null;
}
