import { navigate } from "./router.ts";

// Cross-component channel for "jump to this anchor when the target
// board has finished loading". The anchor-list modal sets a pending
// jump and triggers SPA navigation; BoardApp consumes it after its
// data effect resolves.
//
// Using a module-level variable rather than the URL hash keeps the
// existing router contract intact (paths only, no hash semantics)
// and avoids leaking thread_item_id into the address bar.

let pending: { boardId: string; threadItemId: number } | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribePendingJump(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getPendingJump():
  | { boardId: string; threadItemId: number }
  | null {
  return pending;
}

// Consume the pending jump if it's for the given board. Returns the
// thread_item_id when it applied, null when no pending jump matches.
export function consumePendingJump(boardId: string): number | null {
  if (pending && pending.boardId === boardId) {
    const id = pending.threadItemId;
    pending = null;
    notify();
    return id;
  }
  return null;
}

// Triggered by the anchor list modal when the user clicks a row. SPA
// navigates to the target board (same-board navigation is a no-op,
// which is fine because BoardApp re-runs the jump effect every time
// the pending entry changes).
export function jumpToAnchor(boardId: string, threadItemId: number) {
  pending = { boardId, threadItemId };
  notify();
  navigate(`/board/${boardId}`);
}
