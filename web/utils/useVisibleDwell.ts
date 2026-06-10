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
      // Tab in the background: nothing the user can be "looking at", and on iOS
      // Safari a ticking interval keeps the renderer active (tab-eviction
      // pressure). Skip; resume after the tab becomes visible.
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
