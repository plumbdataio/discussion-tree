import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

describe("power / sleep-prevention", () => {
  test("/get-power-config defaults to off and reports the platform", async () => {
    const r = await post<{ pref: string; platform: string }>(
      `${broker.url}/get-power-config`,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.json.pref).toBe("off");
    expect(typeof r.json.platform).toBe("string");
    expect(r.json.platform.length).toBeGreaterThan(0);
  });

  test("/set-power-config accepts each of the three valid preferences", async () => {
    for (const pref of ["while-mcp-active", "while-broker", "off"] as const) {
      const r = await post<{ ok: boolean; pref: string }>(
        `${broker.url}/set-power-config`,
        { pref },
      );
      expect(r.json.ok).toBe(true);
      expect(r.json.pref).toBe(pref);
      const after = await post<{ pref: string }>(
        `${broker.url}/get-power-config`,
        {},
      );
      expect(after.json.pref).toBe(pref);
    }
  });

  test("/set-power-config rejects an unknown pref", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/set-power-config`,
      { pref: "bogus" },
    );
    expect(r.json.ok).toBe(false);
  });

  test("the preference is persisted to $HOME_DIR/config.json", async () => {
    await post(`${broker.url}/set-power-config`, { pref: "while-broker" });
    const cfgPath = join(broker.homeDir, "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.powerPref).toBe("while-broker");
  });

  test("a fresh broker reloads the persisted preference from disk", async () => {
    // Mutate the running broker, snapshot its home dir to a survival
    // location (the harness's kill() rm's the original), then spin up a
    // second broker pointed at the survival dir.
    await post(`${broker.url}/set-power-config`, { pref: "while-mcp-active" });
    const survival = mkdtempSync(join(tmpdir(), "pd-power-survival-"));
    cpSync(broker.homeDir, survival, { recursive: true });
    await broker.kill();
    const second = await startBroker({
      PARALLEL_DISCUSSION_HOME: survival,
      PARALLEL_DISCUSSION_DB: join(survival, "db.sqlite"),
    });
    try {
      const r = await post<{ pref: string }>(
        `${second.url}/get-power-config`,
        {},
      );
      expect(r.json.pref).toBe("while-mcp-active");
    } finally {
      // Reassign so afterAll's kill() doesn't try to stop the dead one.
      broker = second;
    }
  });
});
