// Centralized broker configuration. Resolves env vars once at module load and
// is imported by every handler that needs a path or limit. Keeping the
// resolution logic in one place means env-var changes only require touching
// this file (and the README's configuration table).

import * as fs from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";

export const PORT = parseInt(
  process.env.PARALLEL_DISCUSSION_PORT ?? "7898",
  10,
);

// PARALLEL_DISCUSSION_HOME is the umbrella state directory. Default:
// $HOME/.parallel-discussion. The MCP server, broker, and SessionStart hook
// all read this same env so a shell-level override flows everywhere.
export const HOME_DIR =
  process.env.PARALLEL_DISCUSSION_HOME ??
  `${process.env.HOME}/.parallel-discussion`;

const LEGACY_DB_PATH = `${process.env.HOME}/.parallel-discussion.db`;

// PARALLEL_DISCUSSION_DB takes precedence. Otherwise we keep an existing
// legacy file (pre-HOME_DIR layout) where it is — never silently move user
// data — and only fall through to the unified path on a fresh install.
export const DB_PATH = (() => {
  if (process.env.PARALLEL_DISCUSSION_DB) {
    return process.env.PARALLEL_DISCUSSION_DB;
  }
  if (existsSync(LEGACY_DB_PATH)) return LEGACY_DB_PATH;
  return `${HOME_DIR}/db.sqlite`;
})();

// REQUESTS.md persists CC's "I want to express X but the API can't" feedback.
// Defaults next to the broker source for development; tests / packaged
// installs override via env.
export const REQUESTS_FILE =
  process.env.PARALLEL_DISCUSSION_REQUESTS_FILE ??
  new URL("../REQUESTS.md", import.meta.url).pathname;

// Public URL surfaced in `create_board` responses. Override when the broker is
// reached through Tailscale Serve / a reverse proxy / a custom hostname so
// users don't get a localhost URL they can't open.
export const PUBLIC_URL =
  process.env.PARALLEL_DISCUSSION_PUBLIC_URL ?? `http://localhost:${PORT}`;

export const UPLOADS_DIR = path.join(HOME_DIR, "uploads");
export const ALLOWED_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// /submit-answer waits this long for the receiving CC to actually pick up the
// pending message. Short enough that the user can retype quickly when no one
// is listening, long enough that a normal 1Hz poll reliably hits.
export const SUBMIT_DELIVERY_TIMEOUT_MS = 8_000;

// Auto-activity watchdog: if no PreToolUse heartbeat arrives within this
// window, the badge self-clears. Primary clearing is the Stop hook (turn end);
// this is a safety net for cases where Stop never fires (CC crash mid-turn).
export const AUTO_ACTIVITY_TIMEOUT_MS = 60_000;

// Side-effect: ensure HOME_DIR and the DB's parent dir exist before
// bun:sqlite touches the file. mkdir is idempotent (recursive).
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
