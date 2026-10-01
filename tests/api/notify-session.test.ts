import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// POST /notify-session: an automated external relay (e.g. a Sentry forwarder)
// notifies a CC agent through dt. The notice is recorded as source "external"
// (never as the user), delivered through pending_messages as kind
// "external_notify", and flags its node unanswered so the Stop-hook nag keeps
// firing until the agent replies on that node.

let broker: BrokerHandle;
let sessionId: string;
let ccSessionId: string;
let boardId: string;

function openDb() {
  return new Database(broker.dbPath, { readonly: true });
}

async function createBoard(sid: string, title: string): Promise<string> {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sid,
    structure: {
      title,
      concerns: [
        {
          id: "c1",
          title: "C1",
          items: [
            { id: "i1", title: "I1" },
            { id: "i2", title: "I2" },
            { id: "cl", title: "Checklist" },
          ],
        },
      ],
    },
  });
  return r.json.board_id;
}

async function notify(body: Record<string, unknown>) {
  return post<any>(`${broker.url}/notify-session`, body);
}

async function getUnanswered() {
  return (
    await post<any>(`${broker.url}/get-unanswered`, {
      cc_session_id: ccSessionId,
    })
  ).json;
}

async function boardUnread(bid: string): Promise<number> {
  const r = await get<any>(`${broker.url}/api/sessions`);
  for (const s of r.json.sessions) {
    for (const b of s.boards ?? []) {
      if (b.id === bid) return b.unread_count;
    }
  }
  throw new Error(`board ${bid} not in /api/sessions`);
}

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccSessionId = await attachCC(broker.url, sessionId);
  boardId = await createBoard(sessionId, "Notify target");
  const flag = await post<{ ok: boolean }>(`${broker.url}/set-node-checklist`, {
    board_id: boardId,
    node_id: "cl",
    is_checklist: true,
  });
  expect(flag.json.ok).toBe(true);
});
afterAll(async () => {
  await broker.kill();
});

describe("/notify-session", () => {
  test("success: external thread item + linked external_notify pending row + unanswered flag", async () => {
    const r = await notify({
      board_id: boardId,
      node_id: "i1",
      text: "Sentry: TypeError in checkout",
      source_label: "sentry-relay",
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.message_id).toBe("number");
    expect(r.json.source_label).toBe("sentry-relay");

    const db = openDb();
    try {
      const item = db
        .query("SELECT * FROM thread_items WHERE id = ?")
        .get(r.json.message_id) as any;
      expect(item.source).toBe("external");
      expect(item.sender_label).toBe("sentry-relay");
      expect(item.node_id).toBe("i1");
      expect(item.read_at).toBeNull();

      const pend = db
        .query("SELECT * FROM pending_messages WHERE thread_item_id = ?")
        .all(r.json.message_id) as any[];
      expect(pend.length).toBe(1);
      expect(pend[0].kind).toBe("external_notify");
      expect(pend[0].session_id).toBe(sessionId);
      expect(pend[0].delivered).toBe(0);

      const un = db
        .query(
          "SELECT * FROM unanswered_nodes WHERE session_id = ? AND board_id = ? AND node_id = ?",
        )
        .get(sessionId, boardId, "i1") as any;
      expect(un).toBeTruthy();
    } finally {
      db.close();
    }

    // The Stop-hook endpoint names this node.
    const u = await getUnanswered();
    expect(u.count).toBeGreaterThanOrEqual(1);
    const n = u.nodes.find((x: any) => x.board_id === boardId && x.node_id === "i1");
    expect(n).toBeTruthy();
    expect(n.reply_tool).toBe("post_to_node");
    expect(u.block).toBe(true);

    // The UI board view carries the item with its label.
    const view = await get<any>(`${broker.url}/api/board/${boardId}`);
    const t = (view.json.threads.i1 as any[]).find((x) => x.id === r.json.message_id);
    expect(t.source).toBe("external");
    expect(t.sender_label).toBe("sentry-relay");
  });

  test("node status is left untouched", async () => {
    const before = await get<any>(`${broker.url}/api/board/${boardId}`);
    const statusBefore = before.json.nodes.find((n: any) => n.id === "i2").status;
    const r = await notify({ board_id: boardId, node_id: "i2", text: "status check" });
    expect(r.json.ok).toBe(true);
    const after = await get<any>(`${broker.url}/api/board/${boardId}`);
    expect(after.json.nodes.find((n: any) => n.id === "i2").status).toBe(statusBefore);
    // Clean up i2's flag so later tests start from a known set.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i2",
      message: "ack",
      status: statusBefore,
      issue_ids: [],
    });
  });

  test("poll delivers kind external_notify with label and does NOT duplicate the thread item", async () => {
    const r = await notify({
      board_id: boardId,
      node_id: "i1",
      text: "poll-me-external-42",
      source_label: "sentry-relay",
    });
    expect(r.json.ok).toBe(true);
    const countBefore = (
      (await get<any>(`${broker.url}/api/board/${boardId}`)).json.threads.i1 as any[]
    ).length;

    const polled = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    const msg = polled.json.messages.find((m) => m.text === "poll-me-external-42");
    expect(msg).toBeTruthy();
    expect(msg.kind).toBe("external_notify");
    expect(msg.thread_item_id).toBe(r.json.message_id);
    expect(msg.sender_label).toBe("sentry-relay");
    expect(msg.node_id).toBe("i1");

    const after = (await get<any>(`${broker.url}/api/board/${boardId}`)).json.threads
      .i1 as any[];
    expect(after.length).toBe(countBefore);
    expect(after.filter((x) => x.text === "poll-me-external-42").length).toBe(1);
    expect(after.some((x) => x.text === "poll-me-external-42" && x.source === "user")).toBe(
      false,
    );

    // Drained: a second poll does not re-deliver it.
    const again = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    expect(again.json.messages.some((m) => m.text === "poll-me-external-42")).toBe(false);
  });

  test("status-only post does not clear; a post_to_node WITH a message clears unanswered", async () => {
    await notify({ board_id: boardId, node_id: "i1", text: "needs a reply" });
    const statusOnly = await post<any>(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "",
      status: "discussing",
      issue_ids: [],
    });
    expect(statusOnly.json.ok).toBe(true);
    let u = await getUnanswered();
    expect(u.nodes.some((x: any) => x.board_id === boardId && x.node_id === "i1")).toBe(true);

    const reply = await post<any>(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "Looked at it — known issue, fixing.",
      status: "discussing",
      issue_ids: [],
    });
    expect(reply.json.ok).toBe(true);
    u = await getUnanswered();
    expect(u.nodes.some((x: any) => x.board_id === boardId && x.node_id === "i1")).toBe(false);
  });

  test("defaults: node_id -> 'main' on the default board, label -> 'external'", async () => {
    const sessions = await get<any>(`${broker.url}/api/sessions`);
    const me = sessions.json.sessions.find((s: any) => s.id === sessionId);
    const def = me.boards.find((b: any) => b.is_default);
    expect(def).toBeTruthy();
    const r = await notify({ board_id: def.id, text: "default target" });
    expect(r.json.ok).toBe(true);
    expect(r.json.source_label).toBe("external");
    const view = await get<any>(`${broker.url}/api/board/${def.id}`);
    const t = (view.json.threads.main as any[]).find((x) => x.id === r.json.message_id);
    expect(t.source).toBe("external");
    expect(t.sender_label).toBe("external");
  });

  test("label sanitization", async () => {
    const cases: [unknown, string][] = [
      ["sentry relay", "sentry-relay"],
      ['evil"); drop', "evil-drop"],
      ["  ok.label_1  ", "ok.label_1"],
      ["!!!", "external"],
      [42, "external"],
      ["x".repeat(100), "x".repeat(40)],
    ];
    for (const [input, expected] of cases) {
      const r = await notify({
        board_id: boardId,
        node_id: "i1",
        text: "label case",
        source_label: input,
      });
      expect(r.json.ok).toBe(true);
      expect(r.json.source_label).toBe(expected);
      expect(r.json.source_label).toMatch(/^[A-Za-z0-9._-]{1,40}$/);
    }
  });

  test("rejects concern / checklist / missing node / missing board", async () => {
    const concern = await notify({ board_id: boardId, node_id: "c1", text: "x" });
    expect(concern.json.ok).toBe(false);
    expect(concern.json.reason).toBe("invalid_target");

    const cl = await notify({ board_id: boardId, node_id: "cl", text: "x" });
    expect(cl.json.ok).toBe(false);
    expect(cl.json.reason).toBe("invalid_target");

    const missing = await notify({ board_id: boardId, node_id: "nope", text: "x" });
    expect(missing.json.ok).toBe(false);
    expect(missing.json.reason).toBe("node_not_found");

    const noBoard = await notify({ board_id: "bd_nope", node_id: "i1", text: "x" });
    expect(noBoard.json.ok).toBe(false);
    expect(noBoard.json.reason).toBe("board_not_found");
  });

  test("rejects empty / oversized text and bad fields", async () => {
    const empty = await notify({ board_id: boardId, node_id: "i1", text: "   " });
    expect(empty.json.ok).toBe(false);
    expect(empty.json.reason).toBe("invalid_request");

    const big = await notify({ board_id: boardId, node_id: "i1", text: "a".repeat(8001) });
    expect(big.json.ok).toBe(false);
    expect(big.json.reason).toBe("text_too_long");

    const edge = await notify({ board_id: boardId, node_id: "i1", text: "a".repeat(8000) });
    expect(edge.json.ok).toBe(true);

    const noBoardId = await notify({ node_id: "i1", text: "x" });
    expect(noBoardId.json.ok).toBe(false);
    expect(noBoardId.json.reason).toBe("invalid_request");
  });

  test("no_recipient when the owning session has no cc_session_id", async () => {
    // create_board refuses an unattached session, so attach, create, then drop
    // the binding directly in the DB to reach the "no cc_session_id" state.
    const lone = await registerSession(broker.url, "/tmp/pd-test-lone");
    await attachCC(broker.url, lone);
    const bid = await createBoard(lone, "Unattached");
    const w = new Database(broker.dbPath);
    try {
      w.run("UPDATE sessions SET cc_session_id = NULL WHERE id = ?", [lone]);
    } finally {
      w.close();
    }
    const r = await notify({ board_id: bid, node_id: "i1", text: "anyone?" });
    expect(r.json).toEqual({ ok: false, error: "no_recipient", reason: "no_recipient" });
    const view = await get<any>(`${broker.url}/api/board/${bid}`);
    expect((view.json.threads.i1 ?? []).length).toBe(0);
  });

  test("no_recipient when the owning session is not alive", async () => {
    const dead = await registerSession(broker.url, "/tmp/pd-test-dead");
    await attachCC(broker.url, dead);
    const bid = await createBoard(dead, "Dead owner");
    await post(`${broker.url}/unregister`, { session_id: dead });
    const r = await notify({ board_id: bid, node_id: "i1", text: "anyone?" });
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("no_recipient");
  });

  test("unread count includes the notice and mark-read clears it", async () => {
    await post(`${broker.url}/mark-board-read`, { board_id: boardId });
    expect(await boardUnread(boardId)).toBe(0);
    const r = await notify({ board_id: boardId, node_id: "i1", text: "unread me" });
    expect(r.json.ok).toBe(true);
    expect(await boardUnread(boardId)).toBe(1);
    const m = await post<any>(`${broker.url}/mark-thread-items-read`, {
      thread_item_ids: [r.json.message_id],
    });
    expect(m.json.marked).toBe(1);
    expect(await boardUnread(boardId)).toBe(0);
  });

  test("a notice resurfaces a paused board", async () => {
    const bid = await createBoard(sessionId, "Shelved");
    const s = await post<any>(`${broker.url}/set-board-status`, {
      board_id: bid,
      status: "paused",
    });
    expect(s.json.ok).toBe(true);
    const r = await notify({ board_id: bid, node_id: "i1", text: "wake up" });
    expect(r.json.ok).toBe(true);
    const view = await get<any>(`${broker.url}/api/board/${bid}`);
    expect(view.json.board.status).not.toBe("paused");
  });
});
