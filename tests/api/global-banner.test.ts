import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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

describe("global banner", () => {
  test("/get-global-banner starts null", async () => {
    const r = await post<{ ok: boolean; banner: unknown }>(
      `${broker.url}/get-global-banner`,
      {},
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.banner).toBeNull();
  });

  test("/set-global-banner stores + /get-global-banner returns it", async () => {
    await post(`${broker.url}/clear-global-banner`, {});
    const set = await post<{
      ok: boolean;
      banner?: { message: string; tone: string };
    }>(`${broker.url}/set-global-banner`, {
      message: "system maintenance in 5 minutes",
      tone: "warn",
    });
    expect(set.json.ok).toBe(true);
    expect(set.json.banner?.message).toBe("system maintenance in 5 minutes");
    expect(set.json.banner?.tone).toBe("warn");

    const got = await post<{
      ok: boolean;
      banner: { message: string; tone: string } | null;
    }>(`${broker.url}/get-global-banner`, {});
    expect(got.json.banner?.message).toBe("system maintenance in 5 minutes");
    expect(got.json.banner?.tone).toBe("warn");
  });

  test("/set-global-banner rejects empty message", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/set-global-banner`,
      { tone: "info" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain("message");
  });

  test("/set-global-banner with tone fallback (unknown -> info)", async () => {
    await post(`${broker.url}/clear-global-banner`, {});
    const set = await post<{ ok: boolean; banner?: { tone: string } }>(
      `${broker.url}/set-global-banner`,
      { message: "hi", tone: "nonsense" },
    );
    expect(set.json.ok).toBe(true);
    expect(set.json.banner?.tone).toBe("info");
  });

  test("/clear-global-banner removes it", async () => {
    await post(`${broker.url}/set-global-banner`, { message: "x", tone: "info" });
    const clr = await post<{ ok: boolean }>(
      `${broker.url}/clear-global-banner`,
      {},
    );
    expect(clr.json.ok).toBe(true);
    const got = await post<{ banner: unknown }>(
      `${broker.url}/get-global-banner`,
      {},
    );
    expect(got.json.banner).toBeNull();
  });

  test("expires_at in the past clears immediately on the next /get", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await post(`${broker.url}/set-global-banner`, {
      message: "stale",
      tone: "info",
      expires_at: past,
    });
    // Give the broker a tick to run its setTimeout(0) auto-clear.
    await new Promise((r) => setTimeout(r, 20));
    const got = await post<{ banner: unknown }>(
      `${broker.url}/get-global-banner`,
      {},
    );
    expect(got.json.banner).toBeNull();
  });
});
