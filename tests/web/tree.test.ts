import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { buildTree } from "../../web/utils/tree.ts";
import type { Node } from "../../shared/types.ts";

function makeNode(partial: Partial<Node> & { id: string }): Node {
  return {
    board_id: "bd_t",
    id: partial.id,
    parent_id: partial.parent_id ?? null,
    kind: partial.kind ?? "concern",
    title: partial.title ?? partial.id,
    context: partial.context ?? "",
    status: partial.status ?? "pending",
    position: partial.position ?? 0,
    created_at: partial.created_at ?? "2024-01-01T00:00:00Z",
  };
}

describe("buildTree", () => {
  test("groups nodes by parent_id (with null root key)", () => {
    const nodes = [
      makeNode({ id: "c1", parent_id: null, position: 0 }),
      makeNode({ id: "c2", parent_id: null, position: 1 }),
      makeNode({ id: "i1", parent_id: "c1", kind: "item", position: 0 }),
    ];
    const t = buildTree(nodes);
    expect(t.get(null)!.map((n) => n.id)).toEqual(["c1", "c2"]);
    expect(t.get("c1")!.map((n) => n.id)).toEqual(["i1"]);
  });

  test("sorts each sibling group by position", () => {
    const nodes = [
      makeNode({ id: "c1", parent_id: null, position: 2 }),
      makeNode({ id: "c2", parent_id: null, position: 0 }),
      makeNode({ id: "c3", parent_id: null, position: 1 }),
    ];
    const t = buildTree(nodes);
    expect(t.get(null)!.map((n) => n.id)).toEqual(["c2", "c3", "c1"]);
  });

  test("returns an empty map when given no nodes", () => {
    const t = buildTree([]);
    expect(t.size).toBe(0);
  });

  test("keeps groups isolated — children sort independently", () => {
    const nodes = [
      makeNode({ id: "c1", parent_id: null, position: 0 }),
      makeNode({ id: "c2", parent_id: null, position: 1 }),
      makeNode({ id: "i_c1_b", parent_id: "c1", position: 1 }),
      makeNode({ id: "i_c1_a", parent_id: "c1", position: 0 }),
      makeNode({ id: "i_c2_z", parent_id: "c2", position: 5 }),
    ];
    const t = buildTree(nodes);
    expect(t.get("c1")!.map((n) => n.id)).toEqual(["i_c1_a", "i_c1_b"]);
    expect(t.get("c2")!.map((n) => n.id)).toEqual(["i_c2_z"]);
  });

  test("ties in position keep original order (stable sort)", () => {
    const nodes = [
      makeNode({ id: "a", position: 0 }),
      makeNode({ id: "b", position: 0 }),
      makeNode({ id: "c", position: 0 }),
    ];
    const t = buildTree(nodes);
    expect(t.get(null)!.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});
