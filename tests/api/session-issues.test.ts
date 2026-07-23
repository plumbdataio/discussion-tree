import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Per-session issue aggregation (broker/session-issues.ts, served at
// /api/session-issues/:id). Projects the session's item nodes into status
// lanes; excludes concerns, the is_log audit item, and checklist nodes.

let broker: BrokerHandle;
let sessionId: string;
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId); // creates the default board too

  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Issue agg",
      concerns: [
        {
          id: "c1",
          title: "C1",
          items: [
            { id: "n-wait", title: "waits on you" },
            { id: "n-prog", title: "in progress" },
            { id: "n-todo", title: "not started" },
            { id: "n-done", title: "settled" },
            { id: "n-cl", title: "checklist node" },
          ],
        },
      ],
    },
  });
  boardId = r.json.board_id;

  const setStatus = (nodeId: string, status: string) =>
    post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: nodeId,
      message: `set ${status}`,
      status,
    });
  await setStatus("n-wait", "needs-reply");
  await setStatus("n-prog", "discussing");
  // n-todo stays pending (default)
  await setStatus("n-done", "resolved");

  // Flag n-cl as a checklist node → it must be excluded from the issue view.
  await post(`${broker.url}/set-node-checklist`, {
    board_id: boardId,
    node_id: "n-cl",
    is_checklist: true,
  });
});

afterAll(async () => {
  await broker.kill();
});

async function fetchIssues() {
  const r = await get<{
    ok: boolean;
    issues: Array<{
      node_id: string;
      title: string;
      lane: string;
      board_id: string;
      board_status: string;
      board_closed: number;
    }>;
    counts: Record<string, number>;
    session_name: string | null;
    filters: any;
  }>(`${broker.url}/api/session-issues/${sessionId}`);
  return r.json;
}

describe("/api/session-issues", () => {
  test("buckets item nodes into the right lanes", async () => {
    const j = await fetchIssues();
    const lane = (nid: string) =>
      j.issues.find((i) => i.node_id === nid)?.lane;
    expect(lane("n-wait")).toBe("wait");
    expect(lane("n-prog")).toBe("prog");
    expect(lane("n-todo")).toBe("todo");
    expect(lane("n-done")).toBe("done");
  });

  test("excludes checklist nodes and the audit-log item", async () => {
    const j = await fetchIssues();
    const titles = j.issues.map((i) => i.title);
    expect(titles).not.toContain("checklist node");
    // The per-board auto-created "Structure changes" log item is is_log=1.
    expect(titles).not.toContain("Structure changes");
    // And no concern leaks in (concerns aren't repliable issues).
    expect(j.issues.every((i) => i.node_id !== "c1")).toBe(true);
  });

  test("counts reflect the lanes (needs-reply is the 'waiting on you' lane)", async () => {
    const j = await fetchIssues();
    // Exactly one needs-reply item on this session (the default board's node
    // starts pending, so it can't inflate the wait lane).
    expect(j.counts.wait).toBe(1);
    expect(j.counts.prog).toBe(1);
    expect(j.counts.done).toBe(1);
    // todo includes n-todo plus possibly the default board's node — at least 1.
    expect(j.counts.todo).toBeGreaterThanOrEqual(1);
  });

  test("unknown session → empty list, ok true", async () => {
    const r = await get<{ ok: boolean; issues: any[]; counts: any }>(
      `${broker.url}/api/session-issues/s_does_not_exist`,
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.issues).toEqual([]);
  });

  test("issues carry board status/closed for client-side filtering", async () => {
    const j = await fetchIssues();
    const anyIssue = j.issues.find((i) => i.node_id === "n-wait")!;
    expect(typeof anyIssue.board_status).toBe("string");
    expect([0, 1]).toContain(anyIssue.board_closed);
  });

  test("per-session filters round-trip through the DB", async () => {
    const before = await fetchIssues();
    expect(before.filters).toBeNull(); // none saved yet

    const filters = {
      lanes: { wait: true, prog: false, todo: true, done: false },
      includeClosedBoards: true,
      maxAgeDays: 30,
    };
    const save = await post<{ ok: boolean }>(
      `${broker.url}/session-issue-filters`,
      { session_id: sessionId, filters },
    );
    expect(save.json.ok).toBe(true);

    const after = await fetchIssues();
    expect(after.filters).toEqual(filters);
  });
});
