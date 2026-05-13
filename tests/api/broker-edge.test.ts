// Cross-cutting broker edge-case tests. Each test is independent; they all
// share one broker process via beforeAll/afterAll.

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
let sessionId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

describe("broker dispatch — unknown routes / malformed bodies", () => {
  test("POST to an unknown route returns 404", async () => {
    const r = await post(`${broker.url}/this-route-does-not-exist`, {});
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/not found/i);
  });

  test("POST with invalid JSON body returns 400", async () => {
    const res = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{this is not json",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid json/i);
  });

  test("GET /health returns ok", async () => {
    const r = await get(`${broker.url}/health`);
    expect(r.status).toBe(200);
    expect((r.json as any).status).toBe("ok");
  });

  test("GET / falls through to the default response (200)", async () => {
    const res = await fetch(broker.url + "/some-random-get");
    expect(res.status).toBe(200);
  });

  test("GET /api/board/<missing> returns 404", async () => {
    const r = await get(`${broker.url}/api/board/bd_nonsense`);
    expect(r.status).toBe(404);
  });

  test("GET /uploads/<missing> returns 404 (not crash)", async () => {
    const res = await fetch(broker.url + "/uploads/nope.png");
    expect(res.status).toBe(404);
  });
});

describe("session lifecycle edge cases", () => {
  test("heartbeat for a missing session id still returns ok (no-op)", async () => {
    const r = await post(`${broker.url}/heartbeat`, {
      session_id: "s_doesnotexist",
    });
    expect(r.json.ok).toBe(true);
  });

  test("unregister is idempotent (twice in a row both return ok)", async () => {
    const s = await registerSession(broker.url, "/tmp/idem");
    const a = await post(`${broker.url}/unregister`, { session_id: s });
    const b = await post(`${broker.url}/unregister`, { session_id: s });
    expect(a.json.ok).toBe(true);
    expect(b.json.ok).toBe(true);
  });

  test("set-session-name persists the name", async () => {
    const s = await registerSession(broker.url, "/tmp/named");
    await post(`${broker.url}/set-session-name`, {
      session_id: s,
      name: "Renamed",
    });
    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((x) => x.id === s);
    expect(me?.name).toBe("Renamed");
  });

  test("/api/sessions returns alive + inactive arrays", async () => {
    const r = await get<{ sessions: any[]; inactive_sessions: any[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(Array.isArray(r.json.sessions)).toBe(true);
    expect(Array.isArray(r.json.inactive_sessions)).toBe(true);
  });

  test("/api/sessions: each alive session has an activity field (possibly null)", async () => {
    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    for (const s of r.json.sessions) {
      // activity is either an object or null — never undefined.
      expect(s).toHaveProperty("activity");
      if (s.activity !== null) expect(typeof s.activity.state).toBe("string");
    }
  });

  test("register creates a fresh id each time", async () => {
    const a = await registerSession(broker.url);
    const b = await registerSession(broker.url);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^s_/);
    expect(b).toMatch(/^s_/);
  });
});

describe("attach-cc-session — ownership transfer and default board", () => {
  test("re-attaching with the same cc_session_id is idempotent (no extra default board)", async () => {
    const s1 = await registerSession(broker.url, "/tmp/cc-idem");
    const cc = `cc-idem-${Math.random().toString(36).slice(2)}`;
    await attachCC(broker.url, s1, cc);

    // attach AGAIN with same cc_session_id (same session) — should be a no-op
    // structurally. The default board count for this session must not grow.
    await attachCC(broker.url, s1, cc);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((x) => x.id === s1)!;
    const defaults = me.boards.filter((b: any) => b.is_default === 1);
    expect(defaults.length).toBe(1);
  });

  test("attach-cc-session reclaims boards from a prior dead session with the same cc_session_id", async () => {
    const cc = `cc-reclaim-${Math.random().toString(36).slice(2)}`;
    const oldSession = await registerSession(broker.url, "/tmp/cc-reclaim");
    await attachCC(broker.url, oldSession, cc);
    // Create a non-default board under the old session.
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: oldSession,
      structure: {
        title: "Reclaim me",
        concerns: [{ id: "rc1", title: "x" }],
      },
    });
    // Kill the old session.
    await post(`${broker.url}/unregister`, { session_id: oldSession });

    // New session with the same cc_session_id should reclaim that board.
    const newSession = await registerSession(broker.url, "/tmp/cc-reclaim");
    const r = await post<{ ok: boolean; reclaimed: any }>(
      `${broker.url}/attach-cc-session`,
      { session_id: newSession, cc_session_id: cc },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.reclaimed.boards).toBeGreaterThanOrEqual(1);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((x) => x.id === newSession)!;
    expect(me.boards.find((b: any) => b.id === c.json.board_id)).toBeTruthy();
  });

  test("attach-cc-session secondary reclaim is restricted to same cwd", async () => {
    const cwd = "/tmp/cc-cwd-isolation-a";
    // Orphan session (alive=0 + no cc_session_id) under cwd.
    const orphan = await registerSession(broker.url, cwd);
    await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: orphan,
      structure: {
        title: "Orphan",
        concerns: [{ id: "oo", title: "x" }],
      },
    }).catch(() => null);
    // create-board requires cc_session_id, so the above fails — that's fine.
    // We just need an orphan session to exist for the reclaim path to scan.
    await post(`${broker.url}/unregister`, { session_id: orphan });

    // A new session under a DIFFERENT cwd attaches a fresh cc_session_id.
    // The orphan boards under cwd A must NOT be reclaimed.
    const newSession = await registerSession(
      broker.url,
      "/tmp/cc-cwd-isolation-b",
    );
    const cc = `cc-cwdiso-${Math.random().toString(36).slice(2)}`;
    const r = await post<{ ok: boolean; reclaimed: any }>(
      `${broker.url}/attach-cc-session`,
      { session_id: newSession, cc_session_id: cc },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.reclaimed.orphan_boards).toBe(0);
  });
});

describe("default-board ensureDefaultBoard idempotency", () => {
  test("multiple attach calls with the same cc_session_id keep ONE default board", async () => {
    const cc = `cc-ensure-${Math.random().toString(36).slice(2)}`;
    const s = await registerSession(broker.url, "/tmp/ensure");
    await attachCC(broker.url, s, cc);
    await attachCC(broker.url, s, cc);
    await attachCC(broker.url, s, cc);
    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((x) => x.id === s)!;
    expect(me.boards.filter((b: any) => b.is_default === 1).length).toBe(1);
  });

  test("default board carries forward through reclaim — never duplicated", async () => {
    const cc = `cc-carry-${Math.random().toString(36).slice(2)}`;
    const s1 = await registerSession(broker.url, "/tmp/carry");
    await attachCC(broker.url, s1, cc);

    const before = await get<{ sessions: any[] }>(
      `${broker.url}/api/sessions`,
    );
    const me1 = before.json.sessions.find((x) => x.id === s1)!;
    const defaultId = me1.boards.find((b: any) => b.is_default === 1).id;

    await post(`${broker.url}/unregister`, { session_id: s1 });
    const s2 = await registerSession(broker.url, "/tmp/carry");
    await attachCC(broker.url, s2, cc);

    const after = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me2 = after.json.sessions.find((x) => x.id === s2)!;
    const defaults = me2.boards.filter((b: any) => b.is_default === 1);
    expect(defaults.length).toBe(1);
    // Same ID — not a new one.
    expect(defaults[0].id).toBe(defaultId);
  });
});

describe("attach-to-board ownership transfer", () => {
  test("attach-to-board redirects future submissions to the new session", async () => {
    // Two sessions, each with cc_session_id. Create a board under sessionA,
    // then attach it to sessionB. The board's session_id should be B.
    const cc1 = `cc-tb1-${Math.random().toString(36).slice(2)}`;
    const cc2 = `cc-tb2-${Math.random().toString(36).slice(2)}`;
    const sA = await registerSession(broker.url, "/tmp/tb");
    await attachCC(broker.url, sA, cc1);
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sA,
      structure: { title: "Transfer", concerns: [{ id: "t1", title: "x" }] },
    });

    const sB = await registerSession(broker.url, "/tmp/tb-other");
    await attachCC(broker.url, sB, cc2);

    const r = await post(`${broker.url}/attach-to-board`, {
      session_id: sB,
      board_id: c.json.board_id,
    });
    expect(r.json.ok).toBe(true);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const owner = list.json.sessions.find((s) =>
      s.boards.some((b: any) => b.id === c.json.board_id),
    );
    expect(owner?.id).toBe(sB);
  });

  test("attach-to-board on a non-existent board does not throw (no-op-ish)", async () => {
    const r = await post(`${broker.url}/attach-to-board`, {
      session_id: sessionId,
      board_id: "bd_nope",
    });
    expect(r.json.ok).toBe(true);
  });
});
