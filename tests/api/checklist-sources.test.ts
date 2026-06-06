import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Surface feature ②: a checklist item carries structured `sources` (0..N),
// each a lowest-level {kind, id} pointer (board | node | message). board_id is
// resolved + stored so the UI can link directly. source_node_id is the legacy
// node shorthand. getBoardView attaches sources to each item.

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
      title: "Sources",
      concerns: [
        {
          id: "c1",
          title: "C1",
          items: [
            { id: "cl", title: "Checklist node" },
            { id: "dec", title: "A decision node" },
          ],
        },
      ],
    },
  });
  boardId = c.json.board_id;
  await post(`${broker.url}/set-node-checklist`, {
    board_id: boardId,
    node_id: "cl",
  });
});
afterAll(async () => {
  await broker.kill();
});

async function items(): Promise<any[]> {
  const v = await get<any>(`${broker.url}/api/board/${boardId}`);
  const node = v.json.nodes.find((n: any) => n.id === "cl");
  return node?.checklist_items ?? [];
}

describe("checklist sources", () => {
  test("record_decision with sources=[{kind:node}] stores and getBoardView returns it", async () => {
    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "cl",
        summary: "X であること",
        sources: [{ kind: "node", id: "dec" }],
      },
    );
    expect(r.json.ok).toBe(true);
    const it = (await items()).find((i) => i.id === r.json.item_id)!;
    expect(it.sources).toHaveLength(1);
    expect(it.sources[0].kind).toBe("node");
    expect(it.sources[0].ref_id).toBe("dec");
    expect(it.sources[0].board_id).toBe(boardId);
  });

  test("legacy source_node_id becomes a node source", async () => {
    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "cl",
        summary: "Y であること",
        source_node_id: "dec",
      },
    );
    expect(r.json.ok).toBe(true);
    const it = (await items()).find((i) => i.id === r.json.item_id)!;
    expect(it.sources).toHaveLength(1);
    expect(it.sources[0].kind).toBe("node");
    expect(it.sources[0].ref_id).toBe("dec");
    // The legacy column is still populated for backward compat.
    expect(it.source_node_id).toBe("dec");
  });

  test("a message source resolves its board_id from the thread item", async () => {
    // Create a real message and capture its id.
    const posted = await post<{ ok: boolean; message_id: number }>(
      `${broker.url}/post-to-node`,
      {
        board_id: boardId,
        node_id: "dec",
        message: "the decisive message",
        status: "discussing",
      },
    );
    const messageId = posted.json.message_id;
    expect(typeof messageId).toBe("number");

    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "cl",
        summary: "Z であること",
        sources: [{ kind: "message", id: String(messageId) }],
      },
    );
    expect(r.json.ok).toBe(true);
    const it = (await items()).find((i) => i.id === r.json.item_id)!;
    expect(it.sources).toHaveLength(1);
    expect(it.sources[0].kind).toBe("message");
    expect(it.sources[0].ref_id).toBe(String(messageId));
    expect(it.sources[0].board_id).toBe(boardId);
  });

  test("multiple sources are stored in order", async () => {
    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "cl",
        summary: "W であること",
        sources: [
          { kind: "board", id: boardId },
          { kind: "node", id: "dec" },
        ],
      },
    );
    expect(r.json.ok).toBe(true);
    const it = (await items()).find((i) => i.id === r.json.item_id)!;
    expect(it.sources).toHaveLength(2);
    expect(it.sources[0]).toMatchObject({ kind: "board", position: 0 });
    expect(it.sources[1]).toMatchObject({ kind: "node", position: 1 });
  });

  test("an unknown node source is rejected and no item is created (atomic)", async () => {
    const before = (await items()).length;
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "cl",
        summary: "should not persist",
        sources: [{ kind: "node", id: "no-such-node" }],
      },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("source node not found");
    expect((await items()).length).toBe(before);
  });

  test("an invalid source kind is rejected", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/record-decision`,
      {
        board_id: boardId,
        node_id: "cl",
        summary: "bad kind",
        sources: [{ kind: "paragraph", id: "x" }],
      },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("invalid source kind");
  });

  test("no sources → empty sources array", async () => {
    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      { board_id: boardId, node_id: "cl", summary: "no source であること" },
    );
    expect(r.json.ok).toBe(true);
    const it = (await items()).find((i) => i.id === r.json.item_id)!;
    expect(it.sources).toEqual([]);
  });
});
