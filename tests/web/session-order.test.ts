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

  test("legacy cwd-keyed order still resolves (backward compat)", () => {
    const x = s("cc-x", "/x");
    const y = s("cc-y", "/y");
    // Old saved order was a list of cwds; sessions still match by cwd.
    expect(applyOrder([y, x], ["/x", "/y"])).toEqual([x, y]);
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

  test("cc_session_id match wins over a cwd also present in the order", () => {
    const a = s("cc-a", "/repo");
    const b = s("cc-b", "/repo");
    // Mixed/transitional order: a's cwd and b's id. b (by id, rank 0) leads a
    // (by cwd, rank 1).
    expect(applyOrder([a, b], ["cc-b", "/repo"])).toEqual([b, a]);
  });
});
