// CLI-verbosity preference. Governs how much the owning CC says in the TERMINAL
// when it answers a discussion-tree message — the board mirror (post_to_node) is
// always the canonical record, so a user who reads replies in the UI can dial
// the CLI chatter down to "concise" or off entirely ("silent"). The preference
// is delivered on every /poll-messages response and the per-CC poller turns it
// into a one-line footer reminder, so a change takes effect on the next message
// with no CC restart.
//
// Persisted in `$HOME_DIR/config.json` (shared with the power pref) so it
// survives broker restarts. Each writer does a read-merge-write, and broker
// route handlers run synchronously with no await between the read and the
// write, so the two keys never clobber each other.

import * as fs from "node:fs";
import { join } from "node:path";
import { type CliVerbosity, isValidCliVerbosity } from "../shared/types.ts";
import { HOME_DIR } from "./config.ts";

const CONFIG_FILE = join(HOME_DIR, "config.json");
let currentVerbosity: CliVerbosity = "default";

function loadConfig(): { cliVerbosity?: CliVerbosity } {
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
      `[cli-verbosity] failed to persist config: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function initCliVerbosity() {
  const cfg = loadConfig();
  currentVerbosity =
    cfg.cliVerbosity && isValidCliVerbosity(cfg.cliVerbosity)
      ? cfg.cliVerbosity
      : "default";
}

export function getCliVerbosity(): CliVerbosity {
  return currentVerbosity;
}

export function setCliVerbosity(next: CliVerbosity) {
  currentVerbosity = next;
  saveConfig({ cliVerbosity: next });
}

// HTTP routes — exposed via the standard broker route map.
export const routes = {
  "/get-cli-verbosity": () => ({ verbosity: currentVerbosity }),
  "/set-cli-verbosity": (body: any) => {
    const next = body?.verbosity;
    if (typeof next !== "string" || !isValidCliVerbosity(next)) {
      return {
        ok: false,
        error: "errors.invalid_status",
        params: { status: String(next) },
      };
    }
    setCliVerbosity(next);
    return { ok: true, verbosity: currentVerbosity };
  },
};
