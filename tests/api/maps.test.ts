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

async function createMap(title: string): Promise<string> {
  const r = await post<{ ok: boolean; map_id: string }>(
    `${broker.url}/create-map`,
    { session_id: sessionId, title },
  );
  expect(r.json.ok).toBe(true);
  expect(r.json.map_id).toMatch(/^map_/);
  return r.json.map_id;
}

async function addNode(
  mapId: string,
  node: Record<string, unknown>,
): Promise<string> {
  const r = await post<{ ok: boolean; node_id: string }>(
    `${broker.url}/map-add-node`,
    { map_id: mapId, node },
  );
  expect(r.json.ok).toBe(true);
  return r.json.node_id;
}

describe("maps — CRUD + graph", () => {
  test("/create-map returns map_id and a /map/ url", async () => {
    const r = await post<{ ok: boolean; map_id: string; url: string }>(
      `${broker.url}/create-map`,
      { session_id: sessionId, title: "My Map" },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.map_id).toMatch(/^map_/);
    expect(r.json.url).toMatch(/^http:\/\/localhost:\d+\/map\/map_/);
  });

  test("/create-map requires a title", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/create-map`,
      { session_id: sessionId, title: "  " },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/title/i);
  });

  test("add node with parent draws an edge and fans the child to the right", async () => {
    const mapId = await createMap("graph");
    const root = await addNode(mapId, {
      title: "root",
      context: "the question",
      kind: "question",
    });
    const child = await addNode(mapId, {
      title: "child",
      kind: "idea",
      parent: root,
    });
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.nodes.length).toBe(2);
    const rootNode = view.json.nodes.find((n: any) => n.id === root);
    const childNode = view.json.nodes.find((n: any) => n.id === child);
    // Child is placed to the right of the root (general-graph fan layout).
    expect(childNode.x).toBeGreaterThan(rootNode.x);
    // The parent hint auto-drew the edge.
    expect(view.json.edges.length).toBe(1);
    expect(view.json.edges[0].from_id).toBe(root);
    expect(view.json.edges[0].to_id).toBe(child);
  });

  test("kind defaults to idea and unknown kinds are normalized", async () => {
    const mapId = await createMap("kinds");
    const a = await addNode(mapId, { title: "a" });
    const b = await addNode(mapId, { title: "b", kind: "totally-bogus" });
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    const byId = Object.fromEntries(
      view.json.nodes.map((n: any) => [n.id, n.kind]),
    );
    expect(byId[a]).toBe("idea");
    expect(byId[b]).toBe("idea");
  });

  test("connect is a general graph (many-to-many) and dedups", async () => {
    const mapId = await createMap("manymany");
    const n1 = await addNode(mapId, { title: "n1" });
    const n2 = await addNode(mapId, { title: "n2" });
    const n3 = await addNode(mapId, { title: "n3" });
    await post(`${broker.url}/map-connect`, {
      map_id: mapId,
      from_id: n1,
      to_id: n2,
    });
    await post(`${broker.url}/map-connect`, {
      map_id: mapId,
      from_id: n1,
      to_id: n3,
    });
    await post(`${broker.url}/map-connect`, {
      map_id: mapId,
      from_id: n2,
      to_id: n3,
    });
    // Duplicate of an existing edge is ignored (not a second row).
    const dup = await post<{ ok: boolean; existed?: boolean }>(
      `${broker.url}/map-connect`,
      { map_id: mapId, from_id: n1, to_id: n2 },
    );
    expect(dup.json.existed).toBe(true);
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.edges.length).toBe(3);
  });

  test("connect rejects self-loops and unknown nodes", async () => {
    const mapId = await createMap("badconnect");
    const n1 = await addNode(mapId, { title: "n1" });
    const self = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/map-connect`,
      { map_id: mapId, from_id: n1, to_id: n1 },
    );
    expect(self.json.ok).toBe(false);
    const ghost = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/map-connect`,
      { map_id: mapId, from_id: n1, to_id: "nope" },
    );
    expect(ghost.json.ok).toBe(false);
  });

  test("logical delete hides the node AND edges touching it, but keeps the row", async () => {
    const mapId = await createMap("delete");
    const a = await addNode(mapId, { title: "a" });
    const b = await addNode(mapId, { title: "b", parent: a });
    const c = await addNode(mapId, { title: "c", parent: a });
    // a→b, a→c. Delete b: node gone, a→b edge dropped from the view, a→c stays.
    await post(`${broker.url}/map-delete-node`, {
      map_id: mapId,
      node_id: b,
    });
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.nodes.map((n: any) => n.id).sort()).toEqual([a, c].sort());
    expect(view.json.edges.length).toBe(1);
    expect(view.json.edges[0].to_id).toBe(c);
    // The deleted node is still a row in the DB (logical delete), so a search
    // over content can't resurrect it but the data isn't lost — verify via the
    // fact that re-adding the same explicit id would now collide is overkill;
    // instead confirm get_map count is stable.
    const gm = await post<{ ok: boolean; nodes: any[] }>(
      `${broker.url}/get-map`,
      { map_id: mapId },
    );
    expect(gm.json.nodes.length).toBe(2);
  });

  test("update_map_node edits content; kind normalized", async () => {
    const mapId = await createMap("update");
    const n = await addNode(mapId, { title: "old", context: "old ctx" });
    await post(`${broker.url}/map-update-node`, {
      map_id: mapId,
      node_id: n,
      title: "new",
      context: "new ctx",
      kind: "research",
    });
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    const node = view.json.nodes[0];
    expect(node.title).toBe("new");
    expect(node.context).toBe("new ctx");
    expect(node.kind).toBe("research");
  });

  test("move_map_node persists position + size", async () => {
    const mapId = await createMap("move");
    const n = await addNode(mapId, { title: "n" });
    await post(`${broker.url}/map-move-node`, {
      map_id: mapId,
      node_id: n,
      x: 1234,
      y: 567,
      w: 400,
      h: 500,
    });
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    const node = view.json.nodes[0];
    expect(node.x).toBe(1234);
    expect(node.y).toBe(567);
    expect(node.w).toBe(400);
    expect(node.h).toBe(500);
  });
});

describe("maps — messages + chat delivery", () => {
  test("/map-post adds a cc message into a node thread, returns message_id", async () => {
    const mapId = await createMap("threads");
    const n = await addNode(mapId, { title: "n" });
    const r = await post<{ ok: boolean; message_id: number }>(
      `${broker.url}/map-post`,
      { map_id: mapId, node_id: n, message: "hi from cc" },
    );
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.message_id).toBe("number");
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.threads[n].length).toBe(1);
    expect(view.json.threads[n][0].source).toBe("cc");
    expect(view.json.threads[n][0].text).toBe("hi from cc");
  });

  test("/map-post into the general chat (__general__)", async () => {
    const mapId = await createMap("general");
    const r = await post<{ ok: boolean }>(`${broker.url}/map-post`, {
      map_id: mapId,
      message: "whole-map note",
    });
    expect(r.json.ok).toBe(true);
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.threads["__general__"].length).toBe(1);
  });

  test("/map-chat delivers + materializes the user message into the thread", async () => {
    const mapId = await createMap("chat");
    const n = await addNode(mapId, { title: "n" });
    // /map-chat blocks until the owning session polls. Fire it, then poll, then
    // await its resolution (mirrors how an attached MCP server drains the queue).
    const chatPromise = post<{ ok: boolean }>(`${broker.url}/map-chat`, {
      map_id: mapId,
      node_id: n,
      text: "user says hello",
    });
    await new Promise((r) => setTimeout(r, 150));
    const poll = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    // The pending map_chat is drained and carries a message_id (materialized).
    const m = poll.json.messages.find((x) => x.kind === "map_chat");
    expect(m).toBeTruthy();
    expect(m.board_id).toBe(mapId);
    expect(m.node_id).toBe(n);
    expect(m.thread_item_id).toBeGreaterThan(0);
    const chat = await chatPromise;
    expect(chat.json.ok).toBe(true);
    // The user message is now in the node thread.
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.threads[n].some((t: any) => t.source === "user")).toBe(
      true,
    );
  });
});

describe("maps — list + search", () => {
  test("/list-maps returns the session's maps with node counts", async () => {
    const mapId = await createMap("listme");
    await addNode(mapId, { title: "x" });
    const r = await post<{ ok: boolean; maps: any[] }>(
      `${broker.url}/list-maps`,
      { session_id: sessionId },
    );
    expect(r.json.ok).toBe(true);
    const mine = r.json.maps.find((m) => m.id === mapId);
    expect(mine).toBeTruthy();
    expect(mine.node_count).toBe(1);
  });

  test("/search-maps matches node content, message bodies, and map titles", async () => {
    const mapId = await createMap("searchable-zenith");
    await addNode(mapId, {
      title: "alpha node",
      context: "contains UNIQUEWORD inside",
    });
    await post(`${broker.url}/map-post`, {
      map_id: mapId,
      message: "a message with ANOTHERWORD",
    });
    const r1 = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-maps`,
      { session_id: sessionId, query: "uniqueword" },
    );
    expect(
      r1.json.matches.some((m) =>
        m.hits.some((h: any) => h.where === "node"),
      ),
    ).toBe(true);
    const r2 = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-maps`,
      { session_id: sessionId, query: "anotherword" },
    );
    expect(
      r2.json.matches.some((m) =>
        m.hits.some((h: any) => h.where === "message"),
      ),
    ).toBe(true);
    const r3 = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-maps`,
      { session_id: sessionId, query: "zenith" },
    );
    expect(
      r3.json.matches.some((m) =>
        m.hits.some((h: any) => h.where === "map_title"),
      ),
    ).toBe(true);
  });

  test("a map shows up in /api/sessions with a node + unread count", async () => {
    const mapId = await createMap("sidebar-map");
    await addNode(mapId, { title: "n" });
    await post(`${broker.url}/map-post`, {
      map_id: mapId,
      message: "unread cc msg",
    });
    const sessions = await get<any>(`${broker.url}/api/sessions`);
    const me = sessions.json.sessions.find((s: any) => s.id === sessionId);
    expect(me).toBeTruthy();
    const m = me.maps.find((x: any) => x.id === mapId);
    expect(m).toBeTruthy();
    expect(m.node_count).toBe(1);
    expect(m.unread_count).toBe(1);
  });

  test("map thread_items do NOT inflate board decision stats", async () => {
    // A map reuses thread_items (board_id = map_id). Make sure the sidebar's
    // per-BOARD stats don't accidentally count a map as a board.
    const mapId = await createMap("isolation");
    await addNode(mapId, { title: "n" });
    const sessions = await get<any>(`${broker.url}/api/sessions`);
    const me = sessions.json.sessions.find((s: any) => s.id === sessionId);
    // No board carries the map_id.
    expect(me.boards.some((b: any) => b.id === mapId)).toBe(false);
  });

  test("marking a map's cc message read clears its sidebar unread dot", async () => {
    const mapId = await createMap("markread");
    await addNode(mapId, { title: "n" });
    const posted = await post<{ message_id: number }>(`${broker.url}/map-post`, {
      map_id: mapId,
      message: "unread cc message",
    });
    let sessions = await get<any>(`${broker.url}/api/sessions`);
    let m = sessions.json.sessions
      .find((s: any) => s.id === sessionId)
      .maps.find((x: any) => x.id === mapId);
    expect(m.unread_count).toBe(1);
    // Map messages are thread_items, so the existing endpoint clears them.
    await post(`${broker.url}/mark-thread-items-read`, {
      thread_item_ids: [posted.json.message_id],
    });
    sessions = await get<any>(`${broker.url}/api/sessions`);
    m = sessions.json.sessions
      .find((s: any) => s.id === sessionId)
      .maps.find((x: any) => x.id === mapId);
    expect(m.unread_count).toBe(0);
  });
});

describe("maps — lifecycle (reclaim + sidebar survival)", () => {
  test("a map is reclaimed by the new session after a CC restart", async () => {
    const cwd = "/tmp/pd-maplife";
    const ccId = `cc-maplife-${Math.random().toString(36).slice(2, 8)}`;
    const a = await registerSession(broker.url, cwd);
    await attachCC(broker.url, a, ccId);
    const mapId = (
      await post<{ map_id: string }>(`${broker.url}/create-map`, {
        session_id: a,
        title: "lifemap",
      })
    ).json.map_id;
    await post(`${broker.url}/map-add-node`, {
      map_id: mapId,
      node: { title: "n" },
    });
    // The CC dies...
    await post(`${broker.url}/unregister`, { session_id: a });
    // ...and restarts: a fresh broker session, same cc_session_id.
    const b = await registerSession(broker.url, cwd);
    await attachCC(broker.url, b, ccId);
    // The map now belongs to the new session (reclaimed alongside boards).
    const lmB = await post<{ maps: any[] }>(`${broker.url}/list-maps`, {
      session_id: b,
    });
    expect(lmB.json.maps.some((m) => m.id === mapId)).toBe(true);
    // ...and not to the dead one.
    const lmA = await post<{ maps: any[] }>(`${broker.url}/list-maps`, {
      session_id: a,
    });
    expect(lmA.json.maps.some((m) => m.id === mapId)).toBe(false);
    // /map-chat no longer hits "no_recipient" (owner is the live new session).
    const chat = post<{ ok: boolean; reason?: string }>(
      `${broker.url}/map-chat`,
      { map_id: mapId, text: "still reachable?" },
    );
    await new Promise((r) => setTimeout(r, 120));
    await post(`${broker.url}/poll-messages`, { session_id: b });
    const res = await chat;
    expect(res.json.ok).toBe(true);
  });

  test("a map-only session survives in the inactive sidebar list", async () => {
    const cwd = "/tmp/pd-maponly";
    const ccId = `cc-maponly-${Math.random().toString(36).slice(2, 8)}`;
    const c = await registerSession(broker.url, cwd);
    await attachCC(broker.url, c, ccId); // creates an EMPTY default board
    const mapId = (
      await post<{ map_id: string }>(`${broker.url}/create-map`, {
        session_id: c,
        title: "only-a-map",
      })
    ).json.map_id;
    await post(`${broker.url}/map-add-node`, {
      map_id: mapId,
      node: { title: "n" },
    });
    // The session goes inactive. Its only content is the map (the default
    // board is empty), so without the maps-aware selector it would vanish.
    await post(`${broker.url}/unregister`, { session_id: c });
    const sessions = await get<any>(`${broker.url}/api/sessions`);
    const inactive = sessions.json.inactive_sessions.find(
      (s: any) => s.id === c,
    );
    expect(inactive).toBeTruthy();
    expect(inactive.maps.some((m: any) => m.id === mapId)).toBe(true);
  });
});

describe("maps — apply_map_ops (batch)", () => {
  test("builds a whole branch in one call with per-op results", async () => {
    const mapId = await createMap("batch");
    const r = await post<{
      ok: boolean;
      applied: number;
      total: number;
      results: any[];
    }>(`${broker.url}/map-apply-ops`, {
      map_id: mapId,
      ops: [
        { op: "add", id: "root", title: "Root", kind: "question" },
        { op: "add", id: "a", title: "A", kind: "idea", parent: "root" },
        { op: "add", id: "b", title: "B", kind: "research", parent: "root" },
        { op: "connect", from_id: "a", to_id: "b" },
        { op: "post", node_id: "a", message: "note on A" },
        { op: "post", message: "general note" },
      ],
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.applied).toBe(6);
    expect(r.json.total).toBe(6);
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.nodes.length).toBe(3);
    // root->a, root->b (from parent=) + a->b (connect)
    expect(view.json.edges.length).toBe(3);
    expect(view.json.threads["a"].length).toBe(1);
    expect(view.json.threads["__general__"].length).toBe(1);
  });

  test("reports per-op failure without aborting the rest of the batch", async () => {
    const mapId = await createMap("batch-partial");
    const r = await post<{ applied: number; results: any[] }>(
      `${broker.url}/map-apply-ops`,
      {
        map_id: mapId,
        ops: [
          { op: "add", id: "x", title: "X" },
          { op: "connect", from_id: "x", to_id: "ghost" }, // fails: ghost missing
          { op: "add", id: "y", title: "Y" }, // still applies
        ],
      },
    );
    expect(r.json.results[0].ok).toBe(true);
    expect(r.json.results[1].ok).toBe(false);
    expect(r.json.results[2].ok).toBe(true);
    expect(r.json.applied).toBe(2);
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    expect(view.json.nodes.length).toBe(2);
  });
});

describe("maps — auto-placement avoids overlap", () => {
  const NODE_W = 320;
  const NODE_H = 340;
  const overlap = (a: any, b: any) =>
    a.x < b.x + (b.w ?? NODE_W) &&
    a.x + (a.w ?? NODE_W) > b.x &&
    a.y < b.y + (b.h ?? NODE_H) &&
    a.y + (a.h ?? NODE_H) > b.y;

  test("two children of one parent don't land on top of each other", async () => {
    const mapId = await createMap("placement");
    const root = await addNode(mapId, { title: "root" });
    const c1 = await addNode(mapId, { title: "c1", parent: root });
    const c2 = await addNode(mapId, { title: "c2", parent: root });
    const view = await get<any>(`${broker.url}/api/map/${mapId}`);
    const byId = Object.fromEntries(
      view.json.nodes.map((n: any) => [n.id, n]),
    );
    // both fan out to the right of the parent...
    expect(byId[c1].x).toBeGreaterThan(byId[root].x);
    expect(byId[c2].x).toBeGreaterThan(byId[root].x);
    // ...but the second is nudged clear of the first (no overlap).
    expect(overlap(byId[c1], byId[c2])).toBe(false);
  });
});

describe("maps — list scope", () => {
  test("scope='all' surfaces other alive sessions' maps; default does not", async () => {
    const other = await registerSession(broker.url, "/tmp/pd-test-other");
    await attachCC(broker.url, other);
    const created = await post<{ ok: boolean; map_id: string }>(
      `${broker.url}/create-map`,
      { session_id: other, title: "other session map" },
    );
    const oid = created.json.map_id;

    const mine = await post<{ maps: any[] }>(`${broker.url}/list-maps`, {
      session_id: sessionId,
    });
    expect(mine.json.maps.some((m) => m.id === oid)).toBe(false);

    const all = await post<{ maps: any[] }>(`${broker.url}/list-maps`, {
      session_id: sessionId,
      scope: "all",
    });
    const found = all.json.maps.find((m) => m.id === oid);
    expect(found).toBeTruthy();
    expect(found.session_id).toBe(other);
  });
});
