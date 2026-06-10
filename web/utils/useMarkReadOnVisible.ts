import type { ThreadItem } from "../../shared/types.ts";
import { useVisibleDwell } from "./useVisibleDwell.ts";

// Marks a card's unread CC messages read once the card has been genuinely on
// screen long enough. We watch the CARD as a whole (not each message) because
// in a long thread, older unread items scroll out of the inner viewport — but
// if the user is actively looking at the card, they've engaged with it. The
// dwell detection lives in the shared useVisibleDwell hook, so the checklist
// auto-read clears with the exact same visible behaviour.

export function useMarkReadOnVisible(
  cardRef: React.RefObject<HTMLElement | null>,
  items: ThreadItem[],
  // An extra gate the caller can close to pause auto-read regardless of
  // on-screen dwell. The map view passes `zoom >= threshold` here so a node
  // that's merely parked on a zoomed-out overview canvas (where the message
  // text isn't actually legible) is NOT silently marked read — the user must
  // zoom in to it. Defaults open, so every board call site is unchanged.
  gateOpen: boolean = true,
) {
  // Re-arm whenever the unread set shifts so we don't keep posting the same
  // ids over and over.
  const unreadIds = items
    .filter((i) => i.source === "cc" && !i.read_at)
    .map((i) => i.id)
    .sort((a, b) => a - b);
  const dep = unreadIds.join(",");

  useVisibleDwell(cardRef, unreadIds.length > 0, gateOpen, dep, () => {
    fetch("/mark-thread-items-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_item_ids: unreadIds }),
    }).catch(() => {
      /* network blip — re-arms on the next dep change */
    });
  });
}
