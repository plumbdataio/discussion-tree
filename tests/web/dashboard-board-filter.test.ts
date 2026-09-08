import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import {
  isBoardVisible,
  statusListToFilter,
} from "../../web/utils/boardFilter.ts";

const board = (
  id: string,
  status: string,
  is_default = 0,
): Parameters<typeof isBoardVisible>[0] => ({
  id,
  status: status as any,
  is_default,
});

// The session dashboard holds its status filter as the list of enabled
// statuses (MultiSelectDropdown's shape) and converts it to a BoardStatusFilter
// via statusListToFilter for isBoardVisible. These tests pin the two behaviors
// the screen depends on: the discussing-only default, and empty = show all.
describe("statusListToFilter (session dashboard status filter)", () => {
  test("the default ['discussing'] enables only discussing", () => {
    const f = statusListToFilter(["discussing"]);
    expect(f).toEqual({
      discussing: true,
      settled: false,
      completed: false,
      withdrawn: false,
      paused: false,
    });
  });

  test("default shows discussing boards and hides the rest (currentBoardId=null)", () => {
    const f = statusListToFilter(["discussing"]);
    expect(isBoardVisible(board("b1", "discussing"), f, null)).toBe(true);
    expect(isBoardVisible(board("b2", "settled"), f, null)).toBe(false);
    expect(isBoardVisible(board("b3", "completed"), f, null)).toBe(false);
    expect(isBoardVisible(board("b4", "withdrawn"), f, null)).toBe(false);
    expect(isBoardVisible(board("b5", "paused"), f, null)).toBe(false);
  });

  test("the default conversation board shows even under the discussing-only default", () => {
    // is_default bypasses the filter entirely — same as the sidebar.
    const f = statusListToFilter(["discussing"]);
    expect(isBoardVisible(board("def", "completed", 1), f, null)).toBe(true);
  });

  test("an empty selection means no filter — every status shows", () => {
    const f = statusListToFilter([]);
    for (const status of [
      "discussing",
      "settled",
      "completed",
      "withdrawn",
      "paused",
    ]) {
      expect(isBoardVisible(board("b", status), f, null)).toBe(true);
    }
  });

  test("multiple selected statuses each pass, others are hidden", () => {
    const f = statusListToFilter(["discussing", "settled"]);
    expect(isBoardVisible(board("b1", "discussing"), f, null)).toBe(true);
    expect(isBoardVisible(board("b2", "settled"), f, null)).toBe(true);
    expect(isBoardVisible(board("b3", "completed"), f, null)).toBe(false);
  });
});
