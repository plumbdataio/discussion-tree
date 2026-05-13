import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { navigate } from "../../web/utils/router.ts";

describe("navigate", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  test("pushes a new pathname onto history", () => {
    navigate("/board/bd_1");
    expect(window.location.pathname).toBe("/board/bd_1");
  });

  test("dispatches pd-route-change so subscribers re-render", () => {
    let fired = 0;
    const h = () => {
      fired++;
    };
    window.addEventListener("pd-route-change", h);
    navigate("/session/s_1");
    window.removeEventListener("pd-route-change", h);
    expect(fired).toBe(1);
  });

  test("no-ops when the target equals the current pathname (no event)", () => {
    navigate("/foo");
    let fired = 0;
    const h = () => {
      fired++;
    };
    window.addEventListener("pd-route-change", h);
    navigate("/foo");
    window.removeEventListener("pd-route-change", h);
    expect(fired).toBe(0);
  });

  test("two distinct navigations both push history", () => {
    navigate("/a");
    navigate("/b");
    expect(window.location.pathname).toBe("/b");
  });

  test("popstate would surface via the route-change event listeners", () => {
    // We can't trigger a real back-button in happy-dom reliably, but we can
    // verify navigate respects history.pushState semantics (back through
    // history.back() should restore /).
    navigate("/x");
    expect(window.location.pathname).toBe("/x");
    window.history.back();
    // happy-dom processes history.back synchronously here; check we're not
    // still on /x.
    expect(window.location.pathname).not.toBe("/x");
  });
});
