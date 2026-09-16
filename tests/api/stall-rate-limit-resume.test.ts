import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// dt-native "resume at the reset time" for a rate_limit cap (broker/activity.ts).
// A cap must NOT be nudged every ~30s; dt arms a SINGLE resume timer aimed at the
// cap's reset time + RESUME_AFTER_RESET_MS and fires the auto-continue exactly
// once. The cause + reset time are injected over HTTP (`reason` / `reset_at`) via
// the same seam the fire-time classifier would otherwise fill from the transcript
// — the parser itself is unit-tested in stall-reason.test.ts.
//
// Timings are compressed via env: the classify phase fires at 40ms
// (DT_AUTO_CONTINUE_MS) and the safety margin is 40ms (DT_RESUME_AFTER_RESET_MS),
// so a whole two-phase cycle completes in well under a second. `reset_at` is an
// absolute epoch in MS, matching what scheduleAutoContinue expects.

const AUTO_PREFIX = "[discussion-tree auto-continue]";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker({
    DT_AUTO_CONTINUE_MS: "40",
    DT_RESUME_AFTER_RESET_MS: "40",
  });
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

describe("stall rate_limit reset-time resume", () => {
  test("resumes exactly ONCE, after the reset + margin (not at classify time)", async () => {
    const { sessionId, ccId } = await freshSession();
    // Reset ~200ms out: classify fires at ~40ms and arms the resume for
    // reset+margin (~240ms). The nudge must NOT appear before then.
    const resetAt = Date.now() + 200;
    await post(`${broker.url}/session-stalled`, {
      cc_session_id: ccId,
      reason: "rate_limit",
      reset_at: resetAt,
    });

    // After the classify phase but before the resume: still nothing sent.
    await sleep(120);
    expect(await nudgeCount(sessionId)).toBe(0);

    // Past reset + margin: exactly one resume.
    await sleep(400);
    expect(await nudgeCount(sessionId)).toBe(1);

    // And it does not keep firing afterward.
    await sleep(200);
    expect(await nudgeCount(sessionId)).toBe(0); // poll drains, so a re-fire would show up
  });

  test("repeated stalls while capped do NOT stack — still one resume", async () => {
    const { sessionId, ccId } = await freshSession();
    const resetAt = Date.now() + 150;
    for (let i = 0; i < 3; i++) {
      await post(`${broker.url}/session-stalled`, {
        cc_session_id: ccId,
        reason: "rate_limit",
        reset_at: resetAt,
      });
      await sleep(15);
    }
    await sleep(500);
    expect(await nudgeCount(sessionId)).toBe(1);
  });

  test("recovery before the resume fires → nothing sent", async () => {
    const { sessionId, ccId } = await freshSession();
    const resetAt = Date.now() + 300; // resume would fire ~340ms after classify
    await post(`${broker.url}/session-stalled`, {
      cc_session_id: ccId,
      reason: "rate_limit",
      reset_at: resetAt,
    });
    // Let the classify phase fire and arm the resume, then show life: a tool
    // heartbeat clears the stall and cancels the pending resume.
    await sleep(120);
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Read",
    });
    await sleep(500);
    expect(await nudgeCount(sessionId)).toBe(0);
  });

  test("rate_limit with no reset_at and no stored limits → nothing sent (never hammer)", async () => {
    const { sessionId, ccId } = await freshSession();
    // No reset_at, no transcript, and this broker has never received a usage
    // limits report → the resume time is unknown → suppress rather than hammer.
    await post(`${broker.url}/session-stalled`, {
      cc_session_id: ccId,
      reason: "rate_limit",
    });
    await sleep(300);
    expect(await nudgeCount(sessionId)).toBe(0);
  });
});
