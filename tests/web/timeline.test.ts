import { describe, test, expect } from "bun:test";
import { buildTimelineEntries } from "../../web/utils/timeline.ts";
import type { TimelineNodeResolver } from "../../web/utils/timeline.ts";
import { MAP_GENERAL_NODE } from "../../shared/types.ts";
import type { ThreadItem } from "../../shared/types.ts";

// buildTimelineEntries flattens every node thread into one chronological stream
// for the shared all-comments timeline preview (map + board). The surface owns
// the node lookup via a resolver; these tests exercise the flatten/sort/filter.

// A map-flavoured resolver: general chat + a small node table.
function makeResolve(
  nodes: Record<string, { kind: string; title: string }>,
): TimelineNodeResolver {
  return (nodeId) => {
    if (nodeId === MAP_GENERAL_NODE)
      return { title: "General", isGeneral: true };
    const n = nodes[nodeId];
    return n ? { title: n.title || "(untitled)", kind: n.kind } : null;
  };
}

function item(
  id: number,
  node_id: string,
  source: ThreadItem["source"],
  created_at: string,
): ThreadItem {
  return { id, board_id: "m", node_id, source, text: `t${id}`, created_at };
}

describe("buildTimelineEntries", () => {
  test("merges node threads + general chat in chronological order", () => {
    const resolve = makeResolve({
      na: { kind: "question", title: "Q" },
      nb: { kind: "idea", title: "I" },
    });
    const threads: Record<string, ThreadItem[]> = {
      na: [
        item(1, "na", "cc", "2026-06-11T09:05:00.000Z"),
        item(4, "na", "user", "2026-06-11T09:20:00.000Z"),
      ],
      nb: [item(2, "nb", "user", "2026-06-11T09:10:00.000Z")],
      [MAP_GENERAL_NODE]: [
        item(3, MAP_GENERAL_NODE, "user", "2026-06-11T09:00:00.000Z"),
      ],
    };
    const out = buildTimelineEntries(threads, resolve);
    // 09:00 (3, general) -> 09:05 (1) -> 09:10 (2) -> 09:20 (4)
    expect(out.map((e) => e.item.id)).toEqual([3, 1, 2, 4]);
    expect(out[0].isGeneral).toBe(true);
    expect(out[0].nodeTitle).toBe("General");
    expect(out[0].kind).toBeUndefined();
    expect(out[1].kind).toBe("question");
    expect(out[2].nodeTitle).toBe("I");
  });

  test("excludes system rows (status changes etc.)", () => {
    const resolve = makeResolve({ na: { kind: "note", title: "N" } });
    const threads: Record<string, ThreadItem[]> = {
      na: [
        item(1, "na", "cc", "2026-06-11T09:00:00.000Z"),
        item(2, "na", "system", "2026-06-11T09:01:00.000Z"),
      ],
    };
    expect(
      buildTimelineEntries(threads, resolve).map((e) => e.item.id),
    ).toEqual([1]);
  });

  test("skips a thread the resolver rejects (deleted node)", () => {
    const resolve = makeResolve({ na: { kind: "note", title: "N" } });
    const threads: Record<string, ThreadItem[]> = {
      na: [item(1, "na", "cc", "2026-06-11T09:00:00.000Z")],
      gone: [item(2, "gone", "cc", "2026-06-11T09:01:00.000Z")],
    };
    expect(
      buildTimelineEntries(threads, resolve).map((e) => e.item.id),
    ).toEqual([1]);
  });

  test("ties on created_at are broken by item id", () => {
    const resolve = makeResolve({ na: { kind: "note", title: "N" } });
    const ts = "2026-06-11T09:00:00.000Z";
    const threads: Record<string, ThreadItem[]> = {
      na: [item(5, "na", "cc", ts), item(2, "na", "cc", ts)],
    };
    expect(
      buildTimelineEntries(threads, resolve).map((e) => e.item.id),
    ).toEqual([2, 5]);
  });

  test("uses the resolver's title (incl. its untitled fallback)", () => {
    const resolve = makeResolve({ na: { kind: "idea", title: "" } });
    const threads: Record<string, ThreadItem[]> = {
      na: [item(1, "na", "cc", "2026-06-11T09:00:00.000Z")],
    };
    expect(buildTimelineEntries(threads, resolve)[0].nodeTitle).toBe(
      "(untitled)",
    );
  });
});
