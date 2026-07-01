import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBroker,
  post,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

describe("cli-verbosity preference", () => {
  test("/get-cli-verbosity defaults to 'default'", async () => {
    const r = await post<{ verbosity: string }>(
      `${broker.url}/get-cli-verbosity`,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.json.verbosity).toBe("default");
  });

  test("/set-cli-verbosity accepts each of the three valid modes", async () => {
    for (const verbosity of ["concise", "silent", "default"] as const) {
      const r = await post<{ ok: boolean; verbosity: string }>(
        `${broker.url}/set-cli-verbosity`,
        { verbosity },
      );
      expect(r.json.ok).toBe(true);
      expect(r.json.verbosity).toBe(verbosity);
      const after = await post<{ verbosity: string }>(
        `${broker.url}/get-cli-verbosity`,
        {},
      );
      expect(after.json.verbosity).toBe(verbosity);
    }
  });

  test("/set-cli-verbosity rejects an unknown mode", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/set-cli-verbosity`,
      { verbosity: "loud" },
    );
    expect(r.json.ok).toBe(false);
  });

  test("the mode is persisted to $HOME_DIR/config.json", async () => {
    await post(`${broker.url}/set-cli-verbosity`, { verbosity: "silent" });
    const cfgPath = join(broker.homeDir, "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.cliVerbosity).toBe("silent");
  });

  test("the mode rides the /poll-messages response", async () => {
    await post(`${broker.url}/set-cli-verbosity`, { verbosity: "concise" });
    const r = await post<{ cli_verbosity?: string }>(
      `${broker.url}/poll-messages`,
      { session_id: "s_nonexistent" },
    );
    expect(r.json.cli_verbosity).toBe("concise");
  });

  test("a fresh broker reloads the persisted mode from disk", async () => {
    await post(`${broker.url}/set-cli-verbosity`, { verbosity: "silent" });
    const survival = mkdtempSync(join(tmpdir(), "pd-cliverb-survival-"));
    cpSync(broker.homeDir, survival, { recursive: true });
    await broker.kill();
    const second = await startBroker({
      DISCUSSION_TREE_HOME: survival,
      DISCUSSION_TREE_DB: join(survival, "db.sqlite"),
    });
    try {
      const r = await post<{ verbosity: string }>(
        `${second.url}/get-cli-verbosity`,
        {},
      );
      expect(r.json.verbosity).toBe("silent");
    } finally {
      // Reassign so afterAll's kill() doesn't try to stop the dead one.
      broker = second;
    }
  });
});
