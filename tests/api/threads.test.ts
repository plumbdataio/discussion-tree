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
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Threads",
      concerns: [
        { id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] },
      ],
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

describe("threads", () => {
  test("/post-to-node appends a CC message and bumps status to discussing", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "Hello from CC",
      status: "discussing",
    });
    expect(r.json.ok).toBe(true);

    const threads = await fetchThreads();
    expect(threads.i1.length).toBeGreaterThanOrEqual(1);
    // The post writes a CC message; if the status changed it ALSO writes a
    // trailing status_change system entry. Pick the CC one explicitly.
    const cc = threads.i1.find((t) => t.source === "cc")!;
    expect(cc).toBeTruthy();
    expect(cc.text).toBe("Hello from CC");

    const v = await get<any>(`${broker.url}/api/board/${boardId}`);
    expect(v.json.nodes.find((n: any) => n.id === "i1").status).toBe(
      "discussing",
    );
  });

  test("/post-to-node appends a status_change system entry on transition", async () => {
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "Decision",
      status: "adopted",
    });
    const threads = await fetchThreads();
    const sys = threads.i1.filter((t: any) => t.source === "system");
    expect(sys.some((s) => s.text.includes("status_change"))).toBe(true);
  });

  test("/submit-answer: no recipient yet (different session, no cc bind) → errors.no_recipient", async () => {
    const naked = await registerSession(broker.url);
    const r2 = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "Submit",
        concerns: [{ id: "x", title: "x", items: [{ id: "y", title: "y" }] }],
      },
    });
    // Re-bind the board to a session WITHOUT cc_session_id so submit fails with no_recipient.
    // Use a trick: unregister our attached session so its alive=0; submit-answer
    // checks alive=1 AND cc_session_id, both gates active. Actually simpler:
    // attach board to the naked session via /attach-to-board.
    await post(`${broker.url}/attach-to-board`, {
      board_id: r2.json.board_id,
      session_id: naked,
    });
    const r = await post<{
      ok: boolean;
      error?: string;
      reason?: string;
    }>(`${broker.url}/submit-answer`, {
      board_id: r2.json.board_id,
      node_id: "y",
      text: "test",
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("errors.no_recipient");
    expect(r.json.reason).toBe("no_recipient");
  });

  test("/submit-answer happy path: blocks until poll-messages delivers", async () => {
    // Submit in the background.
    const submitP = post<{ ok: boolean }>(`${broker.url}/submit-answer`, {
      board_id: boardId,
      node_id: "i1",
      text: "user reply",
    });

    // Give the broker a moment to insert the pending row, then act as the
    // recipient by polling — that flips delivered=1 and submit-answer resolves.
    await new Promise((r) => setTimeout(r, 80));
    const polled = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    expect(polled.json.messages.length).toBeGreaterThanOrEqual(1);

    const final = await submitP;
    expect(final.json.ok).toBe(true);

    const threads = await fetchThreads();
    expect(threads.i1.some((t) => t.text === "user reply")).toBe(true);
  });

  test("/mark-thread-items-read flips read_at on listed CC messages", async () => {
    // Generate a CC message to mark unread, then mark it read.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "unread CC",
      status: "discussing",
    });

    const threads = await fetchThreads();
    const target = threads.i1.find(
      (t) => t.source === "cc" && t.text === "unread CC",
    )!;
    expect(target.read_at).toBeNull();

    const r = await post<{ ok: boolean; marked: number }>(
      `${broker.url}/mark-thread-items-read`,
      { thread_item_ids: [target.id] },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.marked).toBe(1);

    const after = await fetchThreads();
    const same = after.i1.find((t) => t.id === target.id)!;
    expect(same.read_at).not.toBeNull();
  });

  test("/mark-board-read flips every unread CC item on the board", async () => {
    // Drop two new unread CC posts, then mark-board-read.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "u1",
      status: "discussing",
    });
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "i1",
      message: "u2",
      status: "discussing",
    });

    const r = await post<{ ok: boolean; marked: number }>(
      `${broker.url}/mark-board-read`,
      { board_id: boardId },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.marked).toBeGreaterThanOrEqual(2);

    const threads = await fetchThreads();
    expect(
      threads.i1.every((t) => t.source !== "cc" || t.read_at !== null),
    ).toBe(true);
  });
});
