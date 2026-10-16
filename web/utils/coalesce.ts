// Collapse a burst of triggers into ONE call of `fn`, run `delayMs` after the
// first trigger of the burst.
//
// WHY: the broker often sends the same nudge twice in a row (e.g. a post emits
// two "sidebar-refresh" broadcasts a few ms apart), and before 2026-10-16 both
// BoardApp and GlobalBanner turned each one into a "pd-sidebar-refresh" — so a
// single post refetched the ~90KB /api/sessions 2-3 times. The window is
// short enough that the UI still updates immediately.

export type CoalescedTrigger = {
  (): void;
  cancel: () => void;
};

export function coalesce(
  fn: () => void,
  delayMs = 50,
  timers: {
    set: (cb: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (cb, ms) => setTimeout(cb, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): CoalescedTrigger {
  let handle: unknown = null;
  const trigger = (() => {
    if (handle !== null) return;
    handle = timers.set(() => {
      handle = null;
      fn();
    }, delayMs);
  }) as CoalescedTrigger;
  trigger.cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  return trigger;
}
