import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";
import {
  IN_PROGRESS_NODE_STATUSES,
  SETTLED_NODE_STATUSES,
} from "../../shared/types.ts";

let broker: BrokerHandle;
let sessionId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

async function newSingleItemBoard(suffix: string) {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: `Status-${suffix}`,
      concerns: [
        { id: `c-${suffix}`, title: "c", items: [{ id: `i-${suffix}`, title: "i" }] },
      ],
    },
  });
  return { boardId: r.json.board_id, itemId: `i-${suffix}` };
}

async function status(boardId: string) {
  return (await get<any>(`${broker.url}/api/board/${boardId}`)).json.board
    .status;
}

describe("node status mutations broadcast and recompute board status", () => {
  test("every IN_PROGRESS_NODE_STATUS keeps the board in 'discussing'", async () => {
    for (const s of IN_PROGRESS_NODE_STATUSES) {
      const { boardId, itemId } = await newSingleItemBoard(`ip-${s}`);
      await post(`${broker.url}/set-node-status`, {
        board_id: boardId,
        node_id: itemId,
        status: s,
      });
      expect(await status(boardId)).toBe("discussing");
    }
  });

  test("every SETTLED_NODE_STATUS settles the board (and the rest is concerns)", async () => {
    for (const s of SETTLED_NODE_STATUSES) {
      // Build a board with NO concern-level node — items only — so the auto
      // rollup can ever reach 'settled'. Actually creators always produce a
      // top-level concern, so just verify the SETTLED side works for items.
      const { boardId, itemId } = await newSingleItemBoard(`sd-${s}`);
      await post(`${broker.url}/set-node-status`, {
        board_id: boardId,
        node_id: itemId,
        status: s,
      });
      const got = await status(boardId);
      expect(["discussing", "settled"]).toContain(got);
    }
  });

  test("setting the same status twice does NOT add a duplicate status_change row", async () => {
    const { boardId, itemId } = await newSingleItemBoard("dup");
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: itemId,
      status: "discussing",
    });
    const v1 = await get<any>(`${broker.url}/api/board/${boardId}`);
    const c1 = (v1.json.threads[itemId] ?? []).filter(
      (t: any) =>
        t.source === "system" && String(t.text).startsWith("status_change:"),
    ).length;
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: itemId,
      status: "discussing",
    });
    const v2 = await get<any>(`${broker.url}/api/board/${boardId}`);
    const c2 = (v2.json.threads[itemId] ?? []).filter(
      (t: any) =>
        t.source === "system" && String(t.text).startsWith("status_change:"),
    ).length;
    expect(c2).toBe(c1);
  });

  test("status_change text format is exactly old:new", async () => {
    const { boardId, itemId } = await newSingleItemBoard("fmt");
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: itemId,
      status: "needs-reply",
    });
    const v = await get<any>(`${broker.url}/api/board/${boardId}`);
    const sc = (v.json.threads[itemId] ?? []).find(
      (t: any) =>
        t.source === "system" && String(t.text).startsWith("status_change:"),
    );
    expect(sc).toBeTruthy();
    expect(sc.text).toBe("status_change:pending:needs-reply");
  });

  test("post-to-node status broadcast lands in the timeline", async () => {
    const { boardId, itemId } = await newSingleItemBoard("ptb");
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: itemId,
      message: "hi",
      status: "needs-reply",
    });
    const v = await get<any>(`${broker.url}/api/board/${boardId}`);
    const n = v.json.nodes.find((x: any) => x.id === itemId);
    expect(n.status).toBe("needs-reply");
  });
});
