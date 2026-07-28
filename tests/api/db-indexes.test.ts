import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { startBroker, type BrokerHandle } from "../harness/broker-harness.ts";

// A missing index does not fail — it just gets slower until it crosses the
// polling interval, and then the whole broker stops answering at once.
//
// That happened on 2026-07-28: none of the core tables had an index on their
// foreign keys, so /api/sessions re-scanned thread_items once per board (twice,
// counting the unread totals) and took ~4.2s on a 25 MB database. The sidebar
// polls it every 10s in every open tab and Bun.serve is single-threaded, so the
// event loop never came up for air. From the outside it looked like a network
// fault, which cost an hour of chasing Tailscale.
//
// These assertions are cheap insurance against the same silent regression: they
// pin the PLAN, not a timing, so they stay meaningful on any machine and at any
// data size.

let broker: BrokerHandle;
let db: Database;

beforeAll(async () => {
  broker = await startBroker();
  db = new Database(join(broker.homeDir, "db.sqlite"), { readonly: true });
});
afterAll(async () => {
  db?.close();
  await broker.kill();
});

const indexNames = (): string[] =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[]
  ).map((r) => r.name);

const planFor = (sql: string): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail)
    .join(" | ");

describe("db — foreign-key indexes exist on the hot tables", () => {
  test.each([
    ["idx_thread_items_board"],
    ["idx_thread_items_board_node"],
    ["idx_nodes_board"],
    ["idx_boards_session"],
    ["idx_maps_session"],
    ["idx_diagrams_session"],
    ["idx_pending_session"],
  ])("%s is created at startup", (name) => {
    expect(indexNames()).toContain(name);
  });
});

describe("db — the sidebar's queries search rather than scan", () => {
  // SCAN on these means back to the 4-second /api/sessions.
  test("thread_items is searched by board, not scanned", () => {
    const plan = planFor("SELECT 1 FROM thread_items WHERE board_id = 'x'");
    expect(plan).toContain("USING");
    expect(plan).not.toContain("SCAN thread_items");
  });

  test("the nested EXISTS behind the inactive-session list never scans thread_items", () => {
    const plan = planFor(`
      SELECT id FROM sessions WHERE alive = 0 AND EXISTS (
        SELECT 1 FROM boards b WHERE b.session_id = sessions.id AND b.archived = 0
          AND (b.is_default = 0 OR EXISTS (
            SELECT 1 FROM thread_items t WHERE t.board_id = b.id))
      )`);
    expect(plan).not.toContain("SCAN t");
    expect(plan).not.toContain("SCAN b");
  });

  test("a session's surfaces and queued messages are searched by session", () => {
    for (const sql of [
      "SELECT 1 FROM boards WHERE session_id = 'x'",
      "SELECT 1 FROM maps WHERE session_id = 'x'",
      "SELECT 1 FROM diagrams WHERE session_id = 'x'",
      "SELECT 1 FROM pending_messages WHERE session_id = 'x' AND delivered = 0",
    ]) {
      expect(planFor(sql)).toContain("USING");
    }
  });

  test("a board's nodes are searched by board", () => {
    expect(planFor("SELECT 1 FROM nodes WHERE board_id = 'x'")).toContain(
      "USING",
    );
  });
});
