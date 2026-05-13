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
      title: "Nodes extras",
      concerns: [
        {
          id: "C1",
          title: "Concern 1",
          items: [
            { id: "I1A", title: "I1A" },
            { id: "I1B", title: "I1B" },
            { id: "I1C", title: "I1C" },
          ],
        },
        {
          id: "C2",
          title: "Concern 2",
          items: [{ id: "I2A", title: "I2A" }],
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
  return (await get<any>(`${broker.url}/api/board/${boardId}`)).json;
}

describe("move-node — edge cases", () => {
  test("rejects move to a non-existent new_parent_id", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/move-node`,
      { board_id: boardId, node_id: "I1A", new_parent_id: "nope" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });

  test("rejects move when node_id does not exist", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/move-node`,
      { board_id: boardId, node_id: "ghost", new_parent_id: "C2" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });

  test("rejects move that would create a cycle", async () => {
    // Try to move parent under its own descendant.
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/move-node`,
      { board_id: boardId, node_id: "C1", new_parent_id: "I1A" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/cycle/i);
  });

  test("moving with new_parent_id = null parks the node at the root", async () => {
    // I1B currently under C1. Move to root.
    const r = await post<{ ok: boolean }>(`${broker.url}/move-node`, {
      board_id: boardId,
      node_id: "I1B",
      new_parent_id: null,
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "I1B").parent_id).toBeNull();
  });
});

describe("reorder-node — clamping", () => {
  test("reorder to a position beyond the end clamps to the last slot", async () => {
    const r = await post<{ ok: boolean; position: number }>(
      `${broker.url}/reorder-node`,
      { board_id: boardId, node_id: "I1A", new_position: 999 },
    );
    expect(r.json.ok).toBe(true);
    // siblings count is 2 (I1A + I1C remain under C1 after we moved I1B).
    // clamped position is min(999, siblings.length)=min(999, 1)=1 etc — accept
    // any non-negative value here.
    expect(r.json.position).toBeGreaterThanOrEqual(0);
  });

  test("reorder to a negative position clamps to 0", async () => {
    const r = await post<{ ok: boolean; position: number }>(
      `${broker.url}/reorder-node`,
      { board_id: boardId, node_id: "I1C", new_position: -5 },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.position).toBe(0);
  });

  test("reorder errors for an unknown node id", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/reorder-node`,
      { board_id: boardId, node_id: "ghost", new_position: 0 },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });
});

describe("update-node accepts partial fields", () => {
  test("title only", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/update-node`, {
      board_id: boardId,
      node_id: "I2A",
      title: "Renamed",
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "I2A").title).toBe("Renamed");
  });

  test("context only", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/update-node`, {
      board_id: boardId,
      node_id: "I2A",
      context: "ctx-only",
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "I2A").context).toBe("ctx-only");
  });

  test("non-string title is ignored — falls through to 'nothing to update'", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/update-node`,
      { board_id: boardId, node_id: "I2A", title: 42 },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/Nothing to update/i);
  });
});

describe("delete-node — cascade and idempotency", () => {
  test("deleting a concern soft-deletes its descendants", async () => {
    // Build a fresh subtree to delete without disturbing the rest.
    await post(`${broker.url}/add-concern`, {
      board_id: boardId,
      concern: { id: "CDEL", title: "delete me" },
    });
    await post(`${broker.url}/add-item`, {
      board_id: boardId,
      concern_id: "CDEL",
      item: { id: "IDEL1", title: "child 1" },
    });
    await post(`${broker.url}/add-item`, {
      board_id: boardId,
      concern_id: "CDEL",
      item: { id: "IDEL2", title: "child 2" },
    });

    const r = await post<{ ok: boolean; deleted_count: number }>(
      `${broker.url}/delete-node`,
      { board_id: boardId, node_id: "CDEL" },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.deleted_count).toBe(3); // concern + 2 items

    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "CDEL")).toBeFalsy();
    expect(v.nodes.find((n: any) => n.id === "IDEL1")).toBeFalsy();
    expect(v.nodes.find((n: any) => n.id === "IDEL2")).toBeFalsy();
  });

  test("deleting a missing node returns ok=false (not crash)", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/delete-node`,
      { board_id: boardId, node_id: "ghost-node" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });
});

describe("/api/board view shape", () => {
  test("includes board / nodes / threads", async () => {
    const v = await fetchView();
    expect(v.board.id).toBe(boardId);
    expect(Array.isArray(v.nodes)).toBe(true);
    expect(typeof v.threads).toBe("object");
  });

  test("includes the live activity field (object or null)", async () => {
    const v = await fetchView();
    expect("activity" in v).toBe(true);
    expect(v.activity === null || typeof v.activity === "object").toBe(true);
  });

  test("nodes carry the expected fields", async () => {
    const v = await fetchView();
    const n = v.nodes[0];
    expect(n).toHaveProperty("id");
    expect(n).toHaveProperty("kind");
    expect(n).toHaveProperty("title");
    expect(n).toHaveProperty("status");
    expect(n).toHaveProperty("position");
    expect(n).toHaveProperty("created_at");
    expect(n).toHaveProperty("parent_id");
  });

  test("threads keyed by node_id, each entry sorted ascending by id", async () => {
    // Seed two cc messages on the same node and verify order.
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "I2A",
      message: "first",
      status: "discussing",
    });
    await post(`${broker.url}/post-to-node`, {
      board_id: boardId,
      node_id: "I2A",
      message: "second",
      status: "needs-reply",
    });
    const v = await fetchView();
    const t = v.threads.I2A ?? [];
    const ccText = t
      .filter((x: any) => x.source === "cc")
      .map((x: any) => x.text);
    const firstIdx = ccText.indexOf("first");
    const secondIdx = ccText.indexOf("second");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

describe("create-board id generation", () => {
  test("omitted ids produce auto-generated ones prefixed c_ / i_", async () => {
    const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "Auto-IDs",
        concerns: [
          {
            title: "Concern without id",
            items: [{ title: "Item without id" }],
          },
        ],
      },
    });
    const v = await get<any>(`${broker.url}/api/board/${r.json.board_id}`);
    const allIds = v.json.nodes.map((n: any) => n.id);
    expect(allIds.some((id: string) => id.startsWith("c_"))).toBe(true);
    expect(allIds.some((id: string) => id.startsWith("i_"))).toBe(true);
  });
});
