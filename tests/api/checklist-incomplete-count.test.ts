import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The post-compact SessionStart hook asks the broker "how many unfinished
// decision checklists does this CC session own?" so it can emit a count-only
// nudge. "Unfinished" = a checklist node on a non-archived board owned by the
// session with at least one item not done/dropped. Empty checklists don't
// count. Looked up by cc_session_id (hooks only know the CC side).

let broker: BrokerHandle;
let sessionId: string;
let ccId: string;
let boardId: string;

async function count(cc = ccId): Promise<{ ok: boolean; count: number }> {
  const r = await post<{ ok: boolean; count: number }>(
    `${broker.url}/get-incomplete-checklists`,
    { cc_session_id: cc },
  );
  return r.json;
}

async function makeChecklistBoard(node = "cl"): Promise<string> {
  const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "B",
      concerns: [{ id: "c1", title: "C1", items: [{ id: node, title: "CL" }] }],
    },
  });
  const bid = c.json.board_id;
  await post(`${broker.url}/set-node-checklist`, {
    board_id: bid,
    node_id: node,
  });
  return bid;
}

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccId = await attachCC(broker.url, sessionId);
  boardId = await makeChecklistBoard("cl");
});
afterAll(async () => {
  await broker.kill();
});

describe("incomplete-checklist count (post-compact nudge source)", () => {
  test("an empty checklist node does NOT count", async () => {
    expect(await count()).toEqual({ ok: true, count: 0 });
  });

  test("a pending item makes the checklist count as unfinished", async () => {
    await post(`${broker.url}/record-decision`, {
      board_id: boardId,
      node_id: "cl",
      summary: "X であること",
    });
    expect((await count()).count).toBe(1);
  });

  test("an in-progress item still counts as unfinished", async () => {
    const r = await post<{ ok: boolean; item_id: number }>(
      `${broker.url}/record-decision`,
      { board_id: boardId, node_id: "cl", summary: "Y であること" },
    );
    await post(`${broker.url}/update-decision`, {
      item_id: r.json.item_id,
      status: "in-progress",
    });
    expect((await count()).count).toBe(1); // still one unfinished board
  });

  test("a second board with an open checklist bumps the count to 2", async () => {
    const b2 = await makeChecklistBoard("cl2");
    await post(`${broker.url}/record-decision`, {
      board_id: b2,
      node_id: "cl2",
      summary: "Z であること",
    });
    expect((await count()).count).toBe(2);
  });

  test("once every item is done/dropped the board drops out of the count", async () => {
    // Resolve every item on the FIRST board (it had a pending + an in-progress).
    const board = await fetch(`${broker.url}/api/board/${boardId}`).then((r) =>
      r.json(),
    );
    const node = board.nodes.find((n: any) => n.id === "cl");
    for (const it of node.checklist_items) {
      await post(`${broker.url}/update-decision`, {
        item_id: it.id,
        status: "done",
      });
    }
    // Board 1 now fully done → only board 2 remains unfinished.
    expect((await count()).count).toBe(1);
  });

  test("an unknown cc_session_id returns ok:false, count 0", async () => {
    expect(await count("cc-does-not-exist")).toEqual({ ok: false, count: 0 });
  });
});
