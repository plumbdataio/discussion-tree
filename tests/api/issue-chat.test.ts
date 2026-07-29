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

    // Which session it belongs to is what decides who a reply reaches — see
    // the delivery test below, which is the honest check for that.
  });

  test("the container never shows up as a board", async () => {
    const id = await mkIssue("hidden container");
    const posted = await ccPost(id, "somewhere");
    // Structurally a board, deliberately not presented as one: listing it made
    // CC read one issue's neighbours as context for another, while the user
    // was reading a single serial thread (their objection, 2026-07-29).
    const boards = await post<{ boards: { id: string }[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionId, scope: "all" },
    );
    expect(boards.json.boards.map((b) => b.id)).not.toContain(
      posted.json.location!.board_id,
    );
    // Still reachable by id, or the "go to where this was said" jump would
    // land nowhere.
    const view = await get<{
      board: { title: string };
      nodes: { id: string; is_log?: number }[];
    }>(`${broker.url}/api/board/${posted.json.location!.board_id}`);
    expect(view.json.board.title).toBe("Issue conversations");
    // And no board-log concern grows on it: its shape is owned by the tracker,
    // so there are no structure changes to audit.
    expect(view.json.nodes.some((n) => n.is_log)).toBe(false);
  });

  test("searching does not surface it either", async () => {
    const id = await mkIssue("searchable");
    await ccPost(id, "a distinctive phrase nobody else wrote: xyzzy42");
    // Hiding it from list_boards but not from search let CC find the container
    // by text, along with the neighbouring issues' nodes — the same "one issue
    // reads as a tree of unrelated siblings" failure, through another door.
    const r = await post<{ matches: { board_id: string }[] }>(
      `${broker.url}/search-boards`,
      { session_id: sessionId, scope: "all", q: "xyzzy42" },
    );
    expect(r.json.matches ?? []).toEqual([]);
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

  test("the tracker counts the conversation, and what is unread in it", async () => {
    const id = await mkIssue("counted");
    await ccPost(id, "one");
    await ccPost(id, "two");
    const row = async () =>
      (
        await post<{
          issues: { id: string; link_count: number; chat_unread: number }[];
        }>(`${broker.url}/list-issues`, { include_closed: true })
      ).json.issues.find((i) => i.id === id)!;

    // link_count is what the row shows: everything said about this issue,
    // anywhere. There is deliberately no second "…of which this many were said
    // here" number — that distinction is no use to the reader.
    expect((await row()).link_count).toBe(2);
    // Unread is separate, and is what makes a reply visible without opening the
    // row.
    expect((await row()).chat_unread).toBe(2);
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

// The tracker gained a third axis on 2026-07-29: `priority` (how much it
// matters) alongside `state` (what it is waiting for). The user had tried
// low/mid/high in other trackers and it never stuck; the diagnosis was that one
// column was carrying both questions, so a thing that mattered but was stuck
// had no honest value. These pin that they stay separate — and that the waiting
// states never say WHO, which is `owner`'s job (the tracker deliberately has no
// `blocked`).
describe("issues — priority and the waiting states", () => {
  test("priority defaults to mid and is independent of state", async () => {
    const r = await post<{ issue: { id: string; priority: string; state: string } }>(
      `${broker.url}/create-issue`,
      { title: "unrated", session_id: sessionId },
    );
    expect(r.json.issue.priority).toBe("mid");

    const up = await post<{ issue: { priority: string; state: string } }>(
      `${broker.url}/update-issue`,
      { issue_id: r.json.issue.id, priority: "high", state: "waiting_decision" },
    );
    // High priority AND stuck on a decision is the combination low/mid/high
    // alone could not express.
    expect(up.json.issue.priority).toBe("high");
    expect(up.json.issue.state).toBe("waiting_decision");
  });

  test("a bad priority is refused, not silently defaulted", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/create-issue`,
      { title: "typo", priority: "urgent", session_id: sessionId },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/priority/i);
  });

  test("waiting is not closed — it stays in the default list", async () => {
    const id = await mkIssue("waiting on an answer");
    await post(`${broker.url}/update-issue`, {
      issue_id: id,
      state: "waiting_reply",
      owner: "external",
    });
    const open = await post<{ issues: { id: string }[] }>(
      `${broker.url}/list-issues`,
      {},
    );
    expect(open.json.issues.map((i) => i.id)).toContain(id);
  });
});

// Reading an issue's conversation and adding to it are one view, so one call
// has to answer both — where the messages are AND where a new one would go.
describe("issue timeline — also says where to write", () => {
  test("carries the composer's target and recipient", async () => {
    const id = await mkIssue("timeline carries the target");
    const posted = await ccPost(id, "said on the issue thread");
    const tl = await post<{
      ok: boolean;
      location: { board_id: string; node_id: string } | null;
      session: { id: string } | null;
      messages: { id: number; on_issue_thread?: boolean; read_at?: string | null }[];
    }>(`${broker.url}/issue-timeline`, { issue_id: id });

    expect(tl.json.location?.board_id).toBe(posted.json.location!.board_id);
    expect(tl.json.session?.id).toBe(sessionId);
    // Messages said HERE are distinguishable from ones gathered elsewhere —
    // marking the latter read would clear dots the user never saw in place.
    const mine = tl.json.messages.find((m) => m.id === posted.json.message_id);
    expect(mine?.on_issue_thread).toBe(true);
  });

  test("an issue with no conversation says so without creating one", async () => {
    const id = await mkIssue("never discussed");
    const tl = await post<{ ok: boolean; location: unknown; messages: unknown[] }>(
      `${broker.url}/issue-timeline`,
      { issue_id: id },
    );
    expect(tl.json.location).toBeNull();
    expect(tl.json.messages).toEqual([]);
  });
});

// Both found by codex reviewing this day's commits, after my own pass over the
// same diff missed them.
describe("issues — a thread follows its issue to another session", () => {
  test("re-filing an issue moves its conversation, history and all", async () => {
    const id = await mkIssue("starts here");
    const first = await ccPost(id, "said before the move");
    const before = first.json.location!.board_id;

    await post(`${broker.url}/update-issue`, {
      issue_id: id,
      session_id: otherSessionId,
    });
    const after = await ccPost(id, "said after the move");

    // Delivery follows the BOARD's owner, so a thread left behind would send
    // the user's next message to the CC that no longer holds this issue —
    // while the composer, reading the issue's session, says otherwise.
    expect(after.json.location!.board_id).not.toBe(before);
    // And the history came with it — the conversation belongs to the issue, so
    // it goes where the issue goes. Leaving it behind would make the earlier
    // half reachable only through the timeline.
    const items = (await chat(id)).json.items.map((m) => m.text);
    expect(items).toContain("said before the move");
    expect(items).toContain("said after the move");
  });
});

describe("issues — priority actually filters", () => {
  test("asking for one priority does not return the others", async () => {
    const hot = await mkIssue("burning");
    await post(`${broker.url}/update-issue`, { issue_id: hot, priority: "high" });
    const cold = await mkIssue("someday");
    await post(`${broker.url}/update-issue`, { issue_id: cold, priority: "low" });

    const high = await post<{ issues: { id: string }[] }>(
      `${broker.url}/list-issues`,
      { priority: "high" },
    );
    const ids = high.json.issues.map((i) => i.id);
    expect(ids).toContain(hot);
    expect(ids).not.toContain(cold);
    // Issues filed before priority existed default to mid, and must not vanish
    // from an unfiltered read.
    const all = await post<{ issues: { id: string }[] }>(
      `${broker.url}/list-issues`,
      {},
    );
    expect(all.json.issues.map((i) => i.id)).toContain(cold);
  });
});
