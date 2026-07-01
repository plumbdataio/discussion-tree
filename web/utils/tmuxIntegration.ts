import { useEffect, useState } from "react";

// The tmux-integration master switch used to live in per-device localStorage
// (alongside the other UI settings), but it gates machine-level features
// (spawning CC sessions, sending TUI commands into a tmux pane), so it now
// lives server-side on the broker — surviving a browser data-clear / PC restart
// and shared across every device that drives this machine. This hook fetches it
// once, caches it at module scope (so cross-component reads stay in sync and
// don't re-flicker), and POSTs on change.

let cachedValue: boolean | null = null; // null = not yet loaded
let loadStarted = false;
const listeners = new Set<(v: boolean) => void>();

function emit(v: boolean) {
  cachedValue = v;
  listeners.forEach((l) => l(v));
}

// The legacy per-device value, read straight from the raw localStorage payload
// (both the current `tmuxIntegration` key and the older `cliCommandSend` name),
// used only to seed the server the first time — so a user who had it on doesn't
// lose it in the move to server-side storage.
function readLegacyLocal(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem("pd-settings");
    if (!raw) return false;
    const p = JSON.parse(raw) as {
      tmuxIntegration?: boolean;
      cliCommandSend?: boolean;
    };
    return !!(p.tmuxIntegration ?? p.cliCommandSend);
  } catch {
    return false;
  }
}

async function ensureLoaded() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const r = (await fetch("/get-tmux-integration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((res) => res.json())) as { value?: boolean; configured?: boolean };
    let value = !!r.value;
    if (!r.configured && readLegacyLocal()) {
      // One-time migration: carry the legacy per-device toggle onto the server.
      value = true;
      fetch("/set-tmux-integration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: true }),
      }).catch(() => {
        /* ignore */
      });
    }
    emit(value);
  } catch {
    // Broker unreachable — fall back to the legacy local value so the UI still
    // reflects the user's last known choice. Don't latch loadStarted so a later
    // mount can retry the server.
    loadStarted = false;
    emit(readLegacyLocal());
  }
}

export function useTmuxIntegration(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(cachedValue ?? false);

  useEffect(() => {
    const l = (v: boolean) => setValue(v);
    listeners.add(l);
    if (cachedValue !== null) setValue(cachedValue);
    else void ensureLoaded();
    return () => {
      listeners.delete(l);
    };
  }, []);

  const set = (v: boolean) => {
    emit(v); // optimistic; broadcast to every mounted consumer immediately
    fetch("/set-tmux-integration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: v }),
    }).catch(() => {
      /* ignore — value stays optimistic; a reload re-syncs from the server */
    });
  };

  return [value, set];
}
