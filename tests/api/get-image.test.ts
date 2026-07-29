import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Looking at an attachment when the file is on ANOTHER machine. The message's
// absolute path belongs to the broker's disk, so Read opens nothing; the bytes
// come over the same connection the conversation does, and are handed to the
// model as image content — nothing is written to disk on either side.
//
// This exercises the broker half (upload, then serve). The MCP half turns the
// response into MCP image content, which needs a live stdio server to observe.

let broker: BrokerHandle;
let sessionId: string;

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeAll(async () => {
  broker = await startBroker();
  sessionId = await registerSession(broker.url);
});
afterAll(async () => {
  await broker.kill();
});

describe("uploads — fetchable as bytes, not just as a path", () => {
  test("what was uploaded comes back byte for byte", async () => {
    const up = await post<{ ok: boolean; url: string; path: string }>(
      `${broker.url}/upload-image`,
      { board_id: "bd_test", filename: "shot.png", data_base64: PNG_B64 },
    );
    expect(up.json.ok).toBe(true);
    // Both forms are returned: the URL (works from anywhere the broker is
    // reachable) and the absolute path (only meaningful on this machine).
    expect(up.json.url).toStartWith("/uploads/");
    expect(up.json.path).toContain("/uploads/");

    const res = await fetch(`${broker.url}${up.json.url}`);
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer()).toString("base64");
    expect(got).toBe(PNG_B64);
  });

  test("a missing image is a 404, not an empty success", async () => {
    const res = await fetch(`${broker.url}/uploads/bd_test/nope.png`);
    expect(res.status).toBe(404);
  });

  test("the uploads route cannot be walked out of", async () => {
    // The path lands on the filesystem, so a caller must not be able to climb
    // out of the uploads directory with it.
    const res = await fetch(`${broker.url}/uploads/..%2f..%2fdb.sqlite`);
    expect(res.ok).toBe(false);
  });
});
