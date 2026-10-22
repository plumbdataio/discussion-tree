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

  // --- derived + original pair (client-side prep for Claude) ---------------

  // A few bytes that only need to round-trip; the broker never decodes them.
  const FAKE_HEIC_B64 = Buffer.from("....ftypheic fake heic body").toString(
    "base64",
  );
  const SAFARI_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IPHONE_CHROME_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1";
  const CHROME_MAC_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
  const EDGE_WIN_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

  type UploadRes = {
    ok: boolean;
    path: string;
    url: string;
    original_path?: string;
    original_url?: string;
    error?: string;
  };

  async function fullSize(url: string, ua: string): Promise<string> {
    const res = await fetch(`${broker.url}${url}?full=1`, {
      headers: { "User-Agent": ua },
      redirect: "manual",
    });
    if (res.status === 302) {
      return new URL(res.headers.get("location")!, broker.url).pathname;
    }
    expect(res.status).toBe(200);
    return url;
  }

  test("old clients (no original fields) get no original_* in the response", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_compat",
      filename: "shot.png",
      data_base64: TINY_PNG_B64,
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.original_url).toBeUndefined();
    expect(r.json.original_path).toBeUndefined();
    // ?full=1 on an image with no original serves the image itself.
    expect(await fullSize(r.json.url, CHROME_MAC_UA)).toBe(r.json.url);
  });

  test("derived + original: both stored, named <id>.<ext> / <id>.orig.<ext>", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_pair",
      filename: "IMG_0001.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "IMG_0001.HEIC",
      original_base64: FAKE_HEIC_B64,
    });
    expect(r.json.ok).toBe(true);
    const m = r.json.url.match(/^\/uploads\/bd_pair\/(img_[a-z0-9_]+)\.jpg$/);
    expect(m).not.toBeNull();
    expect(r.json.original_url).toBe(`/uploads/bd_pair/${m![1]}.orig.heic`);
    expect(existsSync(r.json.path)).toBe(true);
    expect(existsSync(r.json.original_path!)).toBe(true);
    expect(readFileSync(r.json.original_path!).toString("base64")).toBe(
      FAKE_HEIC_B64,
    );
    // The original is served with its real type.
    const res = await fetch(`${broker.url}${r.json.original_url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/heic");
  });

  test("?full=1 opens a HEIC original only on WebKit; others get the JPEG", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_full",
      filename: "IMG_0002.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "IMG_0002.heic",
      original_base64: FAKE_HEIC_B64,
    });
    const orig = r.json.original_url!;
    expect(await fullSize(r.json.url, SAFARI_UA)).toBe(orig);
    expect(await fullSize(r.json.url, IPHONE_UA)).toBe(orig);
    expect(await fullSize(r.json.url, IPHONE_CHROME_UA)).toBe(orig);
    expect(await fullSize(r.json.url, CHROME_MAC_UA)).toBe(r.json.url);
    expect(await fullSize(r.json.url, EDGE_WIN_UA)).toBe(r.json.url);
  });

  test("?full=1 opens a JPEG original (pre-downscale) on every browser", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_full",
      filename: "big.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "big.jpeg",
      original_base64: TINY_PNG_B64,
    });
    expect(r.json.original_url).toMatch(/\.orig\.jpeg$/);
    expect(await fullSize(r.json.url, EDGE_WIN_UA)).toBe(r.json.original_url!);
    expect(await fullSize(r.json.url, SAFARI_UA)).toBe(r.json.original_url!);
  });

  test("a lone HEIC (browser could not convert) is stored as .heic, not .png", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_heic",
      filename: "IMG_0003.HEIC",
      data_base64: FAKE_HEIC_B64,
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.url).toMatch(/\.heic$/);
    expect(r.json.original_url).toBeUndefined();
  });

  test("an original with an unknown extension is kept as .bin and not redirected to", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_bin",
      filename: "x.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "x.raw",
      original_base64: TINY_PNG_B64,
    });
    expect(r.json.original_url).toMatch(/\.orig\.bin$/);
    expect(await fullSize(r.json.url, SAFARI_UA)).toBe(r.json.url);
  });

  test("an empty original_base64 is treated as not sent", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_emptyorig",
      filename: "x.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "x.heic",
      original_base64: "",
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.original_url).toBeUndefined();
  });

  test("an oversized original rejects the whole upload and writes nothing", async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 1).toString("base64");
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_bigorig",
      filename: "x.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "x.heic",
      original_base64: big,
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/original: file too large/);
    expect(existsSync(`${broker.homeDir}/uploads/bd_bigorig`)).toBe(false);
  });

  test("?full=1 on the original itself just serves it", async () => {
    const r = await post<UploadRes>(`${broker.url}/upload-image`, {
      board_id: "bd_full",
      filename: "y.jpg",
      data_base64: TINY_PNG_B64,
      original_filename: "y.jpg",
      original_base64: TINY_PNG_B64,
    });
    expect(await fullSize(r.json.original_url!, SAFARI_UA)).toBe(
      r.json.original_url!,
    );
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
