import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Talking ON an issue: each issue gets a conversation of its own, on an ORDINARY
// board created the first time somebody writes (2026-07-29 redesign — dt board
// bd_vlap7p27, five rounds with the user).
//
// The rules worth protecting:
//   - NOTHING exists until somebody writes. An issue nobody has discussed must
//     not leave an empty board and node behind.
//   - The conversation lives on an ordinary tree board (one concern / one node
//     to start), found THROUGH the issue's own pointer (chat_board_id /
//     chat_node_id) — never by searching boards for the issue id, so two boards
//     carrying the same id can never be confused.
//   - That board is listed / searched / logged like any other. It used to be
//     hidden; hiding it meant a reply raised no unread dot, the exact failure the
//     surface exists to prevent.
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
    created?: boolean;
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
    const boards = await post<{ boards: { id: string; title: string }[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionId, scope: "all" },
    );
    // A created board would carry the issue's own title; none was created.
    expect(boards.json.boards.map((b) => b.title)).not.toContain(
      "nobody has said anything",
    );
  });

  test("the first message creates the board and a node", async () => {
    const id = await mkIssue("worth discussing");
    const posted = await ccPost(id, "here is what I found");
    expect(posted.json.ok).toBe(true);
    expect(posted.json.location?.board_id).toBeTruthy();
    expect(posted.json.location?.node_id).toBeTruthy();
    // The node id is an ordinary generated id, NOT the issue id — the issue
    // holds a pointer TO it; we never search boards by issue id.
    expect(posted.json.location?.node_id).not.toBe(id);

    const after = await chat(id);
    expect(after.json.location?.board_id).toBe(posted.json.location!.board_id);
    expect(after.json.items.map((m) => m.text)).toContain("here is what I found");
  });

  test("the first post reports it created the board; a later one does not", async () => {
    // The MCP tool turns created=true into "there was no board, I made one — post
    // here from now on", the one moment the workflow needs explaining.
    const id = await mkIssue("first post announces creation");
    const first = await ccPost(id, "opening the conversation");
    expect(first.json.created).toBe(true);
    const second = await ccPost(id, "following up");
    expect(second.json.created).toBe(false);
  });

  test("a second issue gets its own board", async () => {
    const a = await mkIssue("first topic");
    const b = await mkIssue("second topic");
    const pa = await ccPost(a, "about A");
    const pb = await ccPost(b, "about B");
    // Each issue gets a dedicated board now — no shared container.
    expect(pb.json.location?.board_id).not.toBe(pa.json.location!.board_id);

    // Each thread holds only its own conversation. (status_change rows ride the
    // same table and are filtered out by the view.)
    const ca = await chat(a);
    expect(
      ca.json.items.filter((m) => m.source !== "system").map((m) => m.text),
    ).toEqual(["about A"]);
  });
});

describe("issue chat — an ordinary board on the issue's session", () => {
  test("another session's issue gets its own board", async () => {
    const mine = await mkIssue("mine");
    const theirs = await mkIssue("theirs", otherSessionId);
    const pm = await ccPost(mine, "mine");
    const pt = await ccPost(theirs, "theirs");
    expect(pt.json.location?.board_id).not.toBe(pm.json.location!.board_id);
  });

  test("the conversation board is listed and logged like any other", async () => {
    const id = await mkIssue("an ordinary board");
    const posted = await ccPost(id, "somewhere");
    const boardId = posted.json.location!.board_id;

    // Listed, not hidden (the 2026-07-29 redesign: a reply here has to raise an
    // unread dot, which a hidden board could not).
    const boards = await post<{ boards: { id: string; title: string }[] }>(
      `${broker.url}/list-boards`,
      { session_id: sessionId, scope: "all" },
    );
    const listed = boards.json.boards.find((b) => b.id === boardId);
    expect(listed).toBeTruthy();
    // Carries the issue's own title, not a shared container name.
    expect(listed!.title).toBe("an ordinary board");

    // Ordinary in every other way — a board-log concern grows on it on first
    // view, exactly as it would on any board.
    const view = await get<{ nodes: { is_log?: number }[] }>(
      `${broker.url}/api/board/${boardId}`,
    );
    expect(view.json.nodes.some((n) => n.is_log)).toBe(true);
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
    // row. Read straight off the issue's chat_board_id / chat_node_id pointer.
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

    // Where the issue's thread now lives...
    const loc = (await chat(id)).json.location!;
    expect(loc).toBeTruthy();
    // ...is where the message was delivered, on this session.
    const mine = drained.json.messages.filter(
      (m) => m.board_id === loc.board_id && m.node_id === loc.node_id,
    );
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
    const loc = posted.json.location!;
    await post(`${broker.url}/delete-node`, {
      board_id: loc.board_id,
      node_id: loc.node_id,
    });
    // Deletion is logical, and the issue still points at that (now-deleted)
    // node. Re-posting un-deletes it rather than orphaning the earlier
    // conversation under a node nobody can reach.
    const again = await ccPost(id, "after the delete");
    expect(again.json.ok).toBe(true);
    expect(again.json.location!.node_id).toBe(loc.node_id);
    const items = (await chat(id)).json.items.map((m) => m.text);
    expect(items).toContain("before the delete");
    expect(items).toContain("after the delete");
  });

  test("renaming the issue renames its thread and its board", async () => {
    const id = await mkIssue("original name");
    const posted = await ccPost(id, "started");
    const loc = posted.json.location!;
    await post(`${broker.url}/update-issue`, {
      issue_id: id,
      title: "a much better name",
    });
    const view = await get<{
      board: { title: string };
      nodes: { id: string; title: string }[];
    }>(`${broker.url}/api/board/${loc.board_id}`);
    const node = view.json.nodes.find((n) => n.id === loc.node_id)!;
    expect(node.title).toBe("a much better name");
    // The board is dedicated to this one issue, so its sidebar title tracks too.
    expect(view.json.board.title).toBe("a much better name");
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

// Re-filing an issue under another session. The issue points at ONE board (its
// chat_board_id); re-filing does NOT move that pointer, so the conversation
// stays on the board it started on rather than being rebuilt somewhere new.
//
// (Delivery still follows that board's owner — so a re-filed issue's next
// message reaches the original session, the known open edge flagged on the
// re-agree board 2026-07-29. Left unresolved here on purpose; the point of this
// test is that nothing MOVES.)
describe("issues — re-filing keeps the one conversation, without moving it", () => {
  test("the same board is reused, and the whole thread stays readable", async () => {
    const id = await mkIssue("starts here");
    const first = await ccPost(id, "said before the re-file");
    const before = first.json.location!.board_id;

    await post(`${broker.url}/update-issue`, {
      issue_id: id,
      session_id: otherSessionId,
    });
    const after = await ccPost(id, "said after the re-file");
    // Same board — the pointer did not move.
    expect(after.json.location!.board_id).toBe(before);

    // One continuous conversation, read in one place via the links.
    const tl = await post<{ messages: { text: string }[] }>(
      `${broker.url}/issue-timeline`,
      { issue_id: id },
    );
    const texts = tl.json.messages.map((m) => m.text);
    expect(texts).toContain("said before the re-file");
    expect(texts).toContain("said after the re-file");
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
