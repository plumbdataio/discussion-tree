import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The issue tracker is a deliberately-maintained ledger, not a projection of
// node statuses (that predecessor was removed for being unopenable — see the
// local skill session-issue-view-removed). These pin the parts that make it a
// ledger: rows survive, closing means something, and the default list answers
// "what is outstanding" without a filter dance.

let broker: BrokerHandle;
let sessionId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
});
afterAll(async () => {
  await broker.kill();
});

type Issue = {
  id: string;
  title: string;
  body: string;
  owner: string;
  state: string;
  session_id: string | null;
  closed_at: string | null;
  updated_at: string;
};

const create = async (fields: Record<string, unknown> = {}) => {
  const r = await post<{ ok: boolean; issue: Issue; error?: string }>(
    `${broker.url}/create-issue`,
    { title: "an issue", ...fields },
  );
  return r.json;
};

describe("issues — create", () => {
  test("defaults to the CC holding the ball, not started", async () => {
    const r = await create({ title: "write the thing" });
    expect(r.ok).toBe(true);
    expect(r.issue.owner).toBe("cc");
    expect(r.issue.state).toBe("todo");
    expect(r.issue.closed_at).toBeNull();
    expect(r.issue.id).toMatch(/^iss_/);
  });

  test("a title is required", async () => {
    const r = await create({ title: "   " });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/title/i);
  });

  test("unknown owner / state are rejected rather than stored", async () => {
    // A bad enum reaching the DB would render as a lane that doesn't exist.
    expect((await create({ owner: "nobody" })).ok).toBe(false);
    expect((await create({ state: "blocked" })).ok).toBe(false);
  });

  test("created already-closed stamps closed_at", async () => {
    const r = await create({ title: "already done", state: "done" });
    expect(r.issue.closed_at).not.toBeNull();
  });
});

describe("issues — owner x state is two independent axes", () => {
  test("every combination round-trips", async () => {
    for (const owner of ["user", "cc", "external"]) {
      for (const state of ["todo", "doing"]) {
        const r = await create({ title: `${owner}/${state}`, owner, state });
        expect(r.issue.owner).toBe(owner);
        expect(r.issue.state).toBe(state);
      }
    }
    // The distinction the split exists for: "waiting on the user" vs "the user
    // is working on it" — a single status enum could not say which.
    const waiting = await create({ title: "w", owner: "user", state: "todo" });
    const working = await create({ title: "x", owner: "user", state: "doing" });
    expect(waiting.issue.state).not.toBe(working.issue.state);
    expect(waiting.issue.owner).toBe(working.issue.owner);
  });
});

describe("issues — update", () => {
  test("closing stamps closed_at, reopening clears it", async () => {
    const { issue } = await create({ title: "toggle me" });
    const closed = await post<{ issue: Issue }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      state: "done",
    });
    expect(closed.json.issue.closed_at).not.toBeNull();
    const reopened = await post<{ issue: Issue }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      state: "doing",
    });
    expect(reopened.json.issue.closed_at).toBeNull();
  });

  test("editing a closed issue does NOT move its close time", async () => {
    // closed_at tracks the closed/open EDGE. Without that, fixing a typo on a
    // finished issue would keep pushing its completion date forward.
    const { issue } = await create({ title: "typo", state: "done" });
    const first = issue.closed_at;
    const edited = await post<{ issue: Issue }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      title: "typo fixed",
    });
    expect(edited.json.issue.closed_at).toBe(first);
    expect(edited.json.issue.title).toBe("typo fixed");
  });

  test("a bad enum leaves the row untouched", async () => {
    const { issue } = await create({ title: "keep me", owner: "user" });
    const r = await post<{ ok: boolean }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      owner: "somebody",
    });
    expect(r.json.ok).toBe(false);
    const after = await post<{ issue: Issue }>(`${broker.url}/get-issue`, {
      issue_id: issue.id,
    });
    expect(after.json.issue.owner).toBe("user");
  });

  test("updating a missing issue fails cleanly", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/update-issue`,
      { issue_id: "iss_nope", title: "x" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });
});

describe("issues — list", () => {
  test("the default list is what is outstanding; closed is opt-in", async () => {
    const open = await create({ title: "still open", owner: "user" });
    const shut = await create({ title: "finished", state: "done" });
    const def = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {});
    const ids = def.json.issues.map((i) => i.id);
    expect(ids).toContain(open.issue.id);
    expect(ids).not.toContain(shut.issue.id);

    const all = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
    });
    expect(all.json.issues.map((i) => i.id)).toContain(shut.issue.id);
  });

  test("filters by owner and by session", async () => {
    const mine = await create({
      title: "mine",
      owner: "user",
      session_id: sessionId,
    });
    const byOwner = await post<{ issues: Issue[] }>(
      `${broker.url}/list-issues`,
      { owner: "user" },
    );
    expect(byOwner.json.issues.every((i) => i.owner === "user")).toBe(true);
    expect(byOwner.json.issues.map((i) => i.id)).toContain(mine.issue.id);

    const bySession = await post<{ issues: Issue[] }>(
      `${broker.url}/list-issues`,
      { session_id: sessionId },
    );
    expect(bySession.json.issues.every((i) => i.session_id === sessionId)).toBe(
      true,
    );
  });

  test("an explicit state filter overrides the closed-hiding default", async () => {
    const { issue } = await create({ title: "dropped one", state: "dropped" });
    const r = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      state: "dropped",
    });
    expect(r.json.issues.map((i) => i.id)).toContain(issue.id);
  });
});

describe("issues — delete is logical", () => {
  // An issue's body is often the only written record of WHY something was
  // outstanding. A physical delete destroys context nobody can reconstruct and
  // has no undo, so deletion only hides the row.
  test("a deleted issue disappears from reads but is restorable", async () => {
    const { issue } = await create({ title: "noise", body: "why it mattered" });
    expect(
      (await post<{ ok: boolean }>(`${broker.url}/delete-issue`, { issue_id: issue.id })).json.ok,
    ).toBe(true);

    // Gone from every read path...
    expect((await post<{ ok: boolean }>(`${broker.url}/get-issue`, { issue_id: issue.id })).json.ok).toBe(false);
    const listed = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
    });
    expect(listed.json.issues.map((i) => i.id)).not.toContain(issue.id);

    // ...but the row, and its reasoning, survive.
    const back = await post<{ ok: boolean; issue: Issue }>(
      `${broker.url}/restore-issue`,
      { issue_id: issue.id },
    );
    expect(back.json.ok).toBe(true);
    expect(back.json.issue.body).toBe("why it mattered");
    expect((await post<{ ok: boolean }>(`${broker.url}/get-issue`, { issue_id: issue.id })).json.ok).toBe(true);
  });

  test("deleting twice fails the second time (already hidden)", async () => {
    const { issue } = await create({ title: "twice" });
    await post(`${broker.url}/delete-issue`, { issue_id: issue.id });
    const again = await post<{ ok: boolean }>(`${broker.url}/delete-issue`, {
      issue_id: issue.id,
    });
    expect(again.json.ok).toBe(false);
  });

  test("restoring something that was never deleted fails cleanly", async () => {
    const { issue } = await create({ title: "alive" });
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/restore-issue`,
      { issue_id: issue.id },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/deleted/i);
  });
});
