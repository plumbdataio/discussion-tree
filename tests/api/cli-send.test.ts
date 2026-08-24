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
  test("rejects a malformed command (not a single /command)", async () => {
    const sid = await registerSession(broker.url);
    await attachWithTmux(sid, `cc-${sid}`, "%1", "/tmp/sock");
    for (const bad of ["compact", "/bad cmd", "/", "rm -rf"]) {
      const r = await post<{ ok: boolean; error?: string }>(
        `${broker.url}/cli-send`,
        { session_id: sid, command: bad, args: "" },
      );
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toBe("invalid_command");
    }
  });

  test("a well-formed non-/compact command passes the format check (reaches pane logic)", async () => {
    const sid = await registerSession(broker.url);
    // A dead pane id in no tmux server, so a format-valid command gets past the
    // allowlist and fails later at the pane probe — proving it's no longer
    // rejected on the command itself.
    await attachWithTmux(sid, `cc-${sid}`, "%99", "/tmp/dt-test-no-sock");
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact-human", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("pane_gone");
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

// Remote cli-send: the CC's tmux is on ANOTHER machine, so the broker can't
// inject locally; it QUEUES the command for that session's MCP to run on its
// poll (server/poll.ts). A session is remote when it registered with remote:true
// (its MCP's BROKER_URL isn't localhost).
describe("/cli-send — remote (cross-machine)", () => {
  async function registerRemote(): Promise<string> {
    const r = await post<{ session_id: string }>(`${broker.url}/register`, {
      pid: 99000 + Math.floor(Math.random() * 1000),
      cwd: "/tmp/pd-remote",
      remote: true,
    });
    return r.json.session_id;
  }

  test("queues instead of injecting (skips the probe, even with a dead pane)", async () => {
    const sid = await registerRemote();
    // A pane on a nonexistent socket: the LOCAL path fails pane_gone here, so a
    // queued:true result proves the remote branch skipped the probe.
    await attachWithTmux(sid, `cc-remote-${sid}`, "%1", "/tmp/dt-test-no-sock");
    const r = await post<{ ok: boolean; queued?: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "do it" },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.queued).toBe(true);
    expect(r.json.error).toBeUndefined();
  });

  test("still rejects a remote session with no captured tmux pane", async () => {
    const sid = await registerRemote();
    await attachCC(broker.url, sid); // binds cc_session_id, no pane
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("no_tmux_pane");
  });

  test("still rejects a malformed command for a remote session", async () => {
    const sid = await registerRemote();
    await attachWithTmux(sid, `cc-remote-bad-${sid}`, "%1", "/tmp/sock");
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "not a command", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("invalid_command");
  });

  test("the poll delivers the queued inject exactly once", async () => {
    const sid = await registerRemote();
    await attachWithTmux(sid, `cc-remote-poll-${sid}`, "%1", "/tmp/sock");
    await post(`${broker.url}/cli-send`, {
      session_id: sid,
      command: "/compact",
      args: "keep it",
    });
    const first = await post<{
      cli_injects?: { id: number; command: string; args: string }[];
    }>(`${broker.url}/poll-messages`, { session_id: sid });
    expect(first.json.cli_injects?.length).toBe(1);
    expect(first.json.cli_injects?.[0].command).toBe("/compact");
    expect(first.json.cli_injects?.[0].args).toBe("keep it");
    // delivered flips at drain, so a second poll gets nothing (no double-run).
    const second = await post<{ cli_injects?: { id: number }[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sid },
    );
    expect(second.json.cli_injects?.length ?? 0).toBe(0);
  });

  test("cli-inject-acked accepts an id and rejects a missing one", async () => {
    const sid = await registerRemote();
    await attachWithTmux(sid, `cc-remote-ack-${sid}`, "%1", "/tmp/sock");
    await post(`${broker.url}/cli-send`, {
      session_id: sid,
      command: "/compact",
      args: "",
    });
    const drained = await post<{ cli_injects?: { id: number }[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sid },
    );
    const injectId = drained.json.cli_injects?.[0]?.id;
    expect(typeof injectId).toBe("number");
    // ok:true logs the default-board notice; the endpoint returns ok. Idempotent.
    const ack = await post<{ ok: boolean }>(`${broker.url}/cli-inject-acked`, {
      id: injectId,
      ok: true,
    });
    expect(ack.json.ok).toBe(true);
    const again = await post<{ ok: boolean }>(`${broker.url}/cli-inject-acked`, {
      id: injectId,
      ok: true,
    });
    expect(again.json.ok).toBe(true);
    // A non-number id is a no-op failure, never a throw.
    const bad = await post<{ ok: boolean }>(`${broker.url}/cli-inject-acked`, {
      ok: true,
    });
    expect(bad.json.ok).toBe(false);
  });

  test("a LOCAL session (not remote) still injects synchronously (no queue)", async () => {
    // Same dead-pane setup as the remote queue test, but a local session: it
    // must take the inject path and fail pane_gone, NOT queue.
    const sid = await registerSession(broker.url);
    await attachWithTmux(sid, `cc-local-${sid}`, "%1", "/tmp/dt-test-no-sock");
    const r = await post<{ ok: boolean; queued?: boolean; error?: string }>(
      `${broker.url}/cli-send`,
      { session_id: sid, command: "/compact", args: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.queued).toBeUndefined();
    expect(r.json.error).toBe("pane_gone");
  });
});

describe("/cli-history", () => {
  test("rejects a malformed command", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/cli-history`,
      { command: "rm-rf" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe("invalid_command");
  });

  test("returns history + commands arrays for a valid command", async () => {
    const r = await post<{
      ok: boolean;
      history?: { args: string; last_used_at: string }[];
      commands?: string[];
    }>(`${broker.url}/cli-history`, { command: "/compact" });
    expect(r.json.ok).toBe(true);
    expect(Array.isArray(r.json.history)).toBe(true);
    expect(Array.isArray(r.json.commands)).toBe(true);
  });
});
