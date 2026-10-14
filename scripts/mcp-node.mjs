#!/usr/bin/env node
// Node launcher for the per-session MCP server (server.ts).
//
// WHY: the MCP server runs once per Claude Code session for that session's
// whole lifetime. Under Bun its private commit is ~400 MB on Windows (the
// Bun/JSC runtime floor alone is ~200 MB); the same code under Node is
// ~40 MB. Node cannot run the TypeScript sources directly in every version we
// meet, so this launcher bundles server.ts into ONE plain ESM file with
// `bun build --target=node` and imports it in-process.
//
// Freshness: the bundle is keyed by a content fingerprint of everything that
// goes into it (server.ts, server/, shared/, package.json, bun.lock, the
// launcher files). A git pull or local edit changes the key, and the next
// session start rebuilds (~0.1 s). The bun build runs in a short-lived child, so its memory
// is not kept by this process.
//
// Cache: <repo>/.mcp-dist/server-<key>.mjs. Exactly ONE directory below the
// repo root on purpose: server/config.ts resolves the broker script as
// new URL("../broker.ts", import.meta.url), which must land on <repo>/broker.ts.
// Publication is atomic (write to a temp name, then rename), so concurrent
// session starts on a cold cache cannot import a half-written file.
//
// The build itself (and why it goes through a stub entry and rejects bundles
// with a module included twice) lives in scripts/mcp-node-build.mjs.
//
// This file must never write to stdout: stdout is the MCP JSON-RPC channel.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBundle, findDuplicateModules, fingerprint } from "./mcp-node-build.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(REPO, ".mcp-dist");
const PRUNE_AGE_MS = 60 * 60 * 1000;
const LAUNCHER_FILES = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./mcp-node-build.mjs", import.meta.url)),
];

function log(msg) {
  process.stderr.write(`[discussion-tree mcp-node] ${msg}\n`);
}

function prune(keep) {
  const now = Date.now();
  for (const name of fs.readdirSync(CACHE)) {
    const p = path.join(CACHE, name);
    if (p === keep) continue;
    try {
      if (now - fs.statSync(p).mtimeMs > PRUNE_AGE_MS) fs.rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function newestBundle() {
  try {
    return (
      fs
        .readdirSync(CACHE)
        .filter((n) => /^server-[0-9a-f]+\.mjs$/.test(n))
        .map((n) => path.join(CACHE, n))
        .filter((p) => findDuplicateModules(fs.readFileSync(p, "utf8")).length === 0)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ??
      null
    );
  } catch {
    return null;
  }
}

let bundle = path.join(CACHE, `server-${fingerprint(REPO, LAUNCHER_FILES)}.mjs`);
try {
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(bundle)) {
    buildBundle(path.join(REPO, "server.ts"), bundle, { cwd: REPO });
    log(`built ${path.basename(bundle)}`);
  }
  prune(bundle);
} catch (e) {
  // A failed rebuild should not take the session offline if an older bundle
  // exists: run it and say so. With nothing to fall back on, fail loudly.
  const fallback = newestBundle();
  if (!fallback) {
    log(`cannot build the MCP server bundle: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  log(
    `rebuild failed (${e instanceof Error ? e.message : String(e)}); running the previous bundle ${path.basename(fallback)}`,
  );
  bundle = fallback;
}

await import(pathToFileURL(bundle).href);
