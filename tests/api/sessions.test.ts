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

  test("/attach-cc-session inherits the session name from a prior dead session with same cc_session_id", async () => {
    const cwd = "/tmp/name-inherit";
    const ccId = `cc-name-${Math.random().toString(36).slice(2)}`;

    const sidA = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidA, ccId);
    await post(`${broker.url}/set-session-name`, {
      session_id: sidA,
      name: "discussion-tree dev",
    });
    await post(`${broker.url}/unregister`, { session_id: sidA });

    const sidB = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidB, ccId);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const sb = list.json.sessions.find((s) => s.id === sidB);
    expect(sb?.name).toBe("discussion-tree dev");
  });

  test("/attach-cc-session does NOT overwrite a name the new session has already set", async () => {
    const cwd = "/tmp/name-no-overwrite";
    const ccId = `cc-name-${Math.random().toString(36).slice(2)}`;

    const sidA = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidA, ccId);
    await post(`${broker.url}/set-session-name`, {
      session_id: sidA,
      name: "old name",
    });
    await post(`${broker.url}/unregister`, { session_id: sidA });

    const sidB = await registerSession(broker.url, cwd);
    // The new session sets its name FIRST, then attaches — attach must not
    // clobber what's already there.
    await post(`${broker.url}/set-session-name`, {
      session_id: sidB,
      name: "new name",
    });
    await attachCC(broker.url, sidB, ccId);

    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const sb = list.json.sessions.find((s) => s.id === sidB);
    expect(sb?.name).toBe("new name");
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

  test("/get-unanswered returns 0 for a fresh session", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const r = await post<{ ok: boolean; count: number }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: ccId },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.count).toBe(0);
  });

  test("/post-to-node clears only the replied node; status-only does not clear (per-node)", async () => {
    // Per-node nag: each (board, node) with a delivered submission is tracked
    // independently. Two submissions to the SAME node collapse to one row;
    // a submission to a different node adds another. A reply (non-empty
    // message) clears ONLY that node — not the whole backlog — and a
    // status-only post (empty message) clears nothing.
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const board = await post<{ board_id: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sid,
        structure: {
          title: "per-node-board",
          concerns: [
            {
              id: "c1",
              title: "C1",
              items: [
                { id: "i1", title: "I1" },
                { id: "i2", title: "I2" },
              ],
            },
          ],
        },
      },
    );

    // Two submissions to i1 collapse to one unanswered node...
    for (const text of ["first", "again"]) {
      const p = post(`${broker.url}/submit-answer`, {
        board_id: board.json.board_id,
        node_id: "i1",
        text,
      });
      await new Promise((r) => setTimeout(r, 50));
      await post(`${broker.url}/poll-messages`, { session_id: sid });
      await p;
    }
    // ...while a submission to i2 adds a second.
    const p2 = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i2",
      text: "other",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await p2;

    const afterSubmit = await post<{
      count: number;
      nodes: { node_id: string }[];
    }>(`${broker.url}/get-unanswered`, { cc_session_id: ccId });
    expect(afterSubmit.json.count).toBe(2); // i1 (collapsed) + i2
    expect(afterSubmit.json.nodes.map((n) => n.node_id).sort()).toEqual([
      "i1",
      "i2",
    ]);

    // A status-only post (empty message) must NOT clear i1.
    await post(`${broker.url}/post-to-node`, {
      board_id: board.json.board_id,
      node_id: "i1",
      message: "",
      status: "discussing",
    });
    expect(
      (
        await post<{ count: number }>(`${broker.url}/get-unanswered`, {
          cc_session_id: ccId,
        })
      ).json.count,
    ).toBe(2);

    // A real reply to i1 clears ONLY i1 → i2 still outstanding.
    await post(`${broker.url}/post-to-node`, {
      board_id: board.json.board_id,
      node_id: "i1",
      message: "ack i1",
      status: "discussing",
    });
    const afterI1 = await post<{
      count: number;
      nodes: { node_id: string }[];
    }>(`${broker.url}/get-unanswered`, { cc_session_id: ccId });
    expect(afterI1.json.count).toBe(1);
    expect(afterI1.json.nodes[0].node_id).toBe("i2");

    // Reply to i2 → empty set.
    await post(`${broker.url}/post-to-node`, {
      board_id: board.json.board_id,
      node_id: "i2",
      message: "ack i2",
      status: "discussing",
    });
    expect(
      (
        await post<{ count: number }>(`${broker.url}/get-unanswered`, {
          cc_session_id: ccId,
        })
      ).json.count,
    ).toBe(0);
  });

  test("a board_structure_request is tracked on the log node and clears on a reply there", async () => {
    // A structure request has no user content node, but it IS mirrored onto the
    // board's structure-change LOG node and the CC replies there — so it's
    // tracked on that real node and a post_to_node to it clears the nag (rather
    // than nagging forever or being silently un-tracked).
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const board = await post<{ board_id: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sid,
        structure: {
          title: "struct-board",
          concerns: [
            { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
          ],
        },
      },
    );
    const sp = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      kind: "board_structure_request",
      text: "please add a concern about X",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await sp;
    const after = await post<{
      count: number;
      nodes: { node_id: string }[];
    }>(`${broker.url}/get-unanswered`, { cc_session_id: ccId });
    expect(after.json.count).toBe(1); // tracked on the log node
    const logNodeId = after.json.nodes[0].node_id;

    // The CC's summary reply to a structure request goes to that same log node.
    await post(`${broker.url}/post-to-node`, {
      board_id: board.json.board_id,
      node_id: logNodeId,
      message: "done: added a concern about X",
      status: "discussing",
    });
    expect(
      (
        await post<{ count: number }>(`${broker.url}/get-unanswered`, {
          cc_session_id: ccId,
        })
      ).json.count,
    ).toBe(0);
  });

  test("/post-to-node then a fresh /submit-answer pushes the counter back to 1", async () => {
    // Verifies the turn-aware reconcile: bundled reply zeroes the counter,
    // but a NEW submission afterwards still nags correctly. Without this
    // contract, a user who fires a new submission right after the CC's
    // reply would be ignored by the Stop hook.
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const board = await post<{ board_id: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sid,
        structure: {
          title: "reconcile-board",
          concerns: [
            { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
          ],
        },
      },
    );

    // submit → drain → counter = 1.
    const s1 = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i1",
      text: "first",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await s1;
    expect(
      (
        await post<{ ok: boolean; count: number }>(
          `${broker.url}/get-unanswered`,
          { cc_session_id: ccId },
        )
      ).json.count,
    ).toBe(1);

    // CC bundled reply → counter = 0.
    await post(`${broker.url}/post-to-node`, {
      board_id: board.json.board_id,
      node_id: "i1",
      message: "ack",
      status: "discussing",
    });
    expect(
      (
        await post<{ ok: boolean; count: number }>(
          `${broker.url}/get-unanswered`,
          { cc_session_id: ccId },
        )
      ).json.count,
    ).toBe(0);

    // Fresh submission after the post → counter back to 1, nag is correct.
    const s2 = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i1",
      text: "follow-up",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await s2;
    expect(
      (
        await post<{ ok: boolean; count: number }>(
          `${broker.url}/get-unanswered`,
          { cc_session_id: ccId },
        )
      ).json.count,
    ).toBe(1);
  });

  test("/get-unanswered blocks on EVERY stop while count>0, gives up after the streak cap, re-arms on change", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const board = await post<{ board_id: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sid,
        structure: {
          title: "streak",
          concerns: [
            { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
          ],
        },
      },
    );
    // submit + drain → count = 1.
    const sp = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i1",
      text: "ping",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await sp;

    // Blocks on EVERY stop while the count stays 1 (not once-per-chain) — up to
    // the MAX_NAG_STREAK cap of 8 consecutive nags at the same count.
    for (let i = 0; i < 8; i++) {
      const r = await post<{ count: number; block: boolean }>(
        `${broker.url}/get-unanswered`,
        { cc_session_id: ccId },
      );
      expect(r.json.count).toBe(1);
      expect(r.json.block).toBe(true);
    }
    // 9th consecutive nag at the same count → give up so the turn can end.
    const giveUp = await post<{ count: number; block: boolean }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: ccId },
    );
    expect(giveUp.json.count).toBe(1);
    expect(giveUp.json.block).toBe(false);

    // A reply zeroes the count directly (1→0, no intervening get-unanswered at
    // count 0) — this must also clear the streak fields.
    await post(`${broker.url}/post-to-node`, {
      board_id: board.json.board_id,
      node_id: "i1",
      message: "ack",
      status: "discussing",
    });

    // codex P2: a FRESH submission at the SAME count (1) right after the backlog
    // hit the cap must re-arm the nag (block=true). Without the zeroing path
    // clearing the streak, count===stale nag_count would keep returning false.
    const sp2 = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i1",
      text: "ping2",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await sp2;
    const reArmed = await post<{ count: number; block: boolean }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: ccId },
    );
    expect(reArmed.json.count).toBe(1);
    expect(reArmed.json.block).toBe(true);
  });

  test("/reset-unanswered (by cc_session_id) zeros the counter", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const board = await post<{ board_id: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sid,
        structure: {
          title: "reset-by-cc",
          concerns: [
            { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
          ],
        },
      },
    );
    const sp = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i1",
      text: "x",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await sp;

    const before = await post<{ ok: boolean; count: number }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: ccId },
    );
    expect(before.json.count).toBe(1);

    const reset = await post<{ ok: boolean }>(
      `${broker.url}/reset-unanswered`,
      { cc_session_id: ccId },
    );
    expect(reset.json.ok).toBe(true);

    const after = await post<{ ok: boolean; count: number }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: ccId },
    );
    expect(after.json.count).toBe(0);
  });

  test("/reset-unanswered (by session_id, the MCP tool path) zeros the counter", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    const board = await post<{ board_id: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sid,
        structure: {
          title: "reset-by-sid",
          concerns: [
            { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
          ],
        },
      },
    );
    const sp = post(`${broker.url}/submit-answer`, {
      board_id: board.json.board_id,
      node_id: "i1",
      text: "y",
    });
    await new Promise((r) => setTimeout(r, 50));
    await post(`${broker.url}/poll-messages`, { session_id: sid });
    await sp;

    const r = await post<{ ok: boolean; session_id?: string }>(
      `${broker.url}/reset-unanswered`,
      { session_id: sid },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.session_id).toBe(sid);

    const after = await post<{ ok: boolean; count: number }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: ccId },
    );
    expect(after.json.count).toBe(0);
  });

  test("/get-unanswered returns ok=false for unknown cc_session_id", async () => {
    const r = await post<{ ok: boolean; count: number }>(
      `${broker.url}/get-unanswered`,
      { cc_session_id: "no-such-cc" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.count).toBe(0);
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
    await attachCC(broker.url, sid);
    // Give it real content (a non-default board) so it qualifies as an
    // inactive session — a bare empty default board is treated as a husk and
    // filtered out (see session-husk.test.ts).
    await post(`${broker.url}/create-board`, {
      session_id: sid,
      structure: {
        title: "Real",
        concerns: [{ id: "c", title: "C", items: [{ id: "i", title: "I" }] }],
      },
    });
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
