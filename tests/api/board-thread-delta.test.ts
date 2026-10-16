// GET /api/board/<id>/threads?after=<id> — the incremental thread fetch the
// board page uses on live events instead of re-downloading the whole board —
// plus gzip on the broker's JSON responses.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { gunzipSync } from "node:zlib";
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
      title: "Delta",
      concerns: [
        {
          id: "c1",
          title: "C1",
          items: [
            { id: "i1", title: "I1" },
            { id: "i2", title: "I2" },
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

function postCC(nodeId: string, message: string, status = "discussing") {
  return post<{ ok: boolean; message_id: number }>(
    `${broker.url}/post-to-node`,
    { issue_ids: [], board_id: boardId, node_id: nodeId, message, status },
  );
}

function allItems(threads: Record<string, any[]>): any[] {
  return Object.values(threads)
    .flat()
    .sort((a, b) => a.id - b.id);
}

describe("board thread delta", () => {
  test("returns only items newer than `after`, in the full view's row shape", async () => {
    await postCC("i1", "first");
    const full1 = await get<any>(`${broker.url}/api/board/${boardId}`);
    const held = allItems(full1.json.threads);
    const after = held[held.length - 1].id;

    const m = await postCC("i1", "second", "needs-reply");
    const d = await get<any>(
      `${broker.url}/api/board/${boardId}/threads?after=${after}`,
    );
    expect(d.status).toBe(200);
    // The CC post plus its status_change system row, both > after, ascending.
    expect(d.json.threads.map((t: any) => t.source)).toEqual(["cc", "system"]);
    expect(d.json.threads[0].id).toBe(m.json.message_id);
    for (const t of d.json.threads) expect(t.id).toBeGreaterThan(after);

    // Same rows (every column) as the full view returns for them.
    const full2 = await get<any>(`${broker.url}/api/board/${boardId}`);
    const fromFull = allItems(full2.json.threads).filter((t) => t.id > after);
    expect(d.json.threads).toEqual(fromFull);

    // Node statuses + board row + owner/header fields ride along.
    expect(d.json.node_statuses.i1).toBe("needs-reply");
    expect(d.json.node_statuses.i2).toBe("pending");
    expect(d.json.board.id).toBe(boardId);
    for (const k of [
      "owner_alive",
      "owner_stalled",
      "owner_compacting",
      "owner_context_usage",
      "owner_bg_task_count",
      "owner_scheduled_count",
      "scheduled",
      "image_dims",
    ]) {
      expect(k in d.json).toBe(true);
    }
    // No node tree / full thread map in the delta.
    expect(d.json.nodes).toBeUndefined();
  });

  test("after = newest id → no items", async () => {
    const full = await get<any>(`${broker.url}/api/board/${boardId}`);
    const held = allItems(full.json.threads);
    const d = await get<any>(
      `${broker.url}/api/board/${boardId}/threads?after=${held[held.length - 1].id}`,
    );
    expect(d.json.threads).toEqual([]);
  });

  test("node filter narrows to one node", async () => {
    await postCC("i2", "on i2");
    const d = await get<any>(
      `${broker.url}/api/board/${boardId}/threads?after=0&node=i2`,
    );
    expect(d.json.threads.length).toBeGreaterThan(0);
    for (const t of d.json.threads) expect(t.node_id).toBe("i2");
  });

  test("unread_ids tracks read state of already-held items", async () => {
    const m = await postCC("i1", "please read me");
    const id = m.json.message_id;
    let d = await get<any>(
      `${broker.url}/api/board/${boardId}/threads?after=${id}`,
    );
    expect(d.json.unread_ids).toContain(id);

    await post(`${broker.url}/mark-thread-items-read`, {
      thread_item_ids: [id],
    });
    d = await get<any>(`${broker.url}/api/board/${boardId}/threads?after=${id}`);
    expect(d.json.unread_ids).not.toContain(id);
    // Only unread-capable sources are listed (system rows never are).
    const full = await get<any>(`${broker.url}/api/board/${boardId}`);
    const bySource = new Map(
      allItems(full.json.threads).map((t) => [t.id, t.source]),
    );
    for (const u of d.json.unread_ids) {
      expect(["cc", "external"]).toContain(bySource.get(u));
    }
  });

  test("unknown board → 404; bad after → treated as 0", async () => {
    const r = await get<any>(`${broker.url}/api/board/nope/threads?after=1`);
    expect(r.status).toBe(404);
    const d = await get<any>(
      `${broker.url}/api/board/${boardId}/threads?after=garbage`,
    );
    expect(d.status).toBe(200);
    expect(d.json.threads.length).toBeGreaterThan(0);
  });
});

describe("response compression", () => {
  test("large JSON is gzipped when the client accepts it", async () => {
    // Make the board view comfortably larger than the 1KB threshold.
    await postCC("i1", "x".repeat(4000));
    const res = await fetch(`${broker.url}/api/board/${boardId}`, {
      headers: { "accept-encoding": "gzip" },
      // Keep the raw bytes: Bun's fetch would otherwise decode transparently.
      decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    const raw = new Uint8Array(await res.arrayBuffer());
    const json = JSON.parse(gunzipSync(raw).toString("utf8"));
    expect(json.board.id).toBe(boardId);
  });

  test("no gzip without Accept-Encoding, or for tiny bodies", async () => {
    const plain = await fetch(`${broker.url}/api/board/${boardId}`, {
      headers: { "accept-encoding": "identity" },
      decompress: false,
    } as RequestInit);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect((await plain.json()).board.id).toBe(boardId);

    const tiny = await fetch(`${broker.url}/mark-thread-items-read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip",
      },
      body: JSON.stringify({ thread_item_ids: [] }),
      decompress: false,
    } as RequestInit);
    expect(tiny.headers.get("content-encoding")).toBeNull();
  });

  test("gzip;q=0 is honoured as a refusal", async () => {
    const res = await fetch(`${broker.url}/api/board/${boardId}`, {
      headers: { "accept-encoding": "gzip;q=0, br" },
      decompress: false,
    } as RequestInit);
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});
