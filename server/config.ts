// MCP-server side configuration. Mirrors broker/config.ts in spirit, but
// only carries the values server.ts itself needs (port for talking to the
// broker, polling cadences, the broker script path for auto-spawn).

export const BROKER_PORT = parseInt(
  process.env.DISCUSSION_TREE_PORT ?? "7898",
  10,
);
export const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// How often we drain pending_messages from the broker. 1Hz is the contract
// /submit-answer's 8s timeout was tuned against — bumping this would change
// the perceived submit latency.
export const POLL_INTERVAL_MS = 1000;
// Just keeps the session row's last_seen fresh so cleanStaleSessions doesn't
// soft-delete us.
export const HEARTBEAT_INTERVAL_MS = 15_000;

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
export const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
