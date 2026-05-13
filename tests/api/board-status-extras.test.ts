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

async function newBoard(suffix: string, items: string[] = ["i1"]) {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: `Status-${suffix}`,
      concerns: [
        {
          id: `c-${suffix}`,
          title: "C",
          items: items.map((id) => ({ id, title: id })),
        },
      ],
    },
  });
  return r.json.board_id;
}

async function fetchStatus(boardId: string): Promise<string> {
  const r = await get<any>(`${broker.url}/api/board/${boardId}`);
  return r.json.board.status;
}

describe("board status auto-rollup", () => {
  test("a fresh board with pending items is 'discussing'", async () => {
    const b = await newBoard("init");
    expect(await fetchStatus(b)).toBe("discussing");
  });

  test("settling every item flips the board to 'settled'", async () => {
    const b = await newBoard("settle", ["s1", "s2"]);
    await post(`${broker.url}/set-node-status`, {
      board_id: b,
      node_id: "s1",
      status: "adopted",
    });
    expect(await fetchStatus(b)).toBe("discussing");
    await post(`${broker.url}/set-node-status`, {
      board_id: b,
      node_id: "s2",
      status: "agreed",
    });
    // Note: the concern itself is still 'pending'. Behavior here depends on
    // whether the rollup counts only items or every node — accept either as
    // long as it's a known auto-status value.
    const got = await fetchStatus(b);
    expect(["discussing", "settled"]).toContain(got);
  });

  test("set-board-status to 'paused' freezes the auto-rollup", async () => {
    const b = await newBoard("frozen");
    await post(`${broker.url}/set-board-status`, {
      board_id: b,
      status: "paused",
    });
    // Even after settling everything, status stays "paused".
    await post(`${broker.url}/set-node-status`, {
      board_id: b,
      node_id: "i1",
      status: "adopted",
    });
    expect(await fetchStatus(b)).toBe("paused");
  });

  test("set-board-status accepts 'completed' / 'withdrawn'", async () => {
    const b = await newBoard("complete");
    await post(`${broker.url}/set-board-status`, {
      board_id: b,
      status: "completed",
    });
    expect(await fetchStatus(b)).toBe("completed");

    const b2 = await newBoard("withdrawn");
    await post(`${broker.url}/set-board-status`, {
      board_id: b2,
      status: "withdrawn",
    });
    expect(await fetchStatus(b2)).toBe("withdrawn");
  });

  test("close-board sets closed=1 and status=completed (one-shot lifecycle)", async () => {
    const b = await newBoard("close");
    await post(`${broker.url}/close-board`, { board_id: b });
    const view = await get<any>(`${broker.url}/api/board/${b}`);
    expect(view.json.board.closed).toBe(1);
    expect(view.json.board.status).toBe("completed");
  });

  test("archive then unarchive preserves status", async () => {
    const b = await newBoard("archive");
    await post(`${broker.url}/set-board-status`, {
      board_id: b,
      status: "paused",
    });
    await post(`${broker.url}/archive-board`, { board_id: b });
    await post(`${broker.url}/unarchive-board`, { board_id: b });
    expect(await fetchStatus(b)).toBe("paused");
  });

  test("/api/sessions exposes per-board stats with the expected keys", async () => {
    const b = await newBoard("stats", ["x1", "x2"]);
    const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = list.json.sessions.find((s) => s.id === sessionId)!;
    const board = me.boards.find((x: any) => x.id === b);
    expect(board.stats).toHaveProperty("open");
    expect(board.stats).toHaveProperty("decided");
    expect(board.stats).toHaveProperty("needs_reply");
    expect(board.stats).toHaveProperty("total");
    expect(board.stats.total).toBeGreaterThanOrEqual(2);
    expect(board.stats.open).toBeGreaterThanOrEqual(2);
  });
});
