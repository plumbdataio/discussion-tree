import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
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
let ccSessionId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccSessionId = await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

const FLOW = "graph TD\n  A[Start] --> B[End]";

async function createDiagram(
  title: string,
  source = FLOW,
): Promise<string> {
  const r = await post<{ ok: boolean; id: string }>(
    `${broker.url}/upsert-diagram`,
    { session_id: sessionId, title, source },
  );
  expect(r.json.ok).toBe(true);
  expect(r.json.id).toMatch(/^dg_/);
  return r.json.id;
}

describe("diagrams — upsert (create / replace) + validation", () => {
  test("upsert without id creates a diagram, GET returns the full view", async () => {
    const id = await createDiagram("My Flow");
    const view = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(view.json.diagram.id).toBe(id);
    expect(view.json.diagram.title).toBe("My Flow");
    expect(view.json.diagram.source).toBe(FLOW);
    expect(view.json.diagram.session_id).toBe(sessionId);
    // The view carries the same owner_* enrichment a map/board view does, plus
    // an (initially empty) chat thread.
    expect(view.json.owner_alive).toBe(true);
    expect(view.json.owner_can_cli_send).toBe(false); // no tmux pane
    expect(view.json.owner_context_usage ?? null).toBeNull(); // none reported
    expect(Array.isArray(view.json.thread)).toBe(true);
    expect(view.json.thread.length).toBe(0);
  });

  test("upsert with an existing id REPLACES the whole source; created_at is kept", async () => {
    const id = await createDiagram("Original", "graph LR\n  X --> Y");
    const before = await get<any>(`${broker.url}/api/diagram/${id}`);
    const createdAt = before.json.diagram.created_at;

    const replaced = "sequenceDiagram\n  Alice->>Bob: hi";
    const r = await post<{ ok: boolean; id: string }>(
      `${broker.url}/upsert-diagram`,
      { session_id: sessionId, id, title: "Renamed", source: replaced },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.id).toBe(id);

    const after = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(after.json.diagram.title).toBe("Renamed");
    expect(after.json.diagram.source).toBe(replaced);
    // Replace is a whole-source swap, not a new row — created_at is preserved.
    expect(after.json.diagram.created_at).toBe(createdAt);
  });

  test("upsert rejects an empty source", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/upsert-diagram`,
      { session_id: sessionId, title: "blank", source: "   " },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/empty|content/i);
  });

  test("upsert rejects a non-Mermaid first line", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/upsert-diagram`,
      { session_id: sessionId, title: "bogus", source: "this is not a diagram" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/mermaid|diagram type/i);
  });

  test("upsert tolerates leading %% comments / --- frontmatter before the header", async () => {
    const src = "---\ntitle: t\n---\n%% a comment\nflowchart TD\n  A-->B";
    const r = await post<{ ok: boolean; id: string }>(
      `${broker.url}/upsert-diagram`,
      { session_id: sessionId, title: "fm", source: src },
    );
    expect(r.json.ok).toBe(true);
  });

  // Real mermaid.parse backstop (isolated worker, broker/mermaid-validate.ts):
  // a source that clears the header check but is syntactically broken (nested
  // unescaped quotes in a node label) is rejected at upsert, not just at render.
  // The worker's first spawn pays a one-time ~1.5s warm, hence the longer wait.
  test(
    "upsert rejects a header-valid but syntactically broken source",
    async () => {
      const broken = 'flowchart TD\n  A["outer "inner" broke"] --> B';
      const r = await post<{ ok: boolean; error?: string }>(
        `${broker.url}/upsert-diagram`,
        { session_id: sessionId, title: "broken", source: broken },
      );
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toMatch(/syntax|parse/i);
    },
    15_000,
  );

  test(
    "upsert accepts a styled diagram (classDef) the parser must not false-reject",
    async () => {
      const styled =
        "flowchart TD\n  A:::c --> B\n  classDef c fill:#dff";
      const r = await post<{ ok: boolean; id: string }>(
        `${broker.url}/upsert-diagram`,
        { session_id: sessionId, title: "styled", source: styled },
      );
      expect(r.json.ok).toBe(true);
    },
    15_000,
  );

  test("creating a NEW diagram requires session_id", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/upsert-diagram`,
      { title: "no session", source: FLOW },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/session_id/i);
  });
});

describe("diagrams — get / list / delete", () => {
  test("/get-diagram returns the row; missing id fails", async () => {
    const id = await createDiagram("Gettable");
    const r = await post<{ ok: boolean; id: string; title: string; source: string }>(
      `${broker.url}/get-diagram`,
      { id },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.id).toBe(id);
    expect(r.json.title).toBe("Gettable");
    const missing = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/get-diagram`,
      { id: "dg_nope" },
    );
    expect(missing.json.ok).toBe(false);
    expect(missing.json.error).toMatch(/not found/i);
  });

  test("/list-diagrams returns the session's diagrams", async () => {
    const id = await createDiagram("Listed One");
    const r = await post<{ ok: boolean; diagrams: { id: string; title: string }[] }>(
      `${broker.url}/list-diagrams`,
      { session_id: sessionId },
    );
    expect(r.json.ok).toBe(true);
    const mine = r.json.diagrams.find((d) => d.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.title).toBe("Listed One");
  });

  test("/delete-diagram removes it (GET 404s, list drops it)", async () => {
    const id = await createDiagram("Doomed");
    const del = await post<{ ok: boolean }>(`${broker.url}/delete-diagram`, {
      id,
    });
    expect(del.json.ok).toBe(true);
    const view = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(view.status).toBe(404);
    const list = await post<{ diagrams: { id: string }[] }>(
      `${broker.url}/list-diagrams`,
      { session_id: sessionId },
    );
    expect(list.json.diagrams.some((d) => d.id === id)).toBe(false);
  });
});

describe("diagrams — chat", () => {
  test("/post-diagram-chat appends a CC message to the chat thread", async () => {
    const id = await createDiagram("Chat target");
    const r = await post<{ ok: boolean }>(`${broker.url}/post-diagram-chat`, {
      diagram_id: id,
      message: "I updated the diagram.",
    });
    expect(r.json.ok).toBe(true);
    const view = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(view.json.thread.length).toBe(1);
    expect(view.json.thread[0].source).toBe("cc");
    expect(view.json.thread[0].text).toBe("I updated the diagram.");
    // The thread is keyed at the synthetic chat node.
    expect(view.json.thread[0].node_id).toBe("__chat__");
    expect(view.json.thread[0].board_id).toBe(id);
  });

  test("/diagram-chat delivers + materializes the user message into the thread", async () => {
    const id = await createDiagram("Chat delivery");
    // /diagram-chat blocks until the owning session polls — fire it, poll, await.
    const chatPromise = post<{ ok: boolean }>(`${broker.url}/diagram-chat`, {
      diagram_id: id,
      text: "make the box red",
    });
    await new Promise((r) => setTimeout(r, 150));
    const poll = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    const m = poll.json.messages.find((x) => x.kind === "diagram_chat");
    expect(m).toBeTruthy();
    expect(m.board_id).toBe(id);
    expect(m.node_id).toBe("__chat__");
    expect(m.text).toBe("make the box red");
    expect((await chatPromise).json.ok).toBe(true);
    // The user message is now in the chat thread (exactly one copy).
    const view = await get<any>(`${broker.url}/api/diagram/${id}`);
    const userMsgs = view.json.thread.filter((t: any) => t.source === "user");
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].text).toBe("make the box red");
  });

  test("/diagram-chat on a missing diagram returns no_recipient", async () => {
    const r = await post<{ ok: boolean; reason?: string }>(
      `${broker.url}/diagram-chat`,
      { diagram_id: "dg_nope", text: "hello?" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("no_recipient");
  });
});

describe("diagrams — sidebar listing", () => {
  test("a diagram shows up under its session in /api/sessions", async () => {
    const id = await createDiagram("Sidebar diagram");
    const sessions = await get<any>(`${broker.url}/api/sessions`);
    const me = sessions.json.sessions.find((s: any) => s.id === sessionId);
    expect(me).toBeTruthy();
    const d = (me.diagrams ?? []).find((x: any) => x.id === id);
    expect(d).toBeTruthy();
    expect(d.title).toBe("Sidebar diagram");
    // A diagram reuses thread_items (board_id = diagram_id) but must NOT be
    // mistaken for a board.
    expect(me.boards.some((b: any) => b.id === id)).toBe(false);
  });

  test("list_diagrams never shows another session's diagrams", async () => {
    const other = await registerSession(broker.url, "/tmp/pd-diagram-other");
    await attachCC(broker.url, other);
    const created = await post<{ ok: boolean; id: string }>(
      `${broker.url}/upsert-diagram`,
      { session_id: other, title: "other session diagram", source: FLOW },
    );
    const oid = created.json.id;
    const mine = await post<{ diagrams: { id: string }[] }>(
      `${broker.url}/list-diagrams`,
      { session_id: sessionId },
    );
    expect(mine.json.diagrams.some((d) => d.id === oid)).toBe(false);
  });
});

describe("diagrams — context (description)", () => {
  test("upsert stores context; a source-only upsert preserves it; \"\" clears", async () => {
    const id = await createDiagram("ctx", FLOW);
    // Set a description.
    await post(`${broker.url}/upsert-diagram`, {
      session_id: sessionId,
      id,
      source: FLOW,
      context: "the background",
    });
    let v = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(v.json.diagram.context).toBe("the background");
    // Source-only edit (no context key) keeps the existing description.
    await post(`${broker.url}/upsert-diagram`, {
      session_id: sessionId,
      id,
      source: "graph LR\n  X --> Y",
    });
    v = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(v.json.diagram.context).toBe("the background");
    expect(v.json.diagram.source).toBe("graph LR\n  X --> Y");
    // Explicit "" clears it.
    await post(`${broker.url}/upsert-diagram`, {
      session_id: sessionId,
      id,
      source: FLOW,
      context: "",
    });
    v = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(v.json.diagram.context).toBe("");
  });

  test("a freshly created diagram has an empty context", async () => {
    const id = await createDiagram("no ctx");
    const v = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(v.json.diagram.context).toBe("");
  });
});

describe("diagrams — rename + archive", () => {
  test("/rename-diagram changes the title; empty / missing rejected", async () => {
    const id = await createDiagram("Before");
    const r = await post<{ ok: boolean }>(`${broker.url}/rename-diagram`, {
      id,
      title: "After",
    });
    expect(r.json.ok).toBe(true);
    const v = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(v.json.diagram.title).toBe("After");
    const empty = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/rename-diagram`,
      { id, title: "  " },
    );
    expect(empty.json.ok).toBe(false);
    const missing = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/rename-diagram`,
      { id: "dg_nope", title: "x" },
    );
    expect(missing.json.ok).toBe(false);
    expect(missing.json.error).toMatch(/not found/i);
  });

  test("/archive-diagram hides it from the list; archived:false restores it", async () => {
    const id = await createDiagram("Archivable");
    const inList = async () => {
      const r = await post<{ diagrams: { id: string }[] }>(
        `${broker.url}/list-diagrams`,
        { session_id: sessionId },
      );
      return r.json.diagrams.some((d) => d.id === id);
    };
    expect(await inList()).toBe(true);
    expect(
      (await post<{ ok: boolean }>(`${broker.url}/archive-diagram`, { id })).json
        .ok,
    ).toBe(true);
    expect(await inList()).toBe(false);
    // The page still loads while archived (soft hide).
    const v = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(v.status).not.toBe(404);
    // Unarchive restores it.
    await post(`${broker.url}/archive-diagram`, { id, archived: false });
    expect(await inList()).toBe(true);
  });

  test("an archived diagram drops out of /api/sessions", async () => {
    const id = await createDiagram("Sidebar archivable");
    await post(`${broker.url}/archive-diagram`, { id });
    const sessions = await get<any>(`${broker.url}/api/sessions`);
    const me = sessions.json.sessions.find((s: any) => s.id === sessionId);
    expect((me.diagrams ?? []).some((d: any) => d.id === id)).toBe(false);
  });
});

describe("diagrams — lifecycle (reclaim across a CC restart)", () => {
  test("a diagram is reclaimed by the new session, so the page stays attached", async () => {
    const cwd = "/tmp/pd-diagram-life";
    const ccId = `cc-diaglife-${Math.random().toString(36).slice(2, 8)}`;
    const a = await registerSession(broker.url, cwd);
    await attachCC(broker.url, a, ccId);
    const id = (
      await post<{ ok: boolean; id: string }>(`${broker.url}/upsert-diagram`, {
        session_id: a,
        title: "lifediagram",
        source: FLOW,
      })
    ).json.id;
    // Before the restart the owner (session a) is alive.
    let view = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(view.json.owner_alive).toBe(true);

    // The CC dies...
    await post(`${broker.url}/unregister`, { session_id: a });
    // ...and restarts: a fresh broker session, same cc_session_id.
    const b = await registerSession(broker.url, cwd);
    await attachCC(broker.url, b, ccId);

    // The diagram now belongs to the new (live) session — the page is attached
    // again, not stuck on "unattached".
    view = await get<any>(`${broker.url}/api/diagram/${id}`);
    expect(view.json.owner_alive).toBe(true);
    expect(view.json.diagram.session_id).toBe(b);
    const lb = await post<{ diagrams: { id: string }[] }>(
      `${broker.url}/list-diagrams`,
      { session_id: b },
    );
    expect(lb.json.diagrams.some((d) => d.id === id)).toBe(true);
    const la = await post<{ diagrams: { id: string }[] }>(
      `${broker.url}/list-diagrams`,
      { session_id: a },
    );
    expect(la.json.diagrams.some((d) => d.id === id)).toBe(false);
    // diagram-chat no longer hits no_recipient (owner is the live new session).
    const chat = post<{ ok: boolean; reason?: string }>(
      `${broker.url}/diagram-chat`,
      { diagram_id: id, text: "still reachable?" },
    );
    await new Promise((r) => setTimeout(r, 120));
    await post(`${broker.url}/poll-messages`, { session_id: b });
    expect((await chat).json.ok).toBe(true);
  });
});

// A diagram chat is a question addressed to the CC, so leaving it unreplied is
// the same failure the board nag already catches. The wrinkle is that the CC
// cannot answer a diagram with post_to_node — there is no node — so the nag has
// to name the right tool per surface.
describe("diagrams — the Stop-hook nag covers diagram chat", () => {
  type Unanswered = {
    count: number;
    nodes: {
      node_path: string;
      surface?: string;
      reply_tool?: string;
    }[];
  };
  const unanswered = async () =>
    (await post<Unanswered>(`${broker.url}/get-unanswered`, {
      cc_session_id: ccSessionId,
    })).json;

  // /diagram-chat blocks until the owner polls, so fire-then-poll.
  async function userSays(diagramId: string, text: string) {
    const chat = post<{ ok: boolean }>(`${broker.url}/diagram-chat`, {
      diagram_id: diagramId,
      text,
    });
    await new Promise((r) => setTimeout(r, 150));
    await post(`${broker.url}/poll-messages`, { session_id: sessionId });
    expect((await chat).json.ok).toBe(true);
  }

  beforeEach(async () => {
    await post(`${broker.url}/reset-unanswered`, { session_id: sessionId });
  });

  test("an unreplied diagram chat is nagged, naming post_diagram_chat", async () => {
    const id = await createDiagram("Nag me");
    await userSays(id, "why is this edge dashed?");
    const u = await unanswered();
    expect(u.count).toBe(1);
    expect(u.nodes[0].node_path).toContain("Nag me");
    expect(u.nodes[0].surface).toBe("diagram");
    // The whole point: post_to_node would send the CC after a node that
    // doesn't exist on a diagram.
    expect(u.nodes[0].reply_tool).toBe("post_diagram_chat");
  });

  test("a real post_diagram_chat clears it", async () => {
    const id = await createDiagram("Answer me");
    await userSays(id, "why is this edge dashed?");
    expect((await unanswered()).count).toBe(1);
    await post(`${broker.url}/post-diagram-chat`, {
      diagram_id: id,
      message: "It marks an async hop.",
    });
    expect((await unanswered()).count).toBe(0);
  });

  test("an empty post does NOT count as an answer", async () => {
    const id = await createDiagram("Empty post");
    await userSays(id, "why is this edge dashed?");
    await post(`${broker.url}/post-diagram-chat`, {
      diagram_id: id,
      message: "   ",
    });
    expect((await unanswered()).count).toBe(1);
  });

  test("map chat stays out of the nag", async () => {
    // Deliberate asymmetry: on a map the CC answers by growing the graph, not
    // necessarily by posting, so nagging there would over-fire.
    const m = await post<{ ok: boolean; map_id: string }>(
      `${broker.url}/create-map`,
      { session_id: sessionId, title: "No nag here" },
    );
    const mapId = m.json.map_id;
    const chat = post<{ ok: boolean }>(`${broker.url}/map-chat`, {
      map_id: mapId,
      text: "add a node for the cache",
    });
    await new Promise((r) => setTimeout(r, 150));
    await post(`${broker.url}/poll-messages`, { session_id: sessionId });
    expect((await chat).json.ok).toBe(true);
    expect((await unanswered()).count).toBe(0);
  });
});
