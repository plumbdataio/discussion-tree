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

// Same pattern for the edit modal: any pending-reservation chip (pinned below a
// thread, or a row in the reservations list) opens the shared edit modal with
// the reservation's current text + fire time, carried on the event detail.
export type ScheduledEditTarget = {
  id: string;
  text: string;
  fire_at: string;
};
const EDIT_EVENT = "pd-open-scheduled-edit";

export function openScheduledEdit(target: ScheduledEditTarget) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: target }));
}

export function subscribeOpenScheduledEdit(
  cb: (target: ScheduledEditTarget) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb((e as CustomEvent).detail as ScheduledEditTarget);
  window.addEventListener(EDIT_EVENT, h);
  return () => window.removeEventListener(EDIT_EVENT, h);
}
