import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// These exercise everything EXCEPT the actual tmux launch: the modal-bootstrap
// endpoint, the request validation that runs before the broker shells out to
// tmux, the persist-only-on-success rule, and the same-origin guard. Every
// spawn here is steered into a pre-tmux error (missing/relative cwd, missing or
// unknown or alive resume target), so no real session is ever created.

let broker: BrokerHandle;
beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

describe("/spawn-config + /spawn-session", () => {
  test("spawn-config returns defaults + null settings initially", async () => {
    const r = await post<any>(`${broker.url}/spawn-config`, {});
    expect(r.json.settings).toBeNull();
    expect(Array.isArray(r.json.defaults.base_args)).toBe(true);
    expect(r.json.defaults.base_args).toContain(
      "server:plugin:discussion-tree:discussion-tree",
    );
    expect(Array.isArray(r.json.known_cwds)).toBe(true);
    expect(Array.isArray(r.json.resumable)).toBe(true);
  });

  test("spawn-session with no config and nothing stored is rejected", async () => {
    const r = await post<any>(`${broker.url}/spawn-session`, {
      mode: "new",
      cwd: "/tmp",
    });
    expect(r.json.ok).toBe(false);
  });

  test("new-mode validation: missing cwd / relative cwd (both fail before tmux)", async () => {
    const config = { base_args: ["--foo"] };
    const noCwd = await post<any>(`${broker.url}/spawn-session`, {
      mode: "new",
      cwd: "",
      config,
    });
    expect(noCwd.json.ok).toBe(false);
    const relCwd = await post<any>(`${broker.url}/spawn-session`, {
      mode: "new",
      cwd: "relative/path",
      config,
    });
    expect(relCwd.json.ok).toBe(false);
  });

  test("resume-mode validation: missing id / unknown id", async () => {
    const config = { base_args: ["--foo"] };
    const noId = await post<any>(`${broker.url}/spawn-session`, {
      mode: "resume",
      config,
    });
    expect(noId.json.ok).toBe(false);
    const unknownId = await post<any>(`${broker.url}/spawn-session`, {
      mode: "resume",
      resume_cc_session_id: "no-such-cc",
      config,
    });
    expect(unknownId.json.ok).toBe(false);
  });

  test("a failed spawn does NOT persist the config (persist-only-on-success)", async () => {
    const r = await post<any>(`${broker.url}/spawn-session`, {
      mode: "resume",
      resume_cc_session_id: "still-no-such-cc",
      config: { base_args: ["--should-not-be-saved"] },
    });
    expect(r.json.ok).toBe(false);
    const cfg = await post<any>(`${broker.url}/spawn-config`, {});
    expect(cfg.json.settings).toBeNull();
  });

  test("same-origin guard: a foreign Origin is rejected with 403", async () => {
    const res = await fetch(`${broker.url}/spawn-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example.com",
      },
      body: JSON.stringify({ mode: "new", cwd: "" }),
    });
    expect(res.status).toBe(403);
  });

  test("same-origin guard: the broker's own origin passes through to the handler", async () => {
    const res = await fetch(`${broker.url}/spawn-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: broker.url,
      },
      body: JSON.stringify({ mode: "new", cwd: "" }),
    });
    // Not 403 — reaches the handler, which then rejects on the empty cwd.
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
  });
});
