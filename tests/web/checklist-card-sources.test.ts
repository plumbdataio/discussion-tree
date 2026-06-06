import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { ChecklistCard } from "../../web/components/ChecklistCard.tsx";
import type {
  ChecklistItem,
  ChecklistItemSource,
  Node,
} from "../../shared/types.ts";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

// Surface feature ③ (UI): each item with sources shows a toggle; expanding it
// renders one row per source — a message is a jump button, a node / board is a
// link to its board.

function src(p: Partial<ChecklistItemSource>): ChecklistItemSource {
  return {
    id: 0,
    item_id: 0,
    board_id: "bd_x",
    kind: "node",
    ref_id: "dec",
    position: 0,
    created_at: "t",
    ...p,
  };
}
function item(p: Partial<ChecklistItem>): ChecklistItem {
  return {
    id: 0,
    board_id: "bd_x",
    node_id: "cl",
    summary: "S",
    status: "pending",
    position: 0,
    created_at: "t",
    sources: [],
    ...p,
  };
}
function node(items: ChecklistItem[]): Node {
  return {
    board_id: "bd_x",
    id: "cl",
    parent_id: "c1",
    kind: "item",
    title: "CL",
    context: "",
    status: "pending",
    position: 0,
    created_at: "t",
    is_checklist: 1,
    checklist_items: items,
  } as Node;
}

async function mount(n: Node) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ChecklistCard, { node: n }));
  });
  return {
    host,
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

describe("ChecklistCard source citations", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("only items with sources get a toggle, showing the count", async () => {
    const n = node([
      item({ id: 1, position: 0, summary: "A", sources: [src({ id: 10 })] }),
      item({ id: 2, position: 1, summary: "B", sources: [] }),
    ]);
    const m = await mount(n);
    const lis = m.host.querySelectorAll(".checklist-item");
    expect(lis.length).toBe(2);
    expect(lis[0].querySelector(".checklist-source-toggle")).toBeTruthy();
    expect(lis[1].querySelector(".checklist-source-toggle")).toBeNull();
    expect(
      lis[0]
        .querySelector(".checklist-source-count")
        ?.textContent?.trim(),
    ).toBe("1");
    await m.unmount();
  });

  test("a node source expands to a link to its board", async () => {
    const n = node([
      item({
        id: 1,
        position: 0,
        sources: [src({ id: 10, kind: "node", ref_id: "dec", board_id: "bd_x" })],
      }),
    ]);
    const m = await mount(n);
    const toggle = m.host.querySelector(
      ".checklist-source-toggle",
    ) as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    const row = m.host.querySelector(".checklist-source-row") as HTMLElement;
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/board/bd_x");
    expect(row.textContent).toContain("ノード");
    expect(row.textContent).toContain("dec");
    await m.unmount();
  });

  test("a board source links to that board; a message source is a jump button", async () => {
    const n = node([
      item({
        id: 1,
        position: 0,
        sources: [
          src({ id: 10, kind: "board", ref_id: "bd_other", board_id: "bd_other" }),
          src({ id: 11, kind: "message", ref_id: "99", board_id: "bd_msg" }),
        ],
      }),
    ]);
    const m = await mount(n);
    const toggle = m.host.querySelector(
      ".checklist-source-toggle",
    ) as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    const rows = m.host.querySelectorAll(".checklist-source-row");
    expect(rows.length).toBe(2);
    // board → link to itself
    expect(rows[0].tagName).toBe("A");
    expect(rows[0].getAttribute("href")).toBe("/board/bd_other");
    expect(rows[0].textContent).toContain("ボード");
    // message → button (no href, jumps via anchor channel)
    expect(rows[1].tagName).toBe("BUTTON");
    expect(rows[1].getAttribute("href")).toBeNull();
    expect(rows[1].textContent).toContain("メッセージ");
    expect(rows[1].textContent).toContain("99");
    await m.unmount();
  });

  test("toggling twice collapses the source list", async () => {
    const n = node([
      item({ id: 1, position: 0, sources: [src({ id: 10 })] }),
    ]);
    const m = await mount(n);
    const toggle = m.host.querySelector(
      ".checklist-source-toggle",
    ) as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    expect(m.host.querySelector(".checklist-source-row")).toBeTruthy();
    await act(async () => {
      toggle.click();
    });
    expect(m.host.querySelector(".checklist-source-row")).toBeNull();
    await m.unmount();
  });
});
