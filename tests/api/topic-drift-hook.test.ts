import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

const HOOK_SCRIPT = new URL(
  "../../scripts/topic-drift-hook.ts",
  import.meta.url,
).pathname;

let broker: BrokerHandle;
let sessionId: string;
const CC_SESSION_ID = "cc-topic-drift-test-001";
let workDir: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId, CC_SESSION_ID);
  await post(`${broker.url}/create-board`, {
    session_id: sessionId,
    structure: {
      title: "TopicDrift target board",
      concerns: [{ id: "c1", title: "C1", items: [{ id: "i1", title: "I1" }] }],
    },
  });
  workDir = mkdtempSync(join(tmpdir(), "pd-hook-test-"));
});
afterAll(async () => {
  rmSync(workDir, { recursive: true, force: true });
  await broker.kill();
});

// Write a transcript fixture as JSONL with a single assistant message,
// then run the hook with that path. Returns stdout + exit code.
async function runHook(
  assistantText: string,
  opts: { ccSessionId?: string; brokerPort?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const transcriptPath = join(workDir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
    }) + "\n",
  );
  const payload = {
    session_id: opts.ccSessionId ?? CC_SESSION_ID,
    transcript_path: transcriptPath,
  };
  const proc = Bun.spawn(["bun", HOOK_SCRIPT], {
    env: {
      ...process.env,
      PARALLEL_DISCUSSION_PORT: String(opts.brokerPort ?? broker.port),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("topic-drift-hook", () => {
  test("emits reminder when assistant text uses 1. 2. 3. enumerated alternatives", async () => {
    const text = [
      "Here are some choices:",
      "1. Use Postgres for everything",
      "2. Use Postgres + Redis for caching",
      "3. Use SQLite locally and Postgres in prod",
    ].join("\n");
    const r = await runHook(text);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("<system-reminder>");
    expect(r.stdout).toContain("topic-drift");
    expect(r.stdout).toContain("TopicDrift target board");
  });

  test("emits reminder for A. / B. enumerated alternatives", async () => {
    const text = [
      "Two approaches:",
      "A. Use feature flags",
      "B. Hard-code the rollout",
    ].join("\n");
    const r = await runHook(text);
    expect(r.stdout).toContain("<system-reminder>");
  });

  test("emits reminder for Japanese 案 pattern", async () => {
    const text = "案A: caffeinate を常時起動\n案B: 個別に inhibit を使う";
    const r = await runHook(text);
    expect(r.stdout).toContain("<system-reminder>");
  });

  test("stays silent when text has no option-presentation pattern", async () => {
    const r = await runHook("Sure, I'll get right on that.");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent when the cc_session_id has no boards", async () => {
    const text = "1. opt1\n2. opt2\n3. opt3";
    const r = await runHook(text, { ccSessionId: "cc-other-session-no-boards" });
    expect(r.stdout).toBe("");
  });

  test("exits cleanly when transcript_path is missing", async () => {
    const proc = Bun.spawn(["bun", HOOK_SCRIPT], {
      env: { ...process.env, PARALLEL_DISCUSSION_PORT: String(broker.port) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({ session_id: CC_SESSION_ID }));
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
