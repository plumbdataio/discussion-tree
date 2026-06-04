// Generic global banner — a single message that pins to the top of
// every page until cleared or until its `expires_at` passes. Stored
// in-memory only; no DB row, no persistence across broker restarts,
// since the banner's purpose is to announce a here-and-now situation
// (e.g. "the team has paused work", "scheduled downtime in 5min").
//
// External tools can drive this through POST /set-global-banner.

import type { GlobalBanner } from "../shared/types.ts";
import { broadcastToAll } from "./ws.ts";

let current: GlobalBanner | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function clearExpiryTimer() {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function scheduleAutoClear(banner: GlobalBanner) {
  clearExpiryTimer();
  if (!banner.expires_at) return;
  const expiry = Date.parse(banner.expires_at);
  if (Number.isNaN(expiry)) return;
  const delay = expiry - Date.now();
  if (delay <= 0) {
    // Already past — clear immediately on the next tick so the
    // caller still sees ok:true.
    setTimeout(() => {
      if (current === banner) {
        current = null;
        broadcastToAll({ type: "global-banner-update", banner: null });
      }
    }, 0);
    return;
  }
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    if (current === banner) {
      current = null;
      broadcastToAll({ type: "global-banner-update", banner: null });
    }
  }, delay);
}

export function handleSetGlobalBanner(body: {
  message?: string;
  tone?: "info" | "warn" | "error";
  expires_at?: string | null;
}): { ok: boolean; banner?: GlobalBanner; error?: string } {
  if (!body.message || typeof body.message !== "string") {
    return { ok: false, error: "message required" };
  }
  const tone =
    body.tone === "warn" || body.tone === "error" || body.tone === "info"
      ? body.tone
      : "info";
  const banner: GlobalBanner = {
    message: body.message,
    tone,
    expires_at: body.expires_at ?? null,
    set_at: new Date().toISOString(),
  };
  current = banner;
  scheduleAutoClear(banner);
  broadcastToAll({ type: "global-banner-update", banner });
  return { ok: true, banner };
}

export function handleClearGlobalBanner(): { ok: true } {
  clearExpiryTimer();
  if (current !== null) {
    current = null;
    broadcastToAll({ type: "global-banner-update", banner: null });
  }
  return { ok: true };
}

export function handleGetGlobalBanner(): {
  ok: true;
  banner: GlobalBanner | null;
} {
  // Auto-clear stale entries (the timer normally handles this but a
  // broker restart loses scheduled timers — recompute on read).
  if (current?.expires_at && Date.parse(current.expires_at) <= Date.now()) {
    current = null;
  }
  return { ok: true, banner: current };
}

export const routes = {
  "/set-global-banner": handleSetGlobalBanner,
  "/clear-global-banner": handleClearGlobalBanner,
  "/get-global-banner": handleGetGlobalBanner,
};
