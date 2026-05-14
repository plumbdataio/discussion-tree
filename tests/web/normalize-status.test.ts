import { describe, test, expect } from "bun:test";
import {
  BOARD_STATUSES,
  normalizeBoardStatus,
} from "../../web/utils/constants.ts";

describe("normalizeBoardStatus", () => {
  test("passes canonical board statuses through unchanged", () => {
    for (const s of BOARD_STATUSES) {
      expect(normalizeBoardStatus(s)).toBe(s);
    }
  });

  test("maps the legacy 'active' value to 'discussing'", () => {
    expect(normalizeBoardStatus("active")).toBe("discussing");
  });

  test("treats null / undefined as 'discussing'", () => {
    expect(normalizeBoardStatus(null)).toBe("discussing");
    expect(normalizeBoardStatus(undefined)).toBe("discussing");
  });

  test("unknown / garbage values fall through to 'discussing'", () => {
    expect(normalizeBoardStatus("")).toBe("discussing");
    expect(normalizeBoardStatus("bogus")).toBe("discussing");
    expect(normalizeBoardStatus("ACTIVE")).toBe("discussing"); // case-sensitive enum, ACTIVE !== active
    expect(normalizeBoardStatus("DISCUSSING")).toBe("discussing");
  });
});
