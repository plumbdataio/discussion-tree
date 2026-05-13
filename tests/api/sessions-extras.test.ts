import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

describe("/api/sessions inactive list", () => {
  test("dead sessions with no boards are NOT surfaced in inactive_sessions", async () => {
    const s = await registerSession(broker.url, "/tmp/empty-dead");
    await post(`${broker.url}/unregister`, { session_id: s });
    const r = await get<{ inactive_sessions: any[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(r.json.inactive_sessions.find((x: any) => x.id === s)).toBeFalsy();
  });

  test("dead sessions that own at least one non-archived board DO surface", async () => {
    const s = await registerSession(broker.url, "/tmp/dead-with-board");
    await attachCC(broker.url, s);
    await post(`${broker.url}/create-board`, {
      session_id: s,
      structure: {
        title: "kept",
        concerns: [{ id: "x", title: "x" }],
      },
    });
    await post(`${broker.url}/unregister`, { session_id: s });
    const r = await get<{ inactive_sessions: any[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(r.json.inactive_sessions.find((x: any) => x.id === s)).toBeTruthy();
  });

  test("ordering: alive sessions appear in /api/sessions.sessions", async () => {
    const a = await registerSession(broker.url, "/tmp/alive-order-a");
    const b = await registerSession(broker.url, "/tmp/alive-order-b");
    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const ids = r.json.sessions.map((s) => s.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  test("setting an empty session name persists empty (not null)", async () => {
    const s = await registerSession(broker.url, "/tmp/name-empty");
    await post(`${broker.url}/set-session-name`, {
      session_id: s,
      name: "",
    });
    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = r.json.sessions.find((x: any) => x.id === s);
    expect(me?.name).toBe("");
  });

  test("cc_session_id is exposed in /api/sessions sessions", async () => {
    const s = await registerSession(broker.url, "/tmp/cc-exposed");
    const cc = `cc-exposed-${Math.random().toString(36).slice(2)}`;
    await attachCC(broker.url, s, cc);
    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = r.json.sessions.find((x: any) => x.id === s);
    expect(me?.cc_session_id).toBe(cc);
  });
});

describe("create-board reachability gate", () => {
  test("create-board fails on a session bound to a dead cc-session (no attach-cc-session)", async () => {
    const s = await registerSession(broker.url, "/tmp/no-cc");
    const r = await post<{ error?: string }>(`${broker.url}/create-board`, {
      session_id: s,
      structure: {
        title: "X",
        concerns: [{ id: "x", title: "x" }],
      },
    });
    expect(r.json.error).toMatch(/attach_cc_session/i);
  });

  test("create-board with empty concerns array works and produces a board with 0 nodes", async () => {
    const s = await registerSession(broker.url, "/tmp/empty-concerns");
    await attachCC(broker.url, s);
    const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: s,
      structure: { title: "Empty", concerns: [] },
    });
    expect(r.json.board_id).toMatch(/^bd_/);
    const v = await get<any>(`${broker.url}/api/board/${r.json.board_id}`);
    expect(v.json.nodes.length).toBe(0);
  });
});

describe("submit-answer reachability gate", () => {
  test("submit-answer fails with no_recipient when owner session is dead", async () => {
    const s = await registerSession(broker.url, "/tmp/dead-submit");
    await attachCC(broker.url, s);
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: s,
      structure: {
        title: "Dead-owner board",
        concerns: [{ id: "x", title: "x", items: [{ id: "i", title: "i" }] }],
      },
    });
    // Kill the owner.
    await post(`${broker.url}/unregister`, { session_id: s });
    const r = await post<{ ok: boolean; reason?: string }>(
      `${broker.url}/submit-answer`,
      {
        board_id: c.json.board_id,
        node_id: "i",
        text: "hello?",
      },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("no_recipient");
  });
});
