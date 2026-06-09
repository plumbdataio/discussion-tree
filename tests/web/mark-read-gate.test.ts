import "./happydom.ts";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { useMarkReadOnVisible } from "../../web/utils/useMarkReadOnVisible.ts";
import { createRoot } from "react-dom/client";
import { createElement, act, useRef } from "react";
import type { ThreadItem } from "../../shared/types.ts";

// useMarkReadOnVisible posts /mark-thread-items-read once a card has been
// visible (≥VISIBLE_RATIO) for VISIBLE_DURATION_MS continuous. The map view
// adds a `gateOpen` flag (zoom-threshold) that must hard-block the read even
// when the card is on screen the whole time. These tests pin that contract.

const VISIBLE_RECT = {
  top: 10,
  bottom: 200,
  left: 10,
  right: 200,
  height: 190,
  width: 190,
  x: 10,
  y: 10,
  toJSON() {},
} as DOMRect;

function unread(id = 1): ThreadItem {
  return {
    id,
    board_id: "m",
    node_id: "n",
    source: "cc",
    text: "hi",
    created_at: "2026-01-01T00:00:00Z",
    read_at: null,
  } as unknown as ThreadItem;
}

let readPosts: number[][];
let restoreFetch: () => void;

function installFetchSpy() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (typeof url === "string" && url.includes("/mark-thread-items-read")) {
      const body = JSON.parse(init?.body ?? "{}");
      readPosts.push(body.thread_item_ids ?? []);
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

async function mount(items: ThreadItem[], gateOpen: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  function Probe() {
    const r = useRef<HTMLDivElement>(null);
    useMarkReadOnVisible(r, items, gateOpen);
    return createElement("div", { ref: r, className: "card" });
  }
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
  // happy-dom returns an all-zero rect by default; make the card "fully on
  // screen" so the only thing being exercised is the dwell + gate logic.
  const card = host.querySelector(".card") as HTMLElement;
  card.getBoundingClientRect = () => VISIBLE_RECT;
  return {
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

describe("useMarkReadOnVisible gateOpen", () => {
  beforeEach(() => {
    localStorage.clear();
    readPosts = [];
    installFetchSpy();
  });
  afterEach(() => {
    restoreFetch();
  });

  // Gate closed → the effect returns before it ever arms the interval, so a
  // short wait (past one poll tick) already proves no read fires.
  test("does NOT auto-read while the gate is closed, even when on screen", async () => {
    const m = await mount([unread()], false);
    await wait(1200);
    expect(readPosts).toEqual([]);
    await m.unmount();
  });

  // Gate open → after the full visible dwell the unread ids are posted once.
  test("auto-reads after the dwell when the gate is open", async () => {
    const m = await mount([unread(7)], true);
    await wait(6000); // > VISIBLE_DURATION_MS (5000)
    expect(readPosts.length).toBeGreaterThanOrEqual(1);
    expect(readPosts[0]).toEqual([7]);
    await m.unmount();
  }, 10000);

  // No unread cc items → short-circuits regardless of gate.
  test("no read when there are no unread cc items, gate open", async () => {
    const read = { ...unread(), read_at: "2026-01-01T00:00:01Z" } as ThreadItem;
    const m = await mount([read], true);
    await wait(1200);
    expect(readPosts).toEqual([]);
    await m.unmount();
  });
});
