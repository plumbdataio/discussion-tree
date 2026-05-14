import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Force the broker's stale-session sweep to fire every 100 ms so the test
// can observe the soft-delete deterministically (default is 30s).
let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker({ PARALLEL_DISCUSSION_STALE_SWEEP_MS: "100" });
});
afterAll(async () => {
  await broker.kill();
});

// Pick a PID extremely unlikely to exist on the host. macOS pid_max is 99998
// by default, so 999999 is guaranteed-dead for `process.kill(pid, 0)`.
const DEAD_PID = 999_999;

describe("cleanStaleSessions sweep", () => {
  test("soft-deletes sessions whose PID no longer exists", async () => {
    // Register with a dead PID. Heartbeats are not enough on their own —
    // the sweep checks `process.kill(pid, 0)`, which fails for non-existent
    // PIDs regardless of how recently last_seen was updated.
    const reg = await post<{ session_id: string }>(
      `${broker.url}/register`,
      { pid: DEAD_PID, cwd: "/tmp/clean-stale-test" },
    );
    expect(reg.status).toBe(200);
    const sid = reg.json.session_id;

    // Wait long enough for at least 2 sweep ticks (100ms each).
    await new Promise((r) => setTimeout(r, 350));

    // The session should now appear under inactive_sessions (alive=0) OR
    // be missing from the alive list. inactive list filters to sessions
    // with at least one non-archived board, so without a board we just
    // need to confirm the session is NOT in `sessions`.
    const r = await get<{ sessions: any[]; inactive_sessions: any[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(r.status).toBe(200);
    expect(r.json.sessions.find((s) => s.id === sid)).toBeFalsy();
  });

  test("leaves sessions backed by a live PID alone", async () => {
    // Our own process is definitely alive; register with our PID and verify
    // the sweep does NOT soft-delete it.
    const reg = await post<{ session_id: string }>(
      `${broker.url}/register`,
      { pid: process.pid, cwd: "/tmp/clean-stale-live" },
    );
    const sid = reg.json.session_id;

    await new Promise((r) => setTimeout(r, 350));

    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    expect(r.json.sessions.find((s) => s.id === sid)).toBeTruthy();
  });
});
