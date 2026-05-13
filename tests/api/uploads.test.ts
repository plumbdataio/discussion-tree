import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as net from "node:net";
import {
  startBroker,
  post,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Send a single raw GET request (preserving `..` segments etc.) and return
// the response status code. Needed because WHATWG-URL / fetch() normalize
// path segments client-side, hiding traversal attempts from the server.
function rawHttpBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      // Strip headers; we only care about the body for this test.
      const sep = buf.indexOf("\r\n\r\n");
      resolve(sep >= 0 ? buf.slice(sep + 4) : buf);
    });
  });
}

let broker: BrokerHandle;

// 1×1 transparent PNG.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

describe("uploads", () => {
  test("/upload-image writes a file under UPLOADS_DIR/<safeBoard>/", async () => {
    const r = await post<{
      ok: boolean;
      path: string;
      url: string;
    }>(`${broker.url}/upload-image`, {
      board_id: "bd_test",
      filename: "shot.png",
      data_base64: TINY_PNG_B64,
      mime: "image/png",
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.path).toContain(`${broker.homeDir}/uploads/bd_test/`);
    expect(r.json.url).toMatch(/^\/uploads\/bd_test\/img_[a-z0-9_]+\.png$/);
    expect(existsSync(r.json.path)).toBe(true);
    expect(readFileSync(r.json.path).length).toBeGreaterThan(0);
  });

  test("/upload-image rejects empty payload", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/upload-image`,
      { data_base64: "" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/data_base64 required/);
  });

  test("/upload-image sanitizes board_id (e.g., '../escape')", async () => {
    const r = await post<{ ok: boolean; path: string; url: string }>(
      `${broker.url}/upload-image`,
      {
        board_id: "../escape",
        filename: "x.png",
        data_base64: TINY_PNG_B64,
      },
    );
    expect(r.json.ok).toBe(true);
    // safeBoard scrubs all non [a-zA-Z0-9_-] → "../escape" → "___escape".
    expect(r.json.path).toContain(`${broker.homeDir}/uploads/___escape/`);
  });

  test("GET /uploads/<rel> serves the uploaded file", async () => {
    const up = await post<{ url: string }>(`${broker.url}/upload-image`, {
      board_id: "bd_serve",
      filename: "shot.png",
      data_base64: TINY_PNG_B64,
    });
    const res = await fetch(`${broker.url}${up.json.url}`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  test("GET /uploads/ traversal attempts never serve a file outside the upload tree", async () => {
    // The broker has a defense-in-depth `rel.includes("..")` check, but in
    // practice `..` segments are collapsed by `new URL(req.url).pathname`
    // before that check runs. Confirm the front-line normalization keeps
    // the request from ever leaving /uploads/ scope — a path with `..`
    // resolves to /etc/passwd which falls through to the catch-all "broker
    // is alive" response, not to the actual file content.
    const body = await rawHttpBody(broker.port, "/uploads/../../etc/passwd");
    expect(body).not.toContain("root:");
    expect(body).toContain("discussion-tree broker");
  });

  test("GET /uploads/ 404 for missing file", async () => {
    const res = await fetch(`${broker.url}/uploads/bd_test/nope.png`);
    expect(res.status).toBe(404);
  });

  test("/open-file rejects paths outside UPLOADS_DIR", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/open-file`,
      { path: "/etc/passwd" },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/outside allowed/);
  });

  test("/open-file rejects when path is missing", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/open-file`,
      {},
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/path required/);
  });

  test("/open-file rejects an inside path that doesn't exist", async () => {
    const r = await post<{ ok: boolean; error?: string }>(
      `${broker.url}/open-file`,
      { path: `${broker.homeDir}/uploads/bd_test/nope.png` },
    );
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/file not found/);
  });
});
