import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// A CC that starts and exits without ever conversing (CLI or DT) owns only its
// auto-created, empty default board. Once the stale sweep flips it to alive=0
// it must NOT linger in the sidebar as a husk — handleListSessions surfaces a
// dead session only if it holds real content (a non-default board, or a
// default board with at least one message).

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

async function inactiveIds(): Promise<string[]> {
  const r = await get<any>(`${broker.url}/api/sessions`);
  return (r.json.inactive_sessions ?? []).map((s: any) => s.id);
}
async function defaultBoardId(sessionId: string): Promise<string> {
  const r = await get<any>(`${broker.url}/api/sessions`);
  const all = [
    ...(r.json.sessions ?? []),
    ...(r.json.inactive_sessions ?? []),
  ];
  const s = all.find((x: any) => x.id === sessionId);
  const b = s.boards.find((x: any) => x.is_default === 1);
  return b.id;
}

describe("dead-session husk filtering", () => {
  test("a dead session with only an empty default board is NOT surfaced", async () => {
    const s = await registerSession(broker.url, "/tmp/husk-a");
    await attachCC(broker.url, s); // creates the empty default board
    await post(`${broker.url}/unregister`, { session_id: s });
    expect(await inactiveIds()).not.toContain(s);
  });

  test("a dead session that owns a non-default board IS surfaced", async () => {
    const s = await registerSession(broker.url, "/tmp/husk-b");
    await attachCC(broker.url, s);
    await post(`${broker.url}/create-board`, {
      session_id: s,
      structure: {
        title: "Real",
        concerns: [{ id: "c", title: "C", items: [{ id: "i", title: "I" }] }],
      },
    });
    await post(`${broker.url}/unregister`, { session_id: s });
    expect(await inactiveIds()).toContain(s);
  });

  test("a dead session whose default board has a message IS surfaced", async () => {
    const s = await registerSession(broker.url, "/tmp/husk-c");
    await attachCC(broker.url, s);
    const bid = await defaultBoardId(s);
    await post(`${broker.url}/post-to-node`, {
      board_id: bid,
      node_id: "main",
      message: "a real conversation happened here",
      status: "discussing",
    });
    await post(`${broker.url}/unregister`, { session_id: s });
    expect(await inactiveIds()).toContain(s);
  });
});

describe("alive-session husk filtering", () => {
  async function aliveIds(): Promise<string[]> {
    const r = await get<any>(`${broker.url}/api/sessions`);
    return (r.json.sessions ?? []).map((s: any) => s.id);
  }

  test("a bare registration (no board, no name) is NOT in the active list", async () => {
    const s = await registerSession(broker.url, "/tmp/alive-husk-a");
    expect(await aliveIds()).not.toContain(s);
  });

  test("a named alive session with no board IS in the active list", async () => {
    const s = await registerSession(broker.url, "/tmp/alive-husk-b");
    await post(`${broker.url}/set-session-name`, { session_id: s, name: "N" });
    expect(await aliveIds()).toContain(s);
  });

  test("an attached alive session (default board) IS in the active list", async () => {
    const s = await registerSession(broker.url, "/tmp/alive-husk-c");
    await attachCC(broker.url, s);
    expect(await aliveIds()).toContain(s);
  });
});
