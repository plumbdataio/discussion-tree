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
// working spinner. The heartbeat MUST carry a non-empty agent_type: real
// subagents have one (e.g. "general-purpose") and reliably get a SubagentStop,
// while transient harness "helper" subagents have an EMPTY agent_type and never
// stop — the broker gates those out so they can't leak into the count. There is
// NO time-based expiry: a registered subagent stays counted until SubagentStop
// or a manual clear. These tests pin the broker side of that contract:
// the agent_type gate, heartbeat/count, per-agent + all-agent SubagentStop, the
// manual clear, the no-expiry semantics, and the fact that a subagent heartbeat
// leaves the parent's activity untouched.

type SessionItem = {
  id: string;
  running_subagents?: number;
  activity: unknown | null;
};

async function heartbeat(
  url: string,
  ccId: string,
  agentId: string,
  agentType: string = "general-purpose",
) {
  return (
    await post<{ ok: boolean; count?: number }>(
      `${url}/heartbeat-subagent`,
      { cc_session_id: ccId, agent_id: agentId, agent_type: agentType },
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
    broker = await startBroker();
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
    // Carries a valid agent_type so the rejection is provably the session
    // lookup, not the agent_type gate.
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-subagent`, {
      cc_session_id: "cc-nope",
      agent_id: "ag_X",
      agent_type: "general-purpose",
    });
    expect(r.json.ok).toBe(false);
  });

  test("a heartbeat missing agent_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-subagent`, {
      cc_session_id: ccId,
      agent_type: "general-purpose",
    });
    expect(r.json.ok).toBe(false);
  });
});

// The agent_type gate: only real subagents (non-empty agent_type) are tracked.
// The transient harness "helper" subagents send an EMPTY agent_type and never
// get a SubagentStop, so registering them would leak rows and over-count. And
// there is NO time-based expiry: a registered subagent stays counted until a
// SubagentStop or a manual clear, no matter how long it runs. Fresh broker /
// session per case so the count starts clean.
describe("subagent agent_type gate + no time-based expiry", () => {
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

  test("a heartbeat with a non-empty agent_type IS counted", async () => {
    const r = await heartbeat(broker.url, ccId, "ag_real", "general-purpose");
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("a heartbeat with an empty agent_type is NOT counted (helper case)", async () => {
    const r = await heartbeat(broker.url, ccId, "ag_helper", "");
    expect(r.ok).toBe(false);
    // The empty-type helper never registers, so the count is unchanged.
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("a heartbeat with a whitespace-only agent_type is NOT counted", async () => {
    const r = await heartbeat(broker.url, ccId, "ag_helper2", "   ");
    expect(r.ok).toBe(false);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("a heartbeat with a missing agent_type is NOT counted", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-subagent`, {
      cc_session_id: ccId,
      agent_id: "ag_helper3",
    });
    expect(r.json.ok).toBe(false);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("no time-based expiry: a registered subagent stays counted while left alone", async () => {
    // The count query has NO time bound, so an un-stopped subagent never ages
    // out. We can't fast-forward wall-clock, so assert the semantic: after a
    // real delay with NO further heartbeat, the subagent registered above is
    // still counted (a staleness timeout would have dropped it).
    await new Promise((r) => setTimeout(r, 500));
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(1);
  });

  test("only SubagentStop / manual clear removes a counted subagent", async () => {
    // SubagentStop the one real subagent → count drops to 0.
    const s = await stop(broker.url, ccId, "ag_real");
    expect(s.stopped).toBe(1);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(0);
    // Register two more, then the manual clear drops both at once.
    await heartbeat(broker.url, ccId, "ag_real2", "general-purpose");
    await heartbeat(broker.url, ccId, "ag_real3", "general-purpose");
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(2);
    const c = await clearSession(broker.url, sessionId);
    expect(c.cleared).toBe(2);
    expect((await sessionRow(broker.url, sessionId))?.running_subagents).toBe(0);
  });
});
