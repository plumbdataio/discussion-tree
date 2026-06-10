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

async function isStalled(sid: string): Promise<boolean> {
  const res = await get<{
    sessions: { id: string; stalled?: boolean }[];
    inactive_sessions?: { id: string; stalled?: boolean }[];
  }>(`${broker.url}/api/sessions`);
  const all = [...res.json.sessions, ...(res.json.inactive_sessions ?? [])];
  return all.find((s) => s.id === sid)?.stalled ?? false;
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
