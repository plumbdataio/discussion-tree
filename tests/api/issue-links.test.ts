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

  test("omitting the field is refused, and the refusal says what to send", async () => {
    // Inverted on 2026-07-29. The broker used to default a missing field to
    // "no links" so that sessions running an older tool list — which physically
    // could not send it — kept working. Once every live MCP server had been
    // restarted (measured, not assumed) that reason was gone, and a default is
    // exactly what the required parameter exists to prevent: it answers "does
    // this belong to an issue?" for you, silently and always the same way.
    const before = await countMessages();
    const r = await postTo(undefined);
    expect(r.ok).toBe(false);
    expect((r as unknown as { error: string }).error).toContain("issue_ids is required");
    // The refusal has to be actionable: [] is a legitimate answer and saying so
    // is what turns the error into one corrected retry.
    expect((r as unknown as { error: string }).error).toContain("[]");
    expect(await countMessages()).toBe(before);
  });

  test("an explicit empty array is still a valid answer", async () => {
    const r = await postTo([]);
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

// The list has to say how much conversation an issue has BEFORE it is opened.
// Without it the UI could only offer "read the conversation" and discover on
// click that there was none — which is what shipped, and read as a broken
// feature rather than as an issue nobody had linked yet. Most issues genuinely
// have zero: they predate the linking machinery, or belong to another
// session's CC who links their own posts.
describe("issue list — how much conversation is attached", () => {
  test("link_count rides along with each row", async () => {
    const quiet = await mkIssue("nothing linked to this one");
    const busy = await mkIssue("this one gets talked about");
    await postTo([busy]);
    await postTo([busy]);

    const list = await post<{
      issues: { id: string; link_count: number }[];
    }>(`${broker.url}/list-issues`, { include_closed: true });

    const byId = new Map(list.json.issues.map((i) => [i.id, i.link_count]));
    expect(byId.get(busy)).toBe(2);
    // Zero, not undefined — the UI renders it, so it has to be a number.
    expect(byId.get(quiet)).toBe(0);
  });

  test("unlinking is reflected, so the count cannot drift upward forever", async () => {
    const issue = await mkIssue("linked then unlinked");
    const posted = await postTo([issue]);
    const countOf = async () =>
      (
        await post<{ issues: { id: string; link_count: number }[] }>(
          `${broker.url}/list-issues`,
          { include_closed: true },
        )
      ).json.issues.find((i) => i.id === issue)!.link_count;

    expect(await countOf()).toBe(1);
    await post(`${broker.url}/unlink-issue-message`, {
      message_id: posted.message_id,
      issue_id: issue,
    });
    expect(await countOf()).toBe(0);
  });
});

// Ids get written in their SHORTENED form — the timestamp half alone
// ("iss_ms5kq850"). That is what CC types in prose and what the UI turns into a
// link, so the same system that taught everyone to write it that way then
// rejected it at the one moment it mattered. Resolve by prefix; refuse rather
// than guess when a prefix matches more than one issue.
describe("issue ids — the shortened form is the written form", () => {
  test("a prefix links the same as the full id", async () => {
    const full = await mkIssue("linked by prefix");
    const short = full.slice(0, "iss_".length + 8);
    expect(short.length).toBeLessThan(full.length);
    const r = await post<{ ok: boolean; message_id?: number; error?: string }>(
      `${broker.url}/post-to-node`,
      {
        board_id: boardId,
        node_id: nodeId,
        message: "written with the short form",
        status: "discussing",
        issue_ids: [short],
      },
    );
    expect(r.json.ok).toBe(true);
    // Stored against the FULL id, so the timeline finds it either way.
    expect(await linksOf(r.json.message_id!)).toContain(full);
  });

  test("an ambiguous prefix is refused, and says so", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/post-to-node`,
      {
        board_id: boardId,
        node_id: nodeId,
        message: "too little of the id",
        status: "discussing",
        issue_ids: ["iss_"],
      },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/ambiguous/i);
  });

  test("titles come back keyed by whatever form was asked for", async () => {
    const full = await mkIssue("has a readable name");
    const short = full.slice(0, "iss_".length + 8);
    const r = await post<{
      titles: Record<string, { id: string; title: string }>;
    }>(`${broker.url}/issue-titles`, { ids: [short, "iss_nope"] });
    // The user cannot judge anything from an id, so the UI shows this instead.
    expect(r.json.titles[short].title).toBe("has a readable name");
    expect(r.json.titles[short].id).toBe(full);
    // An id that resolves to nothing simply has no entry — the text keeps
    // rendering as written, which is what a placeholder in a sentence ABOUT
    // the format needs.
    expect(r.json.titles["iss_nope"]).toBeUndefined();
  });
});

// "No silent caps" is a rule this codebase learned the hard way: another
// session read a truncated review window and concluded its links were all up to
// date. Every bounded read says so.
describe("issue titles — the cap announces itself", () => {
  test("says what it dropped when asked for more than it will look up", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `iss_none${i}`);
    const r = await post<{ truncated?: boolean; note?: string }>(
      `${broker.url}/issue-titles`,
      { ids },
    );
    expect(r.json.truncated).toBe(true);
    expect(r.json.note).toContain("250");
  });

  test("stays quiet when nothing was dropped", async () => {
    const r = await post<{ truncated?: boolean }>(`${broker.url}/issue-titles`, {
      ids: ["iss_nope"],
    });
    expect(r.json.truncated).toBeUndefined();
  });
});
