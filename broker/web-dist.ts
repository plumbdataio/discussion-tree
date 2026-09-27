// Prebuilt frontend for production mode.
//
// WHY: broker.ts used to serve the SPA only through an HTML import
// (`import indexHtml from "./web/index.html"` placed in Bun.serve `routes`).
// Bun bundles that lazily IN-PROCESS on the first page request, and the
// bundler's working memory (~340-390 MB, measured 2026-09-27, shown as
// "IOAccelerator" 128 MB slabs in `footprint`) is never handed back to the OS.
// The broker is a long-lived all-day process, so that one-off build cost is
// paid for its whole lifetime. A static server serving the same prebuilt
// output stayed at ~10 MB.
//
// So in production we run `bun build` in a SHORT-LIVED CHILD PROCESS and serve
// its static output. The bundler's memory dies with the child.
//
// Cache: `<repo>/.web-dist/<key>/`, repo-local on purpose (NOT under
// DISCUSSION_TREE_HOME): every test broker gets its own temp HOME, and a
// per-HOME cache would make each of them rebuild. <key> is the web/ content
// fingerprint (WEB_BUILD_ID) plus a small fingerprint of what else changes the
// output without touching web/ (bun version, package.json, bun.lock) — a
// dependency upgrade must not keep serving a bundle of the old dependencies.
//
// Publication is atomic: build into a unique temp dir, write `.complete`, then
// rename into place. Concurrent brokers racing on a cold cache each build
// their own temp dir; the first rename wins and the others discard theirs.
//
// This module never throws from ensureWebDist(): a failure returns
// {ok:false} and the broker falls back to in-process bundling, so the UI can
// never go down because of the prebuild.

import * as fs from "node:fs";
import * as path from "node:path";
import { WEB_BUILD_ID } from "./web-build-id.ts";

export type WebDistResult =
  | { ok: true; dir: string; built: boolean }
  | { ok: false; error: string };

export type SpawnResult = { exitCode: number | null; stderr: string };

export type WebDistOptions = {
  /** Repo root (contains web/ and receives .web-dist/). */
  repoDir?: string;
  /** HTML entry to build. Default: <repoDir>/web/index.html. */
  entry?: string;
  /** Cache root. Default: <repoDir>/.web-dist. */
  cacheRoot?: string;
  /** Web content fingerprint. Default: WEB_BUILD_ID. */
  buildId?: string;
  /** Build runner (overridable for tests). */
  spawn?: (cmd: string[], cwd: string) => SpawnResult;
  /** Age after which other cache subdirs are pruned. Default 1h. */
  pruneAgeMs?: number;
};

const DEFAULT_REPO_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_PRUNE_AGE_MS = 60 * 60 * 1000;
// A build takes ~0.5 s; this is only a guard against a hung child blocking
// broker startup forever.
const BUILD_TIMEOUT_MS = 120_000;
const COMPLETE_MARKER = ".complete";
const TMP_PREFIX = ".tmp-";

function defaultSpawn(cmd: string[], cwd: string): SpawnResult {
  const r = Bun.spawnSync(cmd, {
    cwd,
    // `--production` does NOT override an inherited NODE_ENV: a broker started
    // with NODE_ENV=test (e.g. under `bun test`) produced a bundle with React's
    // development runtime (measured 2026-09-27). Pin it.
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "ignore",
    stderr: "pipe",
    timeout: BUILD_TIMEOUT_MS,
  });
  return {
    exitCode: r.exitCode,
    stderr: r.stderr ? r.stderr.toString() : "",
  };
}

function statSig(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return "-";
  }
}

/** Cache key = web fingerprint + fingerprint of non-web inputs to the build. */
export function computeDistKey(buildId: string, repoDir: string): string {
  const extra = [
    Bun.version,
    statSig(path.join(repoDir, "package.json")),
    statSig(path.join(repoDir, "bun.lock")),
  ].join("|");
  return `${buildId}-${Bun.hash(extra).toString(36)}`;
}

export function isCompleteDist(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, COMPLETE_MARKER)) &&
    fs.existsSync(path.join(dir, "index.html"))
  );
}

function tail(s: string, max = 2000): string {
  const t = s.trim();
  return t.length > max ? "..." + t.slice(-max) : t;
}

function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Remove other cache subdirs older than maxAgeMs. Never touches `keep`. */
export function pruneWebDist(
  cacheRoot: string,
  keep: string,
  maxAgeMs: number = DEFAULT_PRUNE_AGE_MS,
  now: number = Date.now(),
): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(cacheRoot, e.name);
    if (path.resolve(full) === path.resolve(keep)) continue;
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs < maxAgeMs) continue; // maybe another broker's in-flight build
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Mark `dir` as in use so another broker's prune never deletes it. Pruning is
 * by mtime, and a long-running broker keeps serving a dir whose mtime is its
 * build time: without this, a test run after a web/ edit (new key) would prune
 * the live broker's dist an hour later and its page would stop loading.
 * Touches now and then every 10 minutes (well inside the 1h prune age).
 */
export function keepWebDistAlive(
  dir: string,
  intervalMs: number = KEEPALIVE_INTERVAL_MS,
): () => void {
  const touch = () => {
    try {
      const now = new Date();
      fs.utimesSync(dir, now, now);
    } catch {
      /* best effort */
    }
  };
  touch();
  const t = setInterval(touch, intervalMs);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}

/**
 * Make sure a complete prebuilt frontend exists for the current web/ content
 * and return its directory. Builds in a child process on a cache miss. Never
 * throws.
 */
export function ensureWebDist(opts: WebDistOptions = {}): WebDistResult {
  try {
    const repoDir = opts.repoDir ?? DEFAULT_REPO_DIR;
    const entry = opts.entry ?? path.join(repoDir, "web", "index.html");
    const cacheRoot = opts.cacheRoot ?? path.join(repoDir, ".web-dist");
    const buildId = opts.buildId ?? WEB_BUILD_ID;
    const spawn = opts.spawn ?? defaultSpawn;
    const dir = path.join(cacheRoot, computeDistKey(buildId, repoDir));

    if (isCompleteDist(dir)) return { ok: true, dir, built: false };

    fs.mkdirSync(cacheRoot, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(cacheRoot, TMP_PREFIX));

    const r = spawn(
      [
        process.execPath,
        "build",
        entry,
        "--outdir",
        tmpDir,
        "--production",
        "--public-path",
        "/",
      ],
      repoDir,
    );
    if (r.exitCode !== 0) {
      rmQuiet(tmpDir);
      return {
        ok: false,
        error: `bun build exited with ${r.exitCode}: ${tail(r.stderr)}`,
      };
    }
    if (!fs.existsSync(path.join(tmpDir, "index.html"))) {
      rmQuiet(tmpDir);
      return {
        ok: false,
        error: `bun build produced no index.html: ${tail(r.stderr)}`,
      };
    }
    fs.writeFileSync(path.join(tmpDir, COMPLETE_MARKER), `${Date.now()}\n`);

    try {
      fs.renameSync(tmpDir, dir);
    } catch (e) {
      // Lost the race to a concurrent broker (rename onto a non-empty dir
      // fails), or `dir` is foreign junk without the marker.
      if (isCompleteDist(dir)) {
        rmQuiet(tmpDir);
        return { ok: true, dir, built: false };
      }
      try {
        rmQuiet(dir);
        fs.renameSync(tmpDir, dir);
      } catch (e2) {
        rmQuiet(tmpDir);
        if (isCompleteDist(dir)) return { ok: true, dir, built: false };
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return { ok: false, error: `could not publish build: ${msg}` };
      }
    }

    pruneWebDist(cacheRoot, dir, opts.pruneAgeMs ?? DEFAULT_PRUNE_AGE_MS);
    return { ok: true, dir, built: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

// Bun's output names: `index-<hash>.js`, `index-<hash>.css`, plus any
// top-level asset. Deliberately narrow: one path segment, safe characters,
// no leading dot (hides `.complete`).
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Map a request pathname to a prebuilt asset file, or null. Only top-level
 * regular files that exist in distDir qualify; index.html is excluded (the
 * SPA routes serve it). Because it only ever matches real dist files, it
 * cannot shadow any broker route.
 */
export function resolveDistAsset(
  distDir: string,
  pathname: string,
): string | null {
  if (!pathname.startsWith("/")) return null;
  const name = pathname.slice(1);
  if (!name || name === "index.html") return null;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return null;
  }
  if (!ASSET_NAME.test(name)) return null;
  const full = path.join(distDir, name);
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}
