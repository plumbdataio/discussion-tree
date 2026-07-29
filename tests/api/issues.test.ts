import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
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

describe("issues — what the cross-session view needs", () => {
  test("rows carry the name of the session they came from", async () => {
    // The view is cross-session, so every row has to say which session it came
    // from without the UI making a round-trip per row.
    const { issue } = await create({ title: "labelled", session_id: sessionId });
    const r = await post<{ issues: (Issue & { session_name: string | null })[] }>(
      `${broker.url}/list-issues`,
      {},
    );
    const mine = r.json.issues.find((i) => i.id === issue.id)!;
    expect(mine.session_name !== undefined).toBe(true);
  });

  test("deleted issues are reachable on request, so the bin can restore them", async () => {
    // Without a read path for deleted rows there is no bin to restore FROM,
    // which makes the logical delete a physical one from the user's side.
    const { issue } = await create({ title: "binned" });
    await post(`${broker.url}/delete-issue`, { issue_id: issue.id });
    const hidden = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
    });
    expect(hidden.json.issues.map((i) => i.id)).not.toContain(issue.id);
    const bin = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
      include_deleted: true,
    });
    expect(bin.json.issues.map((i) => i.id)).toContain(issue.id);
  });

  test("filters persist so they are not re-picked in every browser", async () => {
    const empty = await post<{ filters: unknown }>(
      `${broker.url}/get-issue-filters`,
      {},
    );
    expect(empty.json.filters).toBeNull();
    const shape = { owners: ["user"], states: ["todo"], q: "x" };
    expect(
      (await post<{ ok: boolean }>(`${broker.url}/set-issue-filters`, {
        filters: shape,
      })).json.ok,
    ).toBe(true);
    const back = await post<{ filters: typeof shape }>(
      `${broker.url}/get-issue-filters`,
      {},
    );
    expect(back.json.filters).toEqual(shape);

    // Saving again replaces rather than accumulating rows.
    await post(`${broker.url}/set-issue-filters`, { filters: { owners: [] } });
    const after = await post<{ filters: { owners: string[] } }>(
      `${broker.url}/get-issue-filters`,
      {},
    );
    expect(after.json.filters.owners).toEqual([]);
  });
});

describe("issues — survive a CC restart", () => {
  // A tracker that forgets its rows every time the CC restarts is not a
  // tracker. Broker session ids are per-process, so anything keyed to one has
  // to be carried over by the attach_cc_session reclaim, exactly like boards,
  // maps and diagrams already are.
  test("the session filter still finds issues after the session id changes", async () => {
    const cwd = "/tmp/pd-issue-life";
    const ccId = `cc-issuelife-${Math.random().toString(36).slice(2, 8)}`;
    const a = await registerSession(broker.url, cwd);
    await attachCC(broker.url, a, ccId);
    const open = await create({ title: "outlives a restart", session_id: a });
    const gone = await create({ title: "deleted before restart", session_id: a });
    await post(`${broker.url}/delete-issue`, { issue_id: gone.issue.id });

    // The CC dies and comes back as a fresh broker session, same cc_session_id.
    await post(`${broker.url}/unregister`, { session_id: a });
    const b = await registerSession(broker.url, cwd);
    await attachCC(broker.url, b, ccId);

    const byNew = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      session_id: b,
    });
    expect(byNew.json.issues.map((i) => i.id)).toContain(open.issue.id);
    const byOld = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      session_id: a,
    });
    expect(byOld.json.issues.map((i) => i.id)).not.toContain(open.issue.id);

    // A deleted row moves too, so restoring it does not strand the issue on a
    // session that no longer exists.
    await post(`${broker.url}/restore-issue`, { issue_id: gone.issue.id });
    const after = await post<{ issue: Issue }>(`${broker.url}/get-issue`, {
      issue_id: gone.issue.id,
    });
    expect(after.json.issue.session_id).toBe(b);
  });
});

// Filing an issue against the right session is the difference between a
// cross-session ledger and a pile: getting it wrong once put four issues on an
// unrelated session and they only surfaced because the user spotted them.
describe("issues — which session an issue is filed under", () => {
  test("the pick list covers live sessions and any session still holding an issue", async () => {
    const live = await registerSession(broker.url, "/tmp/pick-live");
    const retired = await registerSession(broker.url, "/tmp/pick-retired");
    const bare = await registerSession(broker.url, "/tmp/pick-bare");
    await create({ title: "on the retired one", session_id: retired });
    await post(`${broker.url}/unregister`, { session_id: retired });
    await post(`${broker.url}/unregister`, { session_id: bare });

    const r = await post<{
      sessions: { id: string; alive: boolean }[];
    }>(`${broker.url}/list-issue-sessions`, {});
    const ids = r.json.sessions.map((s) => s.id);

    expect(ids).toContain(live);
    // Dead but still owns an issue — without it those rows cannot be filtered.
    expect(ids).toContain(retired);
    expect(r.json.sessions.find((s) => s.id === retired)!.alive).toBe(false);
    // Dead and owns nothing: pure noise in a list that is already long.
    expect(ids).not.toContain(bare);
  });

  test("an issue can be re-homed, and detached entirely", async () => {
    const from = await registerSession(broker.url, "/tmp/rehome-a");
    const to = await registerSession(broker.url, "/tmp/rehome-b");
    const issue = (await create({ title: "filed in the wrong place", session_id: from }))
      .issue;

    const moved = await post<{ issue: Issue }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      session_id: to,
    });
    expect(moved.json.issue.session_id).toBe(to);

    const detached = await post<{ issue: Issue }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      session_id: null,
    });
    expect(detached.json.issue.session_id).toBe(null);

    // Omitting the field leaves it alone — otherwise every quick owner/state
    // edit from a row would silently detach the issue.
    const untouched = await post<{ issue: Issue }>(`${broker.url}/update-issue`, {
      issue_id: issue.id,
      session_id: to,
    });
    expect(untouched.json.issue.session_id).toBe(to);
    const afterOwnerEdit = await post<{ issue: Issue }>(
      `${broker.url}/update-issue`,
      { issue_id: issue.id, owner: "user" },
    );
    expect(afterOwnerEdit.json.issue.session_id).toBe(to);
  });
});

// Closing needs the user's sign-off. Not bookkeeping: with the work delegated
// end to end, nothing is ever handed back, so nothing registers as finished.
// The approval is that moment — which is why a CC-closed issue stays visible in
// the default view until it is acknowledged.
describe("issues — closing waits for the user", () => {
  test("CC closing leaves the issue awaiting sign-off", async () => {
    const i = (await create({ title: "cc finishes this" })).issue;
    const closed = await post<{ issue: Issue & { close_approved_at: string | null } }>(
      `${broker.url}/update-issue`,
      { issue_id: i.id, state: "done" },
    );
    expect(closed.json.issue.state).toBe("done");
    expect(closed.json.issue.close_approved_at).toBe(null);

    // ...and it does NOT drop out of the default list, which is the one view
    // the user actually opens. Hiding it behind include_closed would bury the
    // only rows that need them.
    const list = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {});
    expect(list.json.issues.map((x) => x.id)).toContain(i.id);
  });

  test("the user closing it needs no sign-off", async () => {
    const i = (await create({ title: "user finishes this" })).issue;
    const closed = await post<{ issue: Issue & { close_approved_at: string | null } }>(
      `${broker.url}/update-issue`,
      { issue_id: i.id, state: "done", actor: "user" },
    );
    expect(closed.json.issue.close_approved_at).not.toBe(null);
    // Already acknowledged, so it leaves the default view like any closed row.
    const list = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {});
    expect(list.json.issues.map((x) => x.id)).not.toContain(i.id);
  });

  test("approving is idempotent and clears it from the default view", async () => {
    const i = (await create({ title: "approve me" })).issue;
    await post(`${broker.url}/update-issue`, { issue_id: i.id, state: "done" });

    const a1 = await post<{ ok: boolean; issue: Issue & { close_approved_at: string } }>(
      `${broker.url}/approve-issue-close`,
      { issue_id: i.id },
    );
    expect(a1.json.ok).toBe(true);
    const stamp = a1.json.issue.close_approved_at;
    expect(stamp).not.toBe(null);

    // A double-click must not move the timestamp or error.
    const a2 = await post<{ ok: boolean; issue: { close_approved_at: string } }>(
      `${broker.url}/approve-issue-close`,
      { issue_id: i.id },
    );
    expect(a2.json.ok).toBe(true);
    expect(a2.json.issue.close_approved_at).toBe(stamp);

    const list = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {});
    expect(list.json.issues.map((x) => x.id)).not.toContain(i.id);
  });

  test("reopening clears the sign-off, so closing again asks anew", async () => {
    const i = (await create({ title: "reopened" })).issue;
    await post(`${broker.url}/update-issue`, { issue_id: i.id, state: "done" });
    await post(`${broker.url}/approve-issue-close`, { issue_id: i.id });
    await post(`${broker.url}/update-issue`, { issue_id: i.id, state: "todo" });

    const again = await post<{ issue: { close_approved_at: string | null } }>(
      `${broker.url}/update-issue`,
      { issue_id: i.id, state: "done" },
    );
    expect(again.json.issue.close_approved_at).toBe(null);
  });

  test("approving something still open is refused", async () => {
    const i = (await create({ title: "still open" })).issue;
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/approve-issue-close`,
      { issue_id: i.id },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("not closed");
  });

  test("dropping is a close too, and needs the same sign-off", async () => {
    const i = (await create({ title: "dropped by cc" })).issue;
    const r = await post<{ issue: { state: string; close_approved_at: string | null } }>(
      `${broker.url}/update-issue`,
      { issue_id: i.id, state: "dropped" },
    );
    expect(r.json.issue.state).toBe("dropped");
    expect(r.json.issue.close_approved_at).toBe(null);
  });
});
