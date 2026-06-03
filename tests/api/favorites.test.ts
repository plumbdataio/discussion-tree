import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
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

// Helper: create a board with one item, post a CC reply, return the
// thread_item.id of that reply so a test can pin it.
async function seedPinnableMessage(brokerUrl: string, sessionId: string) {
  const board = await post<{ board_id: string }>(`${brokerUrl}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "fav-board",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  const boardId = board.json.board_id;
  await post(`${brokerUrl}/post-to-node`, {
    board_id: boardId,
    node_id: "i1",
    message: "pin me",
    status: "discussing",
  });
  // Pull the thread_item.id back out via get-board so the test isn't
  // peeking into broker internals.
  const got = await post<{
    threads: Record<string, { id: number; source: string; text: string }[]>;
  }>(`${brokerUrl}/get-board-view`, {
    board_id: boardId,
  });
  const item = got.json.threads["i1"].find(
    (t) => t.source === "cc" && t.text === "pin me",
  );
  if (!item) throw new Error("seed failed: pinnable message not found");
  return { boardId, threadItemId: item.id };
}

describe("favorites (anchors)", () => {
  test("/add-favorite pins a thread item and surfaces it via /list-favorites", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    const { boardId, threadItemId } = await seedPinnableMessage(broker.url, sid);

    const add = await post<{ ok: boolean; favorite?: { id: number } }>(
      `${broker.url}/add-favorite`,
      {
        session_id: sid,
        board_id: boardId,
        node_id: "i1",
        thread_item_id: threadItemId,
      },
    );
    expect(add.json.ok).toBe(true);
    expect(add.json.favorite?.id).toBeGreaterThan(0);

    const list = await post<{
      ok: boolean;
      favorites?: { thread_item_id: number; board_id: string }[];
    }>(`${broker.url}/list-favorites`, { session_id: sid });
    expect(list.json.ok).toBe(true);
    expect(list.json.favorites?.length).toBe(1);
    expect(list.json.favorites?.[0].thread_item_id).toBe(threadItemId);
    expect(list.json.favorites?.[0].board_id).toBe(boardId);
  });

  test("/add-favorite is idempotent (toggle re-add is a no-op)", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    const { boardId, threadItemId } = await seedPinnableMessage(broker.url, sid);

    await post(`${broker.url}/add-favorite`, {
      session_id: sid,
      board_id: boardId,
      node_id: "i1",
      thread_item_id: threadItemId,
    });
    const r2 = await post<{ ok: boolean }>(`${broker.url}/add-favorite`, {
      session_id: sid,
      board_id: boardId,
      node_id: "i1",
      thread_item_id: threadItemId,
    });
    expect(r2.json.ok).toBe(true);

    const list = await post<{ favorites: unknown[] }>(
      `${broker.url}/list-favorites`,
      { session_id: sid },
    );
    expect(list.json.favorites.length).toBe(1);
  });

  test("/remove-favorite unpins", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    const { boardId, threadItemId } = await seedPinnableMessage(broker.url, sid);

    await post(`${broker.url}/add-favorite`, {
      session_id: sid,
      board_id: boardId,
      node_id: "i1",
      thread_item_id: threadItemId,
    });
    const rem = await post<{ ok: boolean }>(`${broker.url}/remove-favorite`, {
      session_id: sid,
      thread_item_id: threadItemId,
    });
    expect(rem.json.ok).toBe(true);

    const list = await post<{ favorites: unknown[] }>(
      `${broker.url}/list-favorites`,
      { session_id: sid },
    );
    expect(list.json.favorites.length).toBe(0);
  });

  test("/add-favorite rejects a thread_item_id that doesn't belong to the given node", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    const { boardId } = await seedPinnableMessage(broker.url, sid);

    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/add-favorite`,
      {
        session_id: sid,
        board_id: boardId,
        node_id: "i1",
        thread_item_id: 999999, // doesn't exist
      },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("thread item");
  });

  test("/list-favorites returns the user's own pins ordered newest-first", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid);
    const { boardId, threadItemId: t1 } = await seedPinnableMessage(
      broker.url,
      sid,
    );
    // Second pinnable message on the same node.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "second",
      status: "discussing",
    });
    const got = await post<{
      threads: Record<string, { id: number; text: string }[]>;
    }>(`${broker.url}/get-board-view`, { board_id: boardId });
    const t2 = got.json.threads["i1"].find((t) => t.text === "second")!.id;

    await post(`${broker.url}/add-favorite`, {
      session_id: sid,
      board_id: boardId,
      node_id: "i1",
      thread_item_id: t1,
    });
    await new Promise((r) => setTimeout(r, 5)); // ensure newer timestamp
    await post(`${broker.url}/add-favorite`, {
      session_id: sid,
      board_id: boardId,
      node_id: "i1",
      thread_item_id: t2,
    });

    const list = await post<{
      favorites: { thread_item_id: number }[];
    }>(`${broker.url}/list-favorites`, { session_id: sid });
    expect(list.json.favorites.length).toBe(2);
    // Newest pin (t2) appears first.
    expect(list.json.favorites[0].thread_item_id).toBe(t2);
    expect(list.json.favorites[1].thread_item_id).toBe(t1);
  });

  test("favorites survive attach_cc_session reclaim (CC restart)", async () => {
    const sid1 = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid1);
    const { boardId, threadItemId } = await seedPinnableMessage(
      broker.url,
      sid1,
    );
    await post(`${broker.url}/add-favorite`, {
      session_id: sid1,
      board_id: boardId,
      node_id: "i1",
      thread_item_id: threadItemId,
    });

    // Simulate CC restart: unregister old session, register a new one,
    // attach to the same cc_session_id. Anchors should follow.
    await post(`${broker.url}/unregister`, { session_id: sid1 });
    const sid2 = await registerSession(broker.url);
    await post(`${broker.url}/attach-cc-session`, {
      session_id: sid2,
      cc_session_id: ccId,
    });

    const list = await post<{
      favorites: { thread_item_id: number; session_id: string }[];
    }>(`${broker.url}/list-favorites`, { session_id: sid2 });
    expect(list.json.favorites.length).toBe(1);
    expect(list.json.favorites[0].thread_item_id).toBe(threadItemId);
    expect(list.json.favorites[0].session_id).toBe(sid2);
  });
});
