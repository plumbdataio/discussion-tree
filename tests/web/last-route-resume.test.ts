import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { installLastRouteResume } from "../../web/utils/router.ts";

// A home-screen PWA killed by iOS relaunches at "/"; it must jump back to the
// page the user was on — but only on a FRESH launch in standalone mode.

function setStandalone(on: boolean) {
  (window as any).matchMedia = (q: string) => ({
    matches: on && q.includes("standalone"),
    addEventListener() {},
    removeEventListener() {},
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("installLastRouteResume", () => {
  test("fresh standalone launch at / goes back to the remembered page", () => {
    setStandalone(true);
    localStorage.setItem("dt-last-route", "/board/bd_x");
    installLastRouteResume();
    expect(window.location.pathname).toBe("/board/bd_x");
  });

  test("a later in-app visit to / (same launch) is not redirected", () => {
    setStandalone(true);
    sessionStorage.setItem("dt-launched", "1");
    localStorage.setItem("dt-last-route", "/board/bd_x");
    installLastRouteResume();
    expect(window.location.pathname).toBe("/");
  });

  test("a normal browser tab is never redirected", () => {
    setStandalone(false);
    localStorage.setItem("dt-last-route", "/board/bd_x");
    installLastRouteResume();
    expect(window.location.pathname).toBe("/");
  });

  test("a non-path or protocol-relative stored value is ignored", () => {
    setStandalone(true);
    localStorage.setItem("dt-last-route", "//evil.example/x");
    installLastRouteResume();
    expect(window.location.pathname).toBe("/");
  });

  test("the current path is remembered", () => {
    setStandalone(true);
    window.history.replaceState(null, "", "/session/s1");
    installLastRouteResume();
    expect(localStorage.getItem("dt-last-route")).toBe("/session/s1");
  });
});
