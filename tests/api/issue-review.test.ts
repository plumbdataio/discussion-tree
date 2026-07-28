import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The read side of the link-review ritual. Two things make it work at all:
//
//  - It returns a HEAD of each message, never the text. A session's full history
//    measured 348 KB (~87k tokens) — unusable inside a context that is already
//    nearly full — while one compaction window is ~3k. A 40-character head was
//    measured to identify a message uniquely 100% of the time for CC, 97% for
//    the user.
//  - `to` exists as well as `from`. The ritual is meant to run before a
//    compaction; when it doesn't, the window is only recoverable afterwards by
//    asking for everything up to the compact boundary.

let broker: BrokerHandle;
let db: Database;
let sessionId: string;
let boardId: string;
let nodeId: string;

const review = async (body: Record<string, unknown> = {}) =>
  (
    await post<{
      ok: boolean;
      from: string | null;
      to: string | null;
      total: number;
      messages: {
        id: number;
        source: string;
        at: string;
        head: string;
        path: string;
        issues: string[];
      }[];
    }>(`${broker.url}/review-message-links`, { session_id: sessionId, ...body })
  ).json;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId, `cc-review-${Math.random().toString(36).slice(2, 8)}`);
  const b = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "review",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "Item 1" }] }],
    },
  });
  boardId = b.json.board_id;
  const view = await get<{ nodes: { id: string; kind: string }[] }>(
    `${broker.url}/api/board/${boardId}`,
  );
  nodeId = view.json.nodes.find((n) => n.kind === "item")!.id;
  db = new Database(join(broker.homeDir, "db.sqlite"));
});
afterAll(async () => {
  db?.close();
  await broker.kill();
});

const say = (at: string, source: "user" | "cc", text: string): number => {
  db.run(
    "INSERT INTO thread_items (board_id, node_id, source, text, created_at) VALUES (?, ?, ?, ?, ?)",
    [boardId, nodeId, source, text, at],
  );
  return Number(
    (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
  );
};

describe("review — the window", () => {
  test("from and to both bound it, so a window can be recovered after the fact", async () => {
    say("2026-03-01T00:00:00.000Z", "user", "way before");
    const inside = say("2026-03-05T00:00:00.000Z", "cc", "inside the window");
    say("2026-03-09T00:00:00.000Z", "user", "way after");

    const r = await review({
      from: "2026-03-03T00:00:00.000Z",
      to: "2026-03-07T00:00:00.000Z",
    });
    expect(r.messages.map((m) => m.id)).toEqual([inside]);
  });

  test("with no window given it starts from the last compaction", async () => {
    db.run("UPDATE sessions SET last_compact_at = ? WHERE id = ?", [
      "2026-03-08T00:00:00.000Z",
      sessionId,
    ]);
    const r = await review({});
    expect(r.from).toBe("2026-03-08T00:00:00.000Z");
    // Only the message after that boundary survives the default window.
    expect(r.messages.every((m) => m.at >= "2026-03-08T00:00:00.000Z")).toBe(true);
  });
});

describe("review — what it returns", () => {
  test("a head, not the message, and the path it was said on", async () => {
    const long = "x".repeat(500);
    say("2026-04-01T00:00:00.000Z", "cc", long);
    const r = await review({ from: "2026-04-01T00:00:00.000Z", to: "2026-04-02T00:00:00.000Z", head_chars: 40 });
    const m = r.messages[0];
    expect(m.head.length).toBe(40);
    // Identifying a message is not the same as remembering it; the board/node
    // is the cheapest reminder of what the exchange was about.
    expect(m.path).toBe("review > Item 1");
  });

  test("already-linked messages drop out, since they need no decision", async () => {
    const id = say("2026-05-01T00:00:00.000Z", "cc", "will be linked");
    const win = { from: "2026-05-01T00:00:00.000Z", to: "2026-05-02T00:00:00.000Z" };
    expect((await review(win)).messages.map((m) => m.id)).toEqual([id]);

    const iss = await post<{ issue: { id: string } }>(`${broker.url}/create-issue`, {
      title: "an issue",
      session_id: sessionId,
    });
    await post(`${broker.url}/link-issue-message`, {
      message_id: id,
      issue_ids: [iss.json.issue.id],
    });

    expect((await review(win)).messages).toEqual([]);
    // ...but they are still visible when asked for, with their links attached.
    const all = await review({ ...win, unlinked_only: false });
    expect(all.messages[0].issues).toEqual([iss.json.issue.id]);
  });

  test("system rows are not offered for review", async () => {
    db.run(
      "INSERT INTO thread_items (board_id, node_id, source, text, created_at) VALUES (?, ?, 'system', 'status_change:a:b', ?)",
      [boardId, nodeId, "2026-06-01T00:00:00.000Z"],
    );
    const r = await review({ from: "2026-06-01T00:00:00.000Z", to: "2026-06-02T00:00:00.000Z" });
    expect(r.messages).toEqual([]);
  });
});
