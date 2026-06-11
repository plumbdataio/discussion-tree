// /cli-send (tmux command injection) — the broker-side guards. The actual
// keystroke delivery needs a live tmux pane, so here we cover the allowlist,
// the session/pane lookups, and the "busy" guard; pane delivery is exercised
// live (chrome-devtools + a real tmux pane), not in CI.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
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
