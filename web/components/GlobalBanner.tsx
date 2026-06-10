import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { GlobalBanner as GlobalBannerData } from "../../shared/types.ts";

// Renders the single broker-side global banner at the top of every
// page. Maintains its own dedicated WS connection (channel name
// "_banner", arbitrary) so the banner appears even on pages that
// don't otherwise hold a WS — the broker's broadcastToAll reaches
// any subscribed channel.
//
// Local dismiss state hides the banner without telling the broker —
// other tabs / devices still see it until the broker-side
// expires_at fires or someone calls /clear-global-banner.

export function GlobalBanner() {
  const [banner, setBanner] = useState<GlobalBannerData | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/get-global-banner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setBanner(j.banner ?? null);
      })
      .catch(() => {
        /* tolerate — WS will catch the next update anyway */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/_banner`);
    const onMsg = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg?.type === "global-banner-update") {
          setBanner(msg.banner ?? null);
        } else if (msg?.type === "session-stall-update") {
          // GlobalBanner is mounted on EVERY page, so it's the only socket
          // that can nudge the sidebar's stall warning on the root / session
          // dashboards (where no BoardApp / MapView socket exists). On board /
          // map pages this just double-fires a harmless, idempotent refetch.
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
        }
      } catch {
        /* ignore */
      }
    };
    ws.addEventListener("message", onMsg);
    return () => {
      ws.removeEventListener("message", onMsg);
      try {
        ws.close();
      } catch {
        /* race with native teardown — ignore */
      }
    };
  }, []);

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
