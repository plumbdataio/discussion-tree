import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The MCP server's heartbeat self-healing loop re-binds a session whose broker
// binding was lost, then POSTs /session-reattached. The broker broadcasts a
// one-shot `session-reattached` event (no DB state) so the sidebar can flash a
// brief spinner. broadcastToAll reaches every socket, so a /ws/<board> client
// receives it.

let broker: BrokerHandle;
let sessionId: string;
let ccId: string;
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccId = await attachCC(broker.url, sessionId);
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Reattach",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  boardId = r.json.board_id;
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
        await new Promise((r) => setTimeout(r, 50)); // let the WS settle
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

describe("session re-attached (self-heal → sidebar flash)", () => {
  test("/session-reattached broadcasts a session-reattached event for that session", async () => {
    const msgs = await captureWsMessages(broker.port, boardId, async () => {
      const r = await post<{ ok: boolean }>(
        `${broker.url}/session-reattached`,
        { cc_session_id: ccId },
      );
      expect(r.json.ok).toBe(true);
    });
    expect(
      msgs.some(
        (m) => m.type === "session-reattached" && m.session_id === sessionId,
      ),
    ).toBe(true);
  });

  test("/session-reattached is a no-op for an unknown cc_session_id (no broadcast)", async () => {
    const msgs = await captureWsMessages(broker.port, boardId, async () => {
      const r = await post<{ ok: boolean }>(
        `${broker.url}/session-reattached`,
        { cc_session_id: "cc-does-not-exist" },
      );
      expect(r.json.ok).toBe(false);
    });
    expect(msgs.some((m) => m.type === "session-reattached")).toBe(false);
  });
});
