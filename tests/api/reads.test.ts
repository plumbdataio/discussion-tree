import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;
let sessionA: string;
let sessionB: string;
let ccA: string;
let ccB: string;
let boardA1: string;
let boardA2: string;
let boardB1: string;
let nodeWithThread: string;

beforeAll(async () => {
  broker = await startBroker();

  // Two sibling sessions — one is the "querying" session, the other is a
  // sibling whose boards should be visible only when scope='all'.
  sessionA = await registerSession(broker.url);
  ccA = await attachCC(broker.url, sessionA);
  sessionB = await registerSession(broker.url);
  ccB = await attachCC(broker.url, sessionB);

  // Session A: two boards.
  const a1 = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionA,
    structure: {
      title: "Auth scheme review",
      concerns: [
        {
          id: "auth-c",
          title: "JWT or session?",
          context: "We need to decide tokens vs cookies for the API.",
          items: [
            {
              id: "auth-jwt",
              title: "JWT short expiry",
              context: "15-minute access tokens",
            },
            { id: "auth-cookie", title: "Cookie + CSRF token" },
          ],
        },
      ],
    },
  });
  boardA1 = a1.json.board_id;
  nodeWithThread = "auth-jwt";

  const a2 = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionA,
    structure: {
      title: "Error response format",
      concerns: [
        { id: "err-c", title: "Problem details vs custom JSON" },
      ],
    },
  });
  boardA2 = a2.json.board_id;

  // Seed a thread on auth-jwt — for thread search + truncation tests.
  for (let i = 0; i < 25; i++) {
    await post(`${broker.url}/post-to-node`, {
      board_id: boardA1,
      node_id: nodeWithThread,
      message: `reply ${i}: auth discussion message body`,
      status: "discussing",
    });
  }

  // Session B: a board that mentions "auth" too — so search_boards can verify
  // scope isolation.
  const b1 = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionB,
    structure: {
      title: "Sibling session: auth handoff plan",
      concerns: [{ id: "x", title: "Handoff" }],
    },
  });
  boardB1 = b1.json.board_id;
});

afterAll(async () => {
  await broker.kill();
});

describe("/list-boards", () => {
  test("default scope (this_session) returns only this session's boards", async () => {
    const r = await post<{ ok: boolean; boards: any[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionA },
    );
    expect(r.json.ok).toBe(true);
    const ids = r.json.boards.map((b) => b.id);
    expect(ids).toContain(boardA1);
    expect(ids).toContain(boardA2);
    expect(ids).not.toContain(boardB1); // sibling session's board hidden
  });

  test("scope='all' includes sibling alive sessions", async () => {
    const r = await post<{ ok: boolean; boards: any[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionA, scope: "all" },
    );
    expect(r.json.ok).toBe(true);
    const ids = r.json.boards.map((b) => b.id);
    expect(ids).toContain(boardA1);
    expect(ids).toContain(boardB1);
  });

  test("each row exposes concern/item counts and a last_activity", async () => {
    const r = await post<{ ok: boolean; boards: any[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionA },
    );
    const auth = r.json.boards.find((b) => b.id === boardA1)!;
    expect(auth.concern_count).toBe(1);
    expect(auth.item_count).toBe(2);
    expect(typeof auth.last_activity).toBe("string");
  });

  test("missing session_id → ok=false", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/list-boards`,
      {},
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/session_id/i);
  });
});

describe("/get-board-view", () => {
  test("default truncates each node's thread to the most recent 20 items", async () => {
    const r = await post<{
      ok: boolean;
      threads: Record<string, any[]>;
      thread_truncated: Record<string, number>;
    }>(`${broker.url}/get-board-view`, { board_id: boardA1 });
    expect(r.json.ok).toBe(true);
    expect(r.json.threads[nodeWithThread].length).toBe(20);
    // The total is 25 posts + 1 status_change system entry from the first
    // post_to_node bumping pending → discussing.
    expect(r.json.thread_truncated[nodeWithThread]).toBeGreaterThanOrEqual(25);
  });

  test("max_items_per_node=-1 returns every item", async () => {
    const r = await post<{
      ok: boolean;
      threads: Record<string, any[]>;
      thread_truncated: Record<string, number>;
    }>(`${broker.url}/get-board-view`, {
      board_id: boardA1,
      max_items_per_node: -1,
    });
    expect(r.json.threads[nodeWithThread].length).toBeGreaterThanOrEqual(25);
    expect(r.json.thread_truncated[nodeWithThread]).toBeUndefined();
  });

  test("node_ids filter restricts the threads payload", async () => {
    const r = await post<{ ok: boolean; threads: Record<string, any[]> }>(
      `${broker.url}/get-board-view`,
      { board_id: boardA1, node_ids: [nodeWithThread] },
    );
    expect(Object.keys(r.json.threads)).toEqual([nodeWithThread]);
  });

  test("unknown board → ok=false", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/get-board-view`,
      { board_id: "bd_does_not_exist" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not found/i);
  });
});

describe("/search-boards", () => {
  test("matches board title (this_session scope)", async () => {
    const r = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-boards`,
      { session_id: sessionA, query: "Auth scheme" },
    );
    expect(r.json.ok).toBe(true);
    expect(
      r.json.matches.some(
        (m) => m.board_id === boardA1 && m.match_in === "board_title",
      ),
    ).toBe(true);
  });

  test("default scope excludes sibling session boards", async () => {
    const r = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-boards`,
      { session_id: sessionA, query: "Sibling session" },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.matches.some((m) => m.board_id === boardB1)).toBe(false);
  });

  test("scope='all' surfaces sibling boards", async () => {
    const r = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-boards`,
      { session_id: sessionA, query: "Sibling session", scope: "all" },
    );
    expect(r.json.matches.some((m) => m.board_id === boardB1)).toBe(true);
  });

  test("matches node context", async () => {
    const r = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-boards`,
      { session_id: sessionA, query: "15-minute access" },
    );
    expect(
      r.json.matches.some(
        (m) =>
          m.node_id === "auth-jwt" &&
          (m.match_in === "node_context" || m.match_in === "node_title"),
      ),
    ).toBe(true);
  });

  test("matches thread body and returns a snippet", async () => {
    const r = await post<{ ok: boolean; matches: any[] }>(
      `${broker.url}/search-boards`,
      { session_id: sessionA, query: "auth discussion message" },
    );
    const threadMatch = r.json.matches.find(
      (m) => m.match_in === "thread_text",
    );
    expect(threadMatch).toBeTruthy();
    expect(threadMatch.snippet).toContain("auth discussion message");
  });

  test("empty query → ok=false", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/search-boards`,
      { session_id: sessionA, query: "   " },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/query required/i);
  });
});
