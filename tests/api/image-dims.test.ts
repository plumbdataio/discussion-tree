import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// A message that carries an /uploads/... image must come back with that image's
// intrinsic dimensions in the board view's `image_dims` map, so the frontend
// can reserve its aspect-ratio box before the lazy image loads.

let broker: BrokerHandle;
let sessionId: string;
let boardId: string;

// A minimal but valid PNG header encoding a 120x80 image (parser reads IHDR).
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Images",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  boardId = r.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

describe("board view image_dims", () => {
  test("a posted /uploads image yields its dimensions in image_dims", async () => {
    const up = await post<{ ok: boolean; url: string }>(
      `${broker.url}/upload-image`,
      {
        board_id: boardId,
        filename: "shot.png",
        data_base64: png(120, 80).toString("base64"),
      },
    );
    expect(up.json.ok).toBe(true);
    const url = up.json.url;
    expect(url.startsWith(`/uploads/${boardId}/`)).toBe(true);

    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "i1",
      message: `here it is\n![shot](${url})`,
      status: "discussing",
    });

    const v = await get<any>(`${broker.url}/api/board/${boardId}`);
    expect(v.json.image_dims).toBeTruthy();
    expect(v.json.image_dims[url]).toEqual({ w: 120, h: 80 });
  });

  test("external image URLs are not included", async () => {
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "i1",
      message: "external ![x](https://example.com/pic.png)",
      status: "discussing",
    });
    const v = await get<any>(`${broker.url}/api/board/${boardId}`);
    expect(v.json.image_dims["https://example.com/pic.png"]).toBeUndefined();
  });

  test("a board with no images yields an empty image_dims map", async () => {
    const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "NoImages",
        concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
      },
    });
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: r.json.board_id,
      node_id: "i1",
      message: "just text, no pictures",
      status: "discussing",
    });
    const v = await get<any>(`${broker.url}/api/board/${r.json.board_id}`);
    expect(v.json.image_dims).toEqual({});
  });
});
