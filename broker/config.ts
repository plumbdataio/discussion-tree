// Centralized broker configuration. Resolves env vars once at module load and
// is imported by every handler that needs a path or limit. Keeping the
// resolution logic in one place means env-var changes only require touching
// this file (and the README's configuration table).

import * as fs from "node:fs";
import * as path from "node:path";

export const PORT = parseInt(
  process.env.DISCUSSION_TREE_PORT ?? "7898",
  10,
);

// DISCUSSION_TREE_HOME is the umbrella state directory. Default:
// $HOME/.discussion-tree. The MCP server, broker, and SessionStart hook
// all read this same env so a shell-level override flows everywhere.
// os.homedir() — not process.env.HOME — because HOME is unset on
// stock Windows shells (would land us at "undefined/.discussion-tree").
import { homedir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_INTERVAL_MS } from "../shared/config.ts";
export const HOME_DIR =
  process.env.DISCUSSION_TREE_HOME ?? join(homedir(), ".discussion-tree");

// DISCUSSION_TREE_DB takes precedence; otherwise the DB lives at the unified
// path under HOME_DIR.
export const DB_PATH =
  process.env.DISCUSSION_TREE_DB ?? `${HOME_DIR}/db.sqlite`;

// REQUESTS.md persists CC's "I want to express X but the API can't" feedback.
// Defaults next to the broker source for development; tests / packaged
// installs override via env.
export const REQUESTS_FILE =
  process.env.DISCUSSION_TREE_REQUESTS_FILE ??
  new URL("../REQUESTS.md", import.meta.url).pathname;

// Public URL surfaced in `create_board` responses. Override when the broker is
// reached through Tailscale Serve / a reverse proxy / a custom hostname so
// users don't get a localhost URL they can't open.
export const PUBLIC_URL =
  process.env.DISCUSSION_TREE_PUBLIC_URL ?? `http://localhost:${PORT}`;

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

// A running subagent (Task worker) is considered live only while its last tool
// heartbeat is younger than this. Deliberately MUCH longer than the "working"
// window above: a subagent can sit minutes inside a single long tool call (a
// big test run, a slow build) or between tool calls while the model thinks, and
// a 60s window would flicker the indicator off mid-run. The primary clear path
// is the SubagentStop hook; this is the backstop for when it never fires (the
// subagent's parent crashed, or SubagentStop didn't run), so a leaked
// subagent-running marker disappears on its own within ~3 minutes of the last
// tool call. Override via DT_SUBAGENT_TIMEOUT_MS (used by tests).
export const SUBAGENT_TIMEOUT_MS = process.env.DT_SUBAGENT_TIMEOUT_MS
  ? parseInt(process.env.DT_SUBAGENT_TIMEOUT_MS, 10)
  : 180_000;

// How often broker.ts re-checks every alive session's PID and soft-deletes
// rows whose process is gone. Runs about once per heartbeat interval so a
// remote session that stopped beating is noticed promptly (the timeout below is
// what decides "gone"; this is just how often we look). Tests override to
// ~100ms via the env var so they can observe the soft-delete deterministically.
export const STALE_SESSION_SWEEP_MS = parseInt(
  process.env.DISCUSSION_TREE_STALE_SWEEP_MS ?? "10000",
  10,
);

// A REMOTE session (a CC on another machine, talking to this broker over the
// network) is judged dead by MISSED HEARTBEATS, not an absolute clock: its pid
// means nothing on this machine, so the heartbeat is the only signal that
// crosses. Tolerate REMOTE_MISS_LIMIT missed beats before evicting — enough that
// a brief laptop lid or Tailscale reconnect does not evict a live session (and
// even if one is evicted, it self-recovers on its next beat — see
// handleHeartbeat), short enough that a genuinely gone one stops being offered
// as a recipient. Sized off HEARTBEAT_INTERVAL_MS so the window scales with the
// beat rate instead of drifting when it changes.
export const REMOTE_MISS_LIMIT = 3;
export const REMOTE_SESSION_TIMEOUT_MS = process.env
  .DISCUSSION_TREE_REMOTE_TIMEOUT_MS
  ? parseInt(process.env.DISCUSSION_TREE_REMOTE_TIMEOUT_MS, 10)
  : HEARTBEAT_INTERVAL_MS * REMOTE_MISS_LIMIT;

// Side-effect: ensure HOME_DIR and the DB's parent dir exist before
// bun:sqlite touches the file. mkdir is idempotent (recursive).
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
