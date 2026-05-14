import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { isBoardVisible } from "../../web/utils/boardFilter.ts";
import type { BoardStatusFilter } from "../../web/utils/settings.ts";

const ALL_ON: BoardStatusFilter = {
  discussing: true,
  settled: true,
  completed: true,
  withdrawn: true,
  paused: true,
};
const allExcept = (
  ...off: (keyof BoardStatusFilter)[]
): BoardStatusFilter => {
  const f = { ...ALL_ON };
  for (const k of off) f[k] = false;
  return f;
};

const board = (
  id: string,
  status: string,
  is_default = 0,
): Parameters<typeof isBoardVisible>[0] => ({
  id,
  status: status as any,
  is_default,
});

describe("isBoardVisible", () => {
  test("a board whose status is enabled in the filter is visible", () => {
    expect(isBoardVisible(board("b1", "discussing"), ALL_ON, null)).toBe(true);
  });

  test("a board whose status is filtered out is hidden", () => {
    expect(
      isBoardVisible(board("b1", "completed"), allExcept("completed"), null),
    ).toBe(false);
  });

  test("the default conversation board always shows, even when filtered", () => {
    // Default boards are 'discussing' but the point is they bypass the
    // filter entirely — turn every status off and it still shows.
    const allOff = allExcept(
      "discussing",
      "settled",
      "completed",
      "withdrawn",
      "paused",
    );
    expect(isBoardVisible(board("def", "discussing", 1), allOff, null)).toBe(
      true,
    );
  });

  test("the currently-open board shows even if its status is filtered out", () => {
    // The whole point of the feature: open a 'completed' board by direct
    // URL while the 'completed' filter is off — it must still appear.
    expect(
      isBoardVisible(
        board("open-one", "completed"),
        allExcept("completed"),
        "open-one",
      ),
    ).toBe(true);
  });

  test("a filtered-out board that is NOT the current one stays hidden", () => {
    expect(
      isBoardVisible(
        board("other", "completed"),
        allExcept("completed"),
        "open-one",
      ),
    ).toBe(false);
  });

  test("legacy 'active' status is normalized to 'discussing' for the check", () => {
    // 'active' has no key in the filter; normalizeBoardStatus maps it to
    // 'discussing'. So toggling 'discussing' off must hide an 'active' board.
    expect(
      isBoardVisible(board("legacy", "active"), allExcept("discussing"), null),
    ).toBe(false);
    expect(isBoardVisible(board("legacy", "active"), ALL_ON, null)).toBe(true);
  });

  test("null currentBoardId doesn't accidentally match a board", () => {
    expect(
      isBoardVisible(board("b1", "completed"), allExcept("completed"), null),
    ).toBe(false);
  });
});
