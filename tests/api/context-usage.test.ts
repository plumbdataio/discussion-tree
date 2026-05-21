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

describe("/report-context-usage + /api/sessions surfacing", () => {
  test("a reported usage is surfaced on the matching session row", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);

    const r = await post<{ ok: boolean; session_id?: string }>(
      `${broker.url}/report-context-usage`,
      { cc_session_id: ccId, remaining_pct: 42 },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.session_id).toBe(sid);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sid)!;
    expect(me.context_usage.remaining_pct).toBe(42);
    expect(typeof me.context_usage.set_at).toBe("string");
  });

  test("a later report overwrites the previous one", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    await post(`${broker.url}/report-context-usage`, {
      cc_session_id: ccId,
      remaining_pct: 70,
    });
    await post(`${broker.url}/report-context-usage`, {
      cc_session_id: ccId,
      remaining_pct: 12,
    });
    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sid)!;
    expect(me.context_usage.remaining_pct).toBe(12);
  });

  test("missing cc_session_id is rejected (ok=false)", async () => {
    const r = await post<{ ok: boolean }>(
      `${broker.url}/report-context-usage`,
      { remaining_pct: 50 },
    );
    expect(r.json.ok).toBe(false);
  });

  test("unknown cc_session_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(
      `${broker.url}/report-context-usage`,
      { cc_session_id: "no-such-cc", remaining_pct: 50 },
    );
    expect(r.json.ok).toBe(false);
  });

  test("out-of-range / non-numeric values are rejected", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const bad = [-1, 101, NaN as any, "twenty" as any, undefined as any];
    for (const v of bad) {
      const r = await post<{ ok: boolean }>(
        `${broker.url}/report-context-usage`,
        { cc_session_id: ccId, remaining_pct: v },
      );
      expect(r.json.ok).toBe(false);
    }
  });

  test("a session without any report has context_usage = null", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sid)!;
    expect(me.context_usage).toBeNull();
  });
});
