import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Option A resilience: a channel push that is SILENTLY lost (process stalled /
// OOM-killed under memory pressure — no throw, so Option B never fires) leaves
// the row delivered=1 with pushed_at NULL forever, so it never reaches CC. The
// broker's resweep re-queues such rows past a grace window, BUT only for a
// session whose poller has acked >=1 message (so an old poller that never acks
// isn't swept into a duplicate storm). Grace is forced to 0 via env here. The
// broker is shared across tests, so assertions check a SPECIFIC message's fate
// (does it re-drain?) rather than the global requeue count.

let broker: BrokerHandle;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  broker = await startBroker({ DT_UNACKED_RESWEEP_GRACE_MS: "0" });
});
afterAll(async () => {
  await broker.kill();
});

// Fire /submit-answer WITHOUT awaiting (it blocks until delivered/timeout), then
// drain via /poll-messages so delivered flips to 1 and the row materializes.
// Returns the drained pending row (id + thread_item_id).
async function submitAndDrain(
  sessionId: string,
  boardId: string,
  nodeId: string,
  text: string,
) {
  const submitP = fetch(`${broker.url}/submit-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: boardId, node_id: nodeId, text }),
  });
  await sleep(80);
  const polled = await post<{ messages: any[] }>(
    `${broker.url}/poll-messages`,
    { session_id: sessionId },
  );
  const msg = polled.json.messages.find((m) => m.text === text);
  await submitP.catch(() => {});
  return msg;
}

async function newSessionWithBoard() {
  const sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Resweep",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  return { sessionId, boardId: r.json.board_id };
}

async function poll(sessionId: string): Promise<any[]> {
  const p = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
    session_id: sessionId,
  });
  return p.json.messages;
}

describe("unacked-resweep (Option A)", () => {
  test("re-queues an unacked drained message, but leaves an acked one alone", async () => {
    const { sessionId, boardId } = await newSessionWithBoard();

    // Make the session ack-capable: drain a message and ACK it.
    const acked = await submitAndDrain(sessionId, boardId, "i1", "acked-msg");
    expect(acked).toBeTruthy();
    await post(`${broker.url}/message-acked`, { message_id: acked.id });

    // A second message drains but is NEVER acked (simulates a lost push).
    const lost = await submitAndDrain(sessionId, boardId, "i1", "lost-msg");
    expect(lost).toBeTruthy();

    await post(`${broker.url}/resweep-unacked`, {});

    // Next poll re-drains ONLY the lost message; the acked one stays delivered.
    const texts = (await poll(sessionId)).map((m) => m.text);
    expect(texts).toContain("lost-msg");
    expect(texts).not.toContain("acked-msg");
  });

  test("re-push reuses the same thread item (no UI duplicate)", async () => {
    const { sessionId, boardId } = await newSessionWithBoard();
    await post(`${broker.url}/message-acked`, {
      message_id: (await submitAndDrain(sessionId, boardId, "i1", "seed")).id,
    });

    const first = await submitAndDrain(sessionId, boardId, "i1", "dup-check");
    const itemId = first.thread_item_id;
    expect(typeof itemId).toBe("number");

    await post(`${broker.url}/resweep-unacked`, {});
    const redrained = (await poll(sessionId)).find(
      (m) => m.text === "dup-check",
    );
    expect(redrained).toBeTruthy();
    expect(redrained.id).toBe(first.id);
    // The re-drained row keeps the ORIGINAL thread item — no second UI copy.
    expect(redrained.thread_item_id).toBe(itemId);

    const board = await get<{ threads: Record<string, any[]> }>(
      `${broker.url}/api/board/${boardId}`,
    );
    const copies = (board.json.threads.i1 ?? []).filter(
      (t) => t.text === "dup-check",
    );
    expect(copies.length).toBe(1);
  });

  test("does NOT re-queue for a session whose poller never acked (deploy gate)", async () => {
    const { sessionId, boardId } = await newSessionWithBoard();

    // Drain a message but NEVER ack anything for this session (old poller).
    const msg = await submitAndDrain(sessionId, boardId, "i1", "old-poller-msg");
    expect(msg).toBeTruthy();

    await post(`${broker.url}/resweep-unacked`, {});

    // The message was NOT re-queued — a poll for THIS session returns nothing new.
    const texts = (await poll(sessionId)).map((m) => m.text);
    expect(texts).not.toContain("old-poller-msg");
  });
});
