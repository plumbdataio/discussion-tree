// MCP-server side configuration. Mirrors broker/config.ts in spirit, but
// only carries the values server.ts itself needs (port for talking to the
// broker, polling cadences, the broker script path for auto-spawn).

export const BROKER_PORT = parseInt(
  process.env.PARALLEL_DISCUSSION_PORT ?? "7898",
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

// Resolved relative to this file so the auto-spawn works regardless of cwd.
export const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
