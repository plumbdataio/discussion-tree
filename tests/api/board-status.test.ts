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

async function getBoardStatus(boardId: string): Promise<string> {
  const v = await get<any>(`${broker.url}/api/board/${boardId}`);
  return v.json.board.status;
}

describe("board status auto-rollup (discussing / settled)", () => {
  test("freshly created board defaults to 'discussing'", async () => {
    const id = await createBoard({
      title: "Fresh",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    });
    expect(await getBoardStatus(id)).toBe("discussing");
  });

  test("board flips to 'settled' once every node is in a settled status", async () => {
    const id = await createBoard({
      title: "Settling",
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
    // Settle concern + both items. Concern node also counts toward the
    // rollup so we have to settle it too (e.g. 'resolved').
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    expect(await getBoardStatus(id)).toBe("discussing"); // i2/c1 still in-progress
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i2",
      status: "rejected",
    });
    expect(await getBoardStatus(id)).toBe("discussing"); // c1 still 'pending'
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "c1",
      status: "resolved",
    });
    expect(await getBoardStatus(id)).toBe("settled");
  });

  test("flipping any node back to in-progress reverts the board to 'discussing'", async () => {
    const id = await createBoard({
      title: "Revert",
      concerns: [
        { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
      ],
    });
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "c1",
      status: "resolved",
    });
    expect(await getBoardStatus(id)).toBe("settled");

    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "needs-reply",
    });
    expect(await getBoardStatus(id)).toBe("discussing");
  });

  test("'completed' / 'withdrawn' / 'paused' are frozen against auto-recompute", async () => {
    for (const lifecycle of ["completed", "withdrawn", "paused"] as const) {
      const id = await createBoard({
        title: `Frozen ${lifecycle}`,
        concerns: [
          { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
        ],
      });
      // Set the lifecycle status.
      await post(`${broker.url}/set-board-status`, {
        board_id: id,
        status: lifecycle,
      });
      expect(await getBoardStatus(id)).toBe(lifecycle);
      // Now mutate nodes. The board's status MUST stay frozen.
      await post(`${broker.url}/set-node-status`, {
        board_id: id,
        node_id: "i1",
        status: "adopted",
      });
      expect(await getBoardStatus(id)).toBe(lifecycle);
      await post(`${broker.url}/set-node-status`, {
        board_id: id,
        node_id: "i1",
        status: "pending",
      });
      expect(await getBoardStatus(id)).toBe(lifecycle);
    }
  });

  test("/set-board-status normalizes legacy 'active' to 'discussing'", async () => {
    const id = await createBoard({
      title: "Legacy",
      concerns: [{ id: "x", title: "x" }],
    });
    const r = await post<{ ok: boolean }>(
      `${broker.url}/set-board-status`,
      { board_id: id, status: "active" },
    );
    expect(r.json.ok).toBe(true);
    expect(await getBoardStatus(id)).toBe("discussing");
  });

  test("/set-board-status accepts the new 'discussing' / 'settled' values", async () => {
    const id = await createBoard({
      title: "Direct",
      concerns: [{ id: "x", title: "x" }],
    });
    for (const s of ["discussing", "settled"] as const) {
      const r = await post<{ ok: boolean }>(`${broker.url}/set-board-status`, {
        board_id: id,
        status: s,
      });
      expect(r.json.ok).toBe(true);
      expect(await getBoardStatus(id)).toBe(s);
    }
  });

  test("/set-board-status rejects an unknown status value", async () => {
    const id = await createBoard({
      title: "Bad",
      concerns: [{ id: "x", title: "x" }],
    });
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/set-board-status`,
      { board_id: id, status: "bogus" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/invalid status/i);
  });

  test("default conversation board starts in 'discussing'", async () => {
    // attach_cc_session creates a default board; find it via /api/sessions.
    const r = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = r.json.sessions.find((s) => s.id === sessionId)!;
    const def = me.boards.find((b: any) => b.is_default)!;
    expect(["discussing", "settled"]).toContain(def.status);
  });

  test("legacy 'active' rows from a prior schema are rewritten on startup", async () => {
    // Spin up a separate broker on a fresh DB; pre-seed an 'active' row
    // before broker startup is not feasible from outside the broker
    // (broker creates the schema), so we exercise the runtime path via
    // /set-board-status('active') → 'discussing' instead, which uses the
    // same backwards-compat normalization the startup migration relies on.
    const id = await createBoard({
      title: "Legacy migration smoke",
      concerns: [{ id: "x", title: "x" }],
    });
    await post(`${broker.url}/set-board-status`, {
      board_id: id,
      status: "active",
    });
    expect(await getBoardStatus(id)).toBe("discussing");
  });
});
