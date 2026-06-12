import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The PreCompact hook POSTs /session-compacting when Claude Code starts
// compacting its context; the post-compact SessionStart hook POSTs
// /session-compacting-done on resume. The broker marks the owning session
// compacting; the sidebar + header read it via /api/sessions and the board/map
// view. Any sign of life (tool heartbeat / normal Stop / re-attach) also clears
// it as a self-heal in case the done hook never lands.

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
): Promise<
  { compacting?: boolean; activity?: { state: string } | null } | undefined
> {
  const res = await get<{
    sessions: {
      id: string;
      compacting?: boolean;
      activity?: { state: string } | null;
    }[];
    inactive_sessions?: { id: string; compacting?: boolean }[];
  }>(`${broker.url}/api/sessions`);
  const all = [...res.json.sessions, ...(res.json.inactive_sessions ?? [])];
  return all.find((s) => s.id === sid);
}

async function isCompacting(sid: string): Promise<boolean> {
  return (await sessionItem(sid))?.compacting ?? false;
}

async function startCompacting() {
  const r = await post<{ ok: boolean }>(`${broker.url}/session-compacting`, {
    cc_session_id: ccId,
  });
  expect(r.json.ok).toBe(true);
}

describe("session compacting (PreCompact → UI badge)", () => {
  test("/session-compacting marks the session compacting in /api/sessions", async () => {
    expect(await isCompacting(sessionId)).toBe(false);
    await startCompacting();
    expect(await isCompacting(sessionId)).toBe(true);
  });

  test("/session-compacting-done clears it (post-compact hook)", async () => {
    await startCompacting();
    expect(await isCompacting(sessionId)).toBe(true);
    const r = await post<{ ok: boolean }>(
      `${broker.url}/session-compacting-done`,
      { cc_session_id: ccId },
    );
    expect(r.json.ok).toBe(true);
    expect(await isCompacting(sessionId)).toBe(false);
  });

  test("a tool heartbeat (PreToolUse) self-heals the badge", async () => {
    await startCompacting();
    expect(await isCompacting(sessionId)).toBe(true);
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Read",
    });
    expect(await isCompacting(sessionId)).toBe(false);
  });

  test("a normal Stop (clear-tool-activity) self-heals the badge", async () => {
    await startCompacting();
    expect(await isCompacting(sessionId)).toBe(true);
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
    expect(await isCompacting(sessionId)).toBe(false);
  });

  test("a SessionStart re-attach self-heals the badge", async () => {
    await startCompacting();
    expect(await isCompacting(sessionId)).toBe(true);
    await post(`${broker.url}/attach-cc-session`, {
      session_id: sessionId,
      cc_session_id: ccId,
    });
    expect(await isCompacting(sessionId)).toBe(false);
  });

  test("compacting clears a leftover 'working' badge (no tools run mid-compact)", async () => {
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Bash",
    });
    expect((await sessionItem(sessionId))?.activity?.state).toBe("working");
    await startCompacting();
    const after = await sessionItem(sessionId);
    expect(after?.compacting).toBe(true);
    expect(after?.activity?.state).not.toBe("working");
    // reset for later tests
    await post(`${broker.url}/clear-tool-activity`, { cc_session_id: ccId });
  });

  test("/session-compacting is a no-op for an unknown cc_session_id", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/session-compacting`, {
      cc_session_id: "cc-does-not-exist",
    });
    expect(r.json.ok).toBe(false);
  });

  test("the board view exposes owner_compacting", async () => {
    const res = await get<{
      sessions: { id: string; boards: { id: string }[] }[];
    }>(`${broker.url}/api/sessions`);
    const me = res.json.sessions.find((s) => s.id === sessionId)!;
    const boardId = me.boards[0].id;

    await startCompacting();
    const busyView = await get<{ owner_compacting?: boolean }>(
      `${broker.url}/api/board/${boardId}`,
    );
    expect(busyView.json.owner_compacting).toBe(true);

    await post(`${broker.url}/session-compacting-done`, { cc_session_id: ccId });
    const clearedView = await get<{ owner_compacting?: boolean }>(
      `${broker.url}/api/board/${boardId}`,
    );
    expect(clearedView.json.owner_compacting).toBe(false);
  });
});
