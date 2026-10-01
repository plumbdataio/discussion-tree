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

async function sessionRow(sid: string): Promise<any> {
  const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
  return list.json.sessions.find((s) => s.id === sid);
}

describe("/report-model + /api/sessions surfacing", () => {
  test("model is null before any report", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    expect((await sessionRow(sid)).model).toBeNull();
  });

  test("a reported model is exposed on the session row; later report wins", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const r = await post<{ ok: boolean; session_id?: string }>(
      `${broker.url}/report-model`,
      { cc_session_id: ccId, model: "claude-opus-4-8" },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.session_id).toBe(sid);
    let row = await sessionRow(sid);
    expect(row.model.id).toBe("claude-opus-4-8");
    expect(typeof row.model.set_at).toBe("string");

    await post(`${broker.url}/report-model`, {
      cc_session_id: ccId,
      model: "claude-opus-5-5",
    });
    row = await sessionRow(sid);
    expect(row.model.id).toBe("claude-opus-5-5");
  });

  test("accepts Bedrock / Vertex style ids", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    for (const model of [
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "claude-opus-4-1@20250805",
    ]) {
      const r = await post<{ ok: boolean }>(`${broker.url}/report-model`, {
        cc_session_id: ccId,
        model,
      });
      expect(r.json.ok).toBe(true);
    }
  });

  test("invalid input is rejected and does not overwrite", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    await post(`${broker.url}/report-model`, {
      cc_session_id: ccId,
      model: "claude-sonnet-5",
    });
    const bad: unknown[] = [
      "",
      "a".repeat(81),
      "claude opus",
      "<synthetic>",
      "claude-opus-5-5\n",
      "<script>",
      42,
      null,
      undefined,
      { id: "x" },
    ];
    for (const model of bad) {
      const r = await post<{ ok: boolean }>(`${broker.url}/report-model`, {
        cc_session_id: ccId,
        model,
      });
      expect(r.json.ok).toBe(false);
    }
    expect((await sessionRow(sid)).model.id).toBe("claude-sonnet-5");
  });

  test("missing / unknown cc_session_id is rejected", async () => {
    const r1 = await post<{ ok: boolean }>(`${broker.url}/report-model`, {
      model: "claude-opus-5-5",
    });
    expect(r1.json.ok).toBe(false);
    const r2 = await post<{ ok: boolean }>(`${broker.url}/report-model`, {
      cc_session_id: "no-such-cc",
      model: "claude-opus-5-5",
    });
    expect(r2.json.ok).toBe(false);
  });

  test("a reported model survives a broker restart (DB-persisted)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-model-persist-"));
    const env = {
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_DB: join(home, "db.sqlite"),
    };
    const a = await startBroker(env);
    // Live pid so the session is not swept to alive=0 across the restart.
    const reg = await post<{ session_id: string }>(`${a.url}/register`, {
      pid: process.pid,
      cwd: "/tmp/pd-model-persist",
    });
    const sid = reg.json.session_id;
    const ccId = await attachCC(a.url, sid);
    await post(`${a.url}/report-model`, {
      cc_session_id: ccId,
      model: "claude-fable-5-1",
    });
    await a.kill();

    const b = await startBroker(env);
    await post(`${b.url}/heartbeat`, { session_id: sid });
    const list = await get<{ sessions: any[]; inactive_sessions?: any[] }>(
      `${b.url}/api/sessions`,
    );
    const me = [
      ...list.json.sessions,
      ...(list.json.inactive_sessions ?? []),
    ].find((s) => s.id === sid);
    expect(me?.model?.id).toBe("claude-fable-5-1");
    await b.kill();
    rmSync(home, { recursive: true, force: true });
  });
});
