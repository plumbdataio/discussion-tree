// Bridge between the SessionStart hook and the broker.
//
// The hook (scripts/session-start-hook.sh) writes a small JSON file keyed by
// CC's PID into <state-dir>/cc-sessions/. From the hook's POV $PPID is CC;
// from this MCP server's POV process.ppid is also CC, so the two sides
// agree on the filename.
//
// The file is KEPT after a successful attach. It used to be deleted, on the
// assumption of at most one attach per CC start — but an MCP server can restart
// while CC keeps running (`/mcp` reconnects it, and it is the cheapest way to
// pick up new tools). SessionStart does not fire for that, so no new hint is
// written, and the old one was already gone: the reconnected server had no way
// to learn its own cc_session_id, registered an unbound session, and left the
// user's boards behind. Both observed on 2026-07-28; the only fix was
// restarting CC.
//
// Keeping it is safe because attaching is idempotent — the broker reclaims the
// previous session's boards, exactly as it does across a CC restart. The one
// real hazard is PID reuse: a NEW CC inheriting a dead one's PID would read a
// stale card. The DIRECT hint (named by our ppid) is guarded by age alone —
// HINT_MAX_AGE_MS — because gating it on cwd would break a `/cd` + `/mcp`
// reconnect (same pid, new cwd); the cwd-fallback scan still requires a cwd
// match. See directHintCcId for the full recycled-pid tradeoff.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brokerFetch } from "./broker-client.ts";
import { log } from "./log.ts";
import { getSessionId, setAttachedCcId } from "./state.ts";

export function hintFilePath(): string {
  const ccPid = process.ppid;
  // Resolves the same way the hook does — DISCUSSION_TREE_HOME wins,
  // else default. CC inherits the env, so when the user overrides it the
  // hook and this lookup stay in sync.
  const homeDir =
    process.env.DISCUSSION_TREE_HOME ??
    path.join(os.homedir(), ".discussion-tree");
  return path.join(homeDir, "cc-sessions", `${ccPid}.json`);
}

// Read the CC session id from the SessionStart hook's hint file. Returns
// null when the file doesn't exist, is empty, or the JSON is malformed —
// any of those is treated as "no hint, nothing to attach to right now".
// A hint older than this is treated as not ours. Long enough that a CC running
// for days still re-attaches on an MCP restart, short enough that a recycled PID
// is very unlikely to land on a card still inside the window.
const HINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Hint = { cc_session_id?: string; cwd?: string; written_at?: number };

// Parse one hint file, applying only the age check — a stale card is never ours
// no matter how we found it. Returns null on missing / malformed / expired.
function parseHintFile(file: string): Hint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Hint;
    if (!parsed.cc_session_id) return null;
    if (
      typeof parsed.written_at === "number" &&
      Date.now() - parsed.written_at * 1000 > HINT_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Raw parse — JSON only, no validity/age filtering. Used for the DIRECT hint so
// the whole accept/reject decision lives in directHintCcId (below), the single,
// unit-tested source of truth for the recycled-pid tradeoff.
function parseHintFileRaw(file: string): Hint | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Hint;
  } catch {
    return null;
  }
}

// Decide whether the DIRECT hint (the file whose name == our ppid) is ours.
// Accept its cc_session_id whenever it is present and fresh, EVEN IF its
// recorded cwd no longer equals process.cwd(). The ppid match is a strong
// signal the hint came from OUR CC: an MCP server is CC's direct child, so the
// hint named by our ppid was written by the CC that owns us. That CC may have
// just run `/cd` (changing its cwd) and then `/mcp` (re-spawning us) — the hint
// still carries the OLD cwd, so gating on cwd here would wrongly reject it and
// leave the session unbound. That `/cd` + `/mcp` breakage is exactly what this
// relaxation fixes.
//
// Recycled-pid tradeoff: a stale hint left by a PREVIOUS CC that happened to be
// assigned the SAME pid could now be accepted despite a cwd change — the case
// the old cwd guard was there to catch. The age check (HINT_MAX_AGE_MS) is the
// remaining mitigation: a recycled pid landing on a card still inside the
// window is very unlikely. The cwd-equality requirement is KEPT for the
// readHintByCwd fallback below, which matches hints from OTHER pids by cwd.
export function directHintCcId(hint: Hint | null, now: number): string | null {
  if (!hint?.cc_session_id) return null;
  if (
    typeof hint.written_at === "number" &&
    now - hint.written_at * 1000 > HINT_MAX_AGE_MS
  ) {
    return null;
  }
  return hint.cc_session_id;
}

export function readHintCcId(): string | null {
  // Fast path: the file named by our parent PID. On macOS / Linux the hook's
  // $PPID and this server's process.ppid are both Claude Code, so the filename
  // agrees. We accept it by ppid + freshness alone (NOT cwd — see directHintCcId)
  // so a `/cd` + `/mcp` reconnect (same pid, new cwd) still binds.
  const file = hintFilePath();
  const direct = fs.existsSync(file) ? parseHintFileRaw(file) : null;
  const directId = directHintCcId(direct, Date.now());
  if (directId) return directId;
  // Fallback: match by CWD. On Windows the hook does NOT share our PID — Claude
  // Code runs it through a wrapper, so its $PPID / process.ppid is that wrapper
  // (or 1, from bash mis-reading $PPID) and it writes <wrapper>.json, never
  // <CC-pid>.json; only THIS MCP server is CC's direct child. So the by-PID
  // lookup finds nothing and the session never binds — observed on pd-002
  // 2026-07-30 (the hook wrote 26540.json / 1.json while this server's ppid was
  // 14988). The hint still records CC's cwd, which is ours, so the most-recent
  // hint written for this working directory is this CC's.
  return readHintByCwd();
}

// The most-recent hint whose recorded cwd is ours. This fallback keys on cwd
// (not the PID) to catch hints written by OTHER pids — the Windows wrapper case
// above — so cwd equality is still required here, unlike the direct fast path.
function readHintByCwd(): string | null {
  const dir = path.dirname(hintFilePath());
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: Hint | null = null;
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const h = parseHintFile(path.join(dir, name));
    if (!h?.cc_session_id || h.cwd !== process.cwd()) continue;
    if (!best || (h.written_at ?? 0) > (best.written_at ?? 0)) best = h;
  }
  return best?.cc_session_id ?? null;
}

// The CC process's tmux pane/socket, read from THIS process's env — the MCP
// server runs inside the same tmux pane as Claude Code, so $TMUX_PANE / $TMUX
// describe CC's pane. Null when CC wasn't launched inside tmux. Forwarded to
// the broker so the WebUI can inject a TUI command (e.g. /compact) into it.
function tmuxEnv(): { pane: string | null; socket: string | null } {
  const pane = process.env.TMUX_PANE || null;
  // $TMUX = "<socket_path>,<server_pid>,<session_id>"; the socket is field 1.
  const socket = process.env.TMUX
    ? process.env.TMUX.split(",")[0] || null
    : null;
  return { pane, socket };
}

// One POST to /attach-cc-session. Returns true on success, false on any
// failure. Does NOT throw — caller decides whether to retry.
async function attemptAttach(ccId: string): Promise<boolean> {
  const sid = getSessionId();
  if (!sid) return false;
  const { pane, socket } = tmuxEnv();
  try {
    await brokerFetch("/attach-cc-session", {
      session_id: sid,
      cc_session_id: ccId,
      tmux_pane: pane,
      tmux_socket: socket,
    });
    return true;
  } catch {
    return false;
  }
}

// Called from main() at startup. Polls briefly for the hook hint, then
// retries the attach a few times with exponential backoff to ride out a
// momentary broker startup race.
//
// Resolves to true if attach landed (state has been updated, hint file
// unlinked), false otherwise. The caller (server.ts) is responsible for
// notifying the user via channel push when this returns false.
export async function tryAutoAttach(): Promise<boolean> {
  const file = hintFilePath();
  // The SessionStart hook and this MCP server are both spawned by Claude
  // Code at startup, in parallel — if main() reaches here before the hook
  // finishes writing, a single existsSync would miss the file and we'd
  // skip the bind for the entire CC session. Poll briefly so the bind
  // catches the file as soon as it lands.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ccId = readHintCcId();
  if (!ccId) return false;

  // Retry: cover the case where the broker is up but momentarily refusing
  // the HTTP request (just restarted, GC pause, etc). Backoff 0 / 500ms /
  // 1s / 2s — total ~3.5s extra on top of the 5s polling above.
  const backoffMs = [0, 500, 1000, 2000];
  for (let i = 0; i < backoffMs.length; i++) {
    if (backoffMs[i] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[i]));
    }
    if (await attemptAttach(ccId)) {
      setAttachedCcId(ccId);
      log(
        `Auto-attached to CC session ${ccId} via hook hint (attempt ${i + 1})`,
      );
      // Deliberately NOT deleted — see the note at the top of this file.
      return true;
    }
    log(`Auto-attach attempt ${i + 1} for ${ccId} failed, retrying`);
  }
  log(`Auto-attach gave up for ${ccId} after ${backoffMs.length} attempts`);
  return false;
}

// Heartbeat-driven self-healing. Called once per heartbeat tick from
// server.ts. Cheap on the happy path (= broker still has the binding;
// nothing to do, no extra I/O). When the broker reports a null
// cc_session_id binding, we re-read the hint and try ONE attach — the
// next heartbeat retries if this one fails, so retry-on-failure stays
// out of the heartbeat critical path.
//
// Returns the ccId we just attached to (= caller should notify the
// user), or null if nothing changed.
export async function selfHealAttachOnce(
  brokerSideCcId: string | null,
): Promise<string | null> {
  if (brokerSideCcId) return null;
  const ccId = readHintCcId();
  if (!ccId) return null;
  if (!(await attemptAttach(ccId))) return null;
  setAttachedCcId(ccId);
  return ccId;
}
