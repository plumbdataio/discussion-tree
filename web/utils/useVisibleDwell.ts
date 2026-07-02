import { useEffect } from "react";
import { useSettings } from "./settings.ts";
import { TICK_MS, VISIBLE_DURATION_MS, VISIBLE_RATIO } from "./readTiming.ts";

// Shared "the card has been genuinely on screen long enough" detector. Calls
// onDwell() ONCE when `enabled` and the card has been at least VISIBLE_RATIO
// visible in the viewport for VISIBLE_DURATION_MS continuous — with auto-read
// on and the caller `gateOpen` (the map passes zoom ≥ threshold so a node
// parked on a zoomed-out overview isn't silently cleared). `dep` re-arms the
// one-shot so a fresh change fires again. Both the thread auto-read
// (useMarkReadOnVisible) and the checklist auto-read use this, so their visible
// behaviour is identical by construction.
export function useVisibleDwell(
  cardRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  gateOpen: boolean,
  dep: string,
  onDwell: () => void,
) {
  const [settings] = useSettings();

  useEffect(() => {
    if (!settings.autoReadEnabled) return;
    if (!gateOpen) return;
    if (!enabled) return;
    const card = cardRef.current;
    if (!card) return;

    let visibleSince: number | null = null;
    let posted = false;

    const tick = () => {
      if (posted) return;
      // Only auto-read on the ACTIVE surface. Two cases mean "the user isn't
      // reading this":
      //  - document.hidden: the tab is backgrounded (also avoids keeping the
      //    renderer hot under iOS Safari tab-eviction pressure).
      //  - !document.hasFocus(): the window is visible on screen but NOT focused
      //    — e.g. a second browser window sitting open behind the active one.
      //    document.hidden is FALSE there, so without the focus check that
      //    background window would silently mark messages read (its dwell fires
      //    on a new message while the user is working in a different window).
      // Reset the dwell; it re-arms on the next tick once the surface regains
      // focus, so the counter clears only when the user actually returns to it.
      if (document.hidden || !document.hasFocus()) {
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
      const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const horizontallyOnScreen = r.right > 0 && r.left < vw;
      const ratio = visibleH / r.height;
      if (!(horizontallyOnScreen && ratio >= VISIBLE_RATIO)) {
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
        onDwell();
      }
    };

    tick();
    const interval = setInterval(tick, TICK_MS);
    return () => clearInterval(interval);
    // onDwell intentionally omitted: it's re-created each render but only its
    // `dep`-captured data matters, and `dep` IS a dependency — so the effect
    // re-arms (with a fresh onDwell) exactly when the underlying data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardRef, enabled, gateOpen, dep, settings.autoReadEnabled]);
}
