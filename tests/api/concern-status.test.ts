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

async function createBoard(): Promise<string> {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Concern-status invariant",
      concerns: [
        {
          id: "c1",
          title: "C1",
          items: [{ id: "i1", title: "I1" }],
        },
      ],
    },
  });
  return r.json.board_id;
}

async function getStatus(
  boardId: string,
  nodeId: string,
): Promise<string | undefined> {
  const r = await get<any>(`${broker.url}/api/board/${boardId}`);
  return r.json.nodes.find((n: any) => n.id === nodeId)?.status;
}

describe("concern.status is a schema-level invariant", () => {
  test("freshly created concerns start at 'pending'", async () => {
    const id = await createBoard();
    expect(await getStatus(id, "c1")).toBe("pending");
  });

  test("/set-node-status on a concern is rejected and leaves status untouched", async () => {
    const id = await createBoard();
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/set-node-status`,
      { board_id: id, node_id: "c1", status: "adopted" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/concern\.status/);
    expect(await getStatus(id, "c1")).toBe("pending");
  });

  test("the same call on an item works (no regression)", async () => {
    const id = await createBoard();
    const r = await post<{ ok: boolean }>(
      `${broker.url}/set-node-status`,
      { board_id: id, node_id: "i1", status: "adopted" },
    );
    expect(r.json.ok).toBe(true);
    expect(await getStatus(id, "i1")).toBe("adopted");
  });

  test("/update-node with kind='concern' resets status to 'pending'", async () => {
    const id = await createBoard();
    // First lift the item's status away from default.
    await post(`${broker.url}/set-node-status`, {
      board_id: id,
      node_id: "i1",
      status: "adopted",
    });
    expect(await getStatus(id, "i1")).toBe("adopted");
    // Now promote it to a concern — the schema invariant must reset status.
    // The item has to be re-parented to root for the move to be coherent,
    // but the update_node handler only edits title/context/kind; we test
    // the status side-effect in isolation.
    const r = await post<{ ok: boolean }>(`${broker.url}/update-node`, {
      board_id: id,
      node_id: "i1",
      kind: "concern",
    });
    expect(r.json.ok).toBe(true);
    expect(await getStatus(id, "i1")).toBe("pending");
  });
});
