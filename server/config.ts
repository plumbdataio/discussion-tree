import { fileURLToPath } from "node:url";

// MCP-server side configuration. Mirrors broker/config.ts in spirit, but
// only carries the values server.ts itself needs (port for talking to the
// broker, polling cadences, the broker script path for auto-spawn).

export const BROKER_PORT = parseInt(
  process.env.DISCUSSION_TREE_PORT ?? "7898",
  10,
);

// Which broker this MCP server talks to. Loopback by default — the broker is a
// per-machine singleton and that is the only case with no network in it.
//
// DISCUSSION_TREE_BROKER_URL points a CC on ANOTHER machine at a broker running
// here, so that session appears in the UI like a local one: same boards, same
// delivery, same channel messages. The broker already does not care where a
// request came from; what stopped it was this constant and the auto-spawn
// below. Set the broker's own DISCUSSION_TREE_BIND to something reachable
// (Tailscale) — that side has NO authentication, so whatever can reach the port
// can drive every tool.
export const BROKER_URL = (
  process.env.DISCUSSION_TREE_BROKER_URL ?? `http://127.0.0.1:${BROKER_PORT}`
).replace(/\/+$/, "");

// A remote broker is somebody else's process: it is not ours to start, and
// spawning a LOCAL one on this machine would be worse than failing — the
// session would quietly attach to an empty second broker and none of its boards
// would be where the user is looking.
export const BROKER_IS_REMOTE = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(
  BROKER_URL,
);

// How often we drain pending_messages from the broker. 1Hz is the contract
// /submit-answer's 8s timeout was tuned against — bumping this would change
// the perceived submit latency.
export const POLL_INTERVAL_MS = 1000;
// Keeps the session row's last_seen fresh so cleanStaleSessions doesn't
// soft-delete us. Defined in shared/config.ts because the broker sizes its
// remote-liveness window off the same interval — they must not drift.
export { HEARTBEAT_INTERVAL_MS } from "../shared/config.ts";

// Hard ceiling on any single broker HTTP call. Broker ops are loopback SQLite
// reads/writes (sub-100ms normally), so this only ever trips when the broker is
// genuinely wedged (mid-restart but not yet serving, or the machine is
// thrashing). Without it a stuck call hangs forever — a poll never returns, a
// tool call never resolves — and the MCP server looks unresponsive to Claude
// Code. With it, a wedged call throws and the caller's existing error handling
// (retry next tick / surface an MCP error) takes over.
export const BROKER_FETCH_TIMEOUT_MS = 20_000;

// After this many CONSECUTIVE failed heartbeats (~broker unreachable for
// HEARTBEAT_INTERVAL_MS * N), a session tries to relaunch the broker itself via
// ensureBroker(). N is chosen so the window (~45s) is far longer than a normal
// restart's sub-second downtime, so this never races a deploy — it only fires
// on a broker that has actually stayed down.
export const BROKER_RESPAWN_AFTER_FAILS = 3;

// Resolved relative to this file so the auto-spawn works regardless of cwd.
// fileURLToPath, NOT .pathname: on Windows the latter yields "/C:/Users/..."
// with a leading slash, which Bun.spawn cannot resolve as a module path — so
// the auto-spawn fails there and nothing says why. Identical on POSIX.
//
// This fix lived only as an uncommitted edit on the Windows machine, which
// meant every checkout there needed re-patching by hand. It belongs upstream.
export const BROKER_SCRIPT = fileURLToPath(
  new URL("../broker.ts", import.meta.url),
);
