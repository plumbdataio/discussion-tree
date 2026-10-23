// Append-only JSON-lines failure log shared with the plugin hooks: the same file
// scripts/hook-io.ts logHookFailure writes (os.tmpdir()/dt-hook-failures.log,
// overridable with DT_HOOK_FAILURE_LOG, off under NODE_ENV=test).
//
// WHY a copy instead of importing scripts/hook-io.ts: the per-session MCP
// server is bundled for Node from server/ + shared/ only (scripts/mcp-node.mjs
// fingerprints those dirs), so a change in scripts/ would not rebuild the
// bundle. The MCP's own log() goes to stderr, which Claude Code does not keep,
// so failures that must be diagnosable afterwards are written here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_BYTES = 1024 * 1024;

export function failureLogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DT_HOOK_FAILURE_LOG) return env.DT_HOOK_FAILURE_LOG;
  if (env.NODE_ENV === "test") return "";
  return path.join(os.tmpdir(), "dt-hook-failures.log");
}

// Never throws, never prints.
export function logFailureLine(
  source: string,
  fields: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const file = failureLogPath(env);
    if (!file) return;
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, "");
    } catch {
      /* missing = nothing to trim */
    }
    const line = {
      ts: new Date().toISOString(),
      hook: source,
      pid: process.pid,
      ...fields,
    };
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {
    /* best-effort */
  }
}
