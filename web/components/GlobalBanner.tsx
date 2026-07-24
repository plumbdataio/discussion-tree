import React, { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { GlobalBanner as GlobalBannerData } from "../../shared/types.ts";
import { useLiveSocket } from "../utils/liveSocket.ts";

// Renders the single broker-side global banner at the top of every
// page. Maintains its own dedicated WS connection (channel name
// "_banner", arbitrary) so the banner appears even on pages that
// don't otherwise hold a WS — the broker's broadcastToAll reaches
// any subscribed channel.
//
// Local dismiss state hides the banner without telling the broker —
// other tabs / devices still see it until the broker-side
// expires_at fires or someone calls /clear-global-banner.

// Broadcast types that change something the sidebar renders. GlobalBanner is
// the only socket mounted on every page, so it forwards these to the sidebar
// (BoardApp handles them too, but only on a board page).
const SIDEBAR_REFRESH_TYPES = new Set([
  "session-stall-update",
  "session-compacting-update",
  "sidebar-refresh",
  "bg-tasks-update",
  "schedule-marker-update",
]);

export function GlobalBanner() {
  const [banner, setBanner] = useState<GlobalBannerData | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Pull the current banner. Runs on mount AND after every (re)connect — a
  // banner set or cleared while the socket was down would otherwise never
  // reach this tab, since the broker only pushes the transition.
  const fetchBanner = useCallback(() => {
    fetch("/get-global-banner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setBanner(j.banner ?? null);
      })
      .catch(() => {
        /* tolerate — the WS carries the next update anyway */
      });
  }, []);

  // This socket is mounted on EVERY page and is the sole forwarder of sidebar
  // activity, so it must survive freeze/resume and broker bounces — that whole
  // lifecycle now lives in useLiveSocket.
  useLiveSocket({
    channel: "_banner",
    onResync: fetchBanner,
    onMessage: (msg) => {
      if (msg?.type === "global-banner-update") {
        setBanner(msg.banner ?? null);
      } else if (
        msg?.type === "session-reattached" &&
        typeof msg.session_id === "string"
      ) {
        // The MCP server's heartbeat self-healing loop re-bound this session
        // after its broker binding was lost. One-shot signal — let the sidebar
        // flash a brief spinner so the human sees the recovery too (the agent
        // gets a channel notice separately). Not a sidebar-refresh: there's no
        // /api/sessions change, just a transient UI flash.
        window.dispatchEvent(
          new CustomEvent("pd-session-reattached", {
            detail: { session_id: msg.session_id },
          }),
        );
      } else if (msg?.type === "activity" && typeof msg.session_id === "string") {
        // GlobalBanner is mounted on EVERY page, so forward live activity to
        // the sidebar here too. Otherwise the immediate "working" spinner on a
        // user submit only shows on a board page (BoardApp forwards it) — on
        // the map / session / home pages, or right after a board-WS reconnect,
        // the sidebar would wait for the 10s /api/sessions poll. The sidebar's
        // handler just sets activitiesBySession[sid], so the double-fire on a
        // board page is harmless and idempotent.
        window.dispatchEvent(
          new CustomEvent("pd-activity-update", {
            detail: {
              session_id: msg.session_id,
              activity: msg.activity ?? null,
            },
          }),
        );
      } else if (SIDEBAR_REFRESH_TYPES.has(msg?.type)) {
        // GlobalBanner is mounted on EVERY page, so it's the only socket that
        // can nudge the sidebar on the map / session / home pages (BoardApp
        // forwards these only on a board page). Each of these message types
        // changes something the sidebar shows — stall warning, board/map
        // title (rename → sidebar-refresh), unread counts, BG markers,
        // schedule markers — so refetch /api/sessions. On a board page this
        // just double-fires a harmless, idempotent refetch.
        window.dispatchEvent(new Event("pd-sidebar-refresh"));
      }
    },
  });

  // Auto-clear stale entries client-side too: the broker schedules its
  // own expiry timer but that's lost across broker restarts; this
  // re-checks each render in case we mounted after expiry.
  useEffect(() => {
    if (!banner?.expires_at) return;
    const expiry = Date.parse(banner.expires_at);
    if (Number.isNaN(expiry)) return;
    const delay = expiry - Date.now();
    if (delay <= 0) {
      setBanner(null);
      return;
    }
    const t = setTimeout(() => setBanner(null), delay);
    return () => clearTimeout(t);
  }, [banner?.expires_at]);

  if (!banner) return null;
  // Per-instance dismiss key: the dismiss state should reset every time
  // a fresh banner arrives. set_at is the natural identifier.
  if (dismissed === banner.set_at) return null;

  return (
    <div
      className={`global-banner global-banner-${banner.tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="global-banner-message">{banner.message}</span>
      <button
        type="button"
        className="global-banner-dismiss"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(banner.set_at)}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
