// Cross-component channel to open the global reservations-list modal from
// anywhere — the sidebar clock indicator or a board-header button. A single
// ScheduledListModal (rendered once in frontend.tsx) subscribes; every trigger
// just dispatches the open event, so the triggers don't need to own the modal
// state or live in the same subtree.
const OPEN_EVENT = "pd-open-scheduled-list";

export function openScheduledList() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function subscribeOpenScheduledList(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(OPEN_EVENT, cb);
  return () => window.removeEventListener(OPEN_EVENT, cb);
}
