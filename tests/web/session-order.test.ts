import { describe, test, expect } from "bun:test";
import { applyOrder, sessionOrderKey } from "../../web/utils/sessionOrder.ts";

const s = (cc_session_id: string | null, cwd: string) => ({ cc_session_id, cwd });

describe("sessionOrderKey", () => {
  test("is the cc_session_id, with no cwd fallback (null stays null)", () => {
    expect(sessionOrderKey(s("cc-1", "/a"))).toBe("cc-1");
    // An attached session always has a cc_session_id; a null one is not ordered
    // by cwd — it simply yields a null key that the persist step skips.
    expect(sessionOrderKey(s(null, "/a"))).toBeNull();
  });
});

describe("applyOrder", () => {
  test("orders two sessions that SHARE a cwd independently by cc_session_id", () => {
    // The bug: a cwd-keyed order collapsed same-cwd sessions into one slot, so
    // they could not be reordered relative to each other. cc_session_id keys fix it.
    const a = s("cc-a", "/repo");
    const b = s("cc-b", "/repo");
    // Saved order asks for b before a (both share "/repo").
    expect(applyOrder([a, b], ["cc-b", "cc-a"])).toEqual([b, a]);
    // And the reverse.
    expect(applyOrder([a, b], ["cc-a", "cc-b"])).toEqual([a, b]);
  });

  test("a legacy cwd-keyed order is ignored (cwd is no longer a key)", () => {
    const x = s("cc-x", "/x");
    const y = s("cc-y", "/y");
    // Old builds persisted a list of cwds; those keys now match nothing, so the
    // sessions fall to natural order (a one-time reset — the user re-drags once).
    expect(applyOrder([y, x], ["/x", "/y"])).toEqual([y, x]);
  });

  test("listed come first; unlisted keep natural order (stable ties)", () => {
    const a = s("cc-a", "/a");
    const b = s("cc-b", "/b");
    const c = s("cc-c", "/c");
    // Only c is listed → it leads; a,b keep their incoming order.
    expect(applyOrder([a, b, c], ["cc-c"])).toEqual([c, a, b]);
    // Empty order → unchanged.
    expect(applyOrder([a, b, c], [])).toEqual([a, b, c]);
  });

});
