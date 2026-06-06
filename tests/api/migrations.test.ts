import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
} from "../harness/broker-harness.ts";

describe("migrations are idempotent across broker restarts", () => {
  test("starting twice on the same DB does not error or lose data", async () => {
    // Pin the DB path so two separate startBroker() calls share a file.
    const homeA = mkdtempSync(join(tmpdir(), "pd-mig-"));
    const dbPath = join(homeA, "db.sqlite");

    // First boot: create a session, kill broker.
    const first = await startBroker({
      DISCUSSION_TREE_HOME: homeA,
      DISCUSSION_TREE_DB: dbPath,
    });
    const sid = await registerSession(first.url, "/tmp/persist");
    await first.kill();

    // Second boot on same DB: migrations should NOT throw, and the prior
    // session row should still exist (heartbeat finds it).
    const second = await startBroker({
      DISCUSSION_TREE_HOME: homeA,
      DISCUSSION_TREE_DB: dbPath,
    });
    try {
      const r = await post<{ ok: boolean }>(`${second.url}/heartbeat`, {
        session_id: sid,
      });
      expect(r.json.ok).toBe(true);

      // The checklist + sources schema (added later) must work after a
      // second migration pass on an existing DB.
      await attachCC(second.url, sid);
      const c = await post<{ board_id: string }>(
        `${second.url}/create-board`,
        {
          session_id: sid,
          structure: {
            title: "Mig",
            concerns: [
              {
                id: "c1",
                title: "C1",
                items: [
                  { id: "cl", title: "Checklist" },
                  { id: "dec", title: "Decision" },
                ],
              },
            ],
          },
        },
      );
      const bid = c.json.board_id;
      await post(`${second.url}/set-node-checklist`, {
        board_id: bid,
        node_id: "cl",
      });
      const rec = await post<{ ok: boolean; item_id: number }>(
        `${second.url}/record-decision`,
        {
          board_id: bid,
          node_id: "cl",
          summary: "survives a re-migration",
          sources: [{ kind: "node", id: "dec" }],
        },
      );
      expect(rec.json.ok).toBe(true);
      const v = await get<any>(`${second.url}/api/board/${bid}`);
      const item = v.json.nodes
        .find((n: any) => n.id === "cl")
        .checklist_items.find((i: any) => i.id === rec.json.item_id);
      expect(item.sources).toHaveLength(1);
      expect(item.sources[0].kind).toBe("node");
    } finally {
      await second.kill();
      rmSync(homeA, { recursive: true, force: true });
    }
  });
});
