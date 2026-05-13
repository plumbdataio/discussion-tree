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
      title: "Threads extras",
      concerns: [
        {
          id: "tc1",
          title: "C1",
          items: [{ id: "ti1", title: "Item 1" }],
        },
      ],
    },
  });
  boardId = r.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

async function fetchView() {
  const r = await get<any>(`${broker.url}/api/board/${boardId}`);
  return r.json;
}

describe("post-to-node — status changes and timeline shape", () => {
  test("post-to-node persists a cc thread item before the status_change row", async () => {
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "ti1",
      message: "hello",
      status: "discussing",
    });
    const v = await fetchView();
    const items = v.threads.ti1 ?? [];
    const ccIdx = items.findIndex((t: any) => t.source === "cc");
    const sysIdx = items.findIndex(
      (t: any) =>
        t.source === "system" && String(t.text).startsWith("status_change:"),
    );
    expect(ccIdx).toBeGreaterThanOrEqual(0);
    expect(sysIdx).toBeGreaterThan(ccIdx);
  });

  test("status_change text uses 'old:new' format", async () => {
    // Re-status to a new value — the diff text should include the previous
    // status and the next one separated by colons.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "ti1",
      message: "promote",
      status: "needs-reply",
    });
    const v = await fetchView();
    const items = v.threads.ti1 ?? [];
    const sys = items
      .filter((t: any) => t.source === "system")
      .map((t: any) => t.text)
      .filter((t: string) => t.startsWith("status_change:"));
    // At least one row of the form status_change:<old>:<new>
    const m = sys[sys.length - 1].match(/^status_change:([^:]+):([^:]+)$/);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("needs-reply");
  });

  test("post-to-node with no-change status emits a thread item but no status_change row", async () => {
    // First post moves to "discussing".
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "ti1",
      message: "first",
      status: "discussing",
    });
    const before = await fetchView();
    const sysBefore = (before.threads.ti1 ?? []).filter(
      (t: any) => t.source === "system",
    ).length;

    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "ti1",
      message: "same",
      status: "discussing",
    });
    const after = await fetchView();
    const sysAfter = (after.threads.ti1 ?? []).filter(
      (t: any) => t.source === "system",
    ).length;
    expect(sysAfter).toBe(sysBefore);
  });

  test("post-to-node without status falls back to bumping to discussing", async () => {
    // Reset by setting node status to pending first via set-node-status.
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "ti1",
      status: "pending",
    });
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "ti1",
      message: "no status sent",
    });
    const v = await fetchView();
    const n = v.nodes.find((x: any) => x.id === "ti1");
    // bumpStatusToDiscussing only flips if it's pending; we just set it
    // pending, so it should now be discussing.
    expect(n.status).toBe("discussing");
  });
});

describe("submit-answer error paths", () => {
  test("returns no_recipient when the board does not exist", async () => {
    const r = await post(`${broker.url}/submit-answer`, {
      board_id: "bd_doesnotexist",
      node_id: "x",
      text: "hello",
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("no_recipient");
  });
});

describe("mark-thread-items-read / mark-board-read", () => {
  test("mark-thread-items-read with empty array is a no-op", async () => {
    const r = await post<{ ok: boolean; marked?: number }>(
      `${broker.url}/mark-thread-items-read`,
      { thread_item_ids: [] },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.marked).toBe(0);
  });

  test("mark-thread-items-read with missing array is a no-op", async () => {
    const r = await post<{ ok: boolean; marked?: number }>(
      `${broker.url}/mark-thread-items-read`,
      {},
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.marked).toBe(0);
  });

  test("mark-board-read with no board_id returns ok=false", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/mark-board-read`, {});
    expect(r.json.ok).toBe(false);
  });

  test("mark-board-read flips read_at on every cc-authored thread item", async () => {
    // Seed: one CC message on a node.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "ti1",
      message: "to be read",
      status: "needs-reply",
    });
    // Before: there must be at least one unread cc item.
    const before = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const meBefore = before.json.sessions.find((s) => s.id === sessionId)!;
    const b = meBefore.boards.find((x: any) => x.id === boardId);
    expect((b?.unread_count ?? 0)).toBeGreaterThanOrEqual(1);

    await post(`${broker.url}/mark-board-read`, { board_id: boardId });

    const after = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const meAfter = after.json.sessions.find((s) => s.id === sessionId)!;
    const b2 = meAfter.boards.find((x: any) => x.id === boardId);
    expect(b2?.unread_count ?? 0).toBe(0);
  });
});

describe("poll-messages basics", () => {
  test("poll-messages returns an empty list when nothing pending", async () => {
    const r = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    expect(Array.isArray(r.json.messages)).toBe(true);
    // Pending messages are marked delivered on first poll, so a second poll
    // is always empty.
    const r2 = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    expect(r2.json.messages.length).toBe(0);
  });
});
