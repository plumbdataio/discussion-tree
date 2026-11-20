import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isScrolledToBottom } from "../utils/useSnapToBottom.ts";

// Renders a small floating ▼ button bottom-right of the given scroll
// container WHEN the user is not already at the bottom. Click jumps to
// the latest message. Re-evaluates on scroll, on container resize, and
// on every immediate child resize so newly-arrived markdown / image
// content also flips the button on.
//
// `reversed` flips the coordinate convention for callers whose scroll
// container is laid out with `flex-direction: column-reverse` (e.g. the
// default board): the visual bottom of the column is scrollTop == 0,
// and scrolling up *increases* scrollTop. The button still says "go to
// the latest message," it just measures and jumps the other way.
//
// `itemCount` (the thread's row count): when it grows while the user is
// scrolled up, the thread does NOT jump (useSnapToBottom's followCount
// holds it); instead this button blinks once and keeps the same thick warm
// border an unread card has, until the user reaches the bottom.
function ScrollToBottomButtonImpl({
  scrollRef,
  reversed = false,
  itemCount,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  reversed?: boolean;
  itemCount?: number;
}) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const [blinkKey, setBlinkKey] = useState(0);
  const prevCountRef = useRef(itemCount);

  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = itemCount;
    if (itemCount == null || prev == null || itemCount <= prev) return;
    // `show` is the state from BEFORE the new rows: the user was reading
    // further up, so tell them something arrived below.
    if (!show) return;
    setHasNew(true);
    setBlinkKey((k) => k + 1);
  }, [itemCount]);

  useEffect(() => {
    if (!show) setHasNew(false);
  }, [show]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      // Hide once the latest message is at least partially in view.
      // ~100px slack: as soon as the entry starts peeking in, the
      // button hides so it doesn't fake a "more below" hint while the
      // user is reading the last entry.
      //
      // For `reversed`, scrollTop semantics under flex-direction:
      // column-reverse vary across engines — Chrome/Safari keep
      // scrollTop = 0 at the visual bottom and grow positive as the
      // user scrolls up, while Firefox uses negative values for the
      // same direction. Math.abs lets the single check work either
      // way: "near the visual bottom" iff |scrollTop| is small.
      const atBottom = isScrolledToBottom(el, reversed);
      setShow((cur) => (cur === !atBottom ? cur : !atBottom));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [scrollRef, reversed]);

  if (!show) return null;
  return (
    <button
      // Remount on each arrival so the blink animation replays.
      key={blinkKey}
      type="button"
      className={`scroll-to-bottom${reversed ? " is-reversed" : ""}${
        hasNew ? " has-new" : ""
      }`}
      aria-label={t("scroll.to_bottom")}
      title={t("scroll.to_bottom_short")}
      onClick={() => {
        const el = scrollRef.current;
        if (!el) return;
        // Reversed coords: bottom = 0. Non-reversed: bottom = scrollHeight.
        el.scrollTop = reversed ? 0 : el.scrollHeight;
      }}
    >
      <ChevronDown size={16} strokeWidth={2} />
    </button>
  );
}

// Memoized: scrollRef is a stable useRef on the caller side, so this
// component never needs to re-render just because the parent did
// (e.g. on every textarea keystroke).
export const ScrollToBottomButton = React.memo(ScrollToBottomButtonImpl);
