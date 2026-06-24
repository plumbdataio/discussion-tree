import { useEffect, useState } from "react";
import type { Activity } from "../../shared/types.ts";

// The owning session's live activity for a page header's working/blocked chip.
// GlobalBanner (mounted on every page) forwards every WS "activity" event to a
// window `pd-activity-update` CustomEvent; we pick the one for this session.
// Live events take precedence once they arrive; before that the fetched value
// seeds it — mirroring BoardApp's `sessionActivity ?? data.activity` so a later
// view refetch can't clobber the live state.
export function useHeaderActivity(
  sessionId: string | undefined,
  fetched: Activity | null | undefined,
): Activity | null {
  const [live, setLive] = useState<Activity | null | undefined>(undefined);
  useEffect(() => {
    if (!sessionId) return;
    const onAct = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        session_id?: string;
        activity?: Activity | null;
      };
      if (d?.session_id === sessionId) setLive(d.activity ?? null);
    };
    window.addEventListener("pd-activity-update", onAct);
    return () => window.removeEventListener("pd-activity-update", onAct);
  }, [sessionId]);
  return live !== undefined ? live : (fetched ?? null);
}
