import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// A user submitting a message through the UI should flip the owning session
// to a "working" activity state immediately — before the CC has even polled
// for the pending message — so the UI shows instant feedback.

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

async function createBoard(): Promise<string> {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Activity submit",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  return r.json.board_id;
}

// Fire /submit-answer without awaiting (it blocks until delivered/timeout).
function fireSubmit(boardId: string, nodeId: string, text: string) {
  return fetch(`${broker.url}/submit-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: boardId, node_id: nodeId, text }),
  });
}

describe("user submit -> immediate working activity", () => {
  test("submit-answer sets the owner session to 'working' before delivery", async () => {
    const id = await createBoard();
    const submitP = fireSubmit(id, "i1", "hello from the UI");
    // Let the broker insert the pending row + mark working.
    await new Promise((r) => setTimeout(r, 150));
    const v = await get<any>(`${broker.url}/api/board/${id}`);
    expect(v.json.activity?.state).toBe("working");
    // Deliver so the blocked submit-answer resolves (test cleanup).
    await post(`${broker.url}/poll-messages`, { session_id: sessionId });
    await submitP;
  });

  test("an explicit 'blocked' activity is NOT overwritten by a user submit", async () => {
    const id = await createBoard();
    // LLM marks itself blocked (waiting on user OK).
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: "blocked",
    });
    const submitP = fireSubmit(id, "i1", "another message");
    await new Promise((r) => setTimeout(r, 150));
    const v = await get<any>(`${broker.url}/api/board/${id}`);
    // Still blocked — the user submit must not stomp an explicit LLM state.
    expect(v.json.activity?.state).toBe("blocked");
    await post(`${broker.url}/poll-messages`, { session_id: sessionId });
    await submitP;
    // Clean the explicit state back out so later tests start neutral.
    await post(`${broker.url}/set-activity`, { session_id: sessionId });
  });

  test("the working badge clears via the Stop-hook path after the turn", async () => {
    const id = await createBoard();
    const submitP = fireSubmit(id, "i1", "yet another");
    await new Promise((r) => setTimeout(r, 150));
    let v = await get<any>(`${broker.url}/api/board/${id}`);
    expect(v.json.activity?.state).toBe("working");
    await post(`${broker.url}/poll-messages`, { session_id: sessionId });
    await submitP;
    // The CC's Stop hook fires /clear-tool-activity at end of turn.
    await post(`${broker.url}/clear-tool-activity`, {
      cc_session_id: (await get<any>(`${broker.url}/api/sessions`)).json.sessions.find(
        (s: any) => s.id === sessionId,
      )?.cc_session_id,
    });
    v = await get<any>(`${broker.url}/api/board/${id}`);
    expect(v.json.activity ?? null).toBeNull();
  });
});
