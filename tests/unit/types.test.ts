import { describe, test, expect } from "bun:test";
import {
  AUTO_BOARD_STATUSES,
  IN_PROGRESS_NODE_STATUSES,
  SETTLED_NODE_STATUSES,
  isAutoBoardStatus,
  isSettledNodeStatus,
} from "../../shared/types.ts";

describe("isSettledNodeStatus", () => {
  test("returns true for every member of SETTLED_NODE_STATUSES", () => {
    for (const s of SETTLED_NODE_STATUSES) {
      expect(isSettledNodeStatus(s)).toBe(true);
    }
  });

  test("returns false for every member of IN_PROGRESS_NODE_STATUSES", () => {
    for (const s of IN_PROGRESS_NODE_STATUSES) {
      expect(isSettledNodeStatus(s)).toBe(false);
    }
  });

  test("returns false for unknown strings", () => {
    expect(isSettledNodeStatus("bogus")).toBe(false);
    expect(isSettledNodeStatus("")).toBe(false);
  });

  test("the two status groups are disjoint", () => {
    const a = new Set(SETTLED_NODE_STATUSES);
    for (const s of IN_PROGRESS_NODE_STATUSES) {
      expect(a.has(s)).toBe(false);
    }
  });

  test("groups together cover the canonical NodeStatus values", () => {
    const all = new Set([
      ...SETTLED_NODE_STATUSES,
      ...IN_PROGRESS_NODE_STATUSES,
    ]);
    const canonical = [
      "pending",
      "discussing",
      "resolved",
      "agreed",
      "adopted",
      "rejected",
      "needs-reply",
      "done",
    ];
    for (const c of canonical) expect(all.has(c as any)).toBe(true);
  });
});

describe("isAutoBoardStatus", () => {
  test("returns true for 'discussing' and 'settled'", () => {
    expect(isAutoBoardStatus("discussing")).toBe(true);
    expect(isAutoBoardStatus("settled")).toBe(true);
  });

  test("returns false for user-driven statuses", () => {
    expect(isAutoBoardStatus("completed")).toBe(false);
    expect(isAutoBoardStatus("withdrawn")).toBe(false);
    expect(isAutoBoardStatus("paused")).toBe(false);
  });

  test("returns false for arbitrary strings", () => {
    expect(isAutoBoardStatus("anything")).toBe(false);
    expect(isAutoBoardStatus("")).toBe(false);
  });

  test("AUTO_BOARD_STATUSES has exactly two entries", () => {
    expect(AUTO_BOARD_STATUSES.length).toBe(2);
  });
});
