import { useEffect, useState } from "react";

// A tiny module-scope lock shared between the board's preview modals and the
// board cards behind them. A preview modal (NodeModal / ConcernPreviewModal)
// holds the lock while it's open; the board's visible-dwell auto-read pauses
// while the lock is held, so a node OCCLUDED behind a preview isn't silently
// marked read. (The thread the user is actually reading lives in the modal, not
// in the board card under it — so no board card is genuinely "on screen" for
// the user while a preview is open. When the modal closes, dwell resumes and
// reads whatever is actually visible again.)

let openCount = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// Hold the lock while `active` (default true). A preview modal that is mounted
// only while open calls this with no args (held for its whole lifetime); a
// card that's always mounted but opens its own overlay conditionally passes
// `active` so the lock tracks just the overlay (e.g. ChecklistCard).
export function usePreviewModalLock(active: boolean = true) {
  useEffect(() => {
    if (!active) return;
    openCount += 1;
    emit();
    return () => {
      openCount -= 1;
      emit();
    };
  }, [active]);
}

// Subscribe: true while any preview modal is open.
export function useAnyPreviewModalOpen(): boolean {
  const [open, setOpen] = useState(openCount > 0);
  useEffect(() => {
    const l = () => setOpen(openCount > 0);
    listeners.add(l);
    l(); // sync to the current count in case it changed before we subscribed
    return () => {
      listeners.delete(l);
    };
  }, []);
  return open;
}
