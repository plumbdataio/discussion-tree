import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";
import { useSettings, type Settings } from "../../web/utils/settings.ts";

type API = ReturnType<typeof useSettings>;
const STORAGE_KEY = "pd-settings";

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const out: { api: API | null } = { api: null };
  function Probe() {
    out.api = useSettings();
    return null;
  }
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    out,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

describe("useSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns defaults when localStorage is empty", async () => {
    const { out, unmount } = await mount();
    const [s] = out.api!;
    expect(s.autoReadEnabled).toBe(true);
    expect(s.language).toBe("system");
    expect(s.theme).toBe("system");
    expect(s.boardStatusFilter.discussing).toBe(true);
    expect(s.boardStatusFilter.paused).toBe(true);
    expect(s.sessionOrder).toEqual([]);
    expect(s.collapsedSessions).toEqual({});
    unmount();
  });

  test("hydrates from localStorage", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        autoReadEnabled: false,
        language: "ja",
        theme: "dark",
      } satisfies Partial<Settings>),
    );
    const { out, unmount } = await mount();
    const [s] = out.api!;
    expect(s.autoReadEnabled).toBe(false);
    expect(s.language).toBe("ja");
    expect(s.theme).toBe("dark");
    unmount();
  });

  test("deep-merges boardStatusFilter against defaults", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ boardStatusFilter: { discussing: false } }),
    );
    const { out, unmount } = await mount();
    const [s] = out.api!;
    expect(s.boardStatusFilter.discussing).toBe(false);
    // Missing keys still fall back to default true.
    expect(s.boardStatusFilter.settled).toBe(true);
    expect(s.boardStatusFilter.completed).toBe(true);
    unmount();
  });

  test("deep-merges collapsedSessions against defaults", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ collapsedSessions: { s1: true } }),
    );
    const { out, unmount } = await mount();
    const [s] = out.api!;
    expect(s.collapsedSessions.s1).toBe(true);
    unmount();
  });

  test("sessionOrder preserved as-is", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionOrder: ["a", "b", "c"] }),
    );
    const { out, unmount } = await mount();
    const [s] = out.api!;
    expect(s.sessionOrder).toEqual(["a", "b", "c"]);
    unmount();
  });

  test("falls back to defaults on invalid JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "{ not valid json");
    const { out, unmount } = await mount();
    const [s] = out.api!;
    expect(s.autoReadEnabled).toBe(true);
    expect(s.language).toBe("system");
    unmount();
  });

  test("update() writes through to localStorage", async () => {
    const { out, unmount } = await mount();
    await act(async () => {
      out.api![1]({ theme: "light" });
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.theme).toBe("light");
    unmount();
  });

  test("update() merges over existing values, not replaces", async () => {
    const { out, unmount } = await mount();
    await act(async () => {
      out.api![1]({ theme: "light" });
    });
    await act(async () => {
      out.api![1]({ autoReadEnabled: false });
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.theme).toBe("light");
    expect(stored.autoReadEnabled).toBe(false);
    unmount();
  });

  test("update() returns the new value via the state setter", async () => {
    const { out, unmount } = await mount();
    await act(async () => {
      out.api![1]({ language: "en" });
    });
    expect(out.api![0].language).toBe("en");
    unmount();
  });

  test("dispatches pd-settings-changed on write", async () => {
    const { out, unmount } = await mount();
    let fired = 0;
    const h = () => {
      fired++;
    };
    window.addEventListener("pd-settings-changed", h);
    await act(async () => {
      out.api![1]({ theme: "dark" });
    });
    window.removeEventListener("pd-settings-changed", h);
    expect(fired).toBeGreaterThanOrEqual(1);
    unmount();
  });
});
