import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real-browser checks for the chat threads (default board + item-card thread).
//
// Both are a `flex-direction: column-reverse` scroller (bottom pinning with no
// JS) holding ONE child, `.thread-rows`, whose rows are in natural top-to-bottom
// order. These tests lock in what that structure is for:
//   - a drag selection across messages selects exactly those messages, in
//     reading order (rows rendered directly under column-reverse in
//     newest-first DOM order made the selection follow the reversed DOM);
//   - wheel-scrolling through deep history moves the content by exactly the
//     wheel delta (as direct flex items of the overflowing scroller, rows with
//     content-visibility:auto were flex-shrunk to their padding while skipped
//     and grew back on reveal, so the view jumped by hundreds of px on every
//     pass);
//   - the thread opens pinned to the bottom and stays pinned when a new
//     message arrives.
//
// Runs against its own broker (temp DISCUSSION_TREE_HOME + DB, OS-assigned
// port), never a running one. Run with:
//   npx playwright test -c playwright.thread.config.ts

let broker: ChildProcess;
let home: string;
let base: string;
let defaultBoardId: string;
let defaultNodeId: string;
let itemBoardId: string;

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function get(path: string): Promise<any> {
  return (await fetch(base + path)).json();
}

function startBroker(): Promise<number> {
  home = mkdtempSync(join(tmpdir(), "dt-thread-e2e-"));
  broker = spawn("bun", [resolve("broker.ts")], {
    env: {
      ...process.env,
      DISCUSSION_TREE_PORT: "0",
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_DB: join(home, "db.sqlite"),
      DISCUSSION_TREE_BROKER_URL: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolvePort, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`broker did not start: ${buf.slice(-1000)}`)),
      120_000,
    );
    broker.on("exit", (code) =>
      reject(new Error(`broker exited (${code}): ${buf.slice(-1000)}`)),
    );
    broker.stderr!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
  });
}

// Deterministic, varied message bodies: short lines, long paragraphs and code
// blocks, so deep-history rows have very different heights.
function body(i: number): string {
  const tag = `MSG-${String(i).padStart(3, "0")}`;
  if (i % 7 === 2)
    return `${tag} long.\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4 + (i % 9))}\n\n${"Second paragraph. ".repeat(6)}`;
  if (i % 11 === 3)
    return `${tag} code.\n\n\`\`\`ts\n${Array.from({ length: 4 + (i % 13) }, (_, k) => `const v${k} = ${k};`).join("\n")}\n\`\`\``;
  return `${tag} short ${"word ".repeat(i % 23)}`;
}

const SELECTION_TRIO = ["A", "B", "C"].map(
  (k) => `SEL${k}-start first line of ${k}.\n\nSEL${k} second paragraph SEL${k}-end`,
);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const port = await startBroker();
  base = `http://127.0.0.1:${port}`;

  const reg = await post("/register", { pid: process.pid, cwd: home });
  await post("/attach-cc-session", {
    session_id: reg.session_id,
    cc_session_id: "cc-thread-e2e",
  });
  const sessions = await get("/api/sessions");
  const me = sessions.sessions.find((s: any) => s.id === reg.session_id);
  defaultBoardId = me.boards.find((b: any) => b.is_default).id;
  const view = await get(`/api/board/${defaultBoardId}`);
  defaultNodeId = view.nodes.find(
    (n: any) => n.kind === "item" && n.parent_id !== null,
  ).id;
  // Comfortably more than LIVE_REGION_COUNT so deep history is contained.
  for (let i = 0; i < 160; i++) {
    await post("/post-to-node", {
      issue_ids: [],
      board_id: defaultBoardId,
      node_id: defaultNodeId,
      message: body(i),
      status: "discussing",
    });
  }
  for (const m of SELECTION_TRIO) {
    await post("/post-to-node", {
      issue_ids: [],
      board_id: defaultBoardId,
      node_id: defaultNodeId,
      message: m,
      status: "discussing",
    });
  }

  const created = await post("/create-board", {
    session_id: reg.session_id,
    structure: {
      title: "Thread e2e",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  itemBoardId = created.board_id;
  for (let i = 0; i < 12; i++) {
    await post("/post-to-node", {
      issue_ids: [],
      board_id: itemBoardId,
      node_id: "i1",
      message: body(i),
      status: "discussing",
    });
  }
  for (const m of SELECTION_TRIO) {
    await post("/post-to-node", {
      issue_ids: [],
      board_id: itemBoardId,
      node_id: "i1",
      message: m,
      status: "discussing",
    });
  }
});

test.afterAll(async () => {
  if (broker && broker.exitCode === null) {
    const exited = new Promise((r) => broker.once("exit", r));
    broker.kill();
    await exited;
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

// Viewport point at the first character of `needle` (or just past its last
// character when `atEnd`), found by walking the text nodes under `root`.
async function textPoint(
  page: Page,
  root: string,
  needle: string,
  atEnd: boolean,
): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ({ root, needle, atEnd }) => {
      const walker = document.createTreeWalker(
        document.querySelector(root)!,
        NodeFilter.SHOW_TEXT,
      );
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const i = n.textContent!.indexOf(needle);
        if (i < 0) continue;
        const off = atEnd ? i + needle.length - 1 : i;
        const r = document.createRange();
        r.setStart(n, off);
        r.setEnd(n, off + 1);
        const b = r.getBoundingClientRect();
        return { x: atEnd ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 };
      }
      return null;
    },
    { root, needle, atEnd },
  );
  expect(p, `text "${needle}" not found under ${root}`).not.toBeNull();
  return p!;
}

async function dragSelect(page: Page, root: string): Promise<string[]> {
  const from = await textPoint(page, root, "SELA-start", false);
  const to = await textPoint(page, root, "SELC-end", true);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const text = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  return [...text.matchAll(/SEL([ABC])-(start|end)/g)].map((m) => `${m[1]}-${m[2]}`);
}

const ALL_THREE = ["A-start", "A-end", "B-start", "B-end", "C-start", "C-end"];

async function openDefaultBoard(page: Page) {
  await page.goto(`${base}/board/${defaultBoardId}`);
  await page.locator(".default-board-thread").waitFor();
  await page.getByText("SELC-start", { exact: false }).first().waitFor();
  await page.waitForTimeout(500);
}

// Distance (px) between the bottom of the scroller and the bottom of the row
// containing `needle`; 0 means the row sits flush at the visual bottom.
async function gapBelow(page: Page, root: string, needle: string) {
  return page.evaluate(
    ({ root, needle }) => {
      const el = document.querySelector(root) as HTMLElement;
      const row = Array.from(el.querySelectorAll(".thread-msg")).find((m) =>
        m.textContent?.includes(needle),
      ) as HTMLElement;
      return el.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom;
    },
    { root, needle },
  );
}

test.describe("chat thread", () => {
  test("default board opens pinned to the bottom and follows a new message", async ({ page }) => {
    await openDefaultBoard(page);
    const root = ".default-board-thread";
    expect(Math.abs(await gapBelow(page, root, "SELC-end"))).toBeLessThanOrEqual(8);

    await post("/post-to-node", {
      issue_ids: [],
      board_id: defaultBoardId,
      node_id: defaultNodeId,
      message: "LIVE-ARRIVAL while pinned",
      status: "discussing",
    });
    await page.getByText("LIVE-ARRIVAL while pinned").first().waitFor();
    await page.waitForTimeout(300);
    expect(Math.abs(await gapBelow(page, root, "LIVE-ARRIVAL"))).toBeLessThanOrEqual(8);
  });

  test("default board: drag selection across messages reads top-to-bottom", async ({ page }) => {
    await openDefaultBoard(page);
    expect(await dragSelect(page, ".default-board-thread")).toEqual(ALL_THREE);
  });

  test("item card thread: drag selection across messages reads top-to-bottom", async ({ page }) => {
    await page.goto(`${base}/board/${itemBoardId}`);
    const root = ".item-card > .thread";
    await page.locator(root).first().waitFor();
    await page.getByText("SELC-start", { exact: false }).first().waitFor();
    await page.waitForTimeout(500);
    expect(Math.abs(await gapBelow(page, root, "SELC-end"))).toBeLessThanOrEqual(8);
    expect(await dragSelect(page, root)).toEqual(ALL_THREE);
  });

  test("default board: re-scrolling deep history moves exactly by the wheel delta", async ({ page }) => {
    test.setTimeout(240_000);
    await openDefaultBoard(page);
    const root = ".default-board-thread";
    const box = (await page.locator(root).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Jump deep into the contained (content-visibility:auto) history: the
    // tenth-oldest row. (A percentage of scrollHeight is not used because the
    // regression this guards also collapsed scrollHeight, which put any
    // "60% up" target inside the uncontained live region.)
    const jumpDeep = () =>
      page.evaluate((root) => {
        // Oldest first by id, independent of DOM order.
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(`${root} [data-thread-item-id]`),
        ).sort((a, b) => Number(a.dataset.threadItemId) - Number(b.dataset.threadItemId));
        rows[10].scrollIntoView({ block: "center" });
      }, root);

    // One wheel step: how far (px) the row under the viewport centre moved
    // compared with the wheel delta. null when the scroller was already at
    // the edge the step pushes against (nothing to measure).
    const step = async (
      dy: number,
    ): Promise<{ err: number; index: number } | null> => {
      const before = await page.evaluate(
        ({ root, dy }) => {
          const el = document.querySelector(root) as HTMLElement;
          const range = el.scrollHeight - el.clientHeight;
          // column-reverse: 0 = bottom, scrolling up goes negative.
          const fromBottom = Math.abs(el.scrollTop);
          if ((dy > 0 && fromBottom < 1) || (dy < 0 && range - fromBottom < Math.abs(dy)))
            return null;
          const r = el.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          // The first row reaching past the centre (it may fall in a gap).
          const rows = Array.from(
            el.querySelectorAll<HTMLElement>("[data-thread-item-id]"),
          ).sort((a, b) => Number(a.dataset.threadItemId) - Number(b.dataset.threadItemId));
          for (let i = 0; i < rows.length; i++) {
            const b = rows[i].getBoundingClientRect();
            if (b.bottom >= cy)
              return { id: rows[i].dataset.threadItemId!, top: b.top, index: i };
          }
          return null;
        },
        { root, dy },
      );
      if (!before) return null;
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(100);
      const afterTop = await page.evaluate(
        ({ root, id }) =>
          document
            .querySelector(`${root} [data-thread-item-id="${id}"]`)!
            .getBoundingClientRect().top,
        { root, id: before.id },
      );
      return { err: Math.round(Math.abs(afterTop - before.top + dy)), index: before.index };
    };
    // Wheel down from the tenth-oldest row until the centre reaches row 100
    // (still inside the contained history), then back up to row 10.
    const pass = async () => {
      await jumpDeep();
      await page.waitForTimeout(300);
      const errors: number[] = [];
      for (let i = 0; i < 120; i++) {
        const r = await step(200);
        if (!r) break;
        errors.push(r.err);
        if (r.index >= 100) break;
      }
      for (let i = 0; i < 120; i++) {
        const r = await step(-200);
        if (!r) break;
        errors.push(r.err);
        if (r.index <= 10) break;
      }
      return errors;
    };

    // Pass 1 renders every row it crosses for the first time. A never-painted
    // deep row still swaps its height estimate for its real height then, which
    // can shift the view once (not asserted here). Pass 2 crosses the same,
    // now-rendered rows again: each must keep its remembered size, so the
    // content must move by exactly the wheel delta. (Before the single-wrapper
    // structure, contained rows were flex-shrunk to their padding whenever
    // skipped, so every pass jumped by hundreds of px.)
    const first = await pass();
    const second = await pass();
    console.log("wheel errors pass1", JSON.stringify(first));
    console.log("wheel errors pass2", JSON.stringify(second));
    expect(second.length).toBeGreaterThan(20);
    expect(Math.max(...second)).toBeLessThanOrEqual(4);
  });
});
