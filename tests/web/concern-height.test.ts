import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { useConcernHeight } from "../../web/utils/concernHeight.ts";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

type API = ReturnType<typeof useConcernHeight>;

async function mount(boardId: string | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const out: { api: API | null } = { api: null };
  function Probe() {
    out.api = useConcernHeight(boardId);
    return null;
  }
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    out,
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

const KEY = (b: string) => `dt-concern-height:${b}`;

describe("useConcernHeight", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test("starts at null when no override is stored", async () => {
    const m = await mount("bd_x");
    expect(m.out.api?.[0]).toBeNull();
    await m.unmount();
  });

  test("hydrates from sessionStorage on mount", async () => {
    sessionStorage.setItem(KEY("bd_x"), "180");
    const m = await mount("bd_x");
    expect(m.out.api?.[0]).toBe(180);
    await m.unmount();
  });

  test("setter writes to sessionStorage and updates state", async () => {
    const m = await mount("bd_x");
    await act(async () => {
      m.out.api?.[1](220);
    });
    expect(sessionStorage.getItem(KEY("bd_x"))).toBe("220");
    expect(m.out.api?.[0]).toBe(220);
    await m.unmount();
  });

  test("setting null clears the override and removes the key", async () => {
    sessionStorage.setItem(KEY("bd_x"), "200");
    const m = await mount("bd_x");
    expect(m.out.api?.[0]).toBe(200);
    await act(async () => {
      m.out.api?.[1](null);
    });
    expect(sessionStorage.getItem(KEY("bd_x"))).toBeNull();
    expect(m.out.api?.[0]).toBeNull();
    await m.unmount();
  });

  test("null boardId is a no-op (no write, value stays null)", async () => {
    const m = await mount(null);
    await act(async () => {
      m.out.api?.[1](120);
    });
    // No keys written; reading back returns null.
    expect(sessionStorage.length).toBe(0);
    expect(m.out.api?.[0]).toBeNull();
    await m.unmount();
  });

  test("ignores corrupt sessionStorage values", async () => {
    sessionStorage.setItem(KEY("bd_x"), "not a number");
    const m = await mount("bd_x");
    expect(m.out.api?.[0]).toBeNull();
    await m.unmount();
  });

  test("two mounts on the same board sync via CustomEvent", async () => {
    const a = await mount("bd_y");
    const b = await mount("bd_y");
    await act(async () => {
      a.out.api?.[1](150);
    });
    expect(a.out.api?.[0]).toBe(150);
    expect(b.out.api?.[0]).toBe(150);
    await a.unmount();
    await b.unmount();
  });

  test("mounts on different boards don't cross-talk", async () => {
    const a = await mount("bd_a");
    const b = await mount("bd_b");
    await act(async () => {
      a.out.api?.[1](300);
    });
    expect(a.out.api?.[0]).toBe(300);
    expect(b.out.api?.[0]).toBeNull();
    await a.unmount();
    await b.unmount();
  });
});
