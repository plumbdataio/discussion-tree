import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Surface feature ①: a posted/received message's thread_items.id is handed
// back to CC so it can reference the exact message later (checklist sources).
//   - post_to_node returns message_id (its own CC post).
//   - /submit-answer materializes the user reply AT delivery and /poll-messages
//     carries that thread_item_id, with NO duplicate thread item.
//   - structure-requests / notes carry no thread_item_id.

let broker: BrokerHandle;
let sessionId: string;
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "MsgId",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  boardId = r.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

async function fetchThreads() {
  const r = await get<any>(`${broker.url}/api/board/${boardId}`);
  return r.json.threads as Record<string, any[]>;
}

describe("message id surface", () => {
  test("post_to_node returns message_id matching the inserted CC thread item", async () => {
    const r = await post<{ ok: boolean; message_id?: number }>(
      `${broker.url}/post-to-node`,
      {
        board_id: boardId,
        node_id: "i1",
        message: "cc-post-with-id",
        status: "discussing",
      },
    );
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.message_id).toBe("number");

    const threads = await fetchThreads();
    const cc = threads.i1.find(
      (t) => t.source === "cc" && t.text === "cc-post-with-id",
    )!;
    expect(cc).toBeTruthy();
    expect(cc.id).toBe(r.json.message_id);
  });

  test("/poll-messages carries thread_item_id for a delivered user reply, and the reply is not duplicated", async () => {
    const submitP = post<{ ok: boolean }>(`${broker.url}/submit-answer`, {
      board_id: boardId,
      node_id: "i1",
      text: "unique-user-reply-42",
    });

    // Act as the recipient: polling flips delivered=1 and (now) materializes
    // the user thread item, returning its id.
    await new Promise((r) => setTimeout(r, 80));
    const polled = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const msg = polled.json.messages.find(
      (m) => m.text === "unique-user-reply-42",
    );
    expect(msg).toBeTruthy();
    expect(typeof msg.thread_item_id).toBe("number");

    const final = await submitP;
    expect(final.json.ok).toBe(true);

    // Exactly one thread item with that text — submit-answer must NOT insert a
    // second copy now that poll-messages materializes it.
    const threads = await fetchThreads();
    const matches = threads.i1.filter((t) => t.text === "unique-user-reply-42");
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(msg.thread_item_id);
    // The surfaced id must point at a real user-sourced item.
    expect(matches[0].source).toBe("user");
  });

  test("structure-requests carry no thread_item_id (no message_id surfaced)", async () => {
    const submitP = post<{ ok: boolean }>(`${broker.url}/submit-answer`, {
      board_id: boardId,
      node_id: "__board__",
      text: "structure: add a Spike concern",
      kind: "board_structure_request",
    });
    await new Promise((r) => setTimeout(r, 80));
    const polled = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const msg = polled.json.messages.find(
      (m) => m.kind === "board_structure_request",
    );
    expect(msg).toBeTruthy();
    expect(msg.thread_item_id == null).toBe(true);
    await submitP;
  });
});
