import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  startBroker,
  post,
  registerSession,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// pending_messages is a delivery queue, not an archive, and nothing reads a
// finished row — so without a purge it grows forever (it had reached 6,583 rows
// spanning three months before this existed).
//
// The interesting half of the contract is what the purge must NOT take:
// "delivered" alone does not mean "done". A row is still live to the submit
// poll for a few seconds, and to the unacked resweep for its grace window. So
// these tests pin the boundary, not just the deletion.

let broker: BrokerHandle;
let db: Database;
let sessionId: string;

const insert = (fields: {
  id: number;
  createdAt: string;
  delivered?: number;
  cancelled?: number;
  pushedAt?: string | null;
}) => {
  db.run(
    `INSERT INTO pending_messages
       (id, session_id, board_id, node_id, node_path, text, created_at,
        delivered, cancelled, pushed_at)
     VALUES (?, ?, 'b', 'n', 'b > n', 'x', ?, ?, ?, ?)`,
    [
      fields.id,
      sessionId,
      fields.createdAt,
      fields.delivered ?? 0,
      fields.cancelled ?? 0,
      fields.pushedAt ?? null,
    ],
  );
};

const ids = (): number[] =>
  (db.prepare("SELECT id FROM pending_messages ORDER BY id").all() as {
    id: number;
  }[]).map((r) => r.id);

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = new Date().toISOString();

beforeAll(async () => {
  // The default 7-day window is what ships, and both sides of the boundary are
  // reachable without waiting: a row stamped months ago is past it, one stamped
  // now is not. (A 0-day window would put "now" on the wrong side by the time
  // the purge runs.)
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  db = new Database(join(broker.homeDir, "db.sqlite"));
  db.run("DELETE FROM pending_messages");
});
afterAll(async () => {
  db?.close();
  await broker.kill();
});

describe("pending_messages — the purge takes only what is finished", () => {
  test("old delivered and cancelled rows go; queued and fresh rows stay", async () => {
    insert({ id: 1, createdAt: OLD, delivered: 1, pushedAt: OLD }); // acked, old
    insert({ id: 2, createdAt: OLD, delivered: 1 }); // delivered, never acked
    insert({ id: 3, createdAt: OLD, cancelled: 1 }); // cancelled, old
    insert({ id: 4, createdAt: OLD, delivered: 0 }); // STILL QUEUED
    insert({ id: 5, createdAt: NOW, delivered: 1, pushedAt: NOW }); // just now

    const r = await post<{ ok: boolean; deleted: number; unacked: number }>(
      `${broker.url}/purge-pending`,
      {},
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.deleted).toBe(3);
    // Rows that never reached CC are counted separately: their disappearance is
    // worth seeing in the log rather than inferring from a total.
    expect(r.json.unacked).toBe(1);

    // 4 is undelivered — deleting it would silently drop a message the user
    // sent. 5 is seconds old and the submitting browser may still be polling it.
    expect(ids()).toEqual([4, 5]);
  });

  test("running it again is a no-op", async () => {
    const r = await post<{ deleted: number }>(`${broker.url}/purge-pending`, {});
    expect(r.json.deleted).toBe(0);
    expect(ids()).toEqual([4, 5]);
  });
});
