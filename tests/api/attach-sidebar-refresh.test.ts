import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  get,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// owner_alive gates the board input's enabled state. The session list is behind
// a ~10s /api/sessions poll, so a freshly-bound session (and its default board)
// would lag in the sidebar. handleAttachCCSession broadcasts a sidebar-refresh
// on every attach so the binding — and the ability to start typing — shows up
// instantly. broadcastToAll reaches every socket, so a /ws/<board> client sees it.

let broker: BrokerHandle;
let sessionId: string;
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const r = await get<{ sessions: { id: string; boards: { id: string }[] }[] }>(
    `${broker.url}/api/sessions`,
  );
  boardId = r.json.sessions.find((s) => s.id === sessionId)!.boards[0].id;
});
afterAll(async () => {
  await broker.kill();
});

function captureWsMessages(
  port: number,
  board: string,
  trigger: () => Promise<unknown>,
  timeoutMs = 1500,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${board}`);
    const messages: any[] = [];
    let triggered = false;
    const finish = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(messages);
    };
    const timeout = setTimeout(finish, timeoutMs);
    ws.addEventListener("open", async () => {
      try {
        await new Promise((r) => setTimeout(r, 50));
        await trigger();
        triggered = true;
      } catch (e) {
        clearTimeout(timeout);
        ws.close();
        reject(e);
      }
    });
    ws.addEventListener("message", (e) => {
      try {
        messages.push(JSON.parse(e.data as string));
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.addEventListener("error", () => {
      if (!triggered) {
        clearTimeout(timeout);
        reject(new Error("WS errored before trigger"));
      }
    });
  });
}

describe("attach → instant sidebar refresh", () => {
  test("/attach-cc-session broadcasts a sidebar-refresh so the binding shows up instantly", async () => {
    const msgs = await captureWsMessages(broker.port, boardId, async () => {
      // A fresh session binding (new cc_session_id) — the case that makes a
      // new session + its default board appear in the sidebar.
      await post(`${broker.url}/attach-cc-session`, {
        session_id: sessionId,
        cc_session_id: `cc-${Math.random().toString(36).slice(2, 10)}`,
      });
    });
    expect(msgs.some((m) => m.type === "sidebar-refresh")).toBe(true);
  });
});
