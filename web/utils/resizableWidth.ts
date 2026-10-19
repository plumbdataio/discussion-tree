// Pure helpers behind WidthResizeHandles: clamp a user-dragged width to the
// viewport and persist it per viewer in localStorage. Kept free of React so the
// clamp/persist rules are unit-testable on their own.

// Key for the thread preview modals' chosen width (NodeModal and
// MapNodeModal, which also serves the diagram chat). One shared key: they are
// the same kind of preview, so they open at the same width.
export const THREAD_PREVIEW_WIDTH_KEY = "dt-thread-preview-width";

export const DEFAULT_MIN_WIDTH = 420;
// Total horizontal room kept free around the element (both sides together).
// Matches .modal-backdrop's 24px padding on each side.
export const VIEWPORT_MARGIN = 48;

/**
 * Clamp `width` into [min, viewport - margin]. When the viewport is too narrow
 * to honour `min`, the viewport bound wins (the element must never overflow the
 * screen). Non-finite input falls back to the max.
 */
export function clampWidth(
  width: number,
  viewportWidth: number,
  min: number = DEFAULT_MIN_WIDTH,
  margin: number = VIEWPORT_MARGIN,
): number {
  const max = Math.max(0, viewportWidth - margin);
  if (!Number.isFinite(width)) return max;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * New width after dragging one edge of a horizontally CENTERED element by `dx`
 * pixels. Both edges move symmetrically, so the width changes by 2 * dx — that
 * keeps the grabbed edge under the pointer. Dragging the right edge rightward
 * (dx > 0) or the left edge leftward (dx < 0) widens.
 */
export function widthAfterDrag(
  startWidth: number,
  dx: number,
  edge: "left" | "right",
): number {
  return startWidth + (edge === "right" ? dx : -dx) * 2;
}

/** Stored width, or null when nothing (valid) is stored or storage is blocked. */
export function loadWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Persist `width`; null removes the entry (= back to the default width). */
export function saveWidth(key: string, width: number | null): void {
  try {
    if (width == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Private window / blocked storage: the width just won't be remembered.
  }
}
