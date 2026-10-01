#!/usr/bin/env bun
// Cross-platform smoke harness for the ported Bun hooks.
//
// For each ported hook it: starts a throwaway mock broker on an ephemeral port,
// spawns the hook via `bun scripts/<hook>.ts` with representative stdin (and,
// for the context hook, seeds the statusline temp files the hook reads), then
// asserts the mock broker received the expected POST(s) and — for post-compact —
// that the hook's stdout carries the reminder text.
//
// Pure Bun: no shell-isms, no jq/curl, same temp-dir logic as the hooks. It runs
// identically on macOS and Windows, so this is what proves the scripts work on
// pd-002 (run: `bun scripts/hooks-smoke.ts`). Exits non-zero on any failure.
//
// ensure-broker-running.ts is only exercised on its two no-spawn paths (mock
// already healthy; remote DISCUSSION_TREE_BROKER_URL) against a temp state home,
// so the smoke run can never launch a real broker.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { statuslineTmpDir } from "./cc-context-report-hook.ts";

// ---- Mock broker -----------------------------------------------------------
type Rec = { path: string; body: any };
let received: Rec[] = [];
const RESPONSES: Record<string, unknown> = {
  "/session-compacting-done": { previous_compact_at: "2026-09-23T01:02:03Z" },
  "/get-incomplete-checklists": { count: 2 },
  "/review-message-links": { total: 3 },
  "/get-unanswered": {
    ok: true,
    count: 1,
    block: true,
    nodes: [
      {
        board_id: "bd_smoke",
        node_id: "i1",
        node_path: "Smoke board > I1",
        surface: "board",
        reply_tool: "post_to_node",
      },
    ],
  },
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    let body: any;
    try {
      body = await req.json();
    } catch {
      body = undefined;
    }
    received.push({ path: u.pathname, body });
    return new Response(JSON.stringify(RESPONSES[u.pathname] ?? {}), {
      headers: { "Content-Type": "application/json" },
    });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

// ---- Spawn helper ----------------------------------------------------------
async function runHook(
  script: string,
  stdin: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  received = [];
  const scriptPath = path.join(import.meta.dir, script);
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    env: { ...process.env, DISCUSSION_TREE_BROKER_URL: BASE, ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

// ---- Assertions ------------------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${name}${!cond && detail ? `  -> ${detail}` : ""}`);
}
function got(pathname: string): Rec | undefined {
  return received.find((r) => r.path === pathname);
}
function subset(obj: any, want: Record<string, unknown>): boolean {
  if (!obj) return false;
  return Object.entries(want).every(
    ([k, v]) => JSON.stringify(obj[k]) === JSON.stringify(v),
  );
}

// ---- Scenarios -------------------------------------------------------------
async function contextScenario(): Promise<void> {
  console.log("cc-context-report-hook.ts");
  const sid = `smoke-ctx-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = statuslineTmpDir();
  const pctFile = path.join(tmp, `claude-sl-${sid}-pct`);
  const limFile = path.join(tmp, `claude-sl-${sid}-limits.json`);
  const acct = "/smoke/.claude-acct";
  try {
    fs.writeFileSync(pctFile, "42.0\n");
    fs.writeFileSync(limFile, JSON.stringify({ five_hour: { used_pct: 5 } }));
    const r = await runHook(
      "cc-context-report-hook.ts",
      JSON.stringify({ session_id: sid }),
      { CLAUDE_CONFIG_DIR: acct },
    );
    check("exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    const ctx = got("/report-context-usage");
    check(
      "POST /report-context-usage {remaining_pct:42}",
      subset(ctx?.body, { cc_session_id: sid, remaining_pct: 42 }),
      JSON.stringify(ctx?.body),
    );
    const lim = got("/report-usage-limits");
    check(
      "POST /report-usage-limits incl account + cc_session_id",
      subset(lim?.body, {
        five_hour: { used_pct: 5 },
        cc_session_id: sid,
        account: acct,
      }),
      JSON.stringify(lim?.body),
    );
  } finally {
    fs.rmSync(pctFile, { force: true });
    fs.rmSync(limFile, { force: true });
  }
}

async function contextNoFilesScenario(): Promise<void> {
  console.log("cc-context-report-hook.ts (no statusline files)");
  const sid = `smoke-ctx-none-${process.pid}`;
  const r = await runHook(
    "cc-context-report-hook.ts",
    JSON.stringify({ session_id: sid }),
  );
  check("exits 0", r.code === 0, `code=${r.code}`);
  check("no POST when both temp files absent", received.length === 0,
    `received=${JSON.stringify(received)}`);
}

async function stopFailureScenario(): Promise<void> {
  console.log("stop-failure-hook.ts");
  const r = await runHook(
    "stop-failure-hook.ts",
    JSON.stringify({
      session_id: "smoke-sf",
      transcript_path: "/x/t.jsonl",
    }),
  );
  check("exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
  const s = got("/session-stalled");
  check(
    "POST /session-stalled {cc_session_id, transcript_path}",
    subset(s?.body, {
      cc_session_id: "smoke-sf",
      transcript_path: "/x/t.jsonl",
    }),
    JSON.stringify(s?.body),
  );
}

async function postCompactScenario(): Promise<void> {
  console.log("post-compact-board-reminder.ts");
  const r = await runHook(
    "post-compact-board-reminder.ts",
    JSON.stringify({ session_id: "smoke-pc" }),
  );
  check("exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
  check(
    "stdout starts with the static notice",
    r.stdout.startsWith("[discussion-tree post-compact notice]"),
    r.stdout.slice(0, 60),
  );
  check(
    "stdout has checklist nudge with count 2",
    r.stdout.includes("You own 2 board(s)"),
  );
  check(
    "stdout has issue-link review with count 3",
    r.stdout.includes("3 message(s) from the window you just compacted"),
  );
  check(
    "POST /session-compacting-done",
    subset(got("/session-compacting-done")?.body, { cc_session_id: "smoke-pc" }),
  );
  check(
    "POST /report-context-usage {remaining_pct:100}",
    subset(got("/report-context-usage")?.body, {
      cc_session_id: "smoke-pc",
      remaining_pct: 100,
    }),
  );
  check(
    "POST /get-incomplete-checklists",
    subset(got("/get-incomplete-checklists")?.body, {
      cc_session_id: "smoke-pc",
    }),
  );
  check(
    "POST /review-message-links {from = previous_compact_at, unlinked_only, head_chars}",
    subset(got("/review-message-links")?.body, {
      cc_session_id: "smoke-pc",
      unlinked_only: true,
      head_chars: 60,
      from: "2026-09-23T01:02:03Z",
    }),
    JSON.stringify(got("/review-message-links")?.body),
  );
}

async function checkUnansweredScenario(): Promise<void> {
  console.log("check-unanswered-posts.ts");
  const r = await runHook(
    "check-unanswered-posts.ts",
    JSON.stringify({ session_id: "smoke-cu", stop_hook_active: false }),
  );
  check("exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  check(
    "stdout is {decision:block} naming the node + reply tool",
    parsed?.decision === "block" &&
      String(parsed?.reason).includes("Smoke board > I1") &&
      String(parsed?.reason).includes("reply with post_to_node"),
    r.stdout.slice(0, 120),
  );
  check(
    "POST /get-unanswered {cc_session_id}",
    subset(got("/get-unanswered")?.body, { cc_session_id: "smoke-cu" }),
    JSON.stringify(got("/get-unanswered")?.body),
  );
  check(
    "POST /heartbeat-tool {tool: stop-hook-continuation}",
    subset(got("/heartbeat-tool")?.body, {
      cc_session_id: "smoke-cu",
      tool: "stop-hook-continuation",
    }),
    JSON.stringify(got("/heartbeat-tool")?.body),
  );
}

async function toolActivityScenario(): Promise<void> {
  console.log("tool-activity-hook.ts");
  let r = await runHook(
    "tool-activity-hook.ts",
    JSON.stringify({
      session_id: "smoke-ta",
      tool_name: "Bash",
      tool_input: { command: "sleep 1", run_in_background: true },
      tool_use_id: "toolu_smoke",
    }),
  );
  check("exits 0, no stdout", r.code === 0 && r.stdout === "", `code=${r.code} stdout=${r.stdout}`);
  check(
    "POST /heartbeat-tool {tool: Bash}",
    subset(got("/heartbeat-tool")?.body, { cc_session_id: "smoke-ta", tool: "Bash" }),
    JSON.stringify(received),
  );
  check(
    "POST /bg-task-start {task_id: tool_use_id}",
    subset(got("/bg-task-start")?.body, { cc_session_id: "smoke-ta", task_id: "toolu_smoke" }),
    JSON.stringify(received),
  );
  r = await runHook(
    "tool-activity-hook.ts",
    JSON.stringify({ session_id: "smoke-ta", tool_name: "Read", agent_id: "ag1", agent_type: "general-purpose" }),
  );
  check(
    "subagent: only POST /heartbeat-subagent",
    received.length === 1 &&
      subset(got("/heartbeat-subagent")?.body, {
        cc_session_id: "smoke-ta",
        agent_id: "ag1",
        agent_type: "general-purpose",
      }),
    JSON.stringify(received),
  );
  r = await runHook("tool-activity-hook.ts", "not json");
  check("malformed stdin: exits 0, no POST", r.code === 0 && received.length === 0, JSON.stringify(received));
}

async function blockedOnUserScenario(): Promise<void> {
  console.log("blocked-on-user-hook.ts");
  let r = await runHook(
    "blocked-on-user-hook.ts",
    JSON.stringify({ session_id: "smoke-bu", tool_input: { plan: "The plan" } }),
    {},
    ["start"],
  );
  check("start: exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
  check(
    "start: POST /blocked-on-user-start {question: plan}",
    subset(got("/blocked-on-user-start")?.body, { cc_session_id: "smoke-bu", question: "The plan" }),
    JSON.stringify(received),
  );
  r = await runHook(
    "blocked-on-user-hook.ts",
    JSON.stringify({ session_id: "smoke-bu" }),
    {},
    ["clear"],
  );
  check(
    "clear: POST /blocked-on-user-clear",
    r.code === 0 && subset(got("/blocked-on-user-clear")?.body, { cc_session_id: "smoke-bu" }),
    JSON.stringify(received),
  );
}

async function singlePostScenarios(): Promise<void> {
  const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ["pre-compact-hook.ts", { session_id: "smoke-pre" }, "/session-compacting", { cc_session_id: "smoke-pre" }],
    ["tool-activity-clear-hook.ts", { session_id: "smoke-tac" }, "/clear-tool-activity", { cc_session_id: "smoke-tac" }],
    ["subagent-stop-hook.ts", { session_id: "smoke-ss", agent_id: "ag9" }, "/subagent-stop", { cc_session_id: "smoke-ss", agent_id: "ag9" }],
  ];
  for (const [script, input, endpoint, want] of cases) {
    console.log(script);
    const r = await runHook(script, JSON.stringify(input));
    check("exits 0, no stdout", r.code === 0 && r.stdout === "", `code=${r.code} stdout=${r.stdout}`);
    check(
      `POST ${endpoint} ${JSON.stringify(want)}`,
      received.length === 1 && JSON.stringify(got(endpoint)?.body) === JSON.stringify(want),
      JSON.stringify(received),
    );
  }
}

async function bgReconcileScenario(): Promise<void> {
  console.log("bg-task-reconcile-hook.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-smoke-bg-"));
  try {
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ m: "<task-notification><tool-use-id>toolu_B</tool-use-id><status>completed</status></task-notification>" }),
        JSON.stringify({ m: "<task-notification><tool-use-id>toolu_R</tool-use-id><status>running</status></task-notification>" }),
        JSON.stringify({ m: '<task-notification status="completed"><tool-use-id>toolu_A</tool-use-id></task-notification>' }),
      ].join("\n") + "\n",
    );
    const r = await runHook(
      "bg-task-reconcile-hook.ts",
      JSON.stringify({ session_id: "smoke-bg", transcript_path: transcript }),
    );
    check("exits 0, no stdout", r.code === 0 && r.stdout === "", `code=${r.code} stdout=${r.stdout}`);
    check(
      "POST /bg-task-done {task_ids: [toolu_A, toolu_B]} (running one excluded)",
      JSON.stringify(got("/bg-task-done")?.body) ===
        JSON.stringify({ cc_session_id: "smoke-bg", task_ids: ["toolu_A", "toolu_B"] }),
      JSON.stringify(received),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function ensureBrokerScenarios(): Promise<void> {
  console.log("ensure-broker-running.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dt-smoke-ensure-"));
  const spawnedTraces = () =>
    fs.existsSync(path.join(home, "broker.log")) ||
    fs.existsSync(path.join(home, ".broker-launch.lock"));
  try {
    // The mock answers GET /health, so it reads as an already-running broker.
    let r = await runHook("ensure-broker-running.ts", "{}", {
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_PORT: String(server.port),
    });
    check("healthy: exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    check("healthy: probed GET /health", received.some((x) => x.path === "/health"), JSON.stringify(received));
    check("healthy: no spawn (no broker.log / lock in home)", !spawnedTraces());

    // A remote broker URL: nothing to start here — not even a health probe of
    // the local port (which the mock would have recorded).
    r = await runHook("ensure-broker-running.ts", "{}", {
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_PORT: String(server.port),
      DISCUSSION_TREE_BROKER_URL: "https://remote-broker.invalid:7898",
    });
    check("remote: exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr.trim()}`);
    check("remote: no local /health probe", received.length === 0, JSON.stringify(received));
    check("remote: no spawn (no broker.log / lock in home)", !spawnedTraces());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---- Run --------------------------------------------------------------------
try {
  await contextScenario();
  await contextNoFilesScenario();
  await stopFailureScenario();
  await postCompactScenario();
  await checkUnansweredScenario();
  await toolActivityScenario();
  await blockedOnUserScenario();
  await singlePostScenarios();
  await bgReconcileScenario();
  await ensureBrokerScenarios();
} finally {
  server.stop(true);
}

console.log(
  `\n${failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures} check(s) failed)`}`,
);
process.exit(failures === 0 ? 0 : 1);
