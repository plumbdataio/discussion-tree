import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Talking ON an issue: each issue gets a thread of its own, on a board that is
// created the first time somebody writes.
//
// The two rules worth protecting, both from the design discussion on
// 2026-07-29:
//   - NOTHING exists until somebody writes. An issue nobody has discussed must
//     not leave an empty board and node behind.
//   - The board is keyed by the issue's SESSION. A single global board would
//     hand every issue's conversation to whichever CC happened to own it, so a
//     message about another session's issue would be delivered to the wrong CC
//     and the right one would never hear about it.
//
// Plus the thing the whole link machinery exists for: a message written here is
// attached to its issue without anybody saying so.

let broker: BrokerHandle;
let sessionId: string;
let otherSessionId: string;

const mkIssue = async (title: string, session: string | null = sessionId) =>
  (
    await post<{ issue: { id: string } }>(`${broker.url}/create-issue`, {
      title,
      session_id: session,
    })
  ).json.issue.id;

const chat = (issueId: string) =>
  post<{
    ok: boolean;
    error?: string;
    location: { board_id: string; node_id: string } | null;
    session: { id: string } | null;
    items: { id: number; source: string; text: string }[];
  }>(`${broker.url}/issue-chat`, { issue_id: issueId });

const ccPost = (issueId: string, message: string, extra = {}) =>
  post<{
    ok: boolean;
    error?: string;
    message_id?: number;
    location?: { board_id: string; node_id: string };
  }>(`${broker.url}/issue-chat-post`, {
    issue_id: issueId,
    message,
    status: "discussing",
    ...extra,
  });

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
  await attachCC(broker.url, sessionId);
  otherSessionId = await registerSession(broker.url, "/tmp/pd-test-other");
  await attachCC(broker.url, otherSessionId);
});
afterAll(async () => {
  await broker.kill();
});

describe("issue chat — nothing exists until somebody writes", () => {
  test("a fresh issue has no thread, and asking does not create one", async () => {
    const id = await mkIssue("nobody has said anything");
    const first = await chat(id);
    expect(first.json.ok).toBe(true);
    expect(first.json.location).toBeNull();
    expect(first.json.items).toEqual([]);

    // Reading is what the tracker does on every render — it must not leave a
    // board behind.
    await chat(id);
    const boards = await post<{ boards: { id: string }[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionId },
    );
    const titles = await Promise.all(
      boards.json.boards.map((b) =>
        get<{ title: string }>(`${broker.url}/api/board/${b.id}`).then(
          (r) => r.json.title,
        ),
      ),
    );
    expect(titles).not.toContain("Issue conversations");
  });

  test("the first message creates the board and the node", async () => {
    const id = await mkIssue("worth discussing");
    const posted = await ccPost(id, "here is what I found");
    expect(posted.json.ok).toBe(true);
    expect(posted.json.location?.node_id).toBe(id);

    const after = await chat(id);
    expect(after.json.location?.board_id).toBe(posted.json.location!.board_id);
    expect(after.json.items.map((m) => m.text)).toContain("here is what I found");
  });

  test("a second issue lands on the same board, as its own node", async () => {
    const a = await mkIssue("first topic");
    const b = await mkIssue("second topic");
    const pa = await ccPost(a, "about A");
    const pb = await ccPost(b, "about B");
    expect(pb.json.location?.board_id).toBe(pa.json.location!.board_id);
    expect(pb.json.location?.node_id).not.toBe(pa.json.location!.node_id);

    // Each thread holds only its own conversation. (status_change rows ride
    // the same table and are filtered out by the view.)
    const ca = await chat(a);
    expect(
      ca.json.items.filter((m) => m.source !== "system").map((m) => m.text),
    ).toEqual(["about A"]);
  });
});

describe("issue chat — the board belongs to the issue's session", () => {
  test("another session's issue gets its own board", async () => {
    const mine = await mkIssue("mine");
    const theirs = await mkIssue("theirs", otherSessionId);
    const pm = await ccPost(mine, "mine");
    const pt = await ccPost(theirs, "theirs");
    expect(pt.json.location?.board_id).not.toBe(pm.json.location!.board_id);

    // And it is filed under THAT session, which is what decides who a reply
    // gets delivered to.
    const boards = await post<{ boards: { id: string }[] }>(
      `${broker.url}/list-boards`,
      { session_id: otherSessionId },
    );
    expect(boards.json.boards.map((b) => b.id)).toContain(
      pt.json.location!.board_id,
    );
  });

  test("an issue with no session says so rather than picking one", async () => {
    const orphan = await mkIssue("filed nowhere", null);
    const r = await ccPost(orphan, "hello?");
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/session/i);
  });
});

describe("issue chat — messages link themselves", () => {
  test("posting on an issue's thread attaches the message to it", async () => {
    const id = await mkIssue("links itself");
    const posted = await ccPost(id, "no issue_ids passed");
    expect(await linksOf(posted.json.message_id!)).toContain(id);
  });

  test("an extra issue_id is added, not replaced", async () => {
    const home = await mkIssue("home issue");
    const other = await mkIssue("other issue");
    const posted = await ccPost(home, "touches both", {
      issue_ids: [other],
    });
    const links = await linksOf(posted.json.message_id!);
    expect(links).toContain(home);
    expect(links).toContain(other);
  });

  test("the tracker can see how many messages a thread holds", async () => {
    const id = await mkIssue("counted");
    await ccPost(id, "one");
    await ccPost(id, "two");
    const list = await post<{
      issues: { id: string; chat_count: number; link_count: number }[];
    }>(`${broker.url}/list-issues`, { include_closed: true });
    const row = list.json.issues.find((i) => i.id === id)!;
    // Two messages, plus the status_change the first post writes.
    expect(row.chat_count).toBeGreaterThanOrEqual(2);
    expect(row.link_count).toBe(2);
  });
});

describe("issue chat — the user's own message", () => {
  test("is created, delivered and linked without anyone saying which issue", async () => {
    const id = await mkIssue("the user writes first");
    // /issue-chat-submit blocks until the CC picks the message up, so fire it
    // and drain the queue the way a polling MCP server would.
    const submitP = fetch(`${broker.url}/issue-chat-submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_id: id, text: "what about this one?" }),
    });
    await new Promise((r) => setTimeout(r, 150));
    const drained = await post<{
      messages: { board_id: string; node_id: string; thread_item_id: number }[];
    }>(`${broker.url}/poll-messages`, { session_id: sessionId });
    await submitP;

    // Delivered to this session, on this issue's own node...
    const mine = drained.json.messages.filter((m) => m.node_id === id);
    expect(mine.length).toBe(1);
    // ...and attached to the issue. This is the ONLY path where the user's own
    // messages get linked without CC noticing after the fact.
    expect(await linksOf(mine[0].thread_item_id)).toContain(id);

    const after = await chat(id);
    expect(after.json.items.map((m) => m.text)).toContain("what about this one?");
  });
});

describe("issue chat — the node follows the issue", () => {
  test("a thread deleted by hand comes back with its history", async () => {
    const id = await mkIssue("deleted then resumed");
    const posted = await ccPost(id, "before the delete");
    await post(`${broker.url}/delete-node`, {
      board_id: posted.json.location!.board_id,
      node_id: id,
    });
    // Deletion is logical and the node id is fixed as the issue id, so a naive
    // re-insert would collide on the primary key and the conversation would be
    // dead for good.
    const again = await ccPost(id, "after the delete");
    expect(again.json.ok).toBe(true);
    const items = (await chat(id)).json.items.map((m) => m.text);
    expect(items).toContain("before the delete");
    expect(items).toContain("after the delete");
  });

  test("renaming the issue renames its thread", async () => {
    const id = await mkIssue("original name");
    const posted = await ccPost(id, "started");
    await post(`${broker.url}/update-issue`, {
      issue_id: id,
      title: "a much better name",
    });
    const view = await get<{ nodes: { id: string; title: string }[] }>(
      `${broker.url}/api/board/${posted.json.location!.board_id}`,
    );
    const node = view.json.nodes.find((n) => n.id === id)!;
    expect(node.title).toBe("a much better name");
  });
});
