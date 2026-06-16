// /cli-send (tmux command injection) — the broker-side guards. The actual
// keystroke delivery needs a live tmux pane, so here we cover the allowlist,
// the session/pane lookups, and the "busy" guard; pane delivery is exercised
// live (chrome-devtools + a real tmux pane), not in CI.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

// Attach with an explicit tmux pane/socket (the harness attachCC omits them).
async function attachWithTmux(
  sessionId: string,
  ccId: string,
  pane: string | null,
  socket: string | null,
): Promise<void> {
  await post(`${broker.url}/attach-cc-session`, {
    session_id: sessionId,
    cc_session_id: ccId,
    tmux_pane: pane,
    tmux_socket: socket,
  });
}

describe("/cli-send guards", () => {
  test("rejects a command outside the allowlist", async () => {
    const sid = await registerSession(broker.url);
    await attachWithTmux(sid, `cc-${sid}`, "%1", "/tmp/sock");
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/clear", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("command_not_allowed");
  });

  test("rejects an unknown session", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: "s_does_not_exist", command: "/compact", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("session_not_found");
  });

  test("rejects a session with no captured tmux pane", async () => {
    const sid = await registerSession(broker.url);
    // attachCC binds cc_session_id but passes no tmux pane.
    await attachCC(broker.url, sid);
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "do it" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("no_tmux_pane");
  });

  test("refuses while the session is working (spinner)", async () => {
    const sid = await registerSession(broker.url);
    const ccId = `cc-busy-${sid}`;
    await attachWithTmux(sid, ccId, "%2", "/tmp/sock");
    // Mark the session working (same path the PreToolUse hook uses).
    await post(`${broker.url}/heartbeat-tool`, {
      cc_session_id: ccId,
      tool: "Bash",
    });
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("session_busy");
  });

  test("refuses while the session is blocked on user input", async () => {
    const sid = await registerSession(broker.url);
    const ccId = `cc-blocked-${sid}`;
    await attachWithTmux(sid, ccId, "%3", "/tmp/sock");
    await post(`${broker.url}/blocked-on-user-start`, {
      cc_session_id: ccId,
      question: "pick one",
    });
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("session_busy");
  });

  test("reports pane_gone when the captured pane no longer exists", async () => {
    const sid = await registerSession(broker.url);
    // Idle (not working) session with a pane id that exists in no tmux server.
    await attachWithTmux(sid, `cc-gone-${sid}`, "%99", "/tmp/dt-test-no-sock");
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("pane_gone");
  });
});

// A CC restart re-attaches under the same cc_session_id and reclaims the board
// to the NEW session row. owner_can_cli_send must follow to the new session so
// an open board's command button targets the live pane, not the dead session.
describe("/cli-send across a CC restart", () => {
  async function defaultBoardId(ccId: string): Promise<string | null> {
    const r = await get<{ sessions: { cc_session_id?: string; boards: { id: string; is_default?: number }[] }[] }>(
      `${broker.url}/api/sessions`,
    );
    for (const s of r.json.sessions ?? []) {
      if (s.cc_session_id === ccId) {
        const def = s.boards?.find((b) => b.is_default);
        if (def) return def.id;
      }
    }
    return null;
  }

  test("owner_can_cli_send follows the reclaimed board to the new session", async () => {
    const ccId = `cc-restart-${Math.random().toString(36).slice(2, 8)}`;
    // First launch: NOT in tmux.
    const s1 = await registerSession(broker.url);
    await attachWithTmux(s1, ccId, null, null);
    const bid = await defaultBoardId(ccId);
    expect(bid).toBeTruthy();
    const before = await get<{ owner_can_cli_send?: boolean; board: { session_id: string } }>(
      `${broker.url}/api/board/${bid}`,
    );
    expect(before.json.owner_can_cli_send).toBe(false);
    expect(before.json.board.session_id).toBe(s1);

    // Restart: old session dies, new one re-attaches inside tmux.
    await post(`${broker.url}/unregister`, { session_id: s1 });
    const s2 = await registerSession(broker.url);
    await attachWithTmux(s2, ccId, "%7", "/tmp/sock");

    const after = await get<{ owner_can_cli_send?: boolean; board: { session_id: string } }>(
      `${broker.url}/api/board/${bid}`,
    );
    expect(after.json.board.session_id).toBe(s2);
    expect(after.json.owner_can_cli_send).toBe(true);
  });
});

describe("/cli-history", () => {
  test("rejects a non-allowlisted command", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-history`,
      { command: "/rm-rf" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("command_not_allowed");
  });

  test("returns an (initially empty) history array for /compact", async () => {
    const r = await post<{
      ok: boolean;
      history?: { args: string; last_used_at: string }[];
    }>(`${broker.url}/cli-history`, { command: "/compact" });
    expect(r.json.ok).toBe(true);
    expect(Array.isArray(r.json.history)).toBe(true);
  });
});
