import { useEffect, useState } from "react";
import type { SupportedLanguage } from "../i18n.ts";

// Per-device user settings backed by localStorage. We deliberately do NOT
// sync across devices — different devices (PC for work, phone for couch)
// often want different behaviors (e.g., manual read on phone where you only
// glance at messages without "engaging").

// Sidebar's per-board-status visibility toggle. Keys match
// shared/types.ts BoardStatus values; entries set to false hide boards with
// that status from the sidebar list. Default boards are exempt from this
// filter (they're always visible since they're the conversation surface).
export type BoardStatusFilter = {
  discussing: boolean;
  settled: boolean;
  completed: boolean;
  withdrawn: boolean;
  paused: boolean;
};

export type ThemeChoice = "system" | "light" | "dark";

export type Settings = {
  autoReadEnabled: boolean;
  language: SupportedLanguage;
  theme: ThemeChoice;
  boardStatusFilter: BoardStatusFilter;
  // User-preferred ordering of sessions in the sidebar. Session ids in this
  // array render first, in this order; sessions not present render after,
  // in their natural broker order.
  sessionOrder: string[];
  // Sidebar session visibility, keyed by the CC session id (cc_session_id,
  // falling back to cwd for a not-yet-attached session). cc_session_id is
  // stable across /compact and `claude -r` resume — only a genuinely fresh CC
  // launch gets a new one — so the filter survives the restarts that matter
  // while still being per-session. null = show every session (default). A
  // non-null array is an explicit allow-list: only those sessions show, and a
  // newly-observed session stays hidden until added. "All selected" collapses
  // to null (new sessions appear); "one+ hidden" keeps the array (new sessions
  // stay hidden).
  shownSessions: string[] | null;
  // Per-session collapsed state of the boards list. Missing keys default to
  // expanded (false).
  collapsedSessions: Record<string, boolean>;
  // Desktop-only: hide the whole sidebar to reclaim horizontal space (useful
  // on the map view's wide canvas). A floating reopen button stays visible.
  // The mobile drawer is unaffected — it has its own toggle.
  sidebarCollapsed: boolean;
  // Opt-in master switch for tmux-backed operations. When on, discussion-tree
  // works through tmux to (1) send TUI commands (e.g. /compact) from the header
  // into a CC's tmux pane, and (2) spawn new CC sessions. Off by default (OSS
  // posture: these stay invisible until the user explicitly enables them).
  // (Legacy key name was `cliCommandSend`; migrated forward in readSettings.)
  tmuxIntegration: boolean;
};

const DEFAULTS: Settings = {
  autoReadEnabled: true,
  // "system" lets i18next-browser-languagedetector pick from navigator.language.
  language: "system",
  // "system" follows prefers-color-scheme; explicit choices override.
  theme: "system",
  boardStatusFilter: {
    discussing: true,
    settled: true,
    completed: true,
    withdrawn: true,
    paused: true,
  },
  sessionOrder: [],
  shownSessions: null,
  collapsedSessions: {},
  sidebarCollapsed: false,
  tmuxIntegration: false,
};

const STORAGE_KEY = "pd-settings";

function readSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Pull the legacy `cliCommandSend` key out of the parsed payload so it is
    // NOT spread into the result (and so the next writeSettings drops it from
    // localStorage instead of letting it linger forever); its value is still
    // carried forward into the renamed `tmuxIntegration` below.
    const { cliCommandSend, ...parsed } = JSON.parse(raw) as Partial<Settings> & {
      cliCommandSend?: boolean;
    };
    // Shallow-merge the top-level, but deep-merge `boardStatusFilter` so
    // future status additions still get a default value when the persisted
    // payload is older than the schema. `collapsedSessions` is similarly
    // merged so adding new sessions doesn't wipe an old persisted state.
    return {
      ...DEFAULTS,
      ...parsed,
      boardStatusFilter: {
        ...DEFAULTS.boardStatusFilter,
        ...(parsed.boardStatusFilter ?? {}),
      },
      collapsedSessions: {
        ...DEFAULTS.collapsedSessions,
        ...(parsed.collapsedSessions ?? {}),
      },
      sessionOrder: parsed.sessionOrder ?? DEFAULTS.sessionOrder,
      // Preserve an explicit array; both missing and stored-null mean "show all".
      shownSessions: parsed.shownSessions ?? null,
      // Carry the legacy `cliCommandSend` toggle forward into its renamed key so
      // users who had it on don't silently lose it when this setting was renamed
      // (the toggle now also gates tmux session spawning, not just /compact).
      tmuxIntegration:
        parsed.tmuxIntegration ?? cliCommandSend ?? DEFAULTS.tmuxIntegration,
    };
  } catch {
    return DEFAULTS;
  }
}

function writeSettings(next: Settings) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    // Notify listeners across the React tree without a context provider.
    window.dispatchEvent(new Event("pd-settings-changed"));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(readSettings);

  useEffect(() => {
    const onChange = () => setSettings(readSettings());
    window.addEventListener("pd-settings-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("pd-settings-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...readSettings(), ...patch };
    writeSettings(next);
    setSettings(next);
  };

  return [settings, update];
}
