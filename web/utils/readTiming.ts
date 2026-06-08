// Shared "looked at it long enough → mark read" timing. Both the thread-item
// auto-read (useMarkReadOnVisible) and the checklist-change auto-read read
// these SAME constants, so the visible behaviour is identical and tuning one
// number changes both. Polling-based (TICK_MS) rather than IntersectionObserver
// so a card scrolled partly out of a nested overflow still counts as "engaged".
export const VISIBLE_DURATION_MS = 5_000; // continuous on-screen time to clear
export const TICK_MS = 500; // visibility poll interval
export const VISIBLE_RATIO = 0.4; // fraction of the card that must be in view
