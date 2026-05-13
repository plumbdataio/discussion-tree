import { useEffect } from "react";
import type { ThreadItem } from "../../shared/types.ts";
import { useSettings } from "./settings.ts";

// Polling-based visibility tracker. We watch the CARD as a whole (not each
// message) because in a long thread, older unread items get scrolled out of
// the inner thread viewport — but if the user is actively looking at the
// card, they've engaged with the conversation and we should clear the badge.
// When the card is at least 40% visible in the viewport for 5 continuous
// seconds, all unread CC messages in `items` are marked read at once.
const VISIBLE_DURATION_MS = 5_000;
const TICK_MS = 500;
const VISIBLE_RATIO = 0.4;

export function useMarkReadOnVisible(
  cardRef: React.RefObject<HTMLElement | null>,
  items: ThreadItem[],
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
    if (unreadIds.length === 0) return;
    const card = cardRef.current;
    if (!card) return;

    let visibleSince: number | null = null;
    let posted = false;

    const tick = () => {
      if (posted) return;
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
  }, [cardRef, dep, settings.autoReadEnabled]);
}
