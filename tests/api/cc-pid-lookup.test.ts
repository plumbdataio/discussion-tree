import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Recovering a cc_session_id from the CC pid alone is the path that saves a
// session whose hint file is already gone — every session started before the
// card was kept, which cannot otherwise re-attach no matter how many times the
// MCP server restarts.

let broker: BrokerHandle;
let db: Database;

const lookup = async (cc_pid: unknown) =>
  (
    await post<{ ok: boolean; cc_session_id?: string }>(
      `${broker.url}/lookup-cc-session-by-pid`,
      { cc_pid },
    )
  ).json;

beforeAll(async () => {
  broker = await startBroker();
  db = new Database(join(broker.homeDir, "db.sqlite"));
});
afterAll(async () => {
  db?.close();
  await broker.kill();
});

describe("cc pid lookup", () => {
  test("returns the cc_session_id the broker last saw for that pid", async () => {
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid, "cc-pid-1");
    db.run("UPDATE sessions SET cc_pid = 4242 WHERE id = ?", [sid]);
    expect(await lookup(4242)).toEqual({ ok: true, cc_session_id: "cc-pid-1" });
  });

  test("an unknown pid resolves to nothing rather than a wrong session", async () => {
    expect((await lookup(999999)).ok).toBe(false);
    expect((await lookup("not a number")).ok).toBe(false);
  });

  test("a pid last seen long ago is not trusted", async () => {
    // Pids get reused. Binding to a session that went quiet a week ago would
    // hand the caller somebody else's boards.
    const sid = await registerSession(broker.url);
    await attachCC(broker.url, sid, "cc-pid-stale");
    db.run("UPDATE sessions SET cc_pid = 5151, last_seen = ? WHERE id = ?", [
      "2026-01-01T00:00:00.000Z",
      sid,
    ]);
    expect((await lookup(5151)).ok).toBe(false);
  });
});
