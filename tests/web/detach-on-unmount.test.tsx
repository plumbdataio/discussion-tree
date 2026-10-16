import "./happydom.ts";
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act, useState } from "react";
import i18n from "../../web/i18n.ts";
import { DefaultBoardLayout } from "../../web/components/DefaultBoardLayout.tsx";
import { ItemCard } from "../../web/components/ItemCard.tsx";

// Chrome's AutofillAgent keeps the last-typed textarea alive after a
// navigation, and through its parent pointers the whole old page. The big
// containers empty themselves on unmount (useDetachOnUnmount) so that kept
// textarea can no longer reach the thread rows. These tests run the REAL
// React unmount path (a keyed page swap, as frontend.tsx does on navigation).

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    node_id: "n1",
    source: i % 2 ? "cc" : "user",
    text: `ROW-${i + 1}`,
    created_at: `t${i}`,
    read_at: "t",
  }));
}

function boardData(n: number): any {
  return {
    board: { id: "bd_x", session_id: "s1" },
    nodes: [
      {
        id: "n1",
        kind: "item",
        parent_id: "root",
        board_id: "bd_x",
        title: "T",
        context: "",
        status: "pending",
        position: 0,
        created_at: "t",
      },
    ],
    threads: { n1: items(n) },
    scheduled: [],
  };
}

let setPage: (p: string) => void = () => {};
function Pages({ render }: { render: (p: string) => any }) {
  const [page, set] = useState("a");
  setPage = set;
  return createElement("div", { key: page, className: "page" }, render(page));
}

async function mountPages(render: (p: string) => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Pages, { render }));
  });
  return { host, root };
}

const errors: unknown[] = [];
const origError = console.error;

describe("useDetachOnUnmount", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await new Promise<void>((resolve) => {
        i18n.on("initialized", () => resolve());
      });
    }
    await i18n.changeLanguage("en");
  });
  beforeEach(() => {
    localStorage.clear();
    errors.length = 0;
    console.error = (...a: unknown[]) => {
      errors.push(a);
    };
  });

  test("leaving the default board cuts its rows off the kept textarea; coming back remounts cleanly", async () => {
    const board = () =>
      createElement(DefaultBoardLayout, {
        data: boardData(300),
        ownerAlive: true,
        onSubmit: async () => {},
        ownerSessionId: "s1",
      });
    const { host, root } = await mountPages((p) =>
      p === "a" ? board() : createElement("p", null, "other page"),
    );
    // What autofill would hold on to.
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(host.querySelectorAll(".thread-msg").length).toBe(300);

    await act(async () => setPage("b"));
    expect(textarea.isConnected).toBe(false);
    const oldRoot = textarea.closest(".default-board") as HTMLElement;
    expect(oldRoot).toBeTruthy();
    // The detached old page no longer contains a single row.
    expect(oldRoot.querySelectorAll(".thread-msg").length).toBe(0);
    expect(host.textContent).toContain("other page");

    await act(async () => setPage("a"));
    expect(host.querySelectorAll(".thread-msg").length).toBe(300);

    await act(async () => root.unmount());
    host.remove();
    console.error = origError;
    expect(errors).toEqual([]);
  });

  test("an item card on a concern board does the same", async () => {
    const node = {
      board_id: "bd_x",
      id: "n1",
      parent_id: "c1",
      kind: "item",
      title: "T",
      context: "",
      status: "pending",
      position: 0,
      created_at: "t",
    };
    const card = () =>
      createElement(ItemCard, {
        node,
        childrenByParent: new Map(),
        threads: { n1: items(120) as any },
        flashingNodes: new Set<string>(),
        activity: null,
        ownerAlive: true,
        ownerSessionId: "s1",
        scheduled: [],
        ownerConfirmArmed: false,
        onSubmit: async () => {},
      } as any);
    const { host, root } = await mountPages((p) =>
      p === "a" ? card() : createElement("p", null, "other page"),
    );
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(host.querySelectorAll(".thread-msg").length).toBe(120);
    await act(async () => setPage("b"));
    const oldPage = textarea.closest(".page") as HTMLElement;
    expect(oldPage.querySelectorAll(".thread-msg").length).toBe(0);
    await act(async () => setPage("a"));
    expect(host.querySelectorAll(".thread-msg").length).toBe(120);
    await act(async () => root.unmount());
    host.remove();
    console.error = origError;
    expect(errors).toEqual([]);
  });
});
