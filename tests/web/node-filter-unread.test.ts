import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import {
  isNodeVisibleWithUnread,
  type NodeStatusFilter,
} from "../../web/utils/nodeStatusFilter.ts";
import { NODE_STATUSES } from "../../web/utils/constants.ts";

// Header node filter + the "show unread even if excluded" override.
// isNodeVisibleWithUnread is the pure decision behind it: status passes the
// filter, OR the override is on and the node has unread now, OR it was already
// revealed this session (sticky — so reading it doesn't make it vanish).

function filterWith(excluded: string[]): NodeStatusFilter {
  const f = {} as NodeStatusFilter;
  for (const s of NODE_STATUSES) f[s] = !excluded.includes(s);
  return f;
}

const ALL_ON = filterWith([]);
const DONE_OFF = filterWith(["done"]);

describe("isNodeVisibleWithUnread", () => {
  test("a status that passes the filter is always visible", () => {
    // override/unread/sticky are irrelevant when the status itself is enabled.
    expect(isNodeVisibleWithUnread("pending", ALL_ON, false, false, false)).toBe(
      true,
    );
    expect(isNodeVisibleWithUnread("done", ALL_ON, false, false, false)).toBe(
      true,
    );
  });

  test("an excluded status is hidden when the override is OFF, even with unread", () => {
    expect(isNodeVisibleWithUnread("done", DONE_OFF, false, true, false)).toBe(
      false,
    );
    expect(isNodeVisibleWithUnread("done", DONE_OFF, false, true, true)).toBe(
      false,
    );
  });

  test("override ON reveals an excluded node that has unread", () => {
    expect(isNodeVisibleWithUnread("done", DONE_OFF, true, true, false)).toBe(
      true,
    );
  });

  test("override ON does NOT reveal an excluded node with no unread (and not sticky)", () => {
    expect(isNodeVisibleWithUnread("done", DONE_OFF, true, false, false)).toBe(
      false,
    );
  });

  test("sticky keeps a revealed node visible after its unread clears", () => {
    // hasUnread=false (cleared) but isSticky=true → still visible. This is the
    // "don't vanish out from under the user mid-view" guarantee.
    expect(isNodeVisibleWithUnread("done", DONE_OFF, true, false, true)).toBe(
      true,
    );
  });

  test("a passing status stays visible regardless of override/sticky", () => {
    expect(isNodeVisibleWithUnread("pending", DONE_OFF, true, false, false)).toBe(
      true,
    );
  });
});
