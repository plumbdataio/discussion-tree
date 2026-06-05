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
let sessionId: string;
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "CL",
      concerns: [
        {
          id: "c1",
          title: "C1",
          items: [
            { id: "n1", title: "Checklist node" },
            { id: "src", title: "A decision node" },
          ],
        },
      ],
    },
  });
  boardId = c.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

async function items(): Promise<any[]> {
  const v = await get<any>(`${broker.url}/api/board/${boardId}`);
  const node = v.json.nodes.find((n: any) => n.id === "n1");
  return node?.checklist_items ?? [];
}

describe("decision checklist (record / update / mark)", () => {
  test("record_decision is rejected until the node is a checklist node", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/record-decision`,
      { board_id: boardId, node_id: "n1", summary: "X であること" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("checklist");
  });

  test("mark_checklist_node flags the node (is_checklist=1 in the view)", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/set-node-checklist`, {
      board_id: boardId,
      node_id: "n1",
    });
    expect(r.json.ok).toBe(true);
    const v = await get<any>(`${broker.url}/api/board/${boardId}`);
    const node = v.json.nodes.find((n: any) => n.id === "n1");
    expect(node.is_checklist).toBe(1);
  });

  test("record_decision appends a pending item with the source link", async () => {
    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "n1",
        summary: "認証は JWT であること。背景: セッション管理を避けるため",
        source_node_id: "src",
      },
    );
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.item_id).toBe("number");
    const its = await items();
    expect(its.length).toBe(1);
    expect(its[0].status).toBe("pending");
    expect(its[0].source_node_id).toBe("src");
    expect(its[0].summary).toContain("JWT");
  });

  test("update_decision moves an item to done", async () => {
    const id = (await items())[0].id;
    const r = await post<{ ok: boolean }>(`${broker.url}/update-decision`, {
      item_id: id,
      status: "done",
    });
    expect(r.json.ok).toBe(true);
    expect((await items())[0].status).toBe("done");
  });

  test("update_decision to dropped WITHOUT a reason is rejected", async () => {
    const id = (await items())[0].id;
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/update-decision`,
      { item_id: id, status: "dropped" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("drop_reason");
  });

  test("update_decision to dropped WITH a reason stores the reason", async () => {
    const id = (await items())[0].id;
    const r = await post<{ ok: boolean }>(`${broker.url}/update-decision`, {
      item_id: id,
      status: "dropped",
      drop_reason: "要件が消えた",
    });
    expect(r.json.ok).toBe(true);
    const it = (await items())[0];
    expect(it.status).toBe("dropped");
    expect(it.drop_reason).toBe("要件が消えた");
  });

  test("record_decision rejects an unknown node", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/record-decision`,
      { board_id: boardId, node_id: "nope", summary: "x" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("not found");
  });

  test("invalid status is rejected by update_decision", async () => {
    const id = (await items())[0].id;
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/update-decision`,
      { item_id: id, status: "bogus" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("invalid status");
  });
});

describe("settled injection (checklist boards roll up)", () => {
  test("settling a board WITH a checklist node queues a checklist_settled reminder", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "S",
        concerns: [
          {
            id: "c2",
            title: "C2",
            items: [
              { id: "cl", title: "Checklist" },
              { id: "d1", title: "Decision" },
            ],
          },
        ],
      },
    });
    const bid = c.json.board_id;
    await post(`${broker.url}/set-node-checklist`, {
      board_id: bid,
      node_id: "cl",
    });
    await post(`${broker.url}/set-node-status`, {
      board_id: bid,
      node_id: "cl",
      status: "adopted",
    });
    const r = await post<{ board_status_changed?: { to: string } }>(
      `${broker.url}/set-node-status`,
      { board_id: bid, node_id: "d1", status: "adopted" },
    );
    expect(r.json.board_status_changed?.to).toBe("settled");

    const poll = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const reminder = poll.json.messages.find(
      (m) => m.kind === "checklist_settled" && m.board_id === bid,
    );
    expect(reminder).toBeTruthy();
    expect(reminder.node_id).toBe("cl");
    expect(reminder.text).toContain("settled");
  });

  test("settling a board WITHOUT a checklist node queues no reminder", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "N",
        concerns: [{ id: "c3", title: "C3", items: [{ id: "x1", title: "X" }] }],
      },
    });
    const bid = c.json.board_id;
    await post(`${broker.url}/set-node-status`, {
      board_id: bid,
      node_id: "x1",
      status: "adopted",
    });
    const poll = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const reminder = poll.json.messages.find(
      (m) => m.kind === "checklist_settled" && m.board_id === bid,
    );
    expect(reminder).toBeFalsy();
  });

  test("settling ONE node on a checklist board queues a per-node nudge, not the board-level one yet", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "L2",
        concerns: [
          {
            id: "c4",
            title: "C4",
            items: [
              { id: "cl2", title: "Checklist" },
              { id: "dec1", title: "Decision 1" },
              { id: "dec2", title: "Decision 2" },
            ],
          },
        ],
      },
    });
    const bid = c.json.board_id;
    await post(`${broker.url}/set-node-checklist`, {
      board_id: bid,
      node_id: "cl2",
    });
    // Settle one decision; the board is NOT fully settled (cl2 + dec2 pending).
    await post(`${broker.url}/set-node-status`, {
      board_id: bid,
      node_id: "dec1",
      status: "adopted",
    });
    const poll = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const nudge = poll.json.messages.find(
      (m) => m.kind === "checklist_node_settled" && m.board_id === bid,
    );
    expect(nudge).toBeTruthy();
    expect(nudge.node_id).toBe("cl2");
    expect(nudge.text).toContain("record_decision");
    // No board-level reminder yet — the board hasn't settled.
    const boardLevel = poll.json.messages.find(
      (m) => m.kind === "checklist_settled" && m.board_id === bid,
    );
    expect(boardLevel).toBeFalsy();
  });
});
