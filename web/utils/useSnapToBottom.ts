import type { DependencyList, RefObject } from "react";
import { useEffect } from "react";

// Snap a scroll container to its visual bottom and re-snap a few
// times across the first ~600ms so that content-visibility:auto
// placeholders, image / font hydration, and the browser's own
// scroll-restoration heuristic can't strand us mid-thread on mount.
//
// `reversed` flips the snap mechanism for containers laid out with
// `flex-direction: column-reverse`: we can't just write
// `scrollTop = …` there because the two scrollTop conventions
// (zero-at-bottom on some engines, zero-at-top on others) make the
// assignment unreliable. scrollIntoView({block:"end"}) on the first
// DOM child — which is the visual bottom under column-reverse —
// expresses the intent semantics-free.
//
// `deps` is the dependency list passed through to useEffect: pass
// `[]` for "mount only", or e.g. `[sortDir]` to re-snap when the
// caller wants a re-anchor (anchor-list modal flips sort direction
// and wants the new bottom — or top — in view).
//
// `to` picks which end to anchor against. "end" (default) lands at
// the visual bottom — that's the chat use case. "start" jumps to
// the visual top — useful for list views like an anchor-list modal
// sorted newest-first.
//
// `followOnNew` is a SECOND dependency list for the "auto-follow
// new content if user is already at bottom" behaviour. Pass the
// thread-length dependency here (e.g. `[myThread.length]`) and
// every time it changes the hook will re-snap to the visual bottom
// IF the user is currently near it, otherwise it leaves the user
// alone (so scroll-up-to-read-history is preserved). The deps and
// followOnNew effects are independent so callers can pick either /
// both / neither. This is the chat-app convention — Chrome's
// scroll-anchoring sometimes refuses to follow new content even
// when the user is glued to the bottom, so we hand-roll the follow.
export function useSnapToBottom(
  ref: RefObject<HTMLElement | null>,
  opts: {
    reversed?: boolean;
    to?: "end" | "start";
    deps?: DependencyList;
    followOnNew?: DependencyList;
  } = {},
) {
  const {
    reversed = false,
    to = "end",
    deps = [],
    followOnNew,
  } = opts;
  const snap = () => {
    const el = ref.current;
    if (!el) return;
    if (to === "start") {
      // Visual top under both conventions. column-reverse keeps the
      // origin at the layout top, which is the visually-oldest
      // element under reverse; either way scrollTop = 0 means
      // "show whatever the list calls the start."
      el.scrollTop = 0;
    } else if (reversed) {
      // column-reverse + "end": the first DOM child is the visual
      // bottom; align it to the viewport's end edge regardless of
      // whatever scrollTop convention the engine picked for the
      // reversed flex column.
      const first = el.firstElementChild as HTMLElement | null;
      first?.scrollIntoView({ block: "end" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    snap();
    const raf = requestAnimationFrame(snap);
    const t1 = window.setTimeout(snap, 100);
    const t2 = window.setTimeout(snap, 300);
    const t3 = window.setTimeout(snap, 600);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, deps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!followOnNew) return;
    const el = ref.current;
    if (!el) return;
    // "near bottom" guard so a user who scrolled up to read history
    // isn't yanked back when new messages arrive.
    const nearBottom = reversed
      ? Math.abs(el.scrollTop) <= 100
      : el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
    if (!nearBottom) return;
    snap();
  }, followOnNew ?? []);
}
