import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;
let sessionId: string;
let requestsFile: string;

beforeAll(async () => {
  // Override the REQUESTS.md path so the test doesn't mutate the repo file.
  // tmp directory is created fresh per harness; place the file inside it.
  const fakePath = `/tmp/pd-requests-${Math.random().toString(36).slice(2)}.md`;
  broker = await startBroker({ DISCUSSION_TREE_REQUESTS_FILE: fakePath });
  requestsFile = fakePath;
  sessionId = await registerSession(broker.url);
  await attachCC(broker.url, sessionId);
});
afterAll(async () => {
  await broker.kill();
  if (existsSync(requestsFile)) {
    require("node:fs").rmSync(requestsFile);
  }
});

describe("feedback", () => {
  test("/log-request appends an entry to REQUESTS.md and returns the file path", async () => {
    const r = await post<{ ok: boolean; file: string }>(
      `${broker.url}/log-request`,
      {
        session_id: sessionId,
        title: "Test feedback",
        blocker: "Cannot do X",
        suggested_change: "Add Y",
        category: "ux",
        urgency: "low",
      },
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.file).toBe(requestsFile);
    // Verify the file was actually appended (not just the response).
    expect(existsSync(requestsFile)).toBe(true);
    expect(readFileSync(requestsFile, "utf8")).toContain("Test feedback");
  });

  test("/log-request notifies other alive sessions via pending_messages (kind=feedback_logged)", async () => {
    // Register a second session that will receive the broadcast.
    const otherSession = await registerSession(broker.url, "/tmp/other-cwd");
    await attachCC(broker.url, otherSession);

    await post(`${broker.url}/log-request`, {
      session_id: sessionId,
      title: "Cross-session signal",
      blocker: "Need a way to do Z",
    });

    // Other session polls and should see a feedback_logged message.
    const polled = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: otherSession },
    );
    const fb = polled.json.messages.find((m) => m.kind === "feedback_logged");
    expect(fb).toBeTruthy();
    expect(fb.text).toContain("Cross-session signal");
  });

  test("/log-request does NOT notify the requester themselves", async () => {
    await post(`${broker.url}/log-request`, {
      session_id: sessionId,
      title: "Self-notify check",
      blocker: "x",
    });
    const polled = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionId },
    );
    const echoed = polled.json.messages.find(
      (m) => m.kind === "feedback_logged" && m.text.includes("Self-notify check"),
    );
    expect(echoed).toBeUndefined();
  });
});
