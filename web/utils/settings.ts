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
  active: boolean;
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
  // Per-session collapsed state of the boards list. Missing keys default to
  // expanded (false).
  collapsedSessions: Record<string, boolean>;
};

const DEFAULTS: Settings = {
  autoReadEnabled: true,
  // "system" lets i18next-browser-languagedetector pick from navigator.language.
  language: "system",
  // "system" follows prefers-color-scheme; explicit choices override.
  theme: "system",
  boardStatusFilter: {
    active: true,
    completed: true,
    withdrawn: true,
    paused: true,
  },
  sessionOrder: [],
  collapsedSessions: {},
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
