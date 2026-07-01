// tmux-integration master switch, persisted server-side. This gates the
// tmux-backed features (send TUI commands into a CC pane, spawn CC sessions),
// which are inherently per-machine (they touch the local tmux server), so the
// preference belongs on the broker rather than in a single browser's
// localStorage — that way it survives a browser data-clear / PC restart and is
// shared across every device that drives this machine.
//
// Stored in `$HOME_DIR/config.json` (shared with the power + CLI-verbosity
// prefs). Each writer does a synchronous read-merge-write with no await between
// read and write, so the keys never clobber each other. `configured` tracks
// whether the key was ever written, so the UI can do a one-time migration of a
// user's legacy per-device localStorage value on first run.

import * as fs from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.ts";

const CONFIG_FILE = join(HOME_DIR, "config.json");
let currentValue = false;
let configured = false;

function loadConfig(): { tmuxIntegration?: boolean } {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch: Record<string, unknown>) {
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch {
    /* ignore parse error, treat as empty */
  }
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error(
      `[tmux-integration] failed to persist config: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function initTmuxIntegration() {
  const cfg = loadConfig();
  if (typeof cfg.tmuxIntegration === "boolean") {
    currentValue = cfg.tmuxIntegration;
    configured = true;
  } else {
    currentValue = false;
    configured = false;
  }
}

export function getTmuxIntegration(): boolean {
  return currentValue;
}

export function setTmuxIntegration(next: boolean) {
  currentValue = next;
  configured = true;
  saveConfig({ tmuxIntegration: next });
}

// HTTP routes — exposed via the standard broker route map.
export const routes = {
  "/get-tmux-integration": () => ({
    value: currentValue,
    // false until the user (or the first-run migration) has ever set it, so the
    // client can seed it once from a legacy localStorage value.
    configured,
  }),
  "/set-tmux-integration": (body: any) => {
    if (typeof body?.value !== "boolean") {
      return { ok: false, error: "value must be a boolean" };
    }
    setTmuxIntegration(body.value);
    return { ok: true, value: currentValue };
  },
};
