import "./happydom.ts";
import { describe, test, expect, beforeEach, beforeAll } from "bun:test";
import i18n from "../../web/i18n.ts";
import { DefaultBoardLayout } from "../../web/components/DefaultBoardLayout.tsx";
import { ItemCard } from "../../web/components/ItemCard.tsx";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

// A pending timer-send preview (ScheduledPinned) must render INSIDE the
// scrollable thread container, at the visual bottom — not as an out-of-flow
// pinned sibling between the thread and the input row. When it was a sibling
// (flex: 0 0 auto) a tall scheduled message (inline image / long text) grew
// unbounded, squeezed the flex:1 thread to nothing AND pushed the textarea
// off-screen. In-flow it scrolls with the thread and its height is bounded by
// the scroll container.
//
// The thread is `flex-direction: column-reverse`, so the FIRST DOM child is the
// visual BOTTOM. With no in-flight (tentative) message and an empty thread, the
// ScheduledPinned chip is therefore expected to be the thread's firstElementChild.

const fireAt = new Date(Date.now() + 3_600_000).toISOString();
const scheduled = [{ id: "sc1", node_id: "n1", fire_at: fireAt, text: "queued message" }];

const noop = async () => {};

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
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

describe("ScheduledPinned in-flow placement", () => {
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
  });

  test("DefaultBoardLayout renders it inside the thread, at the visual bottom", async () => {
    const data: any = {
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
      threads: { n1: [] },
      scheduled,
    };
    const m = await mount(
      createElement(DefaultBoardLayout, {
        data,
        ownerAlive: true,
        onSubmit: noop,
        flashingNodes: new Set<string>(),
        ownerSessionId: "s1",
      }),
    );

    const thread = m.host.querySelector(".default-board-thread") as HTMLElement;
    const chip = m.host.querySelector(".scheduled-pinned") as HTMLElement;
    expect(thread).toBeTruthy();
    expect(chip).toBeTruthy();
    // In-flow: descendant of the scroll container (not a sibling after it).
    expect(thread.contains(chip)).toBe(true);
    // column-reverse → first DOM child is the visual bottom.
    expect(thread.firstElementChild).toBe(chip);
    // The preview text is actually rendered.
    expect(chip.textContent).toContain("queued message");
    await m.unmount();
  });

  test("ItemCard renders it inside the thread, at the visual bottom", async () => {
    const node: any = {
      id: "n1",
      board_id: "bd_x",
      parent_id: "c1",
      kind: "item",
      title: "T",
      context: "",
      status: "pending",
      position: 0,
      created_at: "t",
    };
    const m = await mount(
      createElement(ItemCard, {
        node,
        childrenByParent: new Map(),
        threads: { n1: [] },
        flashingNodes: new Set<string>(),
        activity: null,
        ownerAlive: true,
        ownerSessionId: "s1",
        scheduled,
        ownerConfirmArmed: false,
        onSubmit: noop,
      }),
    );

    const thread = m.host.querySelector(".thread") as HTMLElement;
    const chip = m.host.querySelector(".scheduled-pinned") as HTMLElement;
    expect(thread).toBeTruthy();
    expect(chip).toBeTruthy();
    expect(thread.contains(chip)).toBe(true);
    expect(thread.firstElementChild).toBe(chip);
    expect(chip.textContent).toContain("queued message");
    await m.unmount();
  });
});
