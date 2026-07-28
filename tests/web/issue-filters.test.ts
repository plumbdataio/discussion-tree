import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import {
  DEFAULT_FILTERS,
  sanitizeFilters,
  type IssueFilters,
} from "../../web/utils/issues.ts";
import { sessionLabel } from "../../web/components/IssueTrackerModal.tsx";

// The filter blob is stored as JSON in the broker and read back into a view
// that has no other source of truth, so anything unexpected in it has to land
// on a sane filter rather than an empty screen with no explanation.

describe("issue filters — reading back what was stored", () => {
  test("an axis whose values are all invalid widens rather than blanking", () => {
    // An empty owners array would render nothing with no hint why, so an axis
    // left with no valid values means "no filter on this axis".
    expect(sanitizeFilters({ owners: ["nobody"] }).owners).toEqual([
      "user",
      "cc",
      "external",
    ]);
  });

  test("an axis that is not even a list falls back to the default view", () => {
    // Different case from the one above: the blob is malformed rather than
    // deselected, so the right answer is the opening view, not everything.
    expect(sanitizeFilters({ states: 42 }).states).toEqual(DEFAULT_FILTERS.states);
  });

  test("sessions are multi-select, and empty legitimately means every session", () => {
    expect(sanitizeFilters({}).sessionIds).toEqual([]);
    expect(DEFAULT_FILTERS.sessionIds).toEqual([]);
    const f = sanitizeFilters({ sessionIds: ["s_a", 7, "s_b", null] });
    expect(f.sessionIds).toEqual(["s_a", "s_b"]);
  });

  test("a blob from before sessions were multi-select does not throw", () => {
    // The single-session shape simply has no sessionIds, so it widens to "every
    // session" — one filter is lost once, which beats carrying a translation
    // layer for a value that was null on every machine anyway.
    const f = sanitizeFilters({
      owners: ["user"],
      states: ["todo"],
      sessionId: "s_old",
      q: "",
      showDeleted: false,
    } as unknown as IssueFilters);
    expect(f.sessionIds).toEqual([]);
    expect(f.owners).toEqual(["user"]);
  });
});

describe("issue filters — naming a session", () => {
  test("falls back through name, cwd basename, then id", () => {
    expect(sessionLabel({ id: "s_1", name: "pd: dt", cwd: "/a/b" })).toBe("pd: dt");
    expect(sessionLabel({ id: "s_2", name: null, cwd: "/a/b/parallel-discussion" }))
      .toBe("parallel-discussion");
    // A trailing slash must not produce an empty label.
    expect(sessionLabel({ id: "s_3", name: null, cwd: "/a/b/" })).toBe("b");
    expect(sessionLabel({ id: "s_4", name: null, cwd: null })).toBe("s_4");
  });
});
