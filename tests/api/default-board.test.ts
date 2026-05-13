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
let defaultBoardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  // Discover the auto-created default board.
  const list = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
  const me = list.json.sessions.find((s) => s.id === sessionId)!;
  defaultBoardId = me.boards.find((b: any) => b.is_default).id;
});
afterAll(async () => {
  await broker.kill();
});

describe("default board structure lock", () => {
  test("attach-cc-session creates a default board with one concern + one item", async () => {
    const v = await get<any>(`${broker.url}/api/board/${defaultBoardId}`);
    expect(v.json.board.is_default).toBe(1);
    const concerns = v.json.nodes.filter(
      (n: any) => n.kind === "concern" && n.parent_id === null,
    );
    expect(concerns.length).toBe(1);
    const items = v.json.nodes.filter(
      (n: any) => n.kind === "item" && n.parent_id !== null,
    );
    expect(items.length).toBe(1);
  });

  test("/add-concern is rejected on the default board", async () => {
    const r = await post<{ error?: string }>(`${broker.url}/add-concern`, {
      board_id: defaultBoardId,
      concern: { id: "x", title: "x" },
    });
    expect(r.json.error).toMatch(/Default conversation board|fixed structure|locked/i);
  });

  test("/add-item is rejected on the default board", async () => {
    const r = await post<{ error?: string }>(`${broker.url}/add-item`, {
      board_id: defaultBoardId,
      concern_id: "conversation",
      item: { id: "x", title: "x" },
    });
    expect(r.json.error).toMatch(/Default conversation board|fixed structure|locked/i);
  });

  // /update-node is intentionally NOT locked on the default board — title /
  // context edits don't change structure and the MCP instruction layer never
  // listed it among locked tools. Lock that in.
  test("/update-node is allowed on the default board (title/context only)", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/update-node`, {
      board_id: defaultBoardId,
      node_id: "main",
      title: "Renamed",
    });
    expect(r.json.ok).toBe(true);
  });

  test("/move-node is rejected on the default board", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/move-node`,
      { board_id: defaultBoardId, node_id: "main", new_parent_id: null },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/Default conversation board|fixed structure|locked/i);
  });

  test("/reorder-node is rejected on the default board", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/reorder-node`,
      { board_id: defaultBoardId, node_id: "main", new_position: 0 },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/Default conversation board|fixed structure|locked/i);
  });

  test("/delete-node is rejected on the default board", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/delete-node`,
      { board_id: defaultBoardId, node_id: "main" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/Default conversation board|fixed structure|locked/i);
  });

  test("/post-to-node is allowed on the default board", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/post-to-node`, {
      board_id: defaultBoardId,
      node_id: "main",
      message: "hello from CC",
    });
    expect(r.json.ok).toBe(true);
  });
});
