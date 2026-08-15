import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The "pending" board status is the one hybrid in the taxonomy: it is set
// MANUALLY (set_board_status shelves the board and freezes the auto-rollup with
// auto_status_sync=0) but it AUTO-REVERTS to "discussing" the moment any new
// post — a CC reply OR a user reply — lands on the board. These tests pin both
// halves of that contract down.

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

async function createBoard(title: string): Promise<string> {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title,
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  return r.json.board_id;
}

async function fetchBoard(
  boardId: string,
): Promise<{ status: string; auto_status_sync: number }> {
  const v = await get<any>(`${broker.url}/api/board/${boardId}`);
  return {
    status: v.json.board.status,
    auto_status_sync: v.json.board.auto_status_sync,
  };
}

async function shelve(boardId: string) {
  const r = await post<{ ok: boolean }>(`${broker.url}/set-board-status`, {
    board_id: boardId,
    status: "pending",
  });
  expect(r.json.ok).toBe(true);
}

describe("board status 'pending' (shelve + auto-resurface-on-post)", () => {
  test("set_board_status('pending') sets status=pending AND freezes auto_status_sync=0", async () => {
    const id = await createBoard("Shelve me");
    await shelve(id);
    const b = await fetchBoard(id);
    expect(b.status).toBe("pending");
    expect(b.auto_status_sync).toBe(0);
  });

  test("a shelved board stays frozen through node-status changes (no post = no resurface)", async () => {
    const id = await createBoard("Frozen while shelved");
    await shelve(id);
    // A bare node-status mutation must NOT resurface a shelved board — only an
    // actual post does. Even settling the only item leaves it pending.
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    const b = await fetchBoard(id);
    expect(b.status).toBe("pending");
    expect(b.auto_status_sync).toBe(0);
  });

  test("a CC post (/post-to-node) reverts pending → discussing and re-enables auto_status_sync", async () => {
    const id = await createBoard("CC revert");
    await shelve(id);
    const r = await post<{
      ok: boolean;
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: id,
      node_id: "i1",
      message: "back to work",
    });
    expect(r.json.ok).toBe(true);
    // The transition is reported back to the MCP caller too.
    expect(r.json.board_status_changed).toEqual({
      from: "pending",
      to: "discussing",
    });
    const b = await fetchBoard(id);
    expect(b.status).toBe("discussing");
    expect(b.auto_status_sync).toBe(1);
  });

  test("a user post (/submit-answer delivered via /poll-messages) reverts pending → discussing and re-enables auto_status_sync", async () => {
    const id = await createBoard("User revert");
    await shelve(id);

    // Submit in the background; act as the recipient by polling so the pending
    // row flips delivered=1 and submit-answer resolves.
    const submitP = post<{
      ok: boolean;
      board_status_changed?: { from: string; to: string };
    }>(`${broker.url}/submit-answer`, {
      board_id: id,
      node_id: "i1",
      text: "user is back",
    });
    await new Promise((r) => setTimeout(r, 80));
    const polled = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    expect(polled.json.messages.length).toBeGreaterThanOrEqual(1);
    const final = await submitP;
    expect(final.json.ok).toBe(true);
    expect(final.json.board_status_changed).toEqual({
      from: "pending",
      to: "discussing",
    });

    const b = await fetchBoard(id);
    expect(b.status).toBe("discussing");
    expect(b.auto_status_sync).toBe(1);
  });

  test("/set-board-status accepts 'pending' as a valid value", async () => {
    const id = await createBoard("Accepts pending");
    const r = await post<{ ok: boolean }>(`${broker.url}/set-board-status`, {
      board_id: id,
      status: "pending",
    });
    expect(r.json.ok).toBe(true);
    expect((await fetchBoard(id)).status).toBe("pending");
  });
});
