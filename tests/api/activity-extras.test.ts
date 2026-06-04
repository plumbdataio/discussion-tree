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
let ccId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccId = await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

describe("set-activity edge cases", () => {
  test("clearing activity via set-activity with no state returns cleared=true", async () => {
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: "blocked",
      message: "waiting",
    });
    const r = await post<{ ok: boolean; cleared?: boolean }>(
      `${broker.url}/set-activity`,
      { session_id: sessionId },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.cleared).toBe(true);
  });

  test("set-activity returns the new entry under .activity", async () => {
    const r = await post<{ ok: boolean; activity?: any }>(
      `${broker.url}/set-activity`,
      {
        session_id: sessionId,
        state: "working",
        message: "compiling",
      },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.activity?.state).toBe("working");
    expect(r.json.activity?.session_id).toBe(sessionId);
    expect(r.json.activity?.set_at).toMatch(/T.+Z$/);
    // Clean up.
    await post(`${broker.url}/set-activity`, { session_id: sessionId });
  });

  test("set-activity surfaces in /api/sessions activity field", async () => {
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: "blocked",
      message: "waiting on x",
    });
    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = r.json.sessions.find((s) => s.id === sessionId);
    expect(me?.activity?.state).toBe("blocked");
    expect(me?.activity?.message).toBe("waiting on x");
    // Reset.
    await post(`${broker.url}/set-activity`, { session_id: sessionId });
  });
});

describe("heartbeat-tool / clear-tool-activity (cc_session_id-driven)", () => {
  test("heartbeat-tool with missing cc_session_id returns ok=false", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-tool`, {
      tool: "Read",
    });
    expect(r.json.ok).toBe(false);
  });

  test("heartbeat-tool with unknown cc_session_id returns ok=false", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-tool`, {
      cc_session_id: "cc-doesnotexist-xyz",
      tool: "Read",
    });
    expect(r.json.ok).toBe(false);
  });

  test("heartbeat-tool sets working activity for the session bound to cc_session_id", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Read",
    });
    expect(r.json.ok).toBe(true);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sessionId);
    expect(me?.activity?.state).toBe("working");
    expect(me?.activity?.message).toBe("Read");
  });

  test("clear-tool-activity clears 'working' but preserves explicit 'blocked'", async () => {
    // First: set working via heartbeat-tool.
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Bash",
    });
    // Then: clear-tool-activity should clear it.
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    const list1 = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me1 = list1.json.sessions.find((s) => s.id === sessionId);
    expect(me1?.activity).toBeNull();

    // Set explicit blocked, then clear-tool-activity — should NOT clear it.
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: "blocked",
      message: "waiting",
    });
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    const list2 = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me2 = list2.json.sessions.find((s) => s.id === sessionId);
    expect(me2?.activity?.state).toBe("blocked");
    // Cleanup.
    await post(`${broker.url}/set-activity`, { session_id: sessionId });
  });

  test("clear-tool-activity with missing cc_session_id returns ok=false", async () => {
    const r = await post<{ ok: boolean }>(
      `${broker.url}/clear-tool-activity`,
      {},
    );
    expect(r.json.ok).toBe(false);
  });

  test("/clear-activities-for-sessions wipes every state, including explicit ones", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    // Seed an explicit "blocked" state — these normally survive
    // /clear-tool-activity. The bulk-clear endpoint should drop them
    // anyway so external schedulers can quiet every spinner at once.
    await post(`${broker.url}/set-activity`, {
      session_id: sid,
      state: "blocked",
      message: "manual",
    });
    const before = await get<{ sessions: { id: string; activity: any }[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(
      before.json.sessions.find((s) => s.id === sid)?.activity?.state,
    ).toBe("blocked");

    const r = await post<{ ok: boolean; cleared: number }>(
      `${broker.url}/clear-activities-for-sessions`,
      { session_ids: [sid] },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.cleared).toBe(1);

    const after = await get<{ sessions: { id: string; activity: any }[] }>(
      `${broker.url}/api/sessions`,
    );
    expect(after.json.sessions.find((s) => s.id === sid)?.activity).toBeNull();
  });

  test("/clear-activities-for-sessions rejects a non-array body", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/clear-activities-for-sessions`,
      { session_ids: "not-an-array" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("session_ids");
  });
});
