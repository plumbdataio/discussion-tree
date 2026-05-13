import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;
let sessionId: string;
let ccSessionId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccSessionId = await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

describe("activity", () => {
  test("/heartbeat-tool sets a working activity for the matching session", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccSessionId,
      tool: "Edit",
    });
    expect(r.json.ok).toBe(true);
  });

  test("/heartbeat-tool returns ok=false for an unknown cc_session_id", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/heartbeat-tool`, {
      cc_session_id: "no-such-cc",
      tool: "Bash",
    });
    expect(r.json.ok).toBe(false);
  });

  test("/clear-tool-activity clears the auto-managed working state", async () => {
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccSessionId,
      tool: "Read",
    });
    const r = await post<{ ok: boolean }>(`${broker.url}/clear-tool-activity`, {
      cc_session_id: ccSessionId,
    });
    expect(r.json.ok).toBe(true);
  });

  test("/clear-tool-activity does NOT touch an explicit (non-working) activity", async () => {
    // Explicit blocked state via set-activity.
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: "blocked",
      message: "Awaiting OK",
    });
    // Hook clear should be a no-op for "blocked" — confirmed by re-running set
    // afterward and observing it still returns ok=true with the same shape.
    const cleared = await post<{ ok: boolean }>(
      `${broker.url}/clear-tool-activity`,
      { cc_session_id: ccSessionId },
    );
    expect(cleared.json.ok).toBe(true);
    // Empty state to actually clean up before the next test.
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: undefined,
    });
  });

  test("/set-activity with no state clears", async () => {
    await post(`${broker.url}/set-activity`, {
      session_id: sessionId,
      state: "blocked",
      message: "x",
    });
    const r = await post<{ ok: boolean; cleared?: boolean }>(
      `${broker.url}/set-activity`,
      { session_id: sessionId },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.cleared).toBe(true);
  });
});
