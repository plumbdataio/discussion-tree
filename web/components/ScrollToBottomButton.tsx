import React, { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

// Renders a small floating ▼ button bottom-right of the given scroll
// container WHEN the user is not already at the bottom. Click jumps to
// the latest message. Re-evaluates on scroll, on container resize, and
// on every immediate child resize so newly-arrived markdown / image
// content also flips the button on.
function ScrollToBottomButtonImpl({
  scrollRef,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      // Hide once the last message is at least partially in view. Empirically
      // ~100px below the viewport bottom is when the latest message's first
      // line starts to peek in; further down would risk hinting "there's more"
      // when actually the user has already started reading the last entry.
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
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
  }, [scrollRef]);

  if (!show) return null;
  return (
    <button
      type="button"
      className="scroll-to-bottom"
      aria-label="一番下までスクロール"
      title="一番下まで"
      onClick={() => {
        const el = scrollRef.current;
        if (!el) return;
        // content-visibility:auto means off-screen rows render with a
        // 100px intrinsic-size placeholder; jumping to the bottom in
        // one go only reaches the bottom of that placeholder height.
        // As the rows about to enter the viewport hydrate they grow
        // and the real bottom drifts down. Re-pin a few times across
        // the next ~400ms so the user sees a single smooth jump.
        const pin = () => {
          // 1e9, not Number.MAX_SAFE_INTEGER: iOS Safari clamps scrollTop
          // through an i32 path and snaps 2^53 back to 0, sending the user
          // to the very top instead of the bottom. 1e9 stays inside int32
          // and is bigger than any realistic scrollHeight.
          el.scrollTop = 1e9;
        };
        pin();
        requestAnimationFrame(() => {
          pin();
          requestAnimationFrame(pin);
        });
        setTimeout(pin, 100);
        setTimeout(pin, 300);
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
