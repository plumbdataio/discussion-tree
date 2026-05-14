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

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

describe("boards", () => {
  test("/create-board returns board_id and url that uses default PUBLIC_URL", async () => {
    const r = await post<{ board_id: string; url: string }>(
      `${broker.url}/create-board`,
      {
        session_id: sessionId,
        structure: {
          title: "Test",
          concerns: [
            {
              id: "c1",
              title: "C1",
              context: "ctx",
              items: [{ id: "i1", title: "Item 1" }],
            },
          ],
        },
      },
    );
    expect(r.status).toBe(200);
    expect(r.json.board_id).toMatch(/^bd_/);
    // Default PUBLIC_URL is http://localhost:$PORT — check the prefix.
    expect(r.json.url).toMatch(/^http:\/\/localhost:\d+\/board\/bd_/);
  });

  test("/create-board rejects sub-items in the structure", async () => {
    const r = await post<{ error?: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "Bad",
        concerns: [
          {
            id: "c2",
            title: "C2",
            items: [
              {
                id: "i2",
                title: "Item",
                items: [{ id: "i2-sub", title: "Sub" }],
              },
            ],
          },
        ],
      },
    });
    expect(r.json.error).toMatch(/sub-items/i);
  });

  test("/create-board rejects when session has no cc_session_id bound", async () => {
    const naked = await registerSession(broker.url);
    const r = await post<{ error?: string }>(`${broker.url}/create-board`, {
      session_id: naked,
      structure: { title: "Naked", concerns: [] },
    });
    expect(r.json.error).toMatch(/attach_cc_session/i);
  });

  test("/api/board/<id> returns board view with nodes and threads", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "View",
        concerns: [{ id: "v-c1", title: "VC1", items: [{ id: "v-i1", title: "VI1" }] }],
      },
    });
    const r = await get<any>(`${broker.url}/api/board/${c.json.board_id}`);
    expect(r.status).toBe(200);
    expect(r.json.board.id).toBe(c.json.board_id);
    expect(r.json.nodes.length).toBeGreaterThanOrEqual(2);
    expect(r.json.threads).toEqual({});
  });

  test("/api/board/<id> 404 for missing board", async () => {
    const r = await get<any>(`${broker.url}/api/board/bd_doesnotexist`);
    expect(r.status).toBe(404);
  });

  test("/close-board sets status=completed", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: { title: "Close me", concerns: [{ id: "x", title: "x" }] },
    });
    const r = await post<{ ok: boolean }>(`${broker.url}/close-board`, {
      board_id: c.json.board_id,
    });
    expect(r.json.ok).toBe(true);

    const view = await get<any>(`${broker.url}/api/board/${c.json.board_id}`);
    expect(view.json.board.status).toBe("completed");
    expect(view.json.board.closed).toBe(1);
  });

  test("/set-board-status changes status independently of close", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: { title: "Status", concerns: [{ id: "x", title: "x" }] },
    });
    const r = await post<{ ok: boolean }>(`${broker.url}/set-board-status`, {
      board_id: c.json.board_id,
      status: "paused",
    });
    expect(r.json.ok).toBe(true);

    const view = await get<any>(`${broker.url}/api/board/${c.json.board_id}`);
    expect(view.json.board.status).toBe("paused");
  });

  test("/archive-board hides from /api/sessions, /unarchive-board restores", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: { title: "Archivable", concerns: [{ id: "x", title: "x" }] },
    });

    await post(`${broker.url}/archive-board`, { board_id: c.json.board_id });
    const after = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me = after.json.sessions.find((s) => s.id === sessionId)!;
    expect(me.boards.find((b: any) => b.id === c.json.board_id)).toBeFalsy();
    expect(
      (me.archived_boards ?? []).find((b: any) => b.id === c.json.board_id),
    ).toBeTruthy();

    await post(`${broker.url}/unarchive-board`, {
      board_id: c.json.board_id,
    });
    const restored = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const me2 = restored.json.sessions.find((s) => s.id === sessionId)!;
    expect(me2.boards.find((b: any) => b.id === c.json.board_id)).toBeTruthy();
  });

  test("create-board honors PUBLIC_URL when set", async () => {
    const customBroker = await startBroker({
      DISCUSSION_TREE_PUBLIC_URL: "https://my-host.example",
    });
    try {
      const sid = await registerSession(customBroker.url);
      await attachCC(customBroker.url, sid);
      const r = await post<{ url: string }>(`${customBroker.url}/create-board`, {
        session_id: sid,
        structure: { title: "Hosted", concerns: [{ id: "x", title: "x" }] },
      });
      expect(r.json.url).toMatch(/^https:\/\/my-host\.example\/board\/bd_/);
    } finally {
      await customBroker.kill();
    }
  });
});
