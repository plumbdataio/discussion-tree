import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  describeError,
  hookFailureLogPath,
  isLoopbackUrl,
  logHookFailure,
  ONCE_PER_TURN_POST,
  perToolCallPost,
  perToolCallTimeoutMs,
  postBestEffort,
  postJsonBestEffort,
} from "../../scripts/hook-io.ts";
import { runToolActivityClear } from "../../scripts/tool-activity-clear-hook.ts";
import { runToolActivity } from "../../scripts/tool-activity-hook.ts";
import { runCheckUnanswered } from "../../scripts/check-unanswered-posts.ts";

// Locks the hook failure log: every broker call a hook makes is best-effort and
// swallowed, so this one-line-per-failure log in the temp dir is the only trace
// left when hooks cannot reach the broker. Uses DT_HOOK_FAILURE_LOG to point at
// a throwaway file; the "broker" is a local Bun.serve (never the real one).

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-hook-log-"));
const logFile = path.join(dir, "failures.log");
const prevEnv = process.env.DT_HOOK_FAILURE_LOG;

function lines(): any[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let server: ReturnType<typeof Bun.serve>;
let reply: () => Response = () => Response.json({ ok: true });
let hits = 0;

beforeEach(() => {
  process.env.DT_HOOK_FAILURE_LOG = logFile;
  fs.rmSync(logFile, { force: true });
  fs.rmSync(logFile + ".1", { force: true });
  reply = () => Response.json({ ok: true });
  hits = 0;
  server = Bun.serve({
    port: 0,
    fetch: () => {
      hits++;
      return reply();
    },
  });
});

afterEach(() => {
  server.stop(true);
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.DT_HOOK_FAILURE_LOG;
  else process.env.DT_HOOK_FAILURE_LOG = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

// A port nothing listens on: bind one, read its number, close it.
function unusedPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  return p as number;
}

describe("hookFailureLogPath", () => {
  test("override wins; default is the OS temp dir; silent under bun test", () => {
    expect(hookFailureLogPath({ DT_HOOK_FAILURE_LOG: "/x/y.log" })).toBe("/x/y.log");
    expect(hookFailureLogPath({})).toBe(path.join(os.tmpdir(), "dt-hook-failures.log"));
    expect(hookFailureLogPath({ NODE_ENV: "test" })).toBe("");
  });
});

describe("logHookFailure", () => {
  test("writes one JSON line with the expected fields", () => {
    const err = Object.assign(new Error("Unable to connect"), {
      code: "ConnectionRefused",
      cause: { code: "ECONNREFUSED" },
    });
    logHookFailure({
      step: "http://h/x",
      error: err,
      status: 502,
      elapsed_ms: 12,
      session_id: "sid-1",
      detail: "d",
    });
    const ls = lines();
    expect(ls.length).toBe(1);
    const l = ls[0];
    expect(typeof l.ts).toBe("string");
    expect(Number.isNaN(Date.parse(l.ts))).toBe(false);
    expect(typeof l.hook).toBe("string");
    expect(l.pid).toBe(process.pid);
    expect(l.session_id).toBe("sid-1");
    expect(l.step).toBe("http://h/x");
    expect(l.status).toBe(502);
    expect(l.detail).toBe("d");
    expect(l.elapsed_ms).toBe(12);
    expect(l.error).toEqual({
      name: "Error",
      message: "Unable to connect",
      code: "ConnectionRefused",
      cause_code: "ECONNREFUSED",
    });
  });

  test("rotates to .1 once the file exceeds the cap", () => {
    fs.writeFileSync(logFile, "x".repeat(200));
    logHookFailure({ step: "s" }, process.env, 100);
    expect(fs.readFileSync(logFile + ".1", "utf8")).toBe("x".repeat(200));
    expect(lines().length).toBe(1);
    // Under the cap: appends, no rotation.
    logHookFailure({ step: "s2" }, process.env, 100_000);
    expect(lines().map((l) => l.step)).toEqual(["s", "s2"]);
  });

  test("never throws when the log dir is unwritable / missing", () => {
    const bad = { DT_HOOK_FAILURE_LOG: path.join(dir, "no", "such", "dir", "f.log") };
    expect(() => logHookFailure({ step: "s" }, bad)).not.toThrow();
    // A directory in place of the file: append fails, still no throw.
    expect(() => logHookFailure({ step: "s" }, { DT_HOOK_FAILURE_LOG: dir })).not.toThrow();
  });

  test("describeError tolerates non-errors", () => {
    expect(describeError("boom")).toEqual({ message: "boom" });
    expect(describeError(null)).toEqual({ message: "null" });
  });
});

describe("postBestEffort / postJsonBestEffort logging", () => {
  test("logs connection refused with the error code and session id", async () => {
    const url = `http://127.0.0.1:${unusedPort()}/heartbeat-tool`;
    await postBestEffort(url, { cc_session_id: "sid-r" });
    const ls = lines();
    expect(ls.length).toBe(1);
    expect(ls[0].step).toBe(url);
    expect(ls[0].session_id).toBe("sid-r");
    expect(ls[0].error.code ?? ls[0].error.cause_code).toBeTruthy();
    expect(typeof ls[0].elapsed_ms).toBe("number");
  });

  test("logs a non-2xx response with its status", async () => {
    reply = () => Response.json({ error: "nope" }, { status: 500 });
    const out = await postJsonBestEffort(`http://127.0.0.1:${server.port}/x`, {
      cc_session_id: "s",
    });
    expect(out).toEqual({ error: "nope" });
    const ls = lines();
    expect(ls.length).toBe(1);
    expect(ls[0].status).toBe(500);
    expect(ls[0].detail).toContain("nope");
  });

  test("logs a 2xx { ok: false }", async () => {
    reply = () => Response.json({ ok: false });
    const out = await postJsonBestEffort(`http://127.0.0.1:${server.port}/x`, {
      cc_session_id: "s",
    });
    expect(out).toEqual({ ok: false });
    const ls = lines();
    expect(ls.length).toBe(1);
    expect(ls[0].status).toBe(200);
    expect(ls[0].detail).toBe("ok:false");
  });

  test("logs a 2xx non-JSON body (e.g. an old broker without the route)", async () => {
    reply = () => new Response("discussion-tree broker");
    expect(await postJsonBestEffort(`http://127.0.0.1:${server.port}/x`, {})).toBeNull();
    expect(lines()[0].detail).toContain("non-JSON");
  });

  test("logs a timeout", async () => {
    reply = () => new Promise<Response>(() => {}) as any;
    await postBestEffort(`http://127.0.0.1:${server.port}/slow`, {}, 50);
    const ls = lines();
    expect(ls.length).toBe(1);
    expect(ls[0].detail).toBe("timeout after 50ms");
  });

  test("does NOT log a normal { ok: true } (or a JSON body without ok)", async () => {
    const out = await postJsonBestEffort(`http://127.0.0.1:${server.port}/x`, {});
    expect(out).toEqual({ ok: true });
    reply = () => Response.json({ count: 0 });
    await postBestEffort(`http://127.0.0.1:${server.port}/x`, {});
    expect(lines()).toEqual([]);
  });
});

// Timeout policy (see hook-io "Timeout policy"): per-tool-call hooks stay short
// (1s loopback / 2s remote, no retry); once-per-turn hooks get 5s + one retry on
// a timeout / network error, because nothing re-sends them and a miss left the
// "working" spinner stuck (Mac -> tailnet broker: ~1.0s median per request).
describe("timeout policy", () => {
  test("loopback detection", () => {
    expect(isLoopbackUrl("http://127.0.0.1:7898/x")).toBe(true);
    expect(isLoopbackUrl("http://localhost:7898")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:7898/x")).toBe(true);
    expect(isLoopbackUrl("https://hello.tailc809ec.ts.net/x")).toBe(false);
    expect(isLoopbackUrl("http://100.85.218.37:7898")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  test("per-tool-call: 1s loopback, 2s remote, no retry", () => {
    expect(perToolCallTimeoutMs("http://127.0.0.1:7898/heartbeat-tool")).toBe(1000);
    expect(perToolCallTimeoutMs("https://hello.example.ts.net/heartbeat-tool")).toBe(2000);
    expect(perToolCallPost("https://hello.example.ts.net")).toEqual({
      timeoutMs: 2000,
      retries: 0,
    });
  });

  test("once-per-turn: 5s + one retry", () => {
    expect(ONCE_PER_TURN_POST.timeoutMs).toBe(5000);
    expect(ONCE_PER_TURN_POST.retries).toBe(1);
  });
});

describe("retry", () => {
  test("a timed-out attempt is retried and the second answer is returned", async () => {
    let n = 0;
    reply = () =>
      ++n === 1
        ? (new Promise<Response>(() => {}) as any)
        : Response.json({ ok: true, second: true });
    const out = await postJsonBestEffort(
      `http://127.0.0.1:${server.port}/clear-tool-activity`,
      { cc_session_id: "s" },
      { timeoutMs: 50, retries: 1, retryDelayMs: 0 },
    );
    expect(out).toEqual({ ok: true, second: true });
    expect(hits).toBe(2);
    const ls = lines();
    expect(ls.length).toBe(1);
    expect(ls[0].detail).toBe("timeout after 50ms (attempt 1/2)");
  });

  test("both attempts time out -> null, two log lines", async () => {
    reply = () => new Promise<Response>(() => {}) as any;
    const out = await postJsonBestEffort(
      `http://127.0.0.1:${server.port}/x`,
      {},
      { timeoutMs: 30, retries: 1, retryDelayMs: 0 },
    );
    expect(out).toBeNull();
    expect(lines().map((l) => l.detail)).toEqual([
      "timeout after 30ms (attempt 1/2)",
      "timeout after 30ms (attempt 2/2)",
    ]);
  });

  test("an HTTP error / ok:false is NOT retried (the broker answered)", async () => {
    reply = () => Response.json({ error: "nope" }, { status: 500 });
    await postJsonBestEffort(`http://127.0.0.1:${server.port}/x`, {}, {
      timeoutMs: 200,
      retries: 1,
      retryDelayMs: 0,
    });
    expect(hits).toBe(1);
    reply = () => Response.json({ ok: false });
    await postJsonBestEffort(`http://127.0.0.1:${server.port}/x`, {}, ONCE_PER_TURN_POST);
    expect(hits).toBe(2);
  });

  test("a number is still accepted as a plain single-attempt timeout", async () => {
    reply = () => new Promise<Response>(() => {}) as any;
    await postBestEffort(`http://127.0.0.1:${server.port}/slow`, {}, 40);
    expect(hits).toBe(1);
    expect(lines()[0].detail).toBe("timeout after 40ms");
  });
});

describe("per-hook policy", () => {
  const refusedEnv = () => ({
    DISCUSSION_TREE_BROKER_URL: `http://127.0.0.1:${unusedPort()}`,
  });

  test("Stop: tool-activity-clear retries a refused connection once", async () => {
    await runToolActivityClear({ session_id: "sid-stop" }, refusedEnv());
    const ls = lines();
    expect(ls.length).toBe(2);
    expect(ls[0].step).toMatch(/\/clear-tool-activity$/);
    expect(ls[0].detail).toBe("network error (attempt 1/2)");
    expect(ls[1].detail).toBe("network error (attempt 2/2)");
  });

  test("Stop: check-unanswered still allows the stop when the broker is unreachable", async () => {
    const out = await runCheckUnanswered({ session_id: "sid-cu" }, refusedEnv());
    expect(out).toBe("");
    expect(lines().length).toBe(2); // one /get-unanswered, retried once
  });

  test("PreToolUse: tool-activity makes a single attempt", async () => {
    await runToolActivity(
      { session_id: "sid-pre", tool_name: "Read" },
      refusedEnv(),
    );
    const ls = lines();
    expect(ls.length).toBe(1);
    expect(ls[0].step).toMatch(/\/heartbeat-tool$/);
  });
});
