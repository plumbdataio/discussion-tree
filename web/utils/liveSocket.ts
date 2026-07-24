import { useEffect, useRef, useState } from "react";

// @reusable-ui useLiveSocket — USE WHEN a page needs the broker's live
// WebSocket feed (/ws/<channel>) INSTEAD OF calling `new WebSocket(...)`
// directly. It owns reconnection (exponential backoff), the Page Lifecycle
// freeze/resume dance, and — crucially — the post-reconnect resync callback,
// so a socket that dies silently can't leave the page showing stale data.
//
// Why this exists: dt pages have no polling fallback (only the sidebar polls).
// A board's data is refetched ONLY when its socket delivers a frame, so a
// silently-dead socket froze the UI until a manual reload — the "I sent a
// message but it never appeared" failure the user hit repeatedly. Reconnecting
// alone is not enough: whatever happened while we were disconnected was never
// delivered, hence `onResync` fires on every successful (re)connect.
//
// It also reports its connectivity on a window event so <ConnectionBanner>
// can surface "we are disconnected" once, globally, without every page
// growing its own banner.

export const WS_STATE_EVENT = "pd-ws-state";

export type WsStateDetail = {
  /** Per-hook-instance id, stable for the socket's lifetime. */
  id: string;
  connected: boolean;
  /** The socket is going away (unmount / channel switch) — stop tracking it. */
  gone?: boolean;
};

/** First retry waits ~this long; each further attempt doubles it. */
export const RECONNECT_BASE_MS = 1000;
/** Upper bound for a single retry delay. */
export const RECONNECT_MAX_MS = 15000;

/**
 * Exponential backoff with "equal jitter": half the window is fixed, half is
 * random. Full jitter would allow near-zero delays (hammering the broker right
 * after it went down); no jitter would make every page on every device retry in
 * lockstep. Equal jitter keeps a sane floor while spreading the herd.
 *
 * Pure + injectable rand so it can be tested deterministically.
 */
export function reconnectDelay(
  attempt: number,
  rand: () => number = Math.random,
): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // Cap the exponent before the shift so a long-lived tab can't overflow.
  const exp = Math.min(n, 20);
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
  const half = cap / 2;
  return Math.round(half + rand() * half);
}

/** Live sockets currently mounted, keyed by hook-instance id. */
export type WsStateMap = Record<string, boolean>;

/**
 * Fold one WS_STATE_EVENT into the tracked map. A `gone` socket is dropped
 * entirely rather than recorded as disconnected — otherwise navigating away
 * from a page would leave a permanent phantom "disconnected" entry.
 * Returns the SAME object when nothing changed so React can bail out.
 */
export function applyWsState(prev: WsStateMap, d: WsStateDetail): WsStateMap {
  if (!d || typeof d.id !== "string") return prev;
  if (d.gone) {
    if (!(d.id in prev)) return prev;
    const next = { ...prev };
    delete next[d.id];
    return next;
  }
  if (prev[d.id] === d.connected) return prev;
  return { ...prev, [d.id]: d.connected };
}

/** True when at least one tracked socket is down. Empty map = nothing to say. */
export function anyDisconnected(map: WsStateMap): boolean {
  for (const k in map) {
    if (!map[k]) return true;
  }
  return false;
}

let seq = 0;

export type LiveSocketOptions = {
  /**
   * Broker channel to subscribe to (`/ws/<channel>`). `null` = don't connect
   * (e.g. a board page rendered without an id).
   */
  channel: string | null;
  /** Called for every frame, already JSON-parsed. Non-JSON frames are skipped. */
  onMessage?: (msg: any, ev: MessageEvent) => void;
  /**
   * Called right after the socket opens — including the very first connect, so
   * a caller can use it as its single "load the snapshot" path. Anything that
   * changed while we were disconnected is only recoverable here.
   */
  onResync?: () => void;
};

/**
 * Subscribe to a broker channel with automatic reconnection.
 * Returns whether the socket is currently open.
 */
export function useLiveSocket({
  channel,
  onMessage,
  onResync,
}: LiveSocketOptions): boolean {
  const [connected, setConnected] = useState(false);
  // Keep callbacks in refs: the effect must depend on `channel` ALONE. Depending
  // on the callbacks would tear down and re-open the socket on every render
  // that produced a new function identity (and re-run onResync each time).
  const onMessageRef = useRef(onMessage);
  const onResyncRef = useRef(onResync);
  onMessageRef.current = onMessage;
  onResyncRef.current = onResync;

  useEffect(() => {
    if (!channel) {
      setConnected(false);
      return;
    }
    const id = `ws${++seq}`;
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const report = (isConnected: boolean, gone = false) => {
      window.dispatchEvent(
        new CustomEvent<WsStateDetail>(WS_STATE_EVENT, {
          detail: { id, connected: isConnected, gone },
        }),
      );
    };

    const clearRetry = () => {
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
    };

    const scheduleRetry = () => {
      if (disposed || retry) return;
      const delay = reconnectDelay(attempt);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      let sock: WebSocket;
      try {
        sock = new WebSocket(`${proto}://${window.location.host}/ws/${channel}`);
      } catch {
        // Construction itself can throw (e.g. offline in some browsers).
        scheduleRetry();
        return;
      }
      ws = sock;
      sock.onopen = () => {
        if (disposed || ws !== sock) return;
        attempt = 0;
        setConnected(true);
        report(true);
        // Catch up on everything missed while the socket was down. Also covers
        // the first connect, so callers need no separate initial fetch.
        onResyncRef.current?.();
      };
      const down = () => {
        if (disposed || ws !== sock) return;
        setConnected(false);
        report(false);
        scheduleRetry();
      };
      sock.onclose = down;
      // A socket that errors usually closes right after, but not always on
      // every browser — treat both as "down" (scheduleRetry is idempotent).
      sock.onerror = down;
      sock.onmessage = (ev) => {
        if (disposed || ws !== sock) return;
        let msg: any = null;
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          /* non-JSON frame — ignore */
        }
        if (msg != null) onMessageRef.current?.(msg, ev);
      };
    };

    // A retry is pending but the environment just changed for the better
    // (network back / tab visible again) — don't sit out the backoff.
    const retryNow = () => {
      if (disposed) return;
      if (ws && ws.readyState === WebSocket.OPEN) return;
      clearRetry();
      attempt = 0;
      connect();
    };

    const onOnline = () => retryNow();
    const onVisible = () => {
      if (!document.hidden) retryNow();
    };
    // Page Lifecycle: a frozen tab can't send WS frames, and leaving the socket
    // open misleads the OS into thinking the tab is active. Close on freeze and
    // reconnect on resume (which also triggers onResync → fresh data).
    const onFreeze = () => {
      clearRetry();
      try {
        ws?.close();
      } catch {
        /* racing native teardown — ignore */
      }
    };
    const onResume = () => retryNow();

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("freeze", onFreeze as any);
    document.addEventListener("resume", onResume as any);

    connect();

    return () => {
      disposed = true;
      clearRetry();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("freeze", onFreeze as any);
      document.removeEventListener("resume", onResume as any);
      report(false, true);
      try {
        ws?.close();
      } catch {
        /* racing native teardown — ignore */
      }
      ws = null;
    };
  }, [channel]);

  return connected;
}
