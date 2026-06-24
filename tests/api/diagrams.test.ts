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
