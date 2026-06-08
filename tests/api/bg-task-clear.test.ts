import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// The BG marker is registered (PreToolUse hook) under the launching Bash
// call's tool_use_id. A completed <task-notification> carries BOTH a short
// <task-id> and the <tool-use-id>; only the tool_use_id matches what was
// registered. The bg-task-reconcile Stop hook and report_bg_task_done both
// clear by tool_use_id — clearing by the short task-id is a silent no-op (the
// historical bug). These tests pin that contract.

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

async function start(taskId: string) {
  return (
    await post<{ ok: boolean; count: number }>(`${broker.url}/bg-task-start`, {
      cc_session_id: ccId,
      task_id: taskId,
    })
  ).json;
}
async function done(taskIds: string[]) {
  return (
    await post<{ ok: boolean; cleared: number; remaining: number }>(
      `${broker.url}/bg-task-done`,
      { cc_session_id: ccId, task_ids: taskIds },
    )
  ).json;
}

describe("bg-task marker clear-by-tool_use_id contract", () => {
  test("start registers by tool_use_id and counts up", async () => {
    expect((await start("toolu_AAA")).count).toBe(1);
    expect((await start("toolu_BBB")).count).toBe(2);
  });

  test("clearing by the short <task-id> does NOT match (the bug we fixed)", async () => {
    const r = await done(["biyvamak5"]); // a short shell id, never registered
    expect(r.cleared).toBe(0);
    expect(r.remaining).toBe(2);
  });

  test("clearing by the <tool-use-id> clears the markers", async () => {
    const r = await done(["toolu_AAA", "toolu_BBB"]);
    expect(r.cleared).toBe(2);
    expect(r.remaining).toBe(0);
  });

  test("re-clearing already-cleared ids is an idempotent no-op", async () => {
    const r = await done(["toolu_AAA", "toolu_BBB"]);
    expect(r.cleared).toBe(0);
    expect(r.remaining).toBe(0);
  });

  test("an unknown cc_session_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/bg-task-done`, {
      cc_session_id: "cc-nope",
      task_ids: ["toolu_AAA"],
    });
    expect(r.json.ok).toBe(false);
  });
});
