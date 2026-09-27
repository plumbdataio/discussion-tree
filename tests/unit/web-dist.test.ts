// Unit tests for broker/web-dist.ts: the prebuilt-frontend cache and the
// static asset resolver.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureWebDist,
  resolveDistAsset,
  pruneWebDist,
  computeDistKey,
  keepWebDistAlive,
  type SpawnResult,
} from "../../broker/web-dist.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-web-dist-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveDistAsset", () => {
  let dist: string;
  beforeEach(() => {
    dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(dist, "index-abc123.js"), "console.log(1)");
    fs.writeFileSync(path.join(dist, "index-def456.css"), "body{}");
    fs.writeFileSync(path.join(dist, ".complete"), "1");
    fs.mkdirSync(path.join(dist, "sub"));
    fs.writeFileSync(path.join(dist, "sub", "x.js"), "x");
    fs.mkdirSync(path.join(dist, "adir.js"));
  });

  test("resolves an existing top-level asset", () => {
    expect(resolveDistAsset(dist, "/index-abc123.js")).toBe(
      path.join(dist, "index-abc123.js"),
    );
    expect(resolveDistAsset(dist, "/index-def456.css")).toBe(
      path.join(dist, "index-def456.css"),
    );
  });

  test("rejects the root path and index.html (SPA routes own them)", () => {
    expect(resolveDistAsset(dist, "/")).toBeNull();
    expect(resolveDistAsset(dist, "")).toBeNull();
    expect(resolveDistAsset(dist, "/index.html")).toBeNull();
  });

  test("rejects traversal", () => {
    fs.writeFileSync(path.join(root, "secret.js"), "s");
    expect(resolveDistAsset(dist, "/../secret.js")).toBeNull();
    expect(resolveDistAsset(dist, "/..")).toBeNull();
    expect(resolveDistAsset(dist, "/..secret.js")).toBeNull();
    expect(resolveDistAsset(dist, "/%2e%2e/secret.js")).toBeNull();
  });

  test("rejects backslashes and nested paths", () => {
    expect(resolveDistAsset(dist, "/sub/x.js")).toBeNull();
    expect(resolveDistAsset(dist, "//index-abc123.js")).toBeNull();
    expect(resolveDistAsset(dist, "/sub\\x.js")).toBeNull();
    expect(resolveDistAsset(dist, "index-abc123.js")).toBeNull();
  });

  test("rejects missing files, directories and dotfiles", () => {
    expect(resolveDistAsset(dist, "/index-nope.js")).toBeNull();
    expect(resolveDistAsset(dist, "/adir.js")).toBeNull();
    expect(resolveDistAsset(dist, "/sub")).toBeNull();
    expect(resolveDistAsset(dist, "/.complete")).toBeNull();
  });

  test("never matches broker route names absent from dist", () => {
    for (const p of ["/health", "/manifest.webmanifest", "/api", "/uploads"]) {
      expect(resolveDistAsset(dist, p)).toBeNull();
    }
  });
});

// A fake `bun build`: writes the files a real build would into --outdir.
function fakeBuild(calls: string[][], files = true) {
  return (cmd: string[]): SpawnResult => {
    calls.push(cmd);
    const out = cmd[cmd.indexOf("--outdir") + 1]!;
    if (files) {
      fs.writeFileSync(
        path.join(out, "index.html"),
        '<script type="module" src="/index-aaa.js"></script>',
      );
      fs.writeFileSync(path.join(out, "index-aaa.js"), "1");
    }
    return { exitCode: 0, stderr: "" };
  };
}

describe("ensureWebDist", () => {
  test("builds on a miss, then hits the cache without spawning", () => {
    const calls: string[][] = [];
    const opts = {
      repoDir: root,
      cacheRoot: path.join(root, ".web-dist"),
      buildId: "abc",
      spawn: fakeBuild(calls),
    };
    const a = ensureWebDist(opts);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.built).toBe(true);
    expect(fs.existsSync(path.join(a.dir, ".complete"))).toBe(true);
    expect(fs.existsSync(path.join(a.dir, "index.html"))).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("--production");
    expect(calls[0]).toContain("--public-path");

    const b = ensureWebDist(opts);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.built).toBe(false);
    expect(b.dir).toBe(a.dir);
    expect(calls.length).toBe(1);
    // No temp dirs left behind.
    const left = fs
      .readdirSync(opts.cacheRoot)
      .filter((n) => n.startsWith(".tmp-"));
    expect(left).toEqual([]);
  });

  test("a different build id gets its own dir", () => {
    const calls: string[][] = [];
    const base = {
      repoDir: root,
      cacheRoot: path.join(root, ".web-dist"),
      spawn: fakeBuild(calls),
    };
    const a = ensureWebDist({ ...base, buildId: "one" });
    const b = ensureWebDist({ ...base, buildId: "two" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.dir).not.toBe(b.dir);
    expect(calls.length).toBe(2);
  });

  test("a failing build returns ok:false with stderr and leaves no dist", () => {
    const cacheRoot = path.join(root, ".web-dist");
    const r = ensureWebDist({
      repoDir: root,
      cacheRoot,
      buildId: "bad",
      spawn: () => ({ exitCode: 1, stderr: "error: Could not resolve x" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Could not resolve x");
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  test("a build that emits no index.html is a failure", () => {
    const calls: string[][] = [];
    const r = ensureWebDist({
      repoDir: root,
      cacheRoot: path.join(root, ".web-dist"),
      buildId: "empty",
      spawn: fakeBuild(calls, false),
    });
    expect(r.ok).toBe(false);
  });

  test("a throwing spawn is caught, never thrown", () => {
    const r = ensureWebDist({
      repoDir: root,
      cacheRoot: path.join(root, ".web-dist"),
      buildId: "boom",
      spawn: () => {
        throw new Error("spawn exploded");
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("spawn exploded");
  });

  test("an incomplete dir at the target is replaced", () => {
    const cacheRoot = path.join(root, ".web-dist");
    const target = path.join(cacheRoot, computeDistKey("junk", root));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "stray.txt"), "x");
    const r = ensureWebDist({
      repoDir: root,
      cacheRoot,
      buildId: "junk",
      spawn: fakeBuild([]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dir).toBe(target);
    expect(fs.existsSync(path.join(target, ".complete"))).toBe(true);
    expect(fs.existsSync(path.join(target, "stray.txt"))).toBe(false);
  });

  test("losing the publish race to a complete dir reuses it", () => {
    const cacheRoot = path.join(root, ".web-dist");
    const target = path.join(cacheRoot, computeDistKey("race", root));
    const r = ensureWebDist({
      repoDir: root,
      cacheRoot,
      buildId: "race",
      spawn: (cmd) => {
        // Another broker publishes while we are still building.
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "index.html"), "winner");
        fs.writeFileSync(path.join(target, ".complete"), "1");
        return fakeBuild([])(cmd);
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.built).toBe(false);
    expect(fs.readFileSync(path.join(target, "index.html"), "utf8")).toBe(
      "winner",
    );
    const left = fs.readdirSync(cacheRoot).filter((n) => n.startsWith(".tmp-"));
    expect(left).toEqual([]);
  });

  test("the real bun build of a tiny entry works end to end", () => {
    const web = path.join(root, "web");
    fs.mkdirSync(web);
    fs.writeFileSync(
      path.join(web, "index.html"),
      '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>',
    );
    fs.writeFileSync(path.join(web, "main.ts"), "console.log('hi');\n");
    const r = ensureWebDist({ repoDir: root, buildId: "tiny" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = fs.readFileSync(path.join(r.dir, "index.html"), "utf8");
    const m = html.match(/src="\/(index-[^"]+\.js)"/);
    expect(m).not.toBeNull();
    expect(resolveDistAsset(r.dir, `/${m![1]}`)).not.toBeNull();
  });

  test("the real build is a production build even if NODE_ENV is inherited", () => {
    const web = path.join(root, "web");
    fs.mkdirSync(web);
    fs.writeFileSync(
      path.join(web, "index.html"),
      '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(web, "main.ts"),
      'if (process.env.NODE_ENV !== "production") console.log("DEV_ONLY_MARKER");\nconsole.log("PROD_MARKER");\n',
    );
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const r = ensureWebDist({ repoDir: root, buildId: "env" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const js = fs
        .readdirSync(r.dir)
        .filter((n) => n.endsWith(".js"))
        .map((n) => fs.readFileSync(path.join(r.dir, n), "utf8"))
        .join("\n");
      expect(js).toContain("PROD_MARKER");
      expect(js).not.toContain("DEV_ONLY_MARKER");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  test("the real bun build failing on a missing entry returns ok:false", () => {
    const r = ensureWebDist({
      repoDir: root,
      entry: path.join(root, "nope", "index.html"),
      buildId: "missing",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
  });
});

describe("pruneWebDist", () => {
  test("removes only old dirs other than the kept one", () => {
    const cacheRoot = path.join(root, ".web-dist");
    const keep = path.join(cacheRoot, "cur");
    const old = path.join(cacheRoot, "old");
    const young = path.join(cacheRoot, ".tmp-inflight");
    for (const d of [keep, old, young]) fs.mkdirSync(d, { recursive: true });
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(keep, past, past);
    const removed = pruneWebDist(cacheRoot, keep, 60 * 60 * 1000);
    expect(removed).toEqual([old]);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(young)).toBe(true);
  });

  test("a dir kept alive by a running broker survives another's prune", () => {
    const cacheRoot = path.join(root, ".web-dist");
    const served = path.join(cacheRoot, "served-by-old-broker");
    const fresh = path.join(cacheRoot, "new-build");
    for (const d of [served, fresh]) fs.mkdirSync(d, { recursive: true });
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(served, past, past);
    const stop = keepWebDistAlive(served);
    try {
      expect(pruneWebDist(cacheRoot, fresh, 60 * 60 * 1000)).toEqual([]);
      expect(fs.existsSync(served)).toBe(true);
    } finally {
      stop();
    }
  });
});
