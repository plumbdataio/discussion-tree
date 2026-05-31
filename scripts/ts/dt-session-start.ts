#!/usr/bin/env bun
// discussion-tree SessionStart hook — Windows/Bun port of
// scripts/session-start-hook.sh (no jq/bash needed).
//
// Writes a per-PID hint file so the discussion-tree MCP server can auto-attach
// to this Claude Code session at startup, surviving restarts without orphaning
// the user's UI submissions. Claude Code spawns this hook directly, so
// process.ppid == CC's PID — the same key the MCP server reads (process.ppid).
// Also forwards the session_id to the LLM via additionalContext.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const raw = await readStdin();
let input: any = {};
try {
  input = JSON.parse(raw);
} catch {
  /* tolerate empty / malformed stdin */
}

const sid = input.session_id ?? "";
const cwd = input.cwd ?? "";

// Match broker / MCP server resolution exactly: DISCUSSION_TREE_HOME wins,
// else <homedir>/.discussion-tree. All three components MUST agree.
const home =
  process.env.DISCUSSION_TREE_HOME ??
  path.join(os.homedir(), ".discussion-tree");
const dir = path.join(home, "cc-sessions");
fs.mkdirSync(dir, { recursive: true });

const ccPid = process.ppid;
fs.writeFileSync(
  path.join(dir, `${ccPid}.json`),
  JSON.stringify({
    cc_session_id: sid,
    cwd,
    written_at: Math.floor(Date.now() / 1000),
  }),
);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Your session_id is: ${sid}`,
    },
  }),
);
