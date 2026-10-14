// Build helpers for scripts/mcp-node.mjs (the Node launcher of the per-session
// MCP server). Kept in a side-effect-free module so tests can import them.
//
// This file must never write to stdout: the launcher's stdout is the MCP
// JSON-RPC channel.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function listTs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTs(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Content fingerprint of everything that goes into the bundle (plus the
// launcher files themselves, so a change to how we build invalidates bundles
// built the old way).
export function fingerprint(repo, extraFiles = []) {
  const files = [
    path.join(repo, "server.ts"),
    ...listTs(path.join(repo, "server")),
    ...listTs(path.join(repo, "shared")),
    path.join(repo, "package.json"),
    path.join(repo, "bun.lock"),
    ...extraFiles,
  ].sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(path.relative(repo, f).replace(/\\/g, "/"));
    h.update("\0");
    try {
      h.update(fs.readFileSync(f));
    } catch {
      h.update("<missing>");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

// Bun emits a "// <path>" comment before each module's code in a bundle. A
// module whose external imports are hoisted gets the comment twice: once over
// the hoisted `import ... from "node:x"` lines and once over its body. A module
// that was BUNDLED TWICE has two headers with real code under them; that is
// what this reports. Returns the module paths (as Bun prints them) that start
// with one of `prefixes` and carry code under more than one header.
export function findDuplicateModules(code, prefixes = ["server/", "shared/"]) {
  const bodies = new Map();
  let current = null;
  let hasCode = false;
  let inImport = false;
  const flush = () => {
    if (current !== null && hasCode) {
      bodies.set(current, (bodies.get(current) ?? 0) + 1);
    }
  };
  for (const raw of code.split("\n")) {
    const line = raw.trimEnd();
    const header = /^\/\/ (\S+\.(?:[cm]?[jt]sx?))$/.exec(line);
    if (header) {
      flush();
      current = header[1];
      hasCode = false;
      inImport = false;
      continue;
    }
    if (current === null || hasCode) continue;
    const t = line.trim();
    if (t === "") continue;
    // Hoisted imports, single- or multi-line ("import {\n  a,\n} from ...").
    if (inImport) {
      if (/\bfrom\s+["'][^"']+["'];?$/.test(t)) inImport = false;
      continue;
    }
    if (/^import\b/.test(t)) {
      if (!/["'];?$/.test(t)) inImport = true;
      continue;
    }
    hasCode = true;
  }
  flush();
  return [...bodies]
    .filter(([p, n]) => n > 1 && prefixes.some((pre) => p.startsWith(pre)))
    .map(([p]) => p)
    .sort();
}

// Bundle `entry` for Node into `outFile` with `bun build --target=node`.
//
// The entry is NOT handed to bun directly: bun build treats an entry file that
// starts with `#!/usr/bin/env bun` as a Bun-target file even under
// --target=node, and then the modules the entry imports are bundled a second
// time, separately from the copies reached through the other modules (two
// `server/state.ts` instances = the session registered by one is invisible to
// the other). server.ts has that shebang. With a CRLF checkout (Windows,
// core.autocrlf) the shebang line ends in "\r" and is not recognised, which is
// why the bug only showed up on LF checkouts (macOS). Building from a one-line
// stub that imports the entry sidesteps the shebang rule whatever the line
// endings. The result is still checked for duplicated modules, and a bundle
// with any is rejected rather than published.
/**
 * @param {string} entry
 * @param {string} outFile
 * @param {{ cwd?: string, bun?: string }} [opts]
 */
export function buildBundle(entry, outFile, { cwd, bun = "bun" } = {}) {
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true });
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const stub = path.join(dir, `_entry-${tag}.mjs`);
  const tmp = `${outFile}.${tag}.tmp.mjs`;
  // Absolute specifier: a relative one breaks when the two paths sit on
  // different sides of a symlink (macOS /tmp -> /private/tmp).
  const spec = path.resolve(entry).replace(/\\/g, "/");
  const cleanup = () => {
    for (const f of [stub, tmp]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  };
  try {
    fs.writeFileSync(stub, `import ${JSON.stringify(spec)};\n`);
    const res = spawnSync(bun, ["build", stub, "--target=node", "--outfile", tmp], {
      cwd: cwd ?? path.dirname(entry),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      timeout: 120_000,
    });
    if (res.status !== 0 || !fs.existsSync(tmp)) {
      const why = res.error
        ? res.error.message
        : String(res.stderr ?? "").trim().slice(-500);
      throw new Error(`bun build failed: ${why}`);
    }
    const dups = findDuplicateModules(fs.readFileSync(tmp, "utf8"));
    if (dups.length > 0) {
      throw new Error(`bun build bundled these modules twice: ${dups.join(", ")}`);
    }
    try {
      fs.renameSync(tmp, outFile);
    } catch (e) {
      // Another session published the same key first; theirs is identical.
      if (!fs.existsSync(outFile)) throw e;
    }
  } finally {
    cleanup();
  }
}
