import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Option B re-delivery: a channel push that THROWS must not lose the message.
// /poll-messages marks the row delivered AT DRAIN (before the push), so without
// this a thrown push would be silently dropped (selectPending only re-drains
// delivered=0). On a throw the poller POSTs /delivery-failed, which resets
// delivered=0 + flags requeued so the next poll re-drains and re-pushes —
// reusing the already-materialized thread item (no UI duplicate).

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
      title: "Requeue",
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

describe("delivery-failed re-queue (Option B)", () => {
  test("re-queues a delivered message for re-push without duplicating the thread item", async () => {
    const submitP = post<{ ok: boolean }>(`${broker.url}/submit-answer`, {
      board_id: boardId,
      node_id: "i1",
      text: "requeue-me-7",
    });
    // Drain: flips delivered=1 and materializes the user thread item once.
    await new Promise((r) => setTimeout(r, 80));
    const polled1 = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const msg = polled1.json.messages.find((m) => m.text === "requeue-me-7");
    expect(msg).toBeTruthy();
    const itemId = msg.thread_item_id;
    expect(typeof itemId).toBe("number");
    expect((await submitP).json.ok).toBe(true);

    // Simulate the push throwing: the poller asks the broker to re-queue.
    const df = await post<{ ok: boolean }>(`${broker.url}/delivery-failed`, {
      message_id: msg.id,
    });
    expect(df.json.ok).toBe(true);

    // Next poll re-drains the SAME message (delivered was reset to 0).
    const polled2 = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const msg2 = polled2.json.messages.find((m) => m.text === "requeue-me-7");
    expect(msg2).toBeTruthy();
    expect(msg2.id).toBe(msg.id);
    // Re-push reuses the same thread item — NO duplicate id.
    expect(msg2.thread_item_id).toBe(itemId);

    // The UI thread still has exactly ONE copy of the message.
    const threads = await fetchThreads();
    const matches = threads.i1.filter((t) => t.text === "requeue-me-7");
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(itemId);
  });

  test("/delivery-failed is a no-op for a missing/unknown message_id", async () => {
    const r1 = await post<{ ok: boolean }>(`${broker.url}/delivery-failed`, {});
    expect(r1.json.ok).toBe(false);
    const r2 = await post<{ ok: boolean }>(`${broker.url}/delivery-failed`, {
      message_id: 999999,
    });
    // Unknown id: the reset is a no-op (0 rows) but the endpoint returns ok.
    expect(r2.json.ok).toBe(true);
  });
});
