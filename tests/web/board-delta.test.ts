import { describe, test, expect } from "bun:test";
import {
  maxThreadItemId,
  mergeBoardDelta,
} from "../../web/utils/boardDelta.ts";
import type {
  BoardThreadDelta,
  BoardView,
  Node,
  ThreadItem,
} from "../../shared/types.ts";

const B = "bd_x";

function node(id: string, status: Node["status"] = "discussing"): Node {
  return {
    board_id: B,
    id,
    parent_id: id === "c1" ? null : "c1",
    kind: id === "c1" ? "concern" : "item",
    title: id,
    context: "",
    status,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
  } as Node;
}

function item(
  id: number,
  node_id: string,
  source: ThreadItem["source"] = "cc",
  read_at: string | null = "2026-01-01T00:00:00Z",
): ThreadItem {
  return {
    id,
    board_id: B,
    node_id,
    source,
    text: `m${id}`,
    created_at: `2026-01-01T00:00:${String(id).padStart(2, "0")}Z`,
    read_at,
    sender_label: null,
  };
}

function view(threads: Record<string, ThreadItem[]>): BoardView {
  return {
    board: { id: B, session_id: "s", title: "T" } as BoardView["board"],
    nodes: [node("c1", "pending"), node("i1"), node("i2")],
    threads,
    image_dims: { "/uploads/bd_x/a.png": { w: 1, h: 2 } },
    owner_alive: true,
    owner_bg_task_count: 0,
  };
}

function delta(p: Partial<BoardThreadDelta>): BoardThreadDelta {
  return {
    board: { id: B, session_id: "s", title: "T" } as BoardView["board"],
    threads: [],
    unread_ids: [],
    node_statuses: { c1: "pending", i1: "discussing", i2: "discussing" },
    image_dims: {},
    owner_alive: true,
    owner_bg_task_count: 0,
    ...p,
  };
}

describe("maxThreadItemId", () => {
  test("largest id across nodes, 0 when empty", () => {
    expect(maxThreadItemId(view({}))).toBe(0);
    expect(
      maxThreadItemId(view({ i1: [item(3, "i1"), item(9, "i1")], i2: [item(5, "i2")] })),
    ).toBe(9);
  });
});

describe("mergeBoardDelta", () => {
  test("appends new items to their node, keeps untouched arrays and items identical", () => {
    const i1 = [item(1, "i1"), item(4, "i1")];
    const i2 = [item(2, "i2")];
    const v = view({ i1, i2 });
    const m = mergeBoardDelta(
      v,
      delta({ threads: [item(5, "i1"), item(6, "i1", "system")] }),
      4,
    )!;
    expect(m.threads.i1.map((t) => t.id)).toEqual([1, 4, 5, 6]);
    // Old item objects survive (ThreadMessage memo / chunk memo).
    expect(m.threads.i1[0]).toBe(i1[0]);
    expect(m.threads.i1[1]).toBe(i1[1]);
    // Untouched node keeps its exact array; input is not mutated.
    expect(m.threads.i2).toBe(i2);
    expect(i1.length).toBe(2);
    // Nothing moved status → nodes array reused.
    expect(m.nodes).toBe(v.nodes);
  });

  test("de-dups an item that is already held", () => {
    const v = view({ i1: [item(1, "i1"), item(4, "i1")] });
    const m = mergeBoardDelta(
      v,
      delta({ threads: [item(4, "i1"), item(5, "i1")] }),
      3,
    )!;
    expect(m.threads.i1.map((t) => t.id)).toEqual([1, 4, 5]);
  });

  test("an out-of-order id is inserted sorted", () => {
    const v = view({ i1: [item(1, "i1"), item(8, "i1")] });
    const m = mergeBoardDelta(v, delta({ threads: [item(5, "i1")] }), 4)!;
    expect(m.threads.i1.map((t) => t.id)).toEqual([1, 5, 8]);
  });

  test("first item for a node that had no thread yet", () => {
    const v = view({ i1: [item(1, "i1")] });
    const m = mergeBoardDelta(v, delta({ threads: [item(2, "i2")] }), 1)!;
    expect(m.threads.i2.map((t) => t.id)).toEqual([2]);
    expect(m.threads.i1).toBe(v.threads.i1);
  });

  test("no change at all → same threads object", () => {
    const v = view({ i1: [item(1, "i1")] });
    const m = mergeBoardDelta(v, delta({}), 1)!;
    expect(m.threads).toBe(v.threads);
    expect(m.nodes).toBe(v.nodes);
  });

  test("mark-read: held unread items absent from unread_ids become read", () => {
    const unreadA = item(3, "i1", "cc", null);
    const unreadB = item(5, "i1", "external", null);
    const user = item(4, "i1", "user", null); // not an unread-capable source
    const v = view({ i1: [unreadA, user, unreadB], i2: [item(1, "i2")] });
    const m = mergeBoardDelta(v, delta({ unread_ids: [5] }), 5, "READ")!;
    expect(m.threads.i1[0].read_at).toBe("READ");
    expect(m.threads.i1[0]).not.toBe(unreadA);
    // user rows are never reconciled; still-unread one kept as-is.
    expect(m.threads.i1[1]).toBe(user);
    expect(m.threads.i1[2]).toBe(unreadB);
    expect(m.threads.i2).toBe(v.threads.i2);
    // Input untouched.
    expect(unreadA.read_at).toBeNull();
  });

  test("a held item listed as unread is shown unread", () => {
    const v = view({ i1: [item(3, "i1", "cc", "2026-01-01")] });
    const m = mergeBoardDelta(v, delta({ unread_ids: [3] }), 3)!;
    expect(m.threads.i1[0].read_at).toBeNull();
  });

  test("new unread item arrives unread and stays unread", () => {
    const v = view({ i1: [item(1, "i1")] });
    const m = mergeBoardDelta(
      v,
      delta({ threads: [item(2, "i1", "cc", null)], unread_ids: [2] }),
      1,
    )!;
    expect(m.threads.i1[1].read_at).toBeNull();
  });

  test("items newer than what the server saw are not touched by read reconciliation", () => {
    // view already holds id 9 (a full fetch landed while the delta for
    // after=4 was in flight); the delta's unread set can't speak for it.
    const newer = item(9, "i1", "cc", null);
    const v = view({ i1: [item(4, "i1"), newer] });
    const m = mergeBoardDelta(v, delta({ unread_ids: [] }), 4)!;
    expect(m.threads.i1[1]).toBe(newer);
    expect(m.threads.i1[1].read_at).toBeNull();
  });

  test("node statuses update only the nodes that moved", () => {
    const v = view({});
    const m = mergeBoardDelta(
      v,
      delta({
        node_statuses: { c1: "pending", i1: "needs-reply", i2: "discussing" },
      }),
      0,
    )!;
    expect(m.nodes.find((n) => n.id === "i1")!.status).toBe("needs-reply");
    expect(m.nodes.find((n) => n.id === "i2")).toBe(v.nodes[2]);
  });

  test("header / board fields replace, image dims merge", () => {
    const v = view({});
    const m = mergeBoardDelta(
      v,
      delta({
        board: { id: B, session_id: "s", title: "T", status: "settled" } as any,
        owner_bg_task_count: 3,
        owner_alive: false,
        image_dims: { "/uploads/bd_x/b.png": { w: 3, h: 4 } },
      }),
      0,
    )!;
    expect(m.board.status).toBe("settled");
    expect(m.owner_bg_task_count).toBe(3);
    expect(m.owner_alive).toBe(false);
    expect(Object.keys(m.image_dims!).sort()).toEqual([
      "/uploads/bd_x/a.png",
      "/uploads/bd_x/b.png",
    ]);
    // Delta-only keys don't leak into the view.
    expect((m as any).unread_ids).toBeUndefined();
    expect((m as any).node_statuses).toBeUndefined();
  });

  test("structure change or other board → null (caller does a full fetch)", () => {
    const v = view({ i1: [item(1, "i1")] });
    expect(
      mergeBoardDelta(
        v,
        delta({ node_statuses: { c1: "pending", i1: "discussing", i9: "pending" } }),
        1,
      ),
    ).toBeNull();
    expect(
      mergeBoardDelta(v, delta({ threads: [item(2, "i9")] }), 1),
    ).toBeNull();
    expect(
      mergeBoardDelta(
        v,
        delta({ board: { id: "bd_other" } as any }),
        1,
      ),
    ).toBeNull();
  });
});
