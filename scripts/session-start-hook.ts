#!/usr/bin/env bun
// discussion-tree SessionStart hook — Bun port of session-start-hook.sh.
//
// Writes a per-PID hint file so the MCP server can auto-attach to this Claude
// Code session at startup, surviving restarts without orphaning the user's UI
// submissions. Also forwards the session_id to the model as additionalContext.
//
// WHY A PORT. The shell version needs bash and jq, and on Windows it does not
// work even when both are installed: Claude Code reaches bash through a
// wrapper, so `$PPID` inside the script is that wrapper — not Claude Code. The
// hint file gets written under a PID the MCP server never looks up, and
// auto-attach fails with nothing to show for it. Bun is spawned directly, so
// process.ppid IS Claude Code's PID, which is the number the MCP server reads.
//
// It also drops two dependencies (bash, jq) for a runtime the broker and the
// MCP server already require.
//
// The PID pairing is the whole contract: hook writes <CC pid>.json, MCP server
// reads process.ppid. If either side ever stops being a direct child of Claude
// Code, auto-attach breaks silently — which is exactly the failure this file
// exists to fix.

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
let input: { session_id?: string; cwd?: string } = {};
try {
  input = JSON.parse(raw || "{}");
} catch {
  // A hook that throws blocks the session start, so a malformed payload has to
  // degrade to "no hint written" rather than to a broken startup.
}

const sid = String(input.session_id ?? "");
const cwd = String(input.cwd ?? process.cwd());

// Must resolve identically in the broker, the MCP server and here — the broker
// reads cc-sessions/ from this directory to auto-attach, so a hint written
// anywhere else fails silently. Keep in sync with broker/config.ts HOME_DIR.
const home =
  process.env.DISCUSSION_TREE_HOME ??
  path.join(os.homedir(), ".discussion-tree");
const dir = path.join(home, "cc-sessions");

if (sid) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${process.ppid}.json`),
      JSON.stringify({
        cc_session_id: sid,
        cwd,
        written_at: Math.floor(Date.now() / 1000),
      }),
    );
  } catch {
    // Same reasoning: a failed write must not take the session down with it.
    // The MCP server retries and self-heals on its heartbeat.
  }
}

// Standard SessionStart output: hand the session_id to the model, which is how
// it can call attach_cc_session manually if the automatic path never lands.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Your session_id is: ${sid}`,
    },
  }),
);
