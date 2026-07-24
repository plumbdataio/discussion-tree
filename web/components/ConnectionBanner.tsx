import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, WifiOff } from "lucide-react";
import {
  WS_STATE_EVENT,
  applyWsState,
  anyDisconnected,
  type WsStateDetail,
  type WsStateMap,
} from "../utils/liveSocket.ts";

// Global "we lost the live connection" indicator. Every useLiveSocket instance
// reports its state on WS_STATE_EVENT; this component folds them together and
// speaks once for the whole app, so pages don't each grow their own banner.
//
// Deliberately quiet: a pill at the bottom, not a full-width bar — losing the
// socket is recoverable (useLiveSocket is already retrying, and it resyncs on
// reconnect), so the message is "we noticed, we're on it", not an alarm. The
// reload button is only an escape hatch.

/**
 * Grace period before saying anything. A socket blips on every page navigation
 * and on resume; announcing those would be pure noise. Long enough to cover a
 * normal reconnect, short enough that a real outage is visible before the user
 * starts wondering why nothing updates.
 */
const ANNOUNCE_AFTER_MS = 3000;
/** How long the "reconnected" confirmation lingers before fading out. */
const RESTORED_MS = 2500;

type Phase = "ok" | "down" | "restored";

export function ConnectionBanner() {
  const { t } = useTranslation();
  const [sockets, setSockets] = useState<WsStateMap>({});
  const [phase, setPhase] = useState<Phase>("ok");
  const phaseRef = useRef<Phase>("ok");
  phaseRef.current = phase;

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<WsStateDetail>).detail;
      setSockets((prev) => applyWsState(prev, detail));
    };
    window.addEventListener(WS_STATE_EVENT, onState as EventListener);
    return () =>
      window.removeEventListener(WS_STATE_EVENT, onState as EventListener);
  }, []);

  const down = anyDisconnected(sockets);

  useEffect(() => {
    if (down) {
      // Only announce if it stays down — cheap blips stay invisible.
      if (phaseRef.current === "down") return;
      const timer = setTimeout(() => setPhase("down"), ANNOUNCE_AFTER_MS);
      return () => clearTimeout(timer);
    }
    // Back up. Confirm the recovery only if we had actually complained;
    // otherwise go straight back to silence.
    if (phaseRef.current === "down") {
      setPhase("restored");
      const timer = setTimeout(() => setPhase("ok"), RESTORED_MS);
      return () => clearTimeout(timer);
    }
    return;
  }, [down]);

  if (phase === "ok") return null;

  const restored = phase === "restored";
  return (
    <div
      className={`connection-banner ${restored ? "restored" : "down"}`}
      role="status"
      aria-live="polite"
    >
      {restored ? (
        <span className="connection-banner-message">
          {t("connection.restored")}
        </span>
      ) : (
        <>
          <WifiOff size={14} aria-hidden="true" />
          <span className="connection-banner-message">
            {t("connection.offline")}
          </span>
          <button
            type="button"
            className="connection-banner-reload"
            onClick={() => window.location.reload()}
            title={t("connection.reload_title")}
          >
            <RotateCw size={12} aria-hidden="true" />
            {t("connection.reload")}
          </button>
        </>
      )}
    </div>
  );
}
