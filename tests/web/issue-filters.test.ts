import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import {
  DEFAULT_FILTERS,
  ISSUE_ID_RE,
  NO_SESSION,
  isAwaitingApproval,
  isVisible,
  ownerMatches,
  sanitizeFilters,
  sessionMatches,
  stateMatches,
  type Issue,
  type IssueFilters,
} from "../../web/utils/issues.ts";
import { sessionLabel } from "../../web/components/IssueTrackerModal.tsx";

// The filter blob is stored as JSON in the broker and read back into a view
// that has no other source of truth, so anything unexpected in it has to land
// on a sane filter rather than an empty screen with no explanation.

describe("issue filters — reading back what was stored", () => {
  test("empty means unfiltered, and is left empty on every axis", () => {
    // The view reads "nothing selected" as "stop narrowing on this axis", so
    // sanitize must not turn it into an explicit full list — the two used to
    // disagree, which is how clearing an axis emptied the whole list while
    // saving and reloading silently repaired it.
    expect(sanitizeFilters({ owners: [], states: [], sessionIds: [] })).toMatchObject({
      owners: [],
      states: [],
      sessionIds: [],
    });
    // Values that are not valid on their axis drop out, which can leave it
    // empty — same meaning, no special case.
    expect(sanitizeFilters({ owners: ["nobody"] }).owners).toEqual([]);
  });

  test("an axis that is not even a list falls back to the default view", () => {
    // Different case from the one above: the blob is malformed rather than
    // deselected, so the right answer is the opening view, not everything.
    expect(sanitizeFilters({ states: 42 }).states).toEqual(DEFAULT_FILTERS.states);
  });

  test("sessions are multi-select and non-strings are dropped", () => {
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

// The rule that broke on 2026-07-29: session read an empty selection as "no
// filter" and the other two axes read it as "owner is in the empty set", so
// clearing an axis emptied the whole list. sanitizeFilters widening empties on
// read had hidden it — saving and reloading silently repaired the state — until
// the dropdown made "clear this axis" an explicit action.
describe("issue filters — empty means unfiltered on every axis", () => {
  const mk = (
    owner: Issue["owner"],
    state: Issue["state"],
    session_id: string | null,
  ): Issue => ({
    id: "iss_x",
    title: "t",
    body: "",
    owner,
    state,
    session_id,
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    closed_at: null,
  });
  const empty: IssueFilters = {
    owners: [],
    states: [],
    sessionIds: [],
    q: "",
    showDeleted: false,
  };

  test("a cleared axis matches everything", () => {
    const i = mk("cc", "done", "s_1");
    expect(ownerMatches(i, empty)).toBe(true);
    expect(stateMatches(i, empty)).toBe(true);
    expect(sessionMatches(i, empty)).toBe(true);
  });

  test("a non-empty axis still narrows", () => {
    const i = mk("cc", "done", "s_1");
    expect(ownerMatches(i, { ...empty, owners: ["user"] })).toBe(false);
    expect(ownerMatches(i, { ...empty, owners: ["user", "cc"] })).toBe(true);
    expect(stateMatches(i, { ...empty, states: ["todo"] })).toBe(false);
    expect(sessionMatches(i, { ...empty, sessionIds: ["s_2"] })).toBe(false);
  });

  test("an issue filed against no session is reachable, not stranded", () => {
    // Without a value standing for "no session" it would drop out the moment
    // any session was picked, with nothing on screen saying why.
    const orphan = mk("cc", "todo", null);
    expect(sessionMatches(orphan, empty)).toBe(true);
    expect(sessionMatches(orphan, { ...empty, sessionIds: ["s_1"] })).toBe(false);
    expect(sessionMatches(orphan, { ...empty, sessionIds: [NO_SESSION] })).toBe(true);
  });
});

// A close awaiting sign-off jumps the owner and state filters (the default view
// is owner=user + not-done, which is exactly what would hide a CC-closed issue),
// but it must still obey the SESSION filter — a sign-off from another session
// has no business on top of the one you are looking at (asked for 2026-07-30).
describe("issue filters — a close awaiting sign-off", () => {
  const mk = (
    owner: Issue["owner"],
    state: Issue["state"],
    session_id: string | null,
  ): Issue => ({
    id: "iss_x",
    title: "t",
    body: "",
    owner,
    state,
    session_id,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    closed_at: null,
  });
  const empty: IssueFilters = {
    owners: [],
    states: [],
    sessionIds: [],
    q: "",
    showDeleted: false,
  };
  // owner=cc + state=done + not yet approved = the row that needs the user.
  const pending = mk("cc", "done", "s_1");

  test("it really is awaiting approval", () => {
    expect(isAwaitingApproval(pending)).toBe(true);
    // Once acknowledged it is an ordinary closed row again.
    expect(isAwaitingApproval({ ...pending, close_approved_at: "x" })).toBe(false);
  });

  test("owner and state filters do not hide it", () => {
    // The default opening view — owner=user, not-done — would otherwise bury it.
    expect(isVisible(pending, { ...empty, owners: ["user"] })).toBe(true);
    expect(isVisible(pending, { ...empty, states: ["todo", "doing"] })).toBe(true);
  });

  test("but the session filter does", () => {
    // Its own session keeps it; another session drops it, so session A's list
    // never wears session B's sign-off on top.
    expect(isVisible(pending, { ...empty, sessionIds: ["s_1"] })).toBe(true);
    expect(isVisible(pending, { ...empty, sessionIds: ["s_2"] })).toBe(false);
    // A no-session sign-off follows the same rule the rest of the list does.
    const orphan = mk("cc", "dropped", null);
    expect(isVisible(orphan, { ...empty, sessionIds: ["s_1"] })).toBe(false);
    expect(isVisible(orphan, { ...empty, sessionIds: [NO_SESSION] })).toBe(true);
  });

  test("an ordinary row still needs all three axes", () => {
    const openRow = mk("cc", "doing", "s_1");
    expect(isVisible(openRow, { ...empty, owners: ["user"] })).toBe(false);
    expect(isVisible(openRow, { ...empty, sessionIds: ["s_2"] })).toBe(false);
    expect(isVisible(openRow, empty)).toBe(true);
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

// Ids written in a message become links into the tracker. The pattern has to be
// tight enough that placeholders in an explanation ("iss_xxx") do not become
// links to nothing — which looks broken rather than illustrative — and loose
// enough to catch the shortened form that gets written in prose.
describe("issue ids in messages", () => {
  test("matches real ids, full and shortened", () => {
    expect(ISSUE_ID_RE.test("iss_ms5kq850_516a7f9936c503d13860dbd0")).toBe(true);
    // Shortened in prose; the timestamp half is unique in practice and the
    // tracker resolves it by prefix.
    expect(ISSUE_ID_RE.test("iss_ms5kq850")).toBe(true);
  });

  test("does not match placeholders used when explaining the format", () => {
    expect(ISSUE_ID_RE.test("iss_xxx")).toBe(false);
    expect(ISSUE_ID_RE.test("iss_yyy")).toBe(false);
    expect(ISSUE_ID_RE.test("iss_nope")).toBe(false);
    expect(ISSUE_ID_RE.test("iss_")).toBe(false);
    // Not an id at all — a code span of ordinary text must stay a code span.
    expect(ISSUE_ID_RE.test("issue_ids")).toBe(false);
    expect(ISSUE_ID_RE.test("bd_vlap7p27")).toBe(false);
  });
});
