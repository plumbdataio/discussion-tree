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
      title: "Nodes test",
      concerns: [
        {
          id: "c1",
          title: "Concern 1",
          context: "ctx",
          items: [
            { id: "i1a", title: "Item 1A" },
            { id: "i1b", title: "Item 1B" },
          ],
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

describe("nodes", () => {
  test("/add-concern appends a top-level concern", async () => {
    const r = await post<{ node_id: string }>(`${broker.url}/add-concern`, {
      board_id: boardId,
      concern: { id: "c2", title: "Concern 2" },
    });
    expect(r.json.node_id).toBe("c2");
    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "c2")).toBeTruthy();
  });

  test("/add-item appends an item under a concern", async () => {
    const r = await post<{ node_id: string }>(`${broker.url}/add-item`, {
      board_id: boardId,
      concern_id: "c1",
      item: { id: "i1c", title: "Item 1C" },
    });
    expect(r.json.node_id).toBe("i1c");
  });

  test("/add-item rejects sub-items (items array)", async () => {
    const r = await post<{ error?: string }>(`${broker.url}/add-item`, {
      board_id: boardId,
      concern_id: "c1",
      item: {
        id: "ix",
        title: "x",
        items: [{ id: "ix-sub", title: "sub" }],
      },
    });
    expect(r.json.error).toMatch(/sub-item/i);
  });

  test("/update-node updates title / context", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/update-node`, {
      board_id: boardId,
      node_id: "i1a",
      title: "Item 1A (updated)",
      context: "new context",
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    const n = v.nodes.find((x: any) => x.id === "i1a");
    expect(n.title).toBe("Item 1A (updated)");
    expect(n.context).toBe("new context");
  });

  test("/update-node switches kind concern <-> item", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/update-node`, {
      board_id: boardId,
      node_id: "i1c",
      kind: "concern",
    });
    expect(r.json.ok).toBe(true);
    // Note: kind switch alone doesn't reparent the node — that's a separate
    // move_node concern. Confirm the kind value updated.
    const v = await fetchView();
    expect(v.nodes.find((x: any) => x.id === "i1c").kind).toBe("concern");
  });

  test("/update-node rejects when nothing to update", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/update-node`,
      { board_id: boardId, node_id: "i1a" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/Nothing to update/i);
  });

  test("/update-node rejects unknown kind value", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/update-node`,
      { board_id: boardId, node_id: "i1a", kind: "bogus" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/concern|item/);
  });

  test("/move-node attaches a node under a different concern", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/move-node`, {
      board_id: boardId,
      node_id: "i1b",
      new_parent_id: "c2",
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "i1b").parent_id).toBe("c2");
  });

  test("/move-node rejects when target is the node itself", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/move-node`,
      { board_id: boardId, node_id: "c1", new_parent_id: "c1" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/itself|cycle/i);
  });

  test("/reorder-node moves a sibling to position 0", async () => {
    // Currently c1 is at position 0, c2 at position 1. Move c2 to 0.
    const r = await post<{ ok: boolean }>(`${broker.url}/reorder-node`, {
      board_id: boardId,
      node_id: "c2",
      new_position: 0,
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    const concerns = v.nodes
      .filter((n: any) => n.parent_id === null && n.kind === "concern")
      .sort((a: any, b: any) => a.position - b.position);
    expect(concerns[0].id).toBe("c2");
  });

  test("/set-node-status updates status and emits a status_change thread item", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "i1a",
      status: "adopted",
    });
    expect(r.json.ok).toBe(true);

    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "i1a").status).toBe("adopted");
    const sysMsgs = (v.threads.i1a ?? []).filter(
      (t: any) => t.source === "system",
    );
    expect(sysMsgs.some((m: any) => m.text.startsWith("status_change:"))).toBe(
      true,
    );
  });

  // Note: /set-node-status currently does NOT validate the status value at the
  // broker layer — that's enforced by the MCP tool's input schema in server.ts.
  // We lock in this behavior here so future modularization preserves it.
  test("/set-node-status accepts any string at the broker layer (validation lives in the MCP schema)", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "i1a",
      status: "any-arbitrary-value",
    });
    expect(r.json.ok).toBe(true);
  });

  test("/delete-node soft-deletes (sets deleted_at, hidden from view)", async () => {
    // Create a fresh node to delete so we don't pollute other tests.
    await post(`${broker.url}/add-item`, {
      board_id: boardId,
      concern_id: "c1",
      item: { id: "i-delete-me", title: "Delete me" },
    });
    const r = await post<{ ok: boolean }>(`${broker.url}/delete-node`, {
      board_id: boardId,
      node_id: "i-delete-me",
    });
    expect(r.json.ok).toBe(true);
    const v = await fetchView();
    expect(v.nodes.find((n: any) => n.id === "i-delete-me")).toBeFalsy();
  });
});
