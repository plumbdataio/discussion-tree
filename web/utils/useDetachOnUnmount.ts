import { useLayoutEffect } from "react";
import type { RefObject } from "react";

// @reusable-ui useDetachOnUnmount — USE WHEN a component renders a LARGE
// container (a long thread, a big list) in the same subtree as a text input,
// pass the container's ref. INSTEAD OF: letting React drop the subtree as one
// piece, which lets the browser keep all of it alive after you navigate away.
//
// WHY: Chrome's AutofillAgent holds a strong reference to the last text field
// the user typed in (seen in a heap snapshot 2026-10-16: the detached composer
// textarea retained via "autofill::AutofillAgent", a C++ persistent root).
// After a navigation that textarea is detached, but its parent pointers still
// reach the whole old page: on the 4,600-message default board that was ~197k
// DOM nodes plus every React fiber / ThreadItem hanging off them (~24MB of JS
// heap, ~100MB of renderer memory), kept until the user typed in another
// field. Emptying the big container on unmount cuts it off from the retained
// textarea, so only the small remainder (composer, header) can stay alive.
//
// Safe with React: when a subtree is deleted React removes only the TOPMOST
// DOM node of that subtree from its parent; it never touches the nested
// children again, so emptying a nested container ourselves (in a layout-effect
// cleanup, which runs during that same deletion) does not conflict with it.
// Never pass the ref of the component's own root element.
export function useDetachOnUnmount(
  ref: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const atMount = ref.current;
    return () => {
      // ref.current first: the container may mount after this component did
      // (e.g. once data loads). A component's layout cleanup runs before React
      // detaches its descendants' refs, so it is still set here.
      (ref.current ?? atMount)?.replaceChildren();
    };
  }, [ref]);
}
