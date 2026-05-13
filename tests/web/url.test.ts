import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import {
  getBoardIdFromUrl,
  getSessionIdFromUrl,
} from "../../web/utils/url.ts";

describe("getBoardIdFromUrl", () => {
  test("extracts the board id from /board/<id>", () => {
    expect(getBoardIdFromUrl("/board/bd_abc")).toBe("bd_abc");
  });

  test("extracts only the first path segment after /board/", () => {
    expect(getBoardIdFromUrl("/board/bd_abc/extra/stuff")).toBe("bd_abc");
  });

  test("returns null when the path is the root", () => {
    expect(getBoardIdFromUrl("/")).toBeNull();
  });

  test("returns null for an unrelated path", () => {
    expect(getBoardIdFromUrl("/session/s_1")).toBeNull();
  });

  test("returns null for trailing /board with no id", () => {
    // /^\/board\/([^/]+)/ requires at least one non-slash char.
    expect(getBoardIdFromUrl("/board/")).toBeNull();
  });

  test("handles ids that contain dots and dashes", () => {
    expect(getBoardIdFromUrl("/board/bd_1.2-3")).toBe("bd_1.2-3");
  });

  test("falls back to window.location.pathname when called with no arg", () => {
    window.history.pushState(null, "", "/board/bd_default");
    expect(getBoardIdFromUrl()).toBe("bd_default");
  });
});

describe("getSessionIdFromUrl", () => {
  test("extracts the session id from /session/<id>", () => {
    expect(getSessionIdFromUrl("/session/s_xyz")).toBe("s_xyz");
  });

  test("returns null for /board/<id>", () => {
    expect(getSessionIdFromUrl("/board/bd_abc")).toBeNull();
  });

  test("returns null for the root path", () => {
    expect(getSessionIdFromUrl("/")).toBeNull();
  });

  test("falls back to window.location.pathname when called with no arg", () => {
    window.history.pushState(null, "", "/session/s_default");
    expect(getSessionIdFromUrl()).toBe("s_default");
  });

  test("stops at the next slash", () => {
    expect(getSessionIdFromUrl("/session/s_1/board/bd_2")).toBe("s_1");
  });
});
