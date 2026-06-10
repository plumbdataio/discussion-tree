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
  // Sidebar session visibility, keyed by cwd (NOT session id — ids are minted
  // fresh on every CC restart, cwd is stable, and "a client" maps to a cwd
  // tree). null = show every session (the default). A non-null array is an
  // explicit allow-list: only sessions whose cwd is in it are shown, and any
  // newly-observed session is hidden until its cwd is added. So "all selected"
  // collapses to null (new sessions appear); "one+ hidden" keeps the array
  // (new sessions stay hidden).
  shownCwds: string[] | null;
  // Per-session collapsed state of the boards list. Missing keys default to
  // expanded (false).
  collapsedSessions: Record<string, boolean>;
  // Desktop-only: hide the whole sidebar to reclaim horizontal space (useful
  // on the map view's wide canvas). A floating reopen button stays visible.
  // The mobile drawer is unaffected — it has its own toggle.
  sidebarCollapsed: boolean;
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
  shownCwds: null,
  collapsedSessions: {},
  sidebarCollapsed: false,
};

const STORAGE_KEY = "pd-settings";

function readSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
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
      shownCwds: parsed.shownCwds ?? null,
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
