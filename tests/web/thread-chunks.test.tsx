import "./happydom.ts";
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";
import i18n from "../../web/i18n.ts";
import {
  CV_CHUNK_SIZE,
  estimateChunkHeight,
  planThreadChunks,
} from "../../web/utils/threadChunks.ts";
import {
  FALLBACK_CHARS_PER_LINE,
  LIVE_REGION_COUNT,
  charsPerLineForWidth,
  estimateMessageHeight,
} from "../../web/utils/estimateMessageHeight.ts";
import { DefaultBoardLayout } from "../../web/components/DefaultBoardLayout.tsx";
import { ItemCard } from "../../web/components/ItemCard.tsx";

// Long threads put content-visibility:auto on CHUNKS of deep-history rows, not
// on each row (a per-row property made the browser re-check thousands of
// elements on every keystroke). These tests pin the chunk plan and the DOM
// shape that the CSS relies on.

describe("planThreadChunks", () => {
  test("short threads are all live", () => {
    for (const n of [0, 1, LIVE_REGION_COUNT, LIVE_REGION_COUNT + CV_CHUNK_SIZE - 1]) {
      expect(planThreadChunks(n)).toEqual({ chunkCount: 0, liveStart: 0 });
    }
  });

  test("the live region keeps at least LIVE_REGION_COUNT and fewer than LIVE + N rows", () => {
    for (let n = 0; n < 1000; n++) {
      const { chunkCount, liveStart } = planThreadChunks(n);
      expect(liveStart).toBe(chunkCount * CV_CHUNK_SIZE);
      const live = n - liveStart;
      expect(live).toBeGreaterThanOrEqual(Math.min(n, LIVE_REGION_COUNT));
      expect(live).toBeLessThan(LIVE_REGION_COUNT + CV_CHUNK_SIZE);
    }
  });

  test("appending messages never moves an existing chunk boundary", () => {
    let prev = planThreadChunks(0);
    for (let n = 1; n < 1000; n++) {
      const next = planThreadChunks(n);
      // Chunk k always spans [k*N, (k+1)*N); a new message can only add a
      // whole chunk at the end of deep history, never re-cut an existing one.
      expect(next.chunkCount - prev.chunkCount).toBeGreaterThanOrEqual(0);
      expect(next.chunkCount - prev.chunkCount).toBeLessThanOrEqual(1);
      prev = next;
    }
  });

  test("the 4,400-row board gets ~87 chunks instead of ~4,350 contained rows", () => {
    const { chunkCount, liveStart } = planThreadChunks(4412);
    expect(chunkCount).toBe(87);
    expect(liveStart).toBe(4350);
  });
});

describe("estimateChunkHeight", () => {
  test("sums the per-message estimates plus the gaps between rows", () => {
    const texts = ["a", "b".repeat(200), "![x](/u.png)"];
    const sum = texts.reduce((a, t) => a + estimateMessageHeight(t), 0);
    expect(estimateChunkHeight(texts, 8)).toBe(sum + 2 * 8);
    expect(estimateChunkHeight([], 8)).toBe(0);
  });
});

describe("width-aware estimate", () => {
  test("unknown or unusable width falls back to the narrow default", () => {
    for (const w of [null, undefined, 0, -5, Number.NaN]) {
      expect(charsPerLineForWidth(w as any)).toBe(FALLBACK_CHARS_PER_LINE);
    }
  });

  test("a wider thread fits more characters per line (never below a floor)", () => {
    let prev = 0;
    for (let w = 50; w <= 2000; w += 50) {
      const c = charsPerLineForWidth(w);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeGreaterThanOrEqual(16);
      prev = c;
    }
    expect(charsPerLineForWidth(1400)).toBeGreaterThan(FALLBACK_CHARS_PER_LINE);
  });

  test("a long paragraph is estimated shorter in a wide thread than in a narrow one", () => {
    const text = "word ".repeat(400);
    expect(estimateMessageHeight(text, charsPerLineForWidth(1400))).toBeLessThan(
      estimateMessageHeight(text, charsPerLineForWidth(360)),
    );
  });

  test("wide (CJK) characters count about twice a Latin character", () => {
    const cpl = 40;
    const latin = estimateMessageHeight("a".repeat(400), cpl);
    const wide = estimateMessageHeight(String.fromCharCode(0x6f22).repeat(400), cpl);
    const latinDouble = estimateMessageHeight("a".repeat(800), cpl);
    expect(wide).toBeGreaterThan(latin);
    expect(wide).toBe(latinDouble);
  });

  test("the chunk estimate follows the width", () => {
    const texts = Array.from({ length: 50 }, () => "word ".repeat(120));
    expect(estimateChunkHeight(texts, 8, charsPerLineForWidth(1400))).toBeLessThan(
      estimateChunkHeight(texts, 8),
    );
  });
});

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
  });
  return {
    host,
    root,
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    node_id: "n1",
    source: i % 2 ? "cc" : "user",
    text: `ROW-${i + 1}`,
    created_at: `t${i}`,
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

// Every row present, oldest first, chunks are children of the single
// .thread-rows wrapper (never of the column-reverse scroller), and no row
// carries its own containment.
function checkShape(rowsEl: HTMLElement, n: number) {
  const { chunkCount, liveStart } = planThreadChunks(n);
  const chunks = Array.from(rowsEl.querySelectorAll(".thread-chunk")) as HTMLElement[];
  expect(chunks.length).toBe(chunkCount);
  for (const c of chunks) {
    expect(c.parentElement).toBe(rowsEl);
    expect(c.querySelectorAll(".thread-msg").length).toBe(CV_CHUNK_SIZE);
    expect(c.style.containIntrinsicSize).toMatch(/^auto \d+px$/);
  }
  const ids = Array.from(rowsEl.querySelectorAll("[data-thread-item-id]")).map((el) =>
    Number(el.getAttribute("data-thread-item-id")),
  );
  expect(ids).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  // Live rows sit directly in the wrapper after the last chunk.
  const direct = Array.from(rowsEl.children).filter((el) =>
    el.classList.contains("thread-msg"),
  );
  expect(direct.length).toBe(n - liveStart);
  expect(rowsEl.querySelectorAll(".cv-contained").length).toBe(0);
  expect(
    Array.from(rowsEl.querySelectorAll(".thread-msg")).some(
      (el) => (el as HTMLElement).style.containIntrinsicSize,
    ),
  ).toBe(false);
}

describe("chunked thread DOM", () => {
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

  test("DefaultBoardLayout chunks deep history inside .thread-rows", async () => {
    const n = 237;
    const m = await mount(
      createElement(DefaultBoardLayout, {
        data: boardData(n),
        ownerAlive: true,
        onSubmit: async () => {},
        ownerSessionId: "s1",
      }),
    );
    const thread = m.host.querySelector(".default-board-thread") as HTMLElement;
    expect(thread.children.length).toBe(1);
    checkShape(thread.firstElementChild as HTMLElement, n);
    await m.unmount();
  });

  test("a new message keeps existing chunks and only grows the live region", async () => {
    const n = 160;
    const props = {
      ownerAlive: true,
      onSubmit: async () => {},
      ownerSessionId: "s1",
    };
    const m = await mount(createElement(DefaultBoardLayout, { data: boardData(n), ...props }));
    const rowsEl = () =>
      m.host.querySelector(".default-board-thread > .thread-rows") as HTMLElement;
    const before = Array.from(rowsEl().querySelectorAll(".thread-chunk"));
    await act(async () => {
      m.root.render(createElement(DefaultBoardLayout, { data: boardData(n + 1), ...props }));
    });
    const after = Array.from(rowsEl().querySelectorAll(".thread-chunk"));
    // Same chunk elements (React kept them), so their remembered sizes survive.
    expect(after).toEqual(before);
    checkShape(rowsEl(), n + 1);
    await m.unmount();
  });

  test("ItemCard chunks a long node thread the same way", async () => {
    const n = 175;
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
        threads: { n1: items(n) as any },
        flashingNodes: new Set<string>(),
        activity: null,
        ownerAlive: true,
        ownerSessionId: "s1",
        onSubmit: async () => {},
      }),
    );
    const thread = m.host.querySelector(".item-card > .thread") as HTMLElement;
    expect(thread.children.length).toBe(1);
    checkShape(thread.firstElementChild as HTMLElement, n);
    await m.unmount();
  });
});
