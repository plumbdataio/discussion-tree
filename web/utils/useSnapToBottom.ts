import type { DependencyList, RefObject } from "react";
import { useEffect } from "react";

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
export function useSnapToBottom(
  ref: RefObject<HTMLElement | null>,
  opts: { reversed?: boolean; to?: "end" | "start"; deps?: DependencyList } = {},
) {
  const { reversed = false, to = "end", deps = [] } = opts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
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
