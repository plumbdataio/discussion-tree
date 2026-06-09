import React, { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

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
function ScrollToBottomButtonImpl({
  scrollRef,
  reversed = false,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  reversed?: boolean;
}) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);

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
      const atBottom = reversed
        ? Math.abs(el.scrollTop) <= 100
        : el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
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
      type="button"
      className={`scroll-to-bottom${reversed ? " is-reversed" : ""}`}
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
