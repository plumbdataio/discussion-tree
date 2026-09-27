// The production broker serves a frontend prebuilt in a child process
// (broker/web-dist.ts) instead of bundling the HTML import in-process. These
// check the SPA routes, the hashed assets, and that no existing route is
// shadowed.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  get,
  post,
  registerSession,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  // Make sure the test does not inherit a dev/fallback setting.
  broker = await startBroker({ DT_DEV: "0", DT_WEB_PREBUILD: "1" });
});
afterAll(async () => {
  await broker.kill();
});

async function getHtml(p: string): Promise<{ res: Response; body: string }> {
  const res = await fetch(broker.url + p);
  return { res, body: await res.text() };
}

describe("prebuilt frontend serving", () => {
  test("GET / serves the prebuilt index.html", async () => {
    const { res, body } = await getHtml("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(body).toMatch(/<script[^>]+src="\/index-[^"]+\.js"/);
  });

  test("SPA deep links serve the same index.html", async () => {
    const root = (await getHtml("/")).body;
    for (const p of [
      "/board/xyz",
      "/session/s1",
      "/map/mp_1",
      "/diagram/dg_1",
    ]) {
      const { res, body } = await getHtml(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(body).toBe(root);
    }
  });

  test("hashed js and css assets are served with immutable caching", async () => {
    const { body } = await getHtml("/");
    const js = body.match(/src="(\/index-[^"]+\.js)"/)![1]!;
    const jsRes = await fetch(broker.url + js);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toMatch(/javascript/);
    expect(jsRes.headers.get("cache-control")).toContain("immutable");
    expect((await jsRes.text()).length).toBeGreaterThan(1000);

    const css = body.match(/href="(\/index-[^"]+\.css)"/)?.[1];
    if (css) {
      const cssRes = await fetch(broker.url + css);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get("content-type")).toMatch(/css/);
      await cssRes.arrayBuffer();
    }
  });

  test("an unknown top-level GET still falls through to the default", async () => {
    const res = await fetch(broker.url + "/index-doesnotexist.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("discussion-tree broker");
  });
});

describe("existing routes are not shadowed", () => {
  test("GET /health", async () => {
    const r = await get(`${broker.url}/health`);
    expect(r.status).toBe(200);
    expect((r.json as any).status).toBe("ok");
  });

  test("GET /manifest.webmanifest", async () => {
    const res = await fetch(broker.url + "/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("manifest+json");
    await res.arrayBuffer();
  });

  test("GET /api/sessions is JSON", async () => {
    const res = await fetch(broker.url + "/api/sessions");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await res.json();
  });

  test("GET /uploads/<missing> is 404", async () => {
    const res = await fetch(broker.url + "/uploads/nope.png");
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });

  test("POST route still works", async () => {
    const sid = await registerSession(broker.url, "/tmp/web-dist-test");
    expect(typeof sid).toBe("string");
    expect(sid.length).toBeGreaterThan(0);
  });

  test("POST to an unknown route is still 404", async () => {
    const r = await post(`${broker.url}/index.html`, {});
    expect(r.status).toBe(404);
  });
});

describe("fallback: prebuild disabled keeps the in-process HTML import", () => {
  let fb: BrokerHandle;
  beforeAll(async () => {
    fb = await startBroker({ DT_DEV: "0", DT_WEB_PREBUILD: "0" });
  });
  afterAll(async () => {
    await fb.kill();
  });

  test("GET / and a deep link still serve the app", async () => {
    for (const p of ["/", "/board/xyz"]) {
      const res = await fetch(fb.url + p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('id="root"');
    }
  }, 30_000);
});
