import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { jqRaw, parseHookInput } from "../../scripts/hook-io.ts";
import { runToolActivity } from "../../scripts/tool-activity-hook.ts";
import { runBlockedOnUser } from "../../scripts/blocked-on-user-hook.ts";
import { runPreCompact } from "../../scripts/pre-compact-hook.ts";
import { runToolActivityClear } from "../../scripts/tool-activity-clear-hook.ts";
import { runSubagentStop } from "../../scripts/subagent-stop-hook.ts";
import {
  extractCompletedBgTaskIds,
  runBgTaskReconcile,
} from "../../scripts/bg-task-reconcile-hook.ts";
import {
  ensureBrokerRunning,
  healthUrl,
  resolveHome,
  resolveRoot,
  shouldSpawn,
} from "../../scripts/ensure-broker-running.ts";

// Locks the ts ports of the remaining bash hooks against the broker contract the
// .sh versions established: the SAME endpoints, the SAME payload values, and the
// SAME no-POST-when-idle semantics. The broker is a throwaway Bun.serve on an
// ephemeral port reached via DISCUSSION_TREE_BROKER_URL (never the real one).

type Rec = { path: string; body: any };
let received: Rec[] = [];
let server: ReturnType<typeof Bun.serve>;
let ENV: Record<string, string>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      received.push({ path: new URL(req.url).pathname, body });
      return Response.json({});
    },
  });
  ENV = { DISCUSSION_TREE_BROKER_URL: `http://127.0.0.1:${server.port}` };
});
afterAll(() => server.stop(true));
beforeEach(() => {
  received = [];
});

describe("hook-io jq compatibility", () => {
  test("jqRaw mirrors `x=$(jq -r '.f // empty')`", () => {
    expect(jqRaw(undefined)).toBe("");
    expect(jqRaw(null)).toBe("");
    expect(jqRaw(false)).toBe("");
    expect(jqRaw("abc")).toBe("abc");
    expect(jqRaw("abc\n\n")).toBe("abc"); // $(...) strips trailing newlines
    expect(jqRaw(true)).toBe("true");
    expect(jqRaw(12)).toBe("12");
    expect(jqRaw({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test("parseHookInput tolerates malformed / non-object stdin", () => {
    expect(parseHookInput("")).toEqual({});
    expect(parseHookInput("not json")).toEqual({});
    expect(parseHookInput("[1,2]")).toEqual({});
    expect(parseHookInput('"s"')).toEqual({});
    expect(parseHookInput('{"session_id":"x"}')).toEqual({ session_id: "x" });
  });
});

describe("tool-activity-hook", () => {
  test("parent tool call -> /heartbeat-tool only", async () => {
    await runToolActivity({ session_id: "s1", tool_name: "Read" }, ENV);
    expect(received).toEqual([
      { path: "/heartbeat-tool", body: { cc_session_id: "s1", tool: "Read" } },
    ]);
  });

  test("missing tool_name -> tool is empty string", async () => {
    await runToolActivity({ session_id: "s1" }, ENV);
    expect(received).toEqual([
      { path: "/heartbeat-tool", body: { cc_session_id: "s1", tool: "" } },
    ]);
  });

  test("subagent call -> /heartbeat-subagent only (no parent heartbeat, no BG)", async () => {
    await runToolActivity(
      {
        session_id: "s1",
        tool_name: "Bash",
        agent_id: "ag1",
        agent_type: "general-purpose",
        tool_input: { run_in_background: true },
        tool_use_id: "toolu_x",
      },
      ENV,
    );
    expect(received).toEqual([
      {
        path: "/heartbeat-subagent",
        body: { cc_session_id: "s1", agent_id: "ag1", agent_type: "general-purpose" },
      },
    ]);
  });

  test("subagent with no agent_type -> agent_type is empty string", async () => {
    await runToolActivity({ session_id: "s1", agent_id: "ag1" }, ENV);
    expect(received[0]!.body).toEqual({
      cc_session_id: "s1",
      agent_id: "ag1",
      agent_type: "",
    });
  });

  test("Bash run_in_background -> heartbeat then /bg-task-start", async () => {
    await runToolActivity(
      {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "sleep 9", run_in_background: true },
        tool_use_id: "toolu_abc",
      },
      ENV,
    );
    expect(received).toEqual([
      { path: "/heartbeat-tool", body: { cc_session_id: "s1", tool: "Bash" } },
      { path: "/bg-task-start", body: { cc_session_id: "s1", task_id: "toolu_abc" } },
    ]);
  });

  test("no BG POST: foreground Bash, missing tool_use_id, or non-Bash tool", async () => {
    await runToolActivity(
      { session_id: "s1", tool_name: "Bash", tool_input: { run_in_background: false }, tool_use_id: "t" },
      ENV,
    );
    await runToolActivity(
      { session_id: "s1", tool_name: "Bash", tool_input: { run_in_background: true } },
      ENV,
    );
    await runToolActivity(
      { session_id: "s1", tool_name: "Task", tool_input: { run_in_background: true }, tool_use_id: "t" },
      ENV,
    );
    expect(received.map((r) => r.path)).toEqual([
      "/heartbeat-tool",
      "/heartbeat-tool",
      "/heartbeat-tool",
    ]);
  });

  test("no session_id -> no POST at all (even for a subagent)", async () => {
    await runToolActivity({ tool_name: "Read" }, ENV);
    await runToolActivity({ agent_id: "ag1" }, ENV);
    expect(received).toEqual([]);
  });
});

describe("blocked-on-user-hook", () => {
  test("start with question", async () => {
    await runBlockedOnUser("start", { session_id: "s1", tool_input: { question: "Q?" } }, ENV);
    expect(received).toEqual([
      { path: "/blocked-on-user-start", body: { cc_session_id: "s1", question: "Q?" } },
    ]);
  });

  test("start falls through null/false/missing question to plan", async () => {
    await runBlockedOnUser("start", { session_id: "s1", tool_input: { plan: "P" } }, ENV);
    await runBlockedOnUser("start", { session_id: "s1", tool_input: { question: null, plan: "P" } }, ENV);
    await runBlockedOnUser("start", { session_id: "s1", tool_input: { question: false, plan: "P" } }, ENV);
    expect(received.map((r) => r.body.question)).toEqual(["P", "P", "P"]);
  });

  test("an EMPTY question string does not fall through (jq `//` semantics)", async () => {
    await runBlockedOnUser("start", { session_id: "s1", tool_input: { question: "", plan: "P" } }, ENV);
    expect(received[0]!.body.question).toBe("");
  });

  test("start with neither -> question is empty string; trailing newlines stripped", async () => {
    await runBlockedOnUser("start", { session_id: "s1" }, ENV);
    await runBlockedOnUser("start", { session_id: "s1", tool_input: { plan: "line\n\n" } }, ENV);
    expect(received.map((r) => r.body.question)).toEqual(["", "line"]);
  });

  test("clear (and any non-start mode) -> /blocked-on-user-clear", async () => {
    await runBlockedOnUser("clear", { session_id: "s1" }, ENV);
    await runBlockedOnUser("other", { session_id: "s1" }, ENV);
    expect(received).toEqual([
      { path: "/blocked-on-user-clear", body: { cc_session_id: "s1" } },
      { path: "/blocked-on-user-clear", body: { cc_session_id: "s1" } },
    ]);
  });

  test("no session_id -> no POST", async () => {
    await runBlockedOnUser("start", { tool_input: { question: "Q" } }, ENV);
    await runBlockedOnUser("clear", {}, ENV);
    expect(received).toEqual([]);
  });
});

describe("single-POST hooks", () => {
  test("pre-compact -> /session-compacting", async () => {
    await runPreCompact({ session_id: "s1", trigger: "manual" }, ENV);
    expect(received).toEqual([{ path: "/session-compacting", body: { cc_session_id: "s1" } }]);
  });

  test("tool-activity-clear -> /clear-tool-activity", async () => {
    await runToolActivityClear({ session_id: "s1" }, ENV);
    expect(received).toEqual([{ path: "/clear-tool-activity", body: { cc_session_id: "s1" } }]);
  });

  test("subagent-stop with agent_id -> forwards it", async () => {
    await runSubagentStop({ session_id: "s1", agent_id: "ag1" }, ENV);
    expect(received).toEqual([
      { path: "/subagent-stop", body: { cc_session_id: "s1", agent_id: "ag1" } },
    ]);
  });

  test("subagent-stop without agent_id -> omits the key", async () => {
    await runSubagentStop({ session_id: "s1" }, ENV);
    expect(received).toEqual([{ path: "/subagent-stop", body: { cc_session_id: "s1" } }]);
  });

  test("no session_id -> none of them POST", async () => {
    await runPreCompact({}, ENV);
    await runToolActivityClear({}, ENV);
    await runSubagentStop({ agent_id: "ag1" }, ENV);
    expect(received).toEqual([]);
  });

  test("broker down -> resolves quietly (best-effort)", async () => {
    const down = { DISCUSSION_TREE_BROKER_URL: "http://127.0.0.1:1" };
    await runPreCompact({ session_id: "s1" }, down);
    await runToolActivity({ session_id: "s1", tool_name: "Read" }, down);
    expect(received).toEqual([]);
  });
});

describe("bg-task-reconcile-hook", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-bgrec-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // One jsonl line per entry, mirroring how CC stores <task-notification> blocks
  // (newlines JSON-escaped, quotes possibly backslash-escaped).
  const FIXTURE = [
    JSON.stringify({ type: "user", message: "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_BBB</tool-use-id>\n<status>completed</status>\n</task-notification>" }),
    JSON.stringify({ type: "user", message: '<task-notification status="completed"><tool-use-id>toolu_AAA-1_x</tool-use-id></task-notification>' }),
    // Duplicate completion of AAA -> deduped.
    JSON.stringify({ type: "user", message: "<task-notification><tool-use-id>toolu_AAA-1_x</tool-use-id><status>completed</status></task-notification>" }),
    // Still running -> NOT cleared.
    JSON.stringify({ type: "user", message: "<task-notification><tool-use-id>toolu_RUN</tool-use-id><status>running</status></task-notification>" }),
    // Completed + tool-use-id but no task-notification on the line -> ignored.
    JSON.stringify({ type: "assistant", message: "status>completed< tool-use-id>toolu_NOPE" }),
    // A short <task-id> alone is never sent.
    JSON.stringify({ type: "user", message: "<task-notification><task-id>zz</task-id><status>completed</status></task-notification>" }),
  ];

  function writeFixture(name: string, lines: string[], trailingNl = true): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.join("\n") + (trailingNl ? "\n" : ""));
    return p;
  }

  test("extracts unique completed tool_use_ids, sorted", () => {
    const p = writeFixture("t1.jsonl", FIXTURE);
    expect(extractCompletedBgTaskIds(p)).toEqual(["toolu_AAA-1_x", "toolu_BBB"]);
  });

  test("final line without trailing newline still counts", () => {
    const p = writeFixture("t2.jsonl", FIXTURE.slice(0, 1), false);
    expect(extractCompletedBgTaskIds(p)).toEqual(["toolu_BBB"]);
  });

  test("matches across the 8MB read-chunk boundary", () => {
    const pad = JSON.stringify({ pad: "x".repeat(8 * 1024 * 1024 - 20) });
    const p = writeFixture("t3.jsonl", [pad, FIXTURE[0]!, pad, FIXTURE[1]!]);
    expect(extractCompletedBgTaskIds(p)).toEqual(["toolu_AAA-1_x", "toolu_BBB"]);
  });

  test("POSTs /bg-task-done once with all ids", async () => {
    const p = writeFixture("t4.jsonl", FIXTURE);
    await runBgTaskReconcile({ session_id: "s1", transcript_path: p }, ENV);
    expect(received).toEqual([
      {
        path: "/bg-task-done",
        body: { cc_session_id: "s1", task_ids: ["toolu_AAA-1_x", "toolu_BBB"] },
      },
    ]);
  });

  test("no POST: no ids / no session / no transcript / missing file / a directory", async () => {
    const empty = writeFixture("t5.jsonl", FIXTURE.slice(3));
    await runBgTaskReconcile({ session_id: "s1", transcript_path: empty }, ENV);
    await runBgTaskReconcile({ transcript_path: empty }, ENV);
    await runBgTaskReconcile({ session_id: "s1" }, ENV);
    await runBgTaskReconcile({ session_id: "s1", transcript_path: path.join(dir, "nope") }, ENV);
    await runBgTaskReconcile({ session_id: "s1", transcript_path: dir }, ENV);
    expect(received).toEqual([]);
  });
});

describe("ensure-broker-running", () => {
  test("shouldSpawn: unset / empty / loopback -> true; remote -> false", () => {
    expect(shouldSpawn({})).toBe(true);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "" })).toBe(true);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "http://127.0.0.1:7898" })).toBe(true);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "http://localhost:7898/" })).toBe(true);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "http://[::1]:7898" })).toBe(true);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "HTTP://LOCALHOST" })).toBe(true);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "https://hello.tailc809ec.ts.net" })).toBe(false);
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "http://100.85.218.37:7898" })).toBe(false);
    // A host that merely starts with "localhost" is not loopback.
    expect(shouldSpawn({ DISCUSSION_TREE_BROKER_URL: "http://localhost.evil.test" })).toBe(false);
  });

  test("resolveHome: empty string counts as unset", () => {
    const dflt = path.join(os.homedir(), ".discussion-tree");
    expect(resolveHome({})).toBe(dflt);
    expect(resolveHome({ DISCUSSION_TREE_HOME: "" })).toBe(dflt);
    expect(resolveHome({ DISCUSSION_TREE_HOME: "/x/home" })).toBe("/x/home");
  });

  test("resolveRoot / healthUrl defaults", () => {
    expect(resolveRoot({ CLAUDE_PLUGIN_ROOT: "/p/root" })).toBe("/p/root");
    expect(fs.existsSync(path.join(resolveRoot({}), "broker.ts"))).toBe(true);
    expect(healthUrl({})).toBe("http://127.0.0.1:7898/health");
    expect(healthUrl({ DISCUSSION_TREE_PORT: "" })).toBe("http://127.0.0.1:7898/health");
    expect(healthUrl({ DISCUSSION_TREE_PORT: "9999" })).toBe("http://127.0.0.1:9999/health");
  });

  function tmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "dt-ensure-"));
  }

  test("remote URL -> no health probe, no spawn", async () => {
    let probes = 0;
    let launches = 0;
    const r = await ensureBrokerRunning(
      { DISCUSSION_TREE_BROKER_URL: "https://remote.example:7898" },
      { healthy: async () => (probes++, false), launch: () => void launches++ },
    );
    expect(r).toBe("remote");
    expect(probes).toBe(0);
    expect(launches).toBe(0);
  });

  test("already healthy -> no spawn", async () => {
    let launches = 0;
    const r = await ensureBrokerRunning(
      { DISCUSSION_TREE_HOME: tmpHome() },
      { healthy: async () => true, launch: () => void launches++ },
    );
    expect(r).toBe("healthy");
    expect(launches).toBe(0);
  });

  test("down -> spawns once with --smol, cwd=root, home env + log, releases the lock", async () => {
    const home = tmpHome();
    const calls: any[] = [];
    let probes = 0;
    try {
      const r = await ensureBrokerRunning(
        { DISCUSSION_TREE_HOME: home, DISCUSSION_TREE_PORT: "1" },
        {
          // Down on the first probe, up on the second poll.
          healthy: async () => ++probes > 2,
          launch: (cmd, args, opts) => void calls.push({ cmd, args, opts }),
          pollIntervalMs: 1,
        },
      );
      expect(r).toBe("spawned");
      expect(calls.length).toBe(1);
      const root = resolveRoot({});
      expect(calls[0].cmd).toBe(process.execPath);
      expect(calls[0].args).toEqual(["--smol", path.join(root, "broker.ts")]);
      expect(calls[0].opts.cwd).toBe(root);
      expect(calls[0].opts.env.DISCUSSION_TREE_HOME).toBe(home);
      expect(calls[0].opts.logPath).toBe(path.join(home, "broker.log"));
      expect(probes).toBe(3); // initial check + polled until healthy
      expect(fs.existsSync(path.join(home, ".broker-launch.lock"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("lock already held -> loser exits without spawning and leaves the lock", async () => {
    const home = tmpHome();
    const lock = path.join(home, ".broker-launch.lock");
    fs.mkdirSync(lock);
    let launches = 0;
    try {
      const r = await ensureBrokerRunning(
        { DISCUSSION_TREE_HOME: home },
        { healthy: async () => false, launch: () => void launches++ },
      );
      expect(r).toBe("locked");
      expect(launches).toBe(0);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("no broker.ts under the root -> no spawn", async () => {
    const home = tmpHome();
    let launches = 0;
    try {
      const r = await ensureBrokerRunning(
        { DISCUSSION_TREE_HOME: home, CLAUDE_PLUGIN_ROOT: home },
        { healthy: async () => false, launch: () => void launches++ },
      );
      expect(r).toBe("no-broker-script");
      expect(launches).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("launchDetached: child outlives the launching process and appends to the log", async () => {
    const home = tmpHome();
    try {
      const marker = path.join(home, "marker");
      const log = path.join(home, "broker.log");
      fs.writeFileSync(log, "previous\n");
      // A stand-in "broker": waits until its launcher has exited, then proves
      // it is still alive by writing the marker; prints to stdout + stderr.
      const child = path.join(home, "child.ts");
      fs.writeFileSync(
        child,
        `console.log("out:" + process.cwd()); console.error("err:" + process.env.DT_PROBE);\n` +
          `await Bun.sleep(700); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive");\n`,
      );
      // The launcher is its own bun process that exits right after spawning,
      // exactly like the hook does.
      const launcher = path.join(home, "launcher.ts");
      const mod = path.join(import.meta.dir, "../../scripts/ensure-broker-running.ts");
      fs.writeFileSync(
        launcher,
        `import { launchDetached } from ${JSON.stringify(mod)};\n` +
          `launchDetached(process.execPath, [${JSON.stringify(child)}], { cwd: ${JSON.stringify(home)}, env: { ...process.env, DT_PROBE: "p1" }, logPath: ${JSON.stringify(log)} });\n` +
          `process.exit(0);\n`,
      );
      const p = Bun.spawn([process.execPath, launcher], { stdout: "ignore", stderr: "ignore" });
      expect(await p.exited).toBe(0);
      expect(fs.existsSync(marker)).toBe(false); // launcher gone, child still sleeping
      for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await Bun.sleep(100);
      expect(fs.readFileSync(marker, "utf8")).toBe("alive");
      const text = fs.readFileSync(log, "utf8");
      expect(text.startsWith("previous\n")).toBe(true);
      expect(text).toContain(`out:${fs.realpathSync(home)}`);
      expect(text).toContain("err:p1");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("launch failure still releases the lock", async () => {
    const home = tmpHome();
    try {
      await expect(
        ensureBrokerRunning(
          { DISCUSSION_TREE_HOME: home },
          {
            healthy: async () => false,
            launch: () => {
              throw new Error("boom");
            },
          },
        ),
      ).rejects.toThrow("boom");
      expect(fs.existsSync(path.join(home, ".broker-launch.lock"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
