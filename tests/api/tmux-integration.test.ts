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

describe("tmux-integration preference", () => {
  test("/get-tmux-integration defaults to false + unconfigured", async () => {
    const r = await post<{ value: boolean; configured: boolean }>(
      `${broker.url}/get-tmux-integration`,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.json.value).toBe(false);
    // Unconfigured until first write — lets the client seed it from a legacy
    // localStorage value exactly once.
    expect(r.json.configured).toBe(false);
  });

  test("/set-tmux-integration flips the value and marks it configured", async () => {
    const set = await post<{ ok: boolean; value: boolean }>(
      `${broker.url}/set-tmux-integration`,
      { value: true },
    );
    expect(set.json.ok).toBe(true);
    expect(set.json.value).toBe(true);
    const get = await post<{ value: boolean; configured: boolean }>(
      `${broker.url}/get-tmux-integration`,
      {},
    );
    expect(get.json.value).toBe(true);
    expect(get.json.configured).toBe(true);
  });

  test("/set-tmux-integration rejects a non-boolean value", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/set-tmux-integration`,
      { value: "yes" },
    );
    expect(r.json.ok).toBe(false);
  });

  test("the value is persisted to $HOME_DIR/config.json", async () => {
    await post(`${broker.url}/set-tmux-integration`, { value: true });
    const cfgPath = join(broker.homeDir, "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.tmuxIntegration).toBe(true);
  });

  test("a fresh broker reloads the persisted value (configured=true)", async () => {
    await post(`${broker.url}/set-tmux-integration`, { value: true });
    const survival = mkdtempSync(join(tmpdir(), "pd-tmuxint-survival-"));
    cpSync(broker.homeDir, survival, { recursive: true });
    await broker.kill();
    const second = await startBroker({
      DISCUSSION_TREE_HOME: survival,
      DISCUSSION_TREE_DB: join(survival, "db.sqlite"),
    });
    try {
      const r = await post<{ value: boolean; configured: boolean }>(
        `${second.url}/get-tmux-integration`,
        {},
      );
      expect(r.json.value).toBe(true);
      expect(r.json.configured).toBe(true);
    } finally {
      broker = second;
    }
  });
});
