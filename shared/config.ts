// Runtime config shared between the MCP server (which SENDS heartbeats) and the
// broker (which decides when a remote session that STOPPED sending them is gone).
//
// It lives here, in one place, so the two cannot drift: the broker sizes its
// remote-liveness window as a MULTIPLE of this interval (REMOTE_MISS_LIMIT beats),
// so changing the rate here moves the window with it automatically.
export const HEARTBEAT_INTERVAL_MS = 10_000;
