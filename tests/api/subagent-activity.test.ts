import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Subagent-activity indicator. A subagent (Task worker) tool call fires the
// SAME PreToolUse hook as the parent, under the parent's session_id — but its
// stdin carries an agent_id the parent's own calls never do. The tool-activity
// hook routes those to /heartbeat-subagent (instead of /heartbeat-tool), so the
// broker tracks running subagents per session WITHOUT spinning the parent's
// working spinner. These tests pin the broker side of that contract:
// heartbeat/count, per-agent + all-agent SubagentStop, the manual clear, the
// timeout backstop, and the fact that a subagent heartbeat leaves the parent's
// activity untouched.

type SessionItem = {
  id: string;
  running_subagents?: number;
  activity: unknown | null;
};

async function heartbeat(url: string, ccId: string, agentId: string) {
  return (
    await post<{ ok: boolean; count?: number }>(
      `${url}/heartbeat-subagent`,
      { cc_session_id: ccId, agent_id: agentId },
    )
  ).json;
}

async function stop(url: string, ccId: string, agentId?: string) {
  const body: Record<string, string> = { cc_session_id: ccId };
  if (agentId) body.agent_id = agentId;
  return (
    await post<{ ok: boolean; stopped: number }>(`${url}/subagent-stop`, body)
  ).json;
}

async function clearSession(url: string, sessionId: string) {
  return (
    await post<{ ok: boolean; cleared: number }>(
      `${url}/subagent-clear-session`,
      { session_id: sessionId },
    )
  ).json;
}

// The integration read: /api/sessions is what the sidebar polls; the count and
// the (untouched) parent activity both come from there.
async function sessionRow(
  url: string,
  sessionId: string,
): Promise<SessionItem | undefined> {
  const r = await get<{ sessions: SessionItem[] }>(`${url}/api/sessions`);
  return r.json.sessions.find((s) => s.id === sessionId);
}

describe("subagent heartbeat / stop / clear / count", () => {
  let broker: BrokerHandle;
  let sessionId: string;
  let ccId: string;

  beforeAll(async () => {
    // Comfortable timeout so nothing in this block expires mid-test.
    broker = await startBroker({ DT_SUBAGENT_TIMEOUT_MS: "60000" });
    sessionId = await registerSession(broker.url);
    ccId = await attachCC(broker.url, sessionId);
  });
  afterAll(async () => {
    await broker.kill();
  });

  test("a subagent heartbeat counts one running subagent", async () => {
    expect((await heartbeat(broker.url, ccId, "ag_A")).count).toBe(1);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("distinct agent_ids count independently", async () => {
    expect((await heartbeat(broker.url, ccId, "ag_B")).count).toBe(2);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(2);
  });

  test("re-heartbeating the same agent_id does NOT double-count", async () => {
    expect((await heartbeat(broker.url, ccId, "ag_A")).count).toBe(2);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(2);
  });

  test("a subagent heartbeat leaves the parent working spinner untouched", async () => {
    // The whole point: subagent activity must not set the parent's activity.
    expect((await sessionRow(broker.url, sessionId))?.activity).toBeNull();
  });

  test("SubagentStop with agent_id drops exactly that subagent", async () => {
    const r = await stop(broker.url, ccId, "ag_A");
    expect(r.stopped).toBe(1);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("stopping an already-stopped agent_id is an idempotent no-op", async () => {
    const r = await stop(broker.url, ccId, "ag_A");
    expect(r.stopped).toBe(0);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("a heartbeat after stop re-counts the subagent (un-stop on life)", async () => {
    expect((await heartbeat(broker.url, ccId, "ag_A")).count).toBe(2);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(2);
  });

  test("SubagentStop without agent_id drops ALL running subagents", async () => {
    const r = await stop(broker.url, ccId);
    expect(r.stopped).toBe(2);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(0);
  });

  test("manual clear drops all running subagents", async () => {
    await heartbeat(broker.url, ccId, "ag_C");
    await heartbeat(broker.url, ccId, "ag_D");
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(2);
    const r = await clearSession(broker.url, sessionId);
    expect(r.cleared).toBe(2);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(0);
  });

  test("an unknown cc_session_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-subagent`, {
      cc_session_id: "cc-nope",
      agent_id: "ag_X",
    });
    expect(r.json.ok).toBe(false);
  });

  test("a heartbeat missing agent_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-subagent`, {
      cc_session_id: ccId,
    });
    expect(r.json.ok).toBe(false);
  });
});

describe("subagent timeout backstop", () => {
  let broker: BrokerHandle;
  let sessionId: string;
  let ccId: string;

  beforeAll(async () => {
    // Tiny window so a stale heartbeat expires within the test.
    broker = await startBroker({ DT_SUBAGENT_TIMEOUT_MS: "300" });
    sessionId = await registerSession(broker.url);
    ccId = await attachCC(broker.url, sessionId);
  });
  afterAll(async () => {
    await broker.kill();
  });

  test("a subagent whose last heartbeat is older than the timeout stops counting", async () => {
    await heartbeat(broker.url, ccId, "ag_stale");
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
    // Wait past the 300ms window — no SubagentStop ever fires, so only the
    // timeout backstop can clear it.
    await new Promise((r) => setTimeout(r, 450));
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(0);
    // A fresh heartbeat brings it back (last_seen refreshed).
    await heartbeat(broker.url, ccId, "ag_stale");
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });
});
