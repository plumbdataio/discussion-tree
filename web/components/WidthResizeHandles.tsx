import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_MIN_WIDTH,
  clampWidth,
  loadWidth,
  saveWidth,
  widthAfterDrag,
} from "../utils/resizableWidth.ts";

// @reusable-ui WidthResizeHandles — USE WHEN: a horizontally centered panel or
//   modal (e.g. the thread preview) should let the user drag its LEFT / RIGHT
//   edges to change its width on desktop, remembered per viewer.
//   INSTEAD OF hand-rolling edge drag handles + width state. Drop it in as a
//   direct child of the element to resize; that parent must be
//   `position: relative` (any .modal-content is). Both edges move together
//   (the element stays centered), double-click a handle resets to the CSS
//   default width, and at phone width (<= 768px) the handles are hidden and
//   the CSS layout applies unchanged. The width is applied as the CSS variable
//   --resizable-w + attribute [data-width-resized] on the parent (style.css),
//   imperatively, so dragging never re-renders the parent's (possibly huge)
//   content.

const ATTR = "data-width-resized";
const VAR = "--resizable-w";

function applyWidth(target: HTMLElement, width: number | null) {
  if (width == null) {
    target.removeAttribute(ATTR);
    target.style.removeProperty(VAR);
  } else {
    target.setAttribute(ATTR, "");
    target.style.setProperty(VAR, `${width}px`);
  }
}

export function WidthResizeHandles({
  storageKey,
  minWidth = DEFAULT_MIN_WIDTH,
}: {
  // localStorage key the chosen width is kept under. Surfaces that are the
  // same kind of panel should share one key so they open at the same width.
  storageKey: string;
  minWidth?: number;
}) {
  const { t } = useTranslation();
  const leftRef = useRef<HTMLSpanElement>(null);
  // The user's chosen width (unclamped by later window resizes, so it comes
  // back when the window grows again); null = CSS default width.
  const chosenRef = useRef<number | null>(null);

  const target = () => leftRef.current?.parentElement ?? null;

  // Restore before paint so the modal doesn't flash at the default width.
  useLayoutEffect(() => {
    const el = target();
    if (!el) return;
    chosenRef.current = loadWidth(storageKey);
    if (chosenRef.current != null) {
      applyWidth(el, clampWidth(chosenRef.current, window.innerWidth, minWidth));
    }
    return () => applyWidth(el, null);
  }, [storageKey, minWidth]);

  // Re-clamp to the new viewport on window resize (the stored choice is kept).
  useEffect(() => {
    const onResize = () => {
      const el = target();
      if (!el || chosenRef.current == null) return;
      applyWidth(el, clampWidth(chosenRef.current, window.innerWidth, minWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [minWidth]);

  const onPointerDown =
    (edge: "left" | "right") => (e: React.PointerEvent<HTMLSpanElement>) => {
      if (e.button !== 0) return;
      const el = target();
      if (!el) return;
      // No text selection / focus change from the press, and keep it from
      // reaching anything underneath.
      e.preventDefault();
      e.stopPropagation();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      let moved = false;
      let last = startW;
      // Capture so the drag keeps tracking outside the modal, and a release
      // over the backdrop doesn't count as a backdrop click (= close).
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 2) return;
        moved = true;
        last = clampWidth(
          widthAfterDrag(startW, dx, edge),
          window.innerWidth,
          minWidth,
        );
        applyWidth(el, last);
      };
      const onEnd = (ev: PointerEvent) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
        handle.classList.remove("dragging");
        document.body.style.userSelect = prevUserSelect;
        // A plain press (e.g. half of a double-click) must not pin the
        // current default width as a stored choice.
        if (moved) {
          chosenRef.current = last;
          saveWidth(storageKey, last);
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    chosenRef.current = null;
    saveWidth(storageKey, null);
    const el = target();
    if (el) applyWidth(el, null);
  };

  const label = t("modal.resize_width");
  const common = {
    role: "separator",
    "aria-orientation": "vertical" as const,
    "aria-label": label,
    title: label,
    onDoubleClick,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };
  return (
    <>
      <span
        ref={leftRef}
        className="width-resize-handle edge-left"
        onPointerDown={onPointerDown("left")}
        {...common}
      />
      <span
        className="width-resize-handle edge-right"
        onPointerDown={onPointerDown("right")}
        {...common}
      />
    </>
  );
}
