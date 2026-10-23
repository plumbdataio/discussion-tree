// /cli-inject-acked stores the MCP's outcome on the cli_injects row and tells
// the UI when a queued inject failed or was never confirmed. Before this the
// ack's ok/error were discarded, so a send that did nothing looked like one
// that worked (delivered=1 either way).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, post, type BrokerHandle } from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  // Short ack timeout so the "no confirmation" notice fires within the test.
  broker = await startBroker({ DT_CLI_INJECT_ACK_TIMEOUT_MS: "400" });
});
afterAll(async () => {
  await broker.kill();
});

async function queuedInject(): Promise<{ sid: string; id: number }> {
  const r = await post<{ session_id: string }>(`${broker.url}/register`, {
    pid: 98000 + Math.floor(Math.random() * 1000),
    cwd: "/tmp/pd-remote-ack",
    remote: true,
  });
  const sid = r.json.session_id;
  await post(`${broker.url}/attach-cc-session`, {
    session_id: sid,
    cc_session_id: `cc-ack-${sid}`,
    tmux_pane: "%2",
    tmux_socket: "/tmp/psmux-1/default",
  });
  const sent = await post<{ ok: boolean; queued?: boolean }>(
    `${broker.url}/cli-send`,
    { session_id: sid, command: "/compact", args: "" },
  );
  expect(sent.json.queued).toBe(true);
  const drained = await post<{ cli_injects?: { id: number }[] }>(
    `${broker.url}/poll-messages`,
    { session_id: sid },
  );
  const id = drained.json.cli_injects?.[0]?.id;
  expect(typeof id).toBe("number");
  return { sid, id: id! };
}

function row(id: number): {
  ok: number | null;
  error: string | null;
  acked_at: string | null;
} {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    return db
      .query("SELECT ok, error, acked_at FROM cli_injects WHERE id = ?")
      .get(id) as any;
  } finally {
    db.close();
  }
}

// Collect cli-inject-result events from the banner socket (the one every page
// opens) while `during` runs, then for `waitMs` more.
function collectResults(
  during: () => Promise<unknown>,
  waitMs: number,
): Promise<any[]> {
  const port = new URL(broker.url).port;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/_banner`);
    const got: any[] = [];
    ws.addEventListener("message", (e) => {
      try {
        const m = JSON.parse(e.data as string);
        if (m?.type === "cli-inject-result") got.push(m);
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("open", async () => {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await during();
      } catch (e) {
        ws.close();
        reject(e);
        return;
      }
      setTimeout(() => {
        ws.close();
        resolve(got);
      }, waitMs);
    });
  });
}

describe("/cli-inject-acked result", () => {
  test("ok:false stores the error and broadcasts a failure event", async () => {
    let id = 0;
    let sid = "";
    const events = await collectResults(async () => {
      ({ sid, id } = await queuedInject());
      const ack = await post<{ ok: boolean }>(`${broker.url}/cli-inject-acked`, {
        id,
        ok: false,
        error: "tmux_failed: send-keys C-u exited 1 (ambiguous pane id %2)",
      });
      expect(ack.json.ok).toBe(true);
    }, 700);
    const r = row(id);
    expect(r.ok).toBe(0);
    expect(r.error).toContain("ambiguous pane id");
    expect(r.acked_at).toBeTruthy();
    const mine = events.filter((e) => e.inject_id === id);
    // One failure event, and the timeout notice must NOT also fire.
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({
      status: "failed",
      session_id: sid,
      command: "/compact",
    });
    expect(mine[0].error).toContain("ambiguous pane id");
  });

  test("ok:true stores success and broadcasts nothing", async () => {
    let id = 0;
    const events = await collectResults(async () => {
      ({ id } = await queuedInject());
      await post(`${broker.url}/cli-inject-acked`, { id, ok: true });
    }, 700);
    const r = row(id);
    expect(r.ok).toBe(1);
    expect(r.error).toBeNull();
    expect(r.acked_at).toBeTruthy();
    expect(events.filter((e) => e.inject_id === id)).toEqual([]);
  });

  test("no ack after delivery -> a no_ack notice", async () => {
    let id = 0;
    const events = await collectResults(async () => {
      ({ id } = await queuedInject());
    }, 900);
    const mine = events.filter((e) => e.inject_id === id);
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({ status: "no_ack", command: "/compact" });
    expect(row(id).acked_at).toBeNull();
  });

  test("ok:false without an error text is stored as unknown", async () => {
    const { id } = await queuedInject();
    await post(`${broker.url}/cli-inject-acked`, { id, ok: false });
    expect(row(id).error).toBe("unknown");
  });
});
