import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, post, registerSession } from "../harness/broker-harness.ts";

describe("migrations are idempotent across broker restarts", () => {
  test("starting twice on the same DB does not error or lose data", async () => {
    // Pin the DB path so two separate startBroker() calls share a file.
    const homeA = mkdtempSync(join(tmpdir(), "pd-mig-"));
    const dbPath = join(homeA, "db.sqlite");

    // First boot: create a session, kill broker.
    const first = await startBroker({
      PARALLEL_DISCUSSION_HOME: homeA,
      PARALLEL_DISCUSSION_DB: dbPath,
    });
    const sid = await registerSession(first.url, "/tmp/persist");
    await first.kill();

    // Second boot on same DB: migrations should NOT throw, and the prior
    // session row should still exist (heartbeat finds it).
    const second = await startBroker({
      PARALLEL_DISCUSSION_HOME: homeA,
      PARALLEL_DISCUSSION_DB: dbPath,
    });
    try {
      const r = await post<{ ok: boolean }>(`${second.url}/heartbeat`, {
        session_id: sid,
      });
      expect(r.json.ok).toBe(true);
    } finally {
      await second.kill();
      rmSync(homeA, { recursive: true, force: true });
    }
  });
});
