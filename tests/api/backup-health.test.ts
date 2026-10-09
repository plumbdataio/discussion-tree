import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  startBroker,
  post,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// /get-backup-health reads <home>/backup-status.json on every request, so each
// test just rewrites the file and asks again (no waiting on the 5-min poll).

let broker: BrokerHandle;
type Resp = {
  ok: boolean;
  health: {
    state: string;
    error: string | null;
    finished_at: string | null;
    prune_errors: number;
    log_path: string | null;
  };
};

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

const file = () => join(broker.homeDir, "backup-status.json");
const get = () => post<Resp>(`${broker.url}/get-backup-health`, {});
function write(over: Record<string, unknown>) {
  writeFileSync(
    file(),
    JSON.stringify({
      ok: true,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      dest: "x.sqlite",
      size_bytes: 1,
      skipped_existing: false,
      pruned: 0,
      prune_errors: 0,
      error: null,
      ...over,
    }),
  );
}

describe("backup health", () => {
  test("no status file → none, no log path", async () => {
    rmSync(file(), { force: true });
    const r = await get();
    expect(r.json.ok).toBe(true);
    expect(r.json.health.state).toBe("none");
    expect(r.json.health.log_path).toBeNull();
  });

  test("fresh success → ok, log path under home", async () => {
    write({});
    const r = await get();
    expect(r.json.health.state).toBe("ok");
    expect(r.json.health.log_path).toBe(join(broker.homeDir, "backup.log"));
  });

  test("failure → failed with error", async () => {
    write({ ok: false, error: "disk full" });
    const r = await get();
    expect(r.json.health.state).toBe("failed");
    expect(r.json.health.error).toBe("disk full");
  });

  test("old success → stale", async () => {
    write({ finished_at: new Date(Date.now() - 48 * 3_600_000).toISOString() });
    expect((await get()).json.health.state).toBe("stale");
  });

  test("prune errors → ok with count", async () => {
    write({ prune_errors: 3 });
    const r = await get();
    expect(r.json.health.state).toBe("ok");
    expect(r.json.health.prune_errors).toBe(3);
  });

  test("garbage → unreadable", async () => {
    writeFileSync(file(), "not json");
    expect((await get()).json.health.state).toBe("unreadable");
  });
});
