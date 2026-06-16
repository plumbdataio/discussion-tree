import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The StopFailure hook POSTs /session-stalled when a turn ends with an API
// error. The broker marks the owning session stalled; the sidebar + header
// read it via /api/sessions and the board/map view. Any sign of life (tool
// heartbeat / normal Stop / re-attach) clears it.

let broker: BrokerHandle;
let sessionId: string;
let ccId: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  ccId = await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
});

async function sessionItem(
  sid: string,
): Promise<{ stalled?: boolean; activity?: { state: string } | null } | undefined> {
  const res = await get<{
    sessions: {
      id: string;
      stalled?: boolean;
      activity?: { state: string } | null;
    }[];
    inactive_sessions?: { id: string; stalled?: boolean }[];
  }>(`${broker.url}/api/sessions`);
  const all = [...res.json.sessions, ...(res.json.inactive_sessions ?? [])];
  return all.find((s) => s.id === sid);
}

async function isStalled(sid: string): Promise<boolean> {
  return (await sessionItem(sid))?.stalled ?? false;
}

async function stall() {
  const r = await post<{ ok: boolean }>(`${broker.url}/session-stalled`, {
    cc_session_id: ccId,
  });
  expect(r.json.ok).toBe(true);
}

describe("session stall (StopFailure → UI warning)", () => {
  test("/session-stalled marks the session stalled in /api/sessions", async () => {
    expect(await isStalled(sessionId)).toBe(false);
    await stall();
    expect(await isStalled(sessionId)).toBe(true);
  });

  test("a tool heartbeat (PreToolUse) clears the stall", async () => {
    await stall();
    expect(await isStalled(sessionId)).toBe(true);
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Read",
    });
    expect(await isStalled(sessionId)).toBe(false);
  });

  test("a normal Stop (clear-tool-activity) clears the stall", async () => {
    await stall();
    expect(await isStalled(sessionId)).toBe(true);
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    expect(await isStalled(sessionId)).toBe(false);
  });

  test("a SessionStart re-attach clears the stall", async () => {
    await stall();
    expect(await isStalled(sessionId)).toBe(true);
    await post(`${broker.url}/attach-cc-session`, {
      session_id: sessionId,
      cc_session_id: ccId,
    });
    expect(await isStalled(sessionId)).toBe(false);
  });

  test("/channel-pushed clears the stall (poller acked a resolved push)", async () => {
    await stall();
    expect(await isStalled(sessionId)).toBe(true);
    // The poller learns stalled_at from the /poll-messages drain and echoes it.
    const poll = await post<{ stalled_at: string | null }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    expect(poll.json.stalled_at).toBeTruthy();
    const r = await post<{ ok: boolean }>(`${broker.url}/channel-pushed`, {
      session_id: sessionId,
      stalled_at: poll.json.stalled_at,
    });
    expect(r.json.ok).toBe(true);
    expect(await isStalled(sessionId)).toBe(false);
  });

  test("/channel-pushed needs a session_id and a MATCHING stalled_at", async () => {
    const r1 = await post<{ ok: boolean }>(`${broker.url}/channel-pushed`, {});
    expect(r1.json.ok).toBe(false);
    // Unknown id: identity-guarded clear is a no-op but the endpoint returns ok.
    const r2 = await post<{ ok: boolean }>(`${broker.url}/channel-pushed`, {
      session_id: "sess-does-not-exist",
      stalled_at: new Date().toISOString(),
    });
    expect(r2.json.ok).toBe(true);

    await stall();
    expect(await isStalled(sessionId)).toBe(true);
    // An ack with NO stalled_at must not clear a real stall (drain wasn't stalled).
    await post(`${broker.url}/channel-pushed`, { session_id: sessionId });
    expect(await isStalled(sessionId)).toBe(true);
    // An ack with a stale (non-matching) stalled_at must not clear it either.
    await post(`${broker.url}/channel-pushed`, {
      session_id: sessionId,
      stalled_at: "1999-01-01T00:00:00.000Z",
    });
    expect(await isStalled(sessionId)).toBe(true);
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
  });

  test("a stale push ack does NOT clear a newer stall (codex P2)", async () => {
    // The pushed turn can fail and record a NEW stall (different stalled_at)
    // before this push's fire-and-forget ack lands. The ack carries the OLD
    // stalled_at, so the identity guard must make it a no-op on the fresh stall.
    await stall();
    const poll1 = await post<{ stalled_at: string | null }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const oldStalledAt = poll1.json.stalled_at!;
    expect(oldStalledAt).toBeTruthy();

    // Simulate the turn failing → a fresh stall with a distinct timestamp.
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    await new Promise((r) => setTimeout(r, 20)); // ensure a distinct ISO ms
    await stall();
    expect(await isStalled(sessionId)).toBe(true);

    // The delayed ack carries the OLD stalled_at → must be a no-op.
    await post(`${broker.url}/channel-pushed`, {
      session_id: sessionId,
      stalled_at: oldStalledAt,
    });
    expect(await isStalled(sessionId)).toBe(true);

    // A matching ack (the fresh stalled_at) DOES clear it.
    const poll2 = await post<{ stalled_at: string | null }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    expect(poll2.json.stalled_at).not.toBe(oldStalledAt);
    await post(`${broker.url}/channel-pushed`, {
      session_id: sessionId,
      stalled_at: poll2.json.stalled_at,
    });
    expect(await isStalled(sessionId)).toBe(false);
  });

  test("draining a delivery does NOT clear the stall — only /channel-pushed does", async () => {
    // The codex P2: `delivered` flips when the poller DRAINS the queue, before
    // its channel notification to CC is attempted. Clearing the stall on that
    // flag would wipe the ⚠️ even if the push then throws. So a drain alone must
    // leave the stall; only the poller's post-push /channel-pushed ack clears it.
    const res = await get<{
      sessions: { id: string; boards: { id: string }[] }[];
    }>(`${broker.url}/api/sessions`);
    const me = res.json.sessions.find((s) => s.id === sessionId)!;
    const boardId = me.boards[0].id;

    await stall();
    expect(await isStalled(sessionId)).toBe(true);

    // Fire a submit (blocks until delivered/timeout) WITHOUT awaiting, then drain
    // it via /poll-messages so its row flips delivered=1 — exactly the broker
    // state right before the MCP poller attempts the channel notification. The
    // drain also returns the stall timestamp the poller will echo on its ack.
    const submitP = post(`${broker.url}/submit-answer`, {
      board_id: boardId,
      node_id: "main",
      text: "continue",
    });
    await new Promise((r) => setTimeout(r, 150));
    const poll = await post<{ stalled_at: string | null }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );

    // Delivered, but the push hasn't been acked → still stalled.
    expect(await isStalled(sessionId)).toBe(true);

    // Poller acks the resolved push (echoing the drained stalled_at) → clears.
    await post(`${broker.url}/channel-pushed`, {
      session_id: sessionId,
      stalled_at: poll.json.stalled_at,
    });
    expect(await isStalled(sessionId)).toBe(false);

    await submitP; // let the (now-delivered) submit resolve
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
  });

  test("stalling clears a leftover 'working' badge (StopFailure ≠ Stop)", async () => {
    // A tool heartbeat marks the session working. StopFailure fires INSTEAD of
    // Stop, so without an explicit clear the badge would spin next to the
    // stall warning forever.
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Bash",
    });
    expect((await sessionItem(sessionId))?.activity?.state).toBe("working");
    await stall();
    const after = await sessionItem(sessionId);
    expect(after?.stalled).toBe(true);
    expect(after?.activity?.state).not.toBe("working");
    // reset for later tests
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
  });

  test("/session-stalled is a no-op for an unknown cc_session_id", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/session-stalled`, {
      cc_session_id: "cc-does-not-exist",
    });
    expect(r.json.ok).toBe(false);
  });

  test("the board view exposes owner_stalled", async () => {
    // attachCC created the default board; find its id via /api/sessions.
    const res = await get<{
      sessions: { id: string; boards: { id: string }[] }[];
    }>(`${broker.url}/api/sessions`);
    const me = res.json.sessions.find((s) => s.id === sessionId)!;
    const boardId = me.boards[0].id;

    await stall();
    const stalledView = await get<{ owner_stalled?: boolean }>(
      `${broker.url}/api/board/${boardId}`,
    );
    expect(stalledView.json.owner_stalled).toBe(true);

    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    const clearedView = await get<{ owner_stalled?: boolean }>(
      `${broker.url}/api/board/${boardId}`,
    );
    expect(clearedView.json.owner_stalled).toBe(false);
  });
});
