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

describe("sessions", () => {
  test("/register returns a session_id", async () => {
    const r = await post<{ session_id: string }>(`${broker.url}/register`, {
      pid: 12345,
      cwd: "/tmp/pd-x",
    });
    expect(r.status).toBe(200);
    expect(r.json.session_id).toMatch(/^s_[a-z0-9]+$/);
  });

  test("/heartbeat returns ok", async () => {
    const sid = await registerSession(broker.url);
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat`, {
      session_id: sid,
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  test("/unregister soft-deletes (row stays alive=0)", async () => {
    const sid = await registerSession(broker.url);
    const r = await post<{ ok: boolean }>(`${broker.url}/unregister`, {
      session_id: sid,
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    // The session should still exist, just inactive — list-sessions returns
    // it under inactive_sessions if it had any boards (we have none, so it's
    // filtered out). Verify heartbeat still finds the row by issuing one;
    // soft-deleted rows still UPDATE last_seen without error.
    const hb = await post<{ ok: boolean }>(`${broker.url}/heartbeat`, {
      session_id: sid,
    });
    expect(hb.status).toBe(200);
  });

  test("/attach-cc-session creates a default board (side effect)", async () => {
    const sid = await registerSession(broker.url);
    const ccId = `cc-${Math.random().toString(36).slice(2)}`;
    const r = await post<{ ok: boolean; reclaimed: any }>(
      `${broker.url}/attach-cc-session`,
      { session_id: sid, cc_session_id: ccId },
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sid);
    expect(me).toBeTruthy();
    const def = me!.boards.find((b: any) => b.is_default);
    expect(def).toBeTruthy();
    expect(def.title).toBe("Conversation");
  });

  test("/attach-cc-session reclaims boards from a prior dead session with same cc_session_id", async () => {
    const cwd = "/tmp/reclaim";
    const ccId = `cc-reclaim-${Math.random().toString(36).slice(2)}`;

    // Session A: register, attach, the default board is created. Then unregister.
    const sidA = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidA, ccId);
    await post(`${broker.url}/unregister`, { session_id: sidA });

    // Session B: re-register, attach with same cc_session_id — should reclaim.
    const sidB = await registerSession(broker.url, cwd);
    const r = await post<{ ok: boolean; reclaimed: any }>(
      `${broker.url}/attach-cc-session`,
      { session_id: sidB, cc_session_id: ccId },
    );
    expect(r.json.reclaimed.boards).toBeGreaterThanOrEqual(1);

    // Session B should now own the default board (not session A).
    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const sb = list.json.sessions.find((s) => s.id === sidB);
    expect(sb).toBeTruthy();
    expect(sb!.boards.find((b: any) => b.is_default)).toBeTruthy();
  });

  test("/set-session-name updates the row", async () => {
    const sid = await registerSession(broker.url);
    const r = await post<{ ok: boolean }>(`${broker.url}/set-session-name`, {
      session_id: sid,
      name: "my session",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sid);
    expect(me?.name).toBe("my session");
  });

  test("/api/sessions includes the live activity entry under each session", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);

    // No activity yet — field should be null.
    const before = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = before.json.sessions.find((s) => s.id === sid)!;
    expect(me.activity).toBeNull();

    // Drive a heartbeat-tool to lift the in-memory "working" state.
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Edit",
    });

    const after = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me2 = after.json.sessions.find((s) => s.id === sid)!;
    expect(me2.activity).toBeTruthy();
    expect(me2.activity.state).toBe("working");
  });

  test("/api/sessions splits alive vs inactive sessions", async () => {
    const sid = await registerSession(broker.url, "/tmp/inactive-cwd");
    const ccId = await attachCC(broker.url, sid);
    // attach-cc-session creates a default board → after unregister, this session has a non-archived board → inactive_sessions.
    await post(`${broker.url}/unregister`, { session_id: sid });

    const r = await get<{ sessions: any[]; inactive_sessions: any[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(r.status).toBe(200);
    const inactive = r.json.inactive_sessions.find((s) => s.id === sid);
    expect(inactive).toBeTruthy();
    // The dead session should not appear in alive sessions.
    expect(r.json.sessions.find((s) => s.id === sid)).toBeFalsy();
  });
});
