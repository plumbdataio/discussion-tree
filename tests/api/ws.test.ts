import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
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
      title: "WS",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  boardId = r.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

// Open a WS connection to /ws/<board>, collect messages until the timeout
// or until `until(msg)` returns true. Returns the captured array.
function captureWsMessages(
  port: number,
  boardId: string,
  trigger: () => Promise<unknown>,
  timeoutMs = 1500,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${boardId}`);
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
    ws.addEventListener("error", (e) => {
      if (!triggered) {
        clearTimeout(timeout);
        reject(new Error("WS errored before trigger"));
      }
    });
  });
}

describe("websocket broadcasts", () => {
  test("/post-to-node emits a thread-update event for that board", async () => {
    const msgs = await captureWsMessages(broker.port, boardId, async () => {
      await new Promise((r) => setTimeout(r, 50)); // let the WS settle
      await post(`${broker.url}/post-to-node`, {
        board_id: boardId,
        node_id: "i1",
        message: "via ws",
        status: "discussing",
      });
    });
    expect(msgs.some((m) => m.type === "thread-update")).toBe(true);
  });

  test("/set-node-status emits a status-update event", async () => {
    const msgs = await captureWsMessages(broker.port, boardId, async () => {
      await new Promise((r) => setTimeout(r, 50));
      await post(`${broker.url}/set-node-status`, {
        board_id: boardId,
        node_id: "i1",
        status: "agreed",
      });
    });
    expect(msgs.some((m) => m.type === "status-update")).toBe(true);
  });

  test("structural changes (add-item) emit a structure-update event", async () => {
    const msgs = await captureWsMessages(broker.port, boardId, async () => {
      await new Promise((r) => setTimeout(r, 50));
      await post(`${broker.url}/add-item`, {
        board_id: boardId,
        concern_id: "c1",
        item: { id: `i-${Math.random().toString(36).slice(2)}`, title: "x" },
      });
    });
    expect(msgs.some((m) => m.type === "structure-update")).toBe(true);
  });
});
