import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Verifies that node-mutating broker endpoints report a board-level rollup
// transition back in their HTTP response (board_status_changed), so the MCP
// tool layer can surface it to the LLM — not just the UI WebSocket.

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

async function createBoard(structure: any): Promise<string> {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure,
  });
  return r.json.board_id;
}

describe("board_status_changed in mutation responses", () => {
  test("/set-node-status reports discussing → settled when the last item lands", async () => {
    const id = await createBoard({
      title: "Rollup A",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    });
    const r = await post<{
      ok: boolean;
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.board_status_changed).toEqual({
      from: "discussing",
      to: "settled",
    });
  });

  test("/set-node-status omits board_status_changed when the rollup doesn't move", async () => {
    const id = await createBoard({
      title: "Rollup B",
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
    });
    // Settling only i1 leaves i2 in-progress → board stays "discussing".
    const r = await post<{
      ok: boolean;
      board_status_changed?: unknown;
    }>(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.board_status_changed).toBeUndefined();
  });

  test("/set-node-status reports settled → discussing when an item re-opens", async () => {
    const id = await createBoard({
      title: "Rollup C",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    });
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    const r = await post<{
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "needs-reply",
    });
    expect(r.json.board_status_changed).toEqual({
      from: "settled",
      to: "discussing",
    });
  });

  test("/post-to-node reports the rollup transition too", async () => {
    const id = await createBoard({
      title: "Rollup D",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    });
    const r = await post<{
      ok: boolean;
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/post-to-node`, {
      board_id: id,
      node_id: "i1",
      message: "decided",
      status: "adopted",
    });
    expect(r.json.board_status_changed).toEqual({
      from: "discussing",
      to: "settled",
    });
  });

  test("/add-item reverts a settled board and reports settled → discussing", async () => {
    const id = await createBoard({
      title: "Rollup E",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    });
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    // Board is now settled; a fresh pending item should knock it back.
    const r = await post<{
      node_id: string;
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/add-item`, {
      board_id: id,
      concern_id: "c1",
      item: { id: "i2", title: "I2" },
    });
    expect(r.json.board_status_changed).toEqual({
      from: "settled",
      to: "discussing",
    });
  });

  test("/delete-node settling-by-removal reports discussing → settled", async () => {
    const id = await createBoard({
      title: "Rollup F",
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
    });
    // i1 settled, i2 still pending → board "discussing".
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    // Deleting the only in-progress item leaves all-settled → "settled".
    const r = await post<{
      ok: boolean;
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/delete-node`, {
      board_id: id,
      node_id: "i2",
    });
    expect(r.json.board_status_changed).toEqual({
      from: "discussing",
      to: "settled",
    });
  });
});
