import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { clearDraft, useDraft } from "../../web/utils/drafts.ts";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

// Tiny harness: render a function component that captures useDraft's current
// [value, setValue, clear] tuple via a ref, so we can drive it from tests.
type DraftAPI = ReturnType<typeof useDraft>;

async function mountUseDraft(boardId: string, nodeId: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const out: { api: DraftAPI | null; renders: number } = {
    api: null,
    renders: 0,
  };
  function Probe() {
    out.renders++;
    const api = useDraft(boardId, nodeId);
    out.api = api;
    return null;
  }
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    out,
    act,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

const KEY = (b: string, n: string) => `dt-draft:${b}:${n}`;

describe("clearDraft", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("removes the localStorage entry for (board, node)", () => {
    localStorage.setItem(KEY("b", "n"), "hello");
    clearDraft("b", "n");
    expect(localStorage.getItem(KEY("b", "n"))).toBeNull();
  });

  test("is a no-op when the entry is absent", () => {
    expect(() => clearDraft("b", "n")).not.toThrow();
    expect(localStorage.getItem(KEY("b", "n"))).toBeNull();
  });

  test("only clears the targeted entry", () => {
    localStorage.setItem(KEY("b", "n"), "x");
    localStorage.setItem(KEY("b", "other"), "y");
    clearDraft("b", "n");
    expect(localStorage.getItem(KEY("b", "other"))).toBe("y");
  });
});

describe("useDraft", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("hydrates initial value from localStorage", async () => {
    localStorage.setItem(KEY("bd", "nd"), "previously typed");
    const { out, unmount } = await mountUseDraft("bd", "nd");
    expect(out.api![0]).toBe("previously typed");
    unmount();
  });

  test("initial value is empty when nothing is stored", async () => {
    const { out, unmount } = await mountUseDraft("bd", "nd");
    expect(out.api![0]).toBe("");
    unmount();
  });

  test("setValue writes through to localStorage", async () => {
    const { out, unmount } = await mountUseDraft("bd", "nd");
    await act(async () => {
      out.api![1]("hello world");
    });
    expect(localStorage.getItem(KEY("bd", "nd"))).toBe("hello world");
    unmount();
  });

  test("setValue with empty string removes the localStorage entry", async () => {
    localStorage.setItem(KEY("bd", "nd"), "seed");
    const { out, unmount } = await mountUseDraft("bd", "nd");
    await act(async () => {
      out.api![1]("");
    });
    expect(localStorage.getItem(KEY("bd", "nd"))).toBeNull();
    unmount();
  });

  test("setValue supports an updater function", async () => {
    const { out, unmount } = await mountUseDraft("bd", "nd");
    await act(async () => {
      out.api![1]("abc");
    });
    await act(async () => {
      out.api![1]((prev) => prev + "def");
    });
    expect(localStorage.getItem(KEY("bd", "nd"))).toBe("abcdef");
    unmount();
  });

  test("clear() removes the entry and resets value to empty string", async () => {
    localStorage.setItem(KEY("bd", "nd"), "remove me");
    const { out, unmount } = await mountUseDraft("bd", "nd");
    await act(async () => {
      out.api![2]();
    });
    expect(localStorage.getItem(KEY("bd", "nd"))).toBeNull();
    expect(out.api![0]).toBe("");
    unmount();
  });

  test("different (board, node) pairs are isolated under different keys", async () => {
    localStorage.setItem(KEY("b1", "n1"), "one");
    localStorage.setItem(KEY("b2", "n2"), "two");
    const a = await mountUseDraft("b1", "n1");
    const b = await mountUseDraft("b2", "n2");
    expect(a.out.api![0]).toBe("one");
    expect(b.out.api![0]).toBe("two");
    a.unmount();
    b.unmount();
  });
});
