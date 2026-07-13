import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// auto-continue streak-cap (broker/activity.ts): a stalled session (StopFailure
// hook -> /session-stalled) gets nudged with a self-describing "continue" after
// DT_AUTO_CONTINUE_MS, but only up to DT_AUTO_CONTINUE_MAX consecutive times, so
// a persistent stall (e.g. a 5h usage cap that won't lift for hours) isn't
// hammered with a nudge every ~30s. A genuine recovery resets the streak. The
// env shrinks the 30s delay so the test doesn't wait on it.

const AUTO_PREFIX = "[discussion-tree auto-continue]";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let broker: BrokerHandle;
let sessionId: string;
let ccId: string;

beforeAll(async () => {
  broker = await startBroker({
    DT_AUTO_CONTINUE_MS: "60",
    DT_AUTO_CONTINUE_MAX: "2",
  });
  sessionId = await registerSession(broker.url);
  // attachCC sets cc_session_id AND creates the default board the nudge targets.
  ccId = await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

async function stall() {
  await post(`${broker.url}/session-stalled`, { cc_session_id: ccId });
}

// Drain the session's pending queue and count how many auto-continue nudges it
// held (each fired nudge is one submitted message on the default board).
async function drainNudges(): Promise<number> {
  const r = await post<{ messages: Array<{ text?: string }> }>(
    `${broker.url}/poll-messages`,
    { session_id: sessionId },
  );
  return (r.json.messages ?? []).filter(
    (m) => typeof m.text === "string" && m.text.startsWith(AUTO_PREFIX),
  ).length;
}

describe("auto-continue streak-cap", () => {
  test("nudges up to MAX consecutive times, then stops hammering", async () => {
    // Rounds 1 & 2 are within MAX=2: each stall fires exactly one nudge.
    await stall();
    await sleep(220);
    expect(await drainNudges()).toBe(1);

    await stall();
    await sleep(220);
    expect(await drainNudges()).toBe(1);

    // Round 3 exceeds MAX: the streak is capped, so no nudge is scheduled.
    await stall();
    await sleep(220);
    expect(await drainNudges()).toBe(0);
  });

  test("a genuine recovery resets the streak so later stalls nudge again", async () => {
    // We're capped from the previous test. A real sign of life (normal Stop ->
    // /clear-tool-activity -> clearStall) clears the stall and resets the streak.
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    // A fresh stall now gets its nudges again.
    await stall();
    await sleep(220);
    expect(await drainNudges()).toBe(1);
  });
});
