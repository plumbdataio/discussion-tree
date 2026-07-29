// A fingerprint of the frontend this broker process is serving.
//
// WHY: Bun bundles web/ into memory at startup (`import indexHtml from
// "./web/index.html"`), so a page keeps running the bundle it was loaded with
// until someone reloads it. HMR used to paper over that, but it reloaded the
// user's page on every keystroke-level edit and had to go (see broker.ts), which
// left "remember to hard-refresh" as a human step — and a human step that is
// only needed occasionally is one that gets forgotten, on both sides.
//
// So the broker states which frontend it has, every client remembers the value
// it first saw, and a client that reconnects to a DIFFERENT value knows its own
// bundle is stale. The restart is the signal: a web/ change cannot reach the
// browser without one, so hooking here cannot be forgotten. A broker/-only
// change restarts too but leaves the fingerprint untouched, so it does not
// nag about an update that does not exist.
//
// Content-derived, not a random id or a timestamp: restarting the broker
// without touching web/ must NOT look like a new frontend.

import * as fs from "node:fs";
import * as path from "node:path";

// Files that end up in the bundle. Everything else under web/ (fixtures, notes)
// would only add false positives.
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".json",
]);

function collect(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — contributes nothing rather than throwing
  }
  // Sorted so the digest does not depend on filesystem enumeration order.
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      collect(full, acc);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(e.name))) continue;
    try {
      const st = fs.statSync(full);
      // Size + mtime rather than the bytes: this runs on every boot, and the
      // pair changes for any edit that could change the bundle. A same-size
      // same-mtime write is not something an editor produces.
      acc.push(`${full}:${st.size}:${Math.floor(st.mtimeMs)}`);
    } catch {
      /* vanished mid-walk — skip */
    }
  }
}

export function computeWebBuildId(webDir: string): string {
  const parts: string[] = [];
  collect(webDir, parts);
  if (parts.length === 0) return "unknown";
  return Bun.hash(parts.join("\n")).toString(36);
}

// Resolved once at import: the bundle is fixed for the life of the process, so
// re-walking web/ per connection would be pure cost.
export const WEB_BUILD_ID = computeWebBuildId(
  path.join(import.meta.dir, "..", "web"),
);
