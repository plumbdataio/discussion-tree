import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// A sibling MCP server under the same CC (e.g. claude-peers) shares the CC's
// PID. It pings /heartbeat-cc-pid with that pid to light dt's "working" spinner
// for a peer-triggered turn dt has no hook for. The broker resolves cc_pid ->
// the one alive session and marks it working.

let broker: BrokerHandle;
let sessionId: string;
const CC_PID = 654321; // the (fake) owning CC process pid shared with siblings

beforeAll(async () => {
  broker = await startBroker();
  // Register WITH cc_pid (the dt MCP server forwards process.ppid here).
  const r = await post<{ session_id: string }>(`${broker.url}/register`, {
    pid: 99123,
    cwd: "/tmp/pd-ccpid",
    cc_pid: CC_PID,
  });
  sessionId = r.json.session_id;
  // Attach so the session isn't hidden as a husk in /api/sessions.
  await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

async function activityState(sid: string): Promise<string | undefined> {
  const res = await get<{
    sessions: { id: string; activity?: { state: string } | null }[];
  }>(`${broker.url}/api/sessions`);
  return res.json.sessions.find((s) => s.id === sid)?.activity?.state;
}

describe("/heartbeat-cc-pid (sibling MCP -> working spinner)", () => {
  test("marks the matching session working", async () => {
    expect(await activityState(sessionId)).toBeUndefined();
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-cc-pid`, {
      cc_pid: CC_PID,
    });
    expect(r.json.ok).toBe(true);
    expect(await activityState(sessionId)).toBe("working");
    // reset for isolation
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: "x" });
  });

  test("unknown cc_pid is a no-op", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-cc-pid`, {
      cc_pid: 111111,
    });
    expect(r.json.ok).toBe(false);
  });

  test("non-numeric cc_pid is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-cc-pid`, {
      cc_pid: "not-a-pid",
    });
    expect(r.json.ok).toBe(false);
  });
});
