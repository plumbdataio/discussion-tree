import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Per-cause stall handling (broker/activity.ts handleSessionStalled): only a
// transient error should get an auto-continue nudge. A usage cap (rate_limit)
// or a login expiry must NOT be nudged — the old code hammered "continue" at
// both. A login expiry additionally drops a one-time UI notice. Cause is
// overridden directly via `reason` here (the classifier itself is unit-tested
// in stall-reason.test.ts). Fresh session per case: the streak / login-notice
// state is per-session.

const AUTO_PREFIX = "[discussion-tree auto-continue]";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker({ DT_AUTO_CONTINUE_MS: "60" });
});
afterAll(async () => {
  await broker.kill();
});

async function freshSession(): Promise<{ sessionId: string; ccId: string }> {
  const sessionId = await registerSession(broker.url);
  const ccId = await attachCC(broker.url, sessionId); // also creates the default board
  return { sessionId, ccId };
}

async function nudgeCount(sessionId: string): Promise<number> {
  const r = await post<{ messages: Array<{ text?: string }> }>(
    `${broker.url}/poll-messages`,
    { session_id: sessionId },
  );
  return (r.json.messages ?? []).filter(
    (m) => typeof m.text === "string" && m.text.startsWith(AUTO_PREFIX),
  ).length;
}

async function defaultBoardId(sessionId: string): Promise<string> {
  const r = await post<{ boards: Array<{ id: string; is_default: number }> }>(
    `${broker.url}/list-boards`,
    { session_id: sessionId },
  );
  const b = r.json.boards.find((x) => x.is_default === 1);
  if (!b) throw new Error("no default board");
  return b.id;
}

describe("stall per-cause auto-continue", () => {
  test("transient → one nudge fires", async () => {
    const { sessionId, ccId } = await freshSession();
    const r = await post<{ ok: boolean; reason?: string }>(
      `${broker.url}/session-stalled`,
      { cc_session_id: ccId, reason: "transient" },
    );
    expect(r.json.reason).toBe("transient");
    await sleep(220);
    expect(await nudgeCount(sessionId)).toBe(1);
  });

  test("rate_limit → NO nudge (bridge handles the reset-time resume)", async () => {
    const { sessionId, ccId } = await freshSession();
    const r = await post<{ ok: boolean; reason?: string }>(
      `${broker.url}/session-stalled`,
      { cc_session_id: ccId, reason: "rate_limit" },
    );
    expect(r.json.reason).toBe("rate_limit");
    await sleep(220);
    expect(await nudgeCount(sessionId)).toBe(0);
  });

  test("login → NO nudge, but a one-time system notice lands on the board", async () => {
    const { sessionId, ccId } = await freshSession();
    const boardId = await defaultBoardId(sessionId);

    const r = await post<{ ok: boolean; reason?: string }>(
      `${broker.url}/session-stalled`,
      { cc_session_id: ccId, reason: "login" },
    );
    expect(r.json.reason).toBe("login");
    await sleep(220);
    expect(await nudgeCount(sessionId)).toBe(0);

    const board = await get<{ threads: Record<string, any[]> }>(
      `${broker.url}/api/board/${boardId}`,
    );
    const notes = (board.json.threads.main ?? []).filter(
      (t) => t.source === "system" && String(t.text).includes("Login expired"),
    );
    expect(notes.length).toBe(1);

    // A second login stall does NOT duplicate the notice (dedup per episode).
    await post(`${broker.url}/session-stalled`, {
      cc_session_id: ccId,
      reason: "login",
    });
    const board2 = await get<{ threads: Record<string, any[]> }>(
      `${broker.url}/api/board/${boardId}`,
    );
    const notes2 = (board2.json.threads.main ?? []).filter(
      (t) => t.source === "system" && String(t.text).includes("Login expired"),
    );
    expect(notes2.length).toBe(1);
  });

  test("no reason + no transcript → transient (backward compatible)", async () => {
    const { sessionId, ccId } = await freshSession();
    const r = await post<{ ok: boolean; reason?: string }>(
      `${broker.url}/session-stalled`,
      { cc_session_id: ccId },
    );
    expect(r.json.reason).toBe("transient");
    await sleep(220);
    expect(await nudgeCount(sessionId)).toBe(1);
  });
});
