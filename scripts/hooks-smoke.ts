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

import * as fs from "node:fs";
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
): Promise<{ stdout: string; stderr: string; code: number }> {
  received = [];
  const scriptPath = path.join(import.meta.dir, script);
  const proc = Bun.spawn(["bun", scriptPath], {
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

// ---- Run --------------------------------------------------------------------
try {
  await contextScenario();
  await contextNoFilesScenario();
  await stopFailureScenario();
  await postCompactScenario();
  await checkUnansweredScenario();
} finally {
  server.stop(true);
}

console.log(
  `\n${failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures} check(s) failed)`}`,
);
process.exit(failures === 0 ? 0 : 1);
