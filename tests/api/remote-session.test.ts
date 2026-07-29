import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  attachCC,
  get,
  post,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// A CC on ANOTHER machine, pointed at this broker over the network so it shows
// up in the UI like any local session. The thing that breaks first is liveness:
// the stale sweep asks THIS machine's OS whether a pid is running, and a remote
// pid either does not exist here (the session is swept away while perfectly
// alive — after which /submit-answer refuses to deliver to it) or collides with
// an unrelated local process (a dead session that never leaves). So a remote
// session is judged by its heartbeat instead.

let broker: BrokerHandle;

beforeAll(async () => {
  // Sweep fast, and treat a remote session as gone after a very short silence,
  // so both halves are observable without sleeping for a minute.
  broker = await startBroker({
    DISCUSSION_TREE_STALE_SWEEP_MS: "100",
    DISCUSSION_TREE_REMOTE_TIMEOUT_MS: "400",
  });
});
afterAll(async () => {
  await broker.kill();
});

const aliveIds = async () =>
  (
    await get<{ sessions: { id: string }[] }>(`${broker.url}/api/sessions`)
  ).json.sessions.map((s) => s.id);

const register = async (remote: boolean) => {
  const id = (
    await post<{ session_id: string }>(`${broker.url}/register`, {
      // A pid that is certainly not running here.
      pid: 999_999,
      cwd: remote ? "C:\\Users\\pekehata\\work" : "/tmp/pd-test",
      remote,
    })
  ).json.session_id;
  // /api/sessions only lists sessions that have something to show; attaching
  // creates the default conversation board, which is what a real one would have
  // within a second of starting anyway.
  await attachCC(broker.url, id);
  return id;
};

describe("remote sessions — liveness comes from the heartbeat", () => {
  test("a local session with a dead pid is swept, a remote one is not", async () => {
    const local = await register(false);
    const remote = await register(true);
    await new Promise((r) => setTimeout(r, 250));
    const alive = await aliveIds();
    // Same impossible pid, opposite outcomes — which is the whole point.
    expect(alive).not.toContain(local);
    expect(alive).toContain(remote);
  });

  test("a remote session that stops beating does go away", async () => {
    const remote = await register(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(await aliveIds()).not.toContain(remote);
  });

  test("beating keeps it alive across sweeps", async () => {
    const remote = await register(true);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await post(`${broker.url}/heartbeat`, { session_id: remote });
    }
    expect(await aliveIds()).toContain(remote);
  });
});
