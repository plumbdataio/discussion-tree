import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Card-size defaults the broker fills in for a never-resized node (broker/maps.ts).
const NODE_W = 320;
const NODE_H = 340;

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

async function createMap(): Promise<string> {
  const r = await post<{ ok: boolean; map_id: string }>(
    `${broker.url}/create-map`,
    { session_id: sessionId, title: "layout" },
  );
  return r.json.map_id;
}
async function addNode(mapId: string): Promise<string> {
  const r = await post<{ ok: boolean; node_id: string }>(
    `${broker.url}/map-add-node`,
    { session_id: sessionId, map_id: mapId, title: "n" },
  );
  return r.json.node_id;
}
async function move(mapId: string, nodeId: string, body: Record<string, unknown>) {
  return post<{
    ok: boolean;
    before?: { x: number; y: number; w: number; h: number };
    after?: { x: number; y: number; w: number; h: number };
    error?: string;
  }>(`${broker.url}/map-move-node`, { map_id: mapId, node_id: nodeId, ...body });
}
async function nodeFromView(mapId: string, nodeId: string) {
  const view = await get<any>(`${broker.url}/api/map/${mapId}`);
  return view.json.nodes.find((n: any) => n.id === nodeId);
}

describe("map node layout (set_map_node_layout / /map-move-node)", () => {
  test("sets x/y/w/h and get_map reflects it", async () => {
    const mapId = await createMap();
    const id = await addNode(mapId);
    const r = await move(mapId, id, { x: 111, y: 222, w: 400, h: 300 });
    expect(r.json.ok).toBe(true);
    const n = await nodeFromView(mapId, id);
    expect([n.x, n.y, n.w, n.h]).toEqual([111, 222, 400, 300]);
  });

  test("partial update keeps the omitted fields", async () => {
    const mapId = await createMap();
    const id = await addNode(mapId);
    await move(mapId, id, { x: 50, y: 60, w: 500, h: 250 });
    // Move only — size must survive.
    await move(mapId, id, { x: 999, y: 888 });
    let n = await nodeFromView(mapId, id);
    expect([n.x, n.y, n.w, n.h]).toEqual([999, 888, 500, 250]);
    // Resize only — position must survive.
    await move(mapId, id, { w: 123, h: 456 });
    n = await nodeFromView(mapId, id);
    expect([n.x, n.y, n.w, n.h]).toEqual([999, 888, 123, 456]);
  });

  test("returns before + after with concrete numbers; never-resized before uses card defaults", async () => {
    const mapId = await createMap();
    const id = await addNode(mapId);
    const before0 = await nodeFromView(mapId, id); // broker-placed coords
    const r = await move(mapId, id, { x: 10, y: 20 }); // move only, never resized
    expect(r.json.ok).toBe(true);
    // before: original coords, size resolved to the defaults (was NULL in DB).
    expect(r.json.before).toEqual({
      x: before0.x,
      y: before0.y,
      w: NODE_W,
      h: NODE_H,
    });
    // after: new coords, size unchanged (still the defaults).
    expect(r.json.after).toEqual({ x: 10, y: 20, w: NODE_W, h: NODE_H });
  });

  test("missing node → error", async () => {
    const mapId = await createMap();
    const r = await move(mapId, "nope", { x: 1, y: 2 });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });

  test("no x/y/w/h → error", async () => {
    const mapId = await createMap();
    const id = await addNode(mapId);
    const r = await move(mapId, id, {});
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/at least one/i);
  });
});
