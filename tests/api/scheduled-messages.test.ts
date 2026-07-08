import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Timer send (scheduled-messages.ts): the user queues a composer message to be
// delivered to a board node at a future time. These cover the CRUD routes
// (schedule / list / cancel + the per-session count that powers the sidebar
// badge & banner) and the `via_timer` plumbing the poller's "user is away"
// footer keys on — asserted through /submit-answer (the exact body the fire
// loop sends) + /poll-messages, so we don't have to wait on the 15s fire tick.

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
      title: "Timer board",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  boardId = r.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

async function scheduledCount(): Promise<number> {
  const v = await get<any>(`${broker.url}/api/sessions`);
  const s = v.json.sessions.find((x: any) => x.id === sessionId);
  return s?.scheduled_message_count ?? 0;
}

describe("scheduled-messages", () => {
  test("schedule -> list -> per-session count", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r = await post<{ ok: boolean; id: string }>(
      `${broker.url}/schedule-message`,
      { board_id: boardId, node_id: "i1", text: "future work", fire_at: future },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.id).toBeTruthy();

    const list = await post<{ scheduled: any[] }>(
      `${broker.url}/list-scheduled-messages`,
      { board_id: boardId },
    );
    expect(list.json.scheduled.length).toBe(1);
    expect(list.json.scheduled[0].text).toBe("future work");
    expect(list.json.scheduled[0].node_id).toBe("i1");

    expect(await scheduledCount()).toBe(1);
  });

  test("cancel removes it and drops the count", async () => {
    const list = await post<{ scheduled: any[] }>(
      `${broker.url}/list-scheduled-messages`,
      { session_id: sessionId },
    );
    const id = list.json.scheduled[0].id;
    const c = await post<{ ok: boolean }>(
      `${broker.url}/cancel-scheduled-message`,
      { id },
    );
    expect(c.json.ok).toBe(true);
    expect(await scheduledCount()).toBe(0);
    // Cancelling an already-gone id is a no-op (ok:false), not a crash.
    const again = await post<{ ok: boolean }>(
      `${broker.url}/cancel-scheduled-message`,
      { id },
    );
    expect(again.json.ok).toBe(false);
  });

  test("schedule rejects empty text / invalid fire_at", async () => {
    const bad1 = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/schedule-message`,
      { board_id: boardId, node_id: "i1", text: "  ", fire_at: new Date().toISOString() },
    );
    expect(bad1.json.ok).toBe(false);
    expect(bad1.json.error).toMatch(/empty/i);
    const bad2 = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/schedule-message`,
      { board_id: boardId, node_id: "i1", text: "x", fire_at: "not-a-date" },
    );
    expect(bad2.json.ok).toBe(false);
    expect(bad2.json.error).toMatch(/fire_at/i);
  });

  test("via_timer flag rides the delivery so the poller can footer it", async () => {
    // /submit-answer with via_timer:true is exactly what fireDueScheduledMessages
    // sends. It blocks until delivered/timeout, so fire it without awaiting.
    const submitP = fetch(`${broker.url}/submit-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        board_id: boardId,
        node_id: "i1",
        text: "timer-delivered message",
        via_timer: true,
      }),
    });
    await new Promise((r) => setTimeout(r, 150));
    const drain = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const msg = drain.json.messages.find(
      (m: any) => m.text === "timer-delivered message",
    );
    expect(msg).toBeTruthy();
    expect(msg.via_timer).toBe(1);
    await submitP;
  });

  test("a normal (live) submit is NOT flagged via_timer", async () => {
    const submitP = fetch(`${broker.url}/submit-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        board_id: boardId,
        node_id: "i1",
        text: "live message",
      }),
    });
    await new Promise((r) => setTimeout(r, 150));
    const drain = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const msg = drain.json.messages.find((m: any) => m.text === "live message");
    expect(msg).toBeTruthy();
    expect(msg.via_timer).toBe(0);
    await submitP;
  });

  test("list-all returns pending reservations with session + board names joined", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const s = await post<{ id: string }>(`${broker.url}/schedule-message`, {
      board_id: boardId,
      node_id: "i1",
      text: "cross-session list row",
      fire_at: future,
    });
    const all = await post<{ scheduled: any[] }>(
      `${broker.url}/list-all-scheduled-messages`,
      {},
    );
    const row = all.json.scheduled.find(
      (m: any) => m.text === "cross-session list row",
    );
    expect(row).toBeTruthy();
    expect(row.board_title).toBe("Timer board");
    // session_name is joined (may be null if the session has no name set) — the
    // key is present either way, proving the LEFT JOIN ran.
    expect("session_name" in row).toBe(true);
    await post(`${broker.url}/cancel-scheduled-message`, { id: s.json.id });
  });

  test("update changes a pending reservation's text and fire time", async () => {
    const t1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const s = await post<{ id: string }>(`${broker.url}/schedule-message`, {
      board_id: boardId,
      node_id: "i1",
      text: "before edit",
      fire_at: t1,
    });
    const u = await post<{ ok: boolean; fire_at: string }>(
      `${broker.url}/update-scheduled-message`,
      { id: s.json.id, text: "after edit", fire_at: t2 },
    );
    expect(u.json.ok).toBe(true);
    const list = await post<{ scheduled: any[] }>(
      `${broker.url}/list-scheduled-messages`,
      { board_id: boardId },
    );
    const row = list.json.scheduled.find((m: any) => m.id === s.json.id);
    expect(row.text).toBe("after edit");
    expect(row.fire_at).toBe(new Date(t2).toISOString());
    await post(`${broker.url}/cancel-scheduled-message`, { id: s.json.id });
  });
});
