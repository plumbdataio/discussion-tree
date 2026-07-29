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
let boardId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "Threads extras",
      concerns: [
        {
          id: "tc1",
          title: "C1",
          items: [{ id: "ti1", title: "Item 1" }],
        },
      ],
    },
  });
  boardId = r.json.board_id;
});
afterAll(async () => {
  await broker.kill();
});

async function fetchView() {
  const r = await get<any>(`${broker.url}/api/board/${boardId}`);
  return r.json;
}

describe("post-to-node — status changes and timeline shape", () => {
  test("post-to-node persists a cc thread item before the status_change row", async () => {
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "ti1",
      message: "hello",
      status: "discussing",
    });
    const v = await fetchView();
    const items = v.threads.ti1 ?? [];
    const ccIdx = items.findIndex((t: any) => t.source === "cc");
    const sysIdx = items.findIndex(
      (t: any) =>
        t.source === "system" && String(t.text).startsWith("status_change:"),
    );
    expect(ccIdx).toBeGreaterThanOrEqual(0);
    expect(sysIdx).toBeGreaterThan(ccIdx);
  });

  test("status_change text uses 'old:new' format", async () => {
    // Re-status to a new value — the diff text should include the previous
    // status and the next one separated by colons.
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "ti1",
      message: "promote",
      status: "needs-reply",
    });
    const v = await fetchView();
    const items = v.threads.ti1 ?? [];
    const sys = items
      .filter((t: any) => t.source === "system")
      .map((t: any) => t.text)
      .filter((t: string) => t.startsWith("status_change:"));
    // At least one row of the form status_change:<old>:<new>
    const m = sys[sys.length - 1].match(/^status_change:([^:]+):([^:]+)$/);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("needs-reply");
  });

  test("post-to-node with no-change status emits a thread item but no status_change row", async () => {
    // First post moves to "discussing".
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "ti1",
      message: "first",
      status: "discussing",
    });
    const before = await fetchView();
    const sysBefore = (before.threads.ti1 ?? []).filter(
      (t: any) => t.source === "system",
    ).length;

    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "ti1",
      message: "same",
      status: "discussing",
    });
    const after = await fetchView();
    const sysAfter = (after.threads.ti1 ?? []).filter(
      (t: any) => t.source === "system",
    ).length;
    expect(sysAfter).toBe(sysBefore);
  });

  test("post-to-node without status falls back to bumping to discussing", async () => {
    // Reset by setting node status to pending first via set-node-status.
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "ti1",
      status: "pending",
    });
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "ti1",
      message: "no status sent",
    });
    const v = await fetchView();
    const n = v.nodes.find((x: any) => x.id === "ti1");
    // bumpStatusToDiscussing only flips if it's pending; we just set it
    // pending, so it should now be discussing.
    expect(n.status).toBe("discussing");
  });
});

describe("submit-answer error paths", () => {
  test("returns no_recipient when the board does not exist", async () => {
    const r = await post(`${broker.url}/submit-answer`, {
      board_id: "bd_doesnotexist",
      node_id: "x",
      text: "hello",
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe("no_recipient");
  });
});

describe("submit-answer pulls a node back into 'discussing'", () => {
  // Fire /submit-answer without awaiting (it blocks until delivered), let
  // the broker insert the pending row, then deliver via /poll-messages.
  async function userReply(nodeId: string, text: string) {
    const p = fetch(`${broker.url}/submit-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: boardId, node_id: nodeId, text }),
    });
    await new Promise((r) => setTimeout(r, 120));
    await post(`${broker.url}/poll-messages`, { session_id: sessionId });
    await p;
  }
  const statusOf = async (nodeId: string) => {
    const v = await fetchView();
    return v.nodes.find((n: any) => n.id === nodeId)?.status;
  };

  test("a user reply clears 'needs-reply' back to 'discussing'", async () => {
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "ti1",
      status: "needs-reply",
    });
    expect(await statusOf("ti1")).toBe("needs-reply");
    await userReply("ti1", "here is my reply");
    expect(await statusOf("ti1")).toBe("discussing");
  });

  test("the auto-transition is logged as a system thread item", async () => {
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "ti1",
      status: "needs-reply",
    });
    await userReply("ti1", "second reply");
    const v = await fetchView();
    const sys = (v.threads.ti1 ?? []).filter(
      (t: any) => t.source === "system",
    );
    expect(
      sys.some((t: any) => t.text === "status_change:needs-reply:discussing"),
    ).toBe(true);
  });

  test("a settled status (adopted) is NOT disturbed by a user reply", async () => {
    await post(`${broker.url}/set-node-status`, {
      board_id: boardId,
      node_id: "ti1",
      status: "adopted",
    });
    await userReply("ti1", "reply on a decided node");
    // Deliberate verdicts stay put — only pending / needs-reply are bumped.
    expect(await statusOf("ti1")).toBe("adopted");
  });
});

describe("mark-thread-items-read / mark-board-read", () => {
  test("mark-thread-items-read with empty array is a no-op", async () => {
    const r = await post<{ ok: boolean; marked?: number }>(
      `${broker.url}/mark-thread-items-read`,
      { thread_item_ids: [] },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.marked).toBe(0);
  });

  test("mark-thread-items-read with missing array is a no-op", async () => {
    const r = await post<{ ok: boolean; marked?: number }>(
      `${broker.url}/mark-thread-items-read`,
      {},
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.marked).toBe(0);
  });

  test("mark-board-read with no board_id returns ok=false", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/mark-board-read`, {});
    expect(r.json.ok).toBe(false);
  });

  test("mark-board-read flips read_at on every cc-authored thread item", async () => {
    // Seed: one CC message on a node.
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      board_id: boardId,
      node_id: "ti1",
      message: "to be read",
      status: "needs-reply",
    });
    // Before: there must be at least one unread cc item.
    const before = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const meBefore = before.json.sessions.find((s) => s.id === sessionId)!;
    const b = meBefore.boards.find((x: any) => x.id === boardId);
    expect((b?.unread_count ?? 0)).toBeGreaterThanOrEqual(1);

    await post(`${broker.url}/mark-board-read`, { board_id: boardId });

    const after = await get<{ sessions: any[] }>(`${broker.url}/api/sessions`);
    const meAfter = after.json.sessions.find((s) => s.id === sessionId)!;
    const b2 = meAfter.boards.find((x: any) => x.id === boardId);
    expect(b2?.unread_count ?? 0).toBe(0);
  });
});

describe("poll-messages basics", () => {
  test("poll-messages returns an empty list when nothing pending", async () => {
    const r = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    expect(Array.isArray(r.json.messages)).toBe(true);
    // Pending messages are marked delivered on first poll, so a second poll
    // is always empty.
    const r2 = await post<{ messages: any[] }>(`${broker.url}/poll-messages`, {
      session_id: sessionId,
    });
    expect(r2.json.messages.length).toBe(0);
  });
});

// The gap a message arrives after. CC has no clock and does not compare
// timestamps on its own, so a reply landing after a long silence is answered
// with stale context unless the silence is stated. The broker computes the
// "when did this node last speak" half; server/message-gap.ts decides whether
// it is worth reporting (see tests/unit/message-gap.test.ts).
describe("pending messages carry when the node last spoke", () => {
  test("prev_message_at is the previous exchange ON THIS NODE, not board-wide", async () => {
    const b = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "gap",
        concerns: [
          {
            id: "c1",
            title: "C1",
            items: [
              { id: "i1", title: "Item 1" },
              { id: "i2", title: "Item 2" },
            ],
          },
        ],
      },
    });
    const gapBoard = b.json.board_id;
    const view = await get<{ nodes: { id: string; title: string }[] }>(
      `${broker.url}/api/board/${gapBoard}`,
    );
    const n1 = view.json.nodes.find((n) => n.title === "Item 1")!.id;
    const n2 = view.json.nodes.find((n) => n.title === "Item 2")!.id;

    // An exchange on the OTHER node must not count as this node speaking.
    await post(`${broker.url}/post-to-node`, {
      issue_ids: [],
      session_id: sessionId,
      board_id: gapBoard,
      node_id: n2,
      message: "on the other item",
      status: "discussing",
    });
    const mine = await post<{ message_id: number }>(
      `${broker.url}/post-to-node`,
      {
        issue_ids: [],
        session_id: sessionId,
        board_id: gapBoard,
        node_id: n1,
        message: "on this item",
        status: "discussing",
      },
    );

    const submitP = post(`${broker.url}/submit-answer`, {
      board_id: gapBoard,
      node_id: n1,
      text: "user replies later",
    });
    await new Promise((r) => setTimeout(r, 80));
    const polled = await post<{
      messages: { node_id: string; prev_message_at: string | null }[];
    }>(`${broker.url}/poll-messages`, { session_id: sessionId });
    await submitP;

    const row = polled.json.messages.find((m) => m.node_id === n1);
    expect(row).toBeTruthy();
    // Points at the reply on n1, not at the later one on n2.
    const items = await get<{
      threads: Record<string, { id: number; created_at: string }[]>;
    }>(`${broker.url}/api/board/${gapBoard}`);
    const onN1 = items.json.threads[n1].find((t) => t.id === mine.json.message_id);
    expect(row!.prev_message_at).toBe(onN1!.created_at);
  });

  test("the first message on a node reports no previous one", async () => {
    const b = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionId,
      structure: {
        title: "gap-fresh",
        concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "Item 1" }] }],
      },
    });
    const freshBoard = b.json.board_id;
    const view = await get<{ nodes: { id: string; kind: string }[] }>(
      `${broker.url}/api/board/${freshBoard}`,
    );
    const node = view.json.nodes.find((n) => n.kind === "item")!.id;

    const submitP = post(`${broker.url}/submit-answer`, {
      board_id: freshBoard,
      node_id: node,
      text: "first thing said here",
    });
    await new Promise((r) => setTimeout(r, 80));
    const polled = await post<{
      messages: { node_id: string; prev_message_at: string | null }[];
    }>(`${broker.url}/poll-messages`, { session_id: sessionId });
    await submitP;

    const row = polled.json.messages.find((m) => m.node_id === node);
    expect(row).toBeTruthy();
    // NULL, not a gap measured from the epoch.
    expect(row!.prev_message_at).toBe(null);
  });
});

// The fingerprint of the frontend a broker process serves. It exists so a page
// can tell it is running an older bundle than the broker now has — the check
// that replaced HMR. Restarting the broker without touching web/ must NOT look
// like a new frontend, or every restart would nag about an update that is not
// there.
describe("web build id", () => {
  test("depends on web/ content, not on the process", async () => {
    const { computeWebBuildId } = await import("../../broker/web-build-id.ts");
    const { mkdtempSync, writeFileSync, utimesSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "dt-web-"));
    try {
      writeFileSync(join(dir, "style.css"), "body{}");
      const first = computeWebBuildId(dir);
      // Same bytes, same mtime — a plain restart.
      expect(computeWebBuildId(dir)).toBe(first);

      // An edit changes it.
      writeFileSync(join(dir, "style.css"), "body{color:red}");
      expect(computeWebBuildId(dir)).not.toBe(first);

      // A file that never reaches the bundle does not.
      const before = computeWebBuildId(dir);
      writeFileSync(join(dir, "notes.md"), "scratch");
      expect(computeWebBuildId(dir)).toBe(before);

      // Touching without editing counts: bundlers key off mtime too, and a
      // false positive here costs one reload while a false negative leaves the
      // user staring at a stale build.
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "style.css"), later, later);
      expect(computeWebBuildId(dir)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable directory degrades to a constant rather than throwing", async () => {
    const { computeWebBuildId } = await import("../../broker/web-build-id.ts");
    // Starting the broker must never fail because web/ moved.
    expect(computeWebBuildId("/nonexistent/web/dir")).toBe("unknown");
  });
});
