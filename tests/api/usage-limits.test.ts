import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type LimitsBody = {
  cc_session_id?: string;
  five_hour_pct?: number;
  five_hour_resets_at?: number;
  seven_day_pct?: number;
  seven_day_resets_at?: number;
};

describe("/report-usage-limits + /api/sessions surfacing", () => {
  test("a reported set of limits is surfaced as the account-global value", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);

    const resetsFive = Math.floor(Date.now() / 1000) + 3600;
    const resetsSeven = Math.floor(Date.now() / 1000) + 7 * 86400;
    const r = await post<{ ok: boolean; session_id?: string }>(
      `${broker.url}/report-usage-limits`,
      {
        cc_session_id: ccId,
        five_hour_pct: 24,
        five_hour_resets_at: resetsFive,
        seven_day_pct: 41,
        seven_day_resets_at: resetsSeven,
      } satisfies LimitsBody,
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.session_id).toBe(sid);

    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits).not.toBeNull();
    expect(list.json.usage_limits.five_hour_pct).toBe(24);
    expect(list.json.usage_limits.five_hour_resets_at).toBe(resetsFive);
    expect(list.json.usage_limits.seven_day_pct).toBe(41);
    expect(list.json.usage_limits.seven_day_resets_at).toBe(resetsSeven);
    expect(typeof list.json.usage_limits.set_at).toBe("string");
  });

  test("a partial report (only 7d present) is accepted; missing fields are absent", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      seven_day_pct: 55,
    });
    expect(r.json.ok).toBe(true);
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    // Freshest across sessions is this partial one.
    expect(list.json.usage_limits.seven_day_pct).toBe(55);
    expect(list.json.usage_limits.five_hour_pct ?? null).toBeNull();
  });

  test("a later report overwrites the previous one for the same session", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 10,
    });
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 80,
    });
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits.five_hour_pct).toBe(80);
  });

  test("the freshest report across sessions wins (account-global, one chip)", async () => {
    const sidA = await registerSession(broker.url);
    const ccA = await attachCC(broker.url, sidA);
    const sidB = await registerSession(broker.url);
    const ccB = await attachCC(broker.url, sidB);

    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccA,
      five_hour_pct: 11,
    });
    // Small delay so set_at strictly increases (ISO ms resolution).
    await new Promise((r) => setTimeout(r, 5));
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccB,
      five_hour_pct: 99,
    });
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits.five_hour_pct).toBe(99);
  });

  test("missing cc_session_id is rejected (ok=false)", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      five_hour_pct: 50,
    });
    expect(r.json.ok).toBe(false);
  });

  test("unknown cc_session_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      cc_session_id: "no-such-cc",
      five_hour_pct: 50,
    });
    expect(r.json.ok).toBe(false);
  });

  test("a report with no usable pct field is rejected", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    // Only a reset time, no percentage — nothing to show, so ok=false.
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_resets_at: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(r.json.ok).toBe(false);
  });

  test("out-of-range percentages are dropped to absent", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    // 5h is out of range (dropped), 7d is valid → still accepted, 5h absent.
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 150,
      seven_day_pct: 33,
    });
    expect(r.json.ok).toBe(true);
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits.seven_day_pct).toBe(33);
    expect(list.json.usage_limits.five_hour_pct ?? null).toBeNull();
  });

  test("reported limits survive a broker restart (DB-persisted)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-limits-persist-"));
    const env = {
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_DB: join(home, "db.sqlite"),
    };

    const a = await startBroker(env);
    const reg = await post<{ session_id: string }>(`${a.url}/register`, {
      pid: process.pid,
      cwd: "/tmp/pd-limits-persist",
    });
    const sid = reg.json.session_id;
    const ccId = await attachCC(a.url, sid);
    await post(`${a.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 37,
      seven_day_pct: 60,
    });
    await a.kill();

    const b = await startBroker(env);
    await post(`${b.url}/heartbeat`, { session_id: sid });
    const list = await get<{ usage_limits: any }>(`${b.url}/api/sessions`);
    expect(list.json.usage_limits.five_hour_pct).toBe(37);
    expect(list.json.usage_limits.seven_day_pct).toBe(60);
    await b.kill();
    rmSync(home, { recursive: true, force: true });
  });
});
