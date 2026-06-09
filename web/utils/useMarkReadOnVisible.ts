import { useEffect } from "react";
import type { ThreadItem } from "../../shared/types.ts";
import { useSettings } from "./settings.ts";
import { TICK_MS, VISIBLE_DURATION_MS, VISIBLE_RATIO } from "./readTiming.ts";

// Polling-based visibility tracker. We watch the CARD as a whole (not each
// message) because in a long thread, older unread items get scrolled out of
// the inner thread viewport — but if the user is actively looking at the
// card, they've engaged with the conversation and we should clear the badge.
// When the card is at least VISIBLE_RATIO visible in the viewport for
// VISIBLE_DURATION_MS continuous, all unread CC messages in `items` are marked
// read at once. The timing constants are shared (readTiming.ts) so the
// checklist-change auto-read clears with the exact same visible behaviour.

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
  const [settings] = useSettings();

  // Re-arm whenever the unread set shifts so we don't keep posting the same
  // ids over and over.
  const unreadIds = items
    .filter((i) => i.source === "cc" && !i.read_at)
    .map((i) => i.id)
    .sort((a, b) => a - b);
  const dep = unreadIds.join(",");

  useEffect(() => {
    // User has opted out of auto-read; the manual "Mark read" button on each
    // card takes over.
    if (!settings.autoReadEnabled) return;
    // Caller gate closed (e.g. map zoomed out below the legibility threshold):
    // don't auto-read at all. Re-runs when gateOpen flips because it's a dep.
    if (!gateOpen) return;
    if (unreadIds.length === 0) return;
    const card = cardRef.current;
    if (!card) return;

    let visibleSince: number | null = null;
    let posted = false;

    const tick = () => {
      if (posted) return;
      // Tab in the background: nothing the user can be "looking at",
      // and on iOS Safari a ticking interval keeps the renderer active
      // and contributes to tab-eviction pressure. Skip the work; resume
      // on the next tick after the tab becomes visible again.
      if (document.hidden) {
        visibleSince = null;
        return;
      }
      const r = card.getBoundingClientRect();
      if (r.height === 0) {
        visibleSince = null;
        return;
      }
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const visibleH = Math.max(
        0,
        Math.min(r.bottom, vh) - Math.max(r.top, 0),
      );
      const horizontallyOnScreen = r.right > 0 && r.left < vw;
      const ratio = visibleH / r.height;
      const visible = horizontallyOnScreen && ratio >= VISIBLE_RATIO;
      if (!visible) {
        visibleSince = null;
        return;
      }
      const now = Date.now();
      if (visibleSince == null) {
        visibleSince = now;
        return;
      }
      if (now - visibleSince >= VISIBLE_DURATION_MS) {
        posted = true;
        fetch("/mark-thread-items-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread_item_ids: unreadIds }),
        }).catch(() => {
          /* network blip — `posted` resets on next dep change */
        });
      }
    };

    tick();
    const interval = setInterval(tick, TICK_MS);
    return () => clearInterval(interval);
  }, [cardRef, dep, settings.autoReadEnabled, gateOpen]);
}
