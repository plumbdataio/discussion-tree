import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let broker: BrokerHandle;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  broker = await startBroker();
  sessionA = await registerSession(broker.url, "/tmp/fb-a");
  sessionB = await registerSession(broker.url, "/tmp/fb-b");
  await attachCC(broker.url, sessionA);
  await attachCC(broker.url, sessionB);
});
afterAll(async () => {
  await broker.kill();
});

describe("log-request fan-out", () => {
  test("appends an entry to REQUESTS.md and notifies other sessions", async () => {
    const title = `feedback-${Math.random().toString(36).slice(2)}`;
    const r = await post<{ ok: boolean; file: string }>(
      `${broker.url}/log-request`,
      {
        session_id: sessionA,
        title,
        blocker: "Cannot do X",
        suggested_change: "Add Y",
      },
    );
    expect(r.json.ok).toBe(true);
    const md = readFileSync(r.json.file, "utf-8");
    expect(md).toContain(title);
    expect(md).toContain("Cannot do X");
    expect(md).toContain("Add Y");

    // Session A should NOT receive its own feedback (the loop skips it).
    // Session B should.
    const polledA = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionA },
    );
    const polledB = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionB },
    );
    // A may also have OTHER messages from earlier tests; check there's no
    // feedback_logged entry for this specific title.
    expect(
      polledA.json.messages.find(
        (m) => m.kind === "feedback_logged" && (m.text ?? "").includes(title),
      ),
    ).toBeFalsy();
    expect(
      polledB.json.messages.find(
        (m) => m.kind === "feedback_logged" && (m.text ?? "").includes(title),
      ),
    ).toBeTruthy();
  });

  test("works without optional suggested_change", async () => {
    const r = await post<{ ok: boolean; file: string }>(
      `${broker.url}/log-request`,
      {
        session_id: sessionA,
        title: "no suggestion",
        blocker: "Foo",
      },
    );
    expect(r.json.ok).toBe(true);
  });

  test("optional board_id flows into the notification text", async () => {
    const c = await post<{ board_id: string }>(`${broker.url}/create-board`, {
      session_id: sessionA,
      structure: { title: "fb-board", concerns: [{ id: "x", title: "x" }] },
    });
    const title = `fb-with-board-${Math.random().toString(36).slice(2)}`;
    await post(`${broker.url}/log-request`, {
      session_id: sessionA,
      title,
      blocker: "B",
      board_id: c.json.board_id,
    });
    const polledB = await post<{ messages: any[] }>(
      `${broker.url}/poll-messages`,
      { session_id: sessionB },
    );
    const matching = polledB.json.messages.find(
      (m) => m.kind === "feedback_logged" && (m.text ?? "").includes(title),
    );
    expect(matching).toBeTruthy();
    expect(matching.text).toContain(c.json.board_id);
  });
});
