import { describe, test, expect } from "bun:test";
import { buildTimelineEntries } from "../../web/components/MapTimelineModal.tsx";
import { MAP_GENERAL_NODE } from "../../shared/types.ts";
import type { MapNode, MapNodeKind, ThreadItem } from "../../shared/types.ts";

// buildTimelineEntries flattens every node thread + the general chat into one
// chronological stream for the map's all-comments timeline preview.

const labels = { general: "General", untitled: "(untitled)" };

function node(id: string, kind: MapNodeKind, title: string): MapNode {
  return {
    map_id: "m",
    id,
    title,
    context: "",
    kind,
    x: 0,
    y: 0,
    created_at: "2026-01-01T00:00:00.000Z",
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
    const nodes = [node("na", "question", "Q"), node("nb", "idea", "I")];
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
    const out = buildTimelineEntries(nodes, threads, labels);
    // 09:00 (3, general) -> 09:05 (1) -> 09:10 (2) -> 09:20 (4)
    expect(out.map((e) => e.item.id)).toEqual([3, 1, 2, 4]);
    expect(out[0].isGeneral).toBe(true);
    expect(out[0].nodeTitle).toBe("General");
    expect(out[0].kind).toBeUndefined();
    expect(out[1].kind).toBe("question");
    expect(out[2].nodeTitle).toBe("I");
  });

  test("excludes system rows (status changes etc.)", () => {
    const nodes = [node("na", "note", "N")];
    const threads: Record<string, ThreadItem[]> = {
      na: [
        item(1, "na", "cc", "2026-06-11T09:00:00.000Z"),
        item(2, "na", "system", "2026-06-11T09:01:00.000Z"),
      ],
    };
    expect(
      buildTimelineEntries(nodes, threads, labels).map((e) => e.item.id),
    ).toEqual([1]);
  });

  test("skips a thread whose (non-general) node was deleted", () => {
    const nodes = [node("na", "note", "N")];
    const threads: Record<string, ThreadItem[]> = {
      na: [item(1, "na", "cc", "2026-06-11T09:00:00.000Z")],
      gone: [item(2, "gone", "cc", "2026-06-11T09:01:00.000Z")],
    };
    expect(
      buildTimelineEntries(nodes, threads, labels).map((e) => e.item.id),
    ).toEqual([1]);
  });

  test("ties on created_at are broken by item id", () => {
    const nodes = [node("na", "note", "N")];
    const ts = "2026-06-11T09:00:00.000Z";
    const threads: Record<string, ThreadItem[]> = {
      na: [item(5, "na", "cc", ts), item(2, "na", "cc", ts)],
    };
    expect(
      buildTimelineEntries(nodes, threads, labels).map((e) => e.item.id),
    ).toEqual([2, 5]);
  });

  test("falls back to the untitled label for an empty node title", () => {
    const nodes = [node("na", "idea", "")];
    const threads: Record<string, ThreadItem[]> = {
      na: [item(1, "na", "cc", "2026-06-11T09:00:00.000Z")],
    };
    expect(buildTimelineEntries(nodes, threads, labels)[0].nodeTitle).toBe(
      "(untitled)",
    );
  });
});
