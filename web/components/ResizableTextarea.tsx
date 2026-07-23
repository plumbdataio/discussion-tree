import React, { forwardRef, useRef } from "react";

// Chat composer textarea with a custom TOP-RIGHT resize handle (native resize is
// disabled). Two reasons the handle is at the top-right, not the browser default
// bottom-right:
//  - the composer usually sits at the bottom of the screen, so a bottom handle
//    has almost no room to drag into; a top-right handle grows the box UPWARD.
//  - the drag uses pointer capture, so it keeps tracking even when the cursor
//    leaves the box — which also stops a drag that strays outside an enclosing
//    preview modal from registering as a backdrop click and closing it.

// @reusable-ui ResizableTextarea — USE WHEN: any chat / multi-line text
//   composer. INSTEAD OF a raw <textarea>: adds the custom top-right resize
//   handle (native grip off) + pointer-capture drag. Drop-in — forwards all
//   <textarea> props and the ref.
const MIN_H = 60;
const MAX_H = 600;

export const ResizableTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function ResizableTextarea({ className, ...props }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref)
      (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
  };

  const onHandleDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    const ta = innerRef.current;
    if (!ta) return;
    const startY = e.clientY;
    const startH = ta.offsetHeight;
    const handle = e.currentTarget;
    // Capture so every subsequent pointer event goes to the handle — the drag
    // survives the cursor leaving the box, and the release can't land on (and
    // dismiss) a modal backdrop underneath.
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      // Dragging UP (clientY decreases) grows the box; it's bottom-anchored in
      // the composer, so the added height appears above the caret.
      const next = Math.max(
        MIN_H,
        Math.min(MAX_H, startH + (startY - ev.clientY)),
      );
      ta.style.height = `${next}px`;
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <span className="answer-input-wrap">
      <textarea ref={setRef} className={className} {...props} />
      <span
        className="answer-resize-handle"
        aria-hidden="true"
        onPointerDown={onHandleDown}
      />
    </span>
  );
});
