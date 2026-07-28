import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Links exist so one issue's conversation can be read as a single timeline, no
// matter which board each part of it happened on. The unit is a MESSAGE and the
// relation is many-to-many, decided on 2026-07-28: a node-level link needs far
// fewer decisions, but a node routinely carries a one-off exchange about a
// different problem, and folding that in produces an aggregate that looks right
// and isn't.
//
// The rule these tests protect: linking happens in the same call that posts. A
// separate "now link it" round-trip is a place the link can be forgotten, and
// forgetting is the whole failure mode.

let broker: BrokerHandle;
let sessionId: string;
let boardId: string;
let nodeId: string;

const mkIssue = async (title: string) =>
  (
    await post<{ issue: { id: string } }>(`${broker.url}/create-issue`, {
      title,
      session_id: sessionId,
    })
  ).json.issue.id;

const linksOf = async (messageId: number) =>
  (
    await post<{ issues: { id: string }[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
      linked_to_message: messageId,
    })
  ).json.issues.map((i) => i.id);

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  // create_board refuses an unbound session (a board would orphan on restart).
  await attachCC(broker.url, sessionId, `cc-links-${Math.random().toString(36).slice(2, 8)}`);
  const b = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "links",
      concerns: [
        { id: "c1", title: "C1", items: [{ id: "i1", title: "Item 1" }] },
      ],
    },
  });
  boardId = b.json.board_id;
  const view = await get<{ nodes: { id: string; kind: string }[] }>(
    `${broker.url}/api/board/${boardId}`,
  );
  nodeId = view.json.nodes.find((n) => n.kind === "item")!.id;
});
afterAll(async () => {
  await broker.kill();
});

const countMessages = async (): Promise<number> => {
  const v = await get<{ threads: Record<string, unknown[]> }>(
    `${broker.url}/api/board/${boardId}`,
  );
  return Object.values(v.json.threads ?? {}).reduce((n, t) => n + t.length, 0);
};

const postTo = async (issue_ids?: unknown) =>
  (
    await post<{ ok: boolean; message_id: number }>(`${broker.url}/post-to-node`, {
      session_id: sessionId,
      board_id: boardId,
      node_id: nodeId,
      message: "hello",
      status: "discussing",
      issue_ids,
    })
  ).json;

describe("issue links — attached by the post itself", () => {
  test("a post carries its links in the same call", async () => {
    const a = await mkIssue("issue A");
    const b = await mkIssue("issue B");
    const r = await postTo([a, b]);
    expect(r.ok).toBe(true);
    // Many-to-many: one message can belong to two issues rather than being
    // split, because a message is the smallest unit worth splitting.
    expect((await linksOf(r.message_id)).sort()).toEqual([a, b].sort());
  });

  test("an empty list is a valid answer and links nothing", async () => {
    const r = await postTo([]);
    expect(r.ok).toBe(true);
    expect(await linksOf(r.message_id)).toEqual([]);
  });

  test("a stale issue id rejects the post and says which id was wrong", async () => {
    // Dropping the bad id would lose the link permanently AND invisibly. A
    // rejection costs one retry with a corrected argument — which is what an
    // agent does with an error — so what matters is that it names the id.
    const good = await mkIssue("issue C");
    const before = await countMessages();
    const r = (await post<{ ok: boolean; error?: string }>(
      `${broker.url}/post-to-node`,
      {
        session_id: sessionId,
        board_id: boardId,
        node_id: nodeId,
        message: "hello",
        status: "discussing",
        issue_ids: [good, "iss_does_not_exist"],
      },
    )).json;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("iss_does_not_exist");
    expect(r.error).toContain("list_issues");
    // Nothing landed: no half-posted message with only some of its links.
    expect(await countMessages()).toBe(before);
  });

  test("a deleted issue counts as unknown", async () => {
    const gone = await mkIssue("issue to delete");
    await post(`${broker.url}/delete-issue`, { issue_id: gone });
    const r = (await post<{ ok: boolean; error?: string }>(
      `${broker.url}/post-to-node`,
      {
        session_id: sessionId,
        board_id: boardId,
        node_id: nodeId,
        message: "hello",
        status: "discussing",
        issue_ids: [gone],
      },
    )).json;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("restore");
  });

  test("omitting the field entirely still posts", async () => {
    // The MCP schema is what forces the caller to decide; the broker stays
    // lenient so a session running an older tool list keeps working.
    const r = await postTo(undefined);
    expect(r.ok).toBe(true);
    expect(await linksOf(r.message_id)).toEqual([]);
  });
});

describe("issue links — maintained after the fact", () => {
  test("a link can be added and removed later", async () => {
    const a = await mkIssue("issue D");
    const r = await postTo([]);
    await post(`${broker.url}/link-issue-message`, {
      message_id: r.message_id,
      issue_ids: [a],
    });
    expect(await linksOf(r.message_id)).toEqual([a]);

    // Linking twice must not duplicate the row.
    await post(`${broker.url}/link-issue-message`, {
      message_id: r.message_id,
      issue_ids: [a],
    });
    expect(await linksOf(r.message_id)).toEqual([a]);

    await post(`${broker.url}/unlink-issue-message`, {
      message_id: r.message_id,
      issue_id: a,
    });
    expect(await linksOf(r.message_id)).toEqual([]);
  });
});

// The timeline is what the links were collected FOR: one decision's whole
// conversation in a single column, whichever surface each part of it happened
// on. A message that lives on a map or a diagram is not a corner case — those
// post tools carry issue_ids too — and dropping them would produce an aggregate
// that looks complete and isn't.
describe("issue timeline — one conversation across every surface", () => {
  test("board, map and diagram messages come back interleaved by time", async () => {
    const issue = await mkIssue("spans three surfaces");

    const map = await post<{ map_id: string }>(`${broker.url}/create-map`, {
      session_id: sessionId,
      title: "a map",
    });
    const diagram = await post<{ id: string }>(`${broker.url}/upsert-diagram`, {
      session_id: sessionId,
      title: "a diagram",
      source: "graph TD\n A-->B",
    });

    const onBoard = (await postTo([issue])).message_id;
    const onMap = (
      await post<{ message_id: number }>(`${broker.url}/map-post`, {
        session_id: sessionId,
        map_id: map.json.map_id,
        node_id: "__general__",
        message: "said on the map",
        issue_ids: [issue],
      })
    ).json.message_id;
    const onDiagram = (
      await post<{ message_id: number }>(`${broker.url}/post-diagram-chat`, {
        session_id: sessionId,
        diagram_id: diagram.json.id,
        message: "said on the diagram",
        issue_ids: [issue],
      })
    ).json.message_id;

    const tl = await post<{
      ok: boolean;
      messages: {
        id: number;
        surface: string;
        text: string;
        path: string;
        container_id: string;
      }[];
    }>(`${broker.url}/issue-timeline`, { issue_id: issue });

    expect(tl.json.ok).toBe(true);
    expect(tl.json.messages.map((m) => m.id)).toEqual([onBoard, onMap, onDiagram]);
    expect(tl.json.messages.map((m) => m.surface)).toEqual([
      "board",
      "map",
      "diagram",
    ]);
    // Full text, not a head: the caller is here to read.
    expect(tl.json.messages[1].text).toBe("said on the map");
    // Every row has to say where it came from, and carry enough to go there.
    expect(tl.json.messages[2].container_id).toBe(diagram.json.id);
    // A whole-surface chat has a synthetic node id that means nothing to a
    // reader, so the path collapses to the container's own name.
    expect(tl.json.messages[2].path).toBe("a diagram");
    expect(tl.json.messages[0].path).toBe("links > Item 1");
  });

  test("an issue with nothing linked yet answers empty, not an error", async () => {
    const issue = await mkIssue("nothing linked");
    const tl = await post<{ ok: boolean; messages: unknown[] }>(
      `${broker.url}/issue-timeline`,
      { issue_id: issue },
    );
    expect(tl.json.ok).toBe(true);
    expect(tl.json.messages).toEqual([]);
  });

  test("an unknown issue is an error, not an empty timeline", async () => {
    const tl = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/issue-timeline`,
      { issue_id: "iss_nope" },
    );
    expect(tl.json.ok).toBe(false);
    expect(tl.json.error).toContain("not found");
  });
});
