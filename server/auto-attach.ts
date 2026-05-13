// Bridge between the SessionStart hook and the broker.
//
// The hook (scripts/session-start-hook.sh) writes a small JSON file keyed by
// CC's PID into <state-dir>/cc-sessions/. From the hook's POV $PPID is CC;
// from this MCP server's POV process.ppid is also CC, so the two sides
// agree on the filename. After we read+attach we delete the file
// (idempotent — at most one attach per CC start).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brokerFetch } from "./broker-client.ts";
import { log } from "./log.ts";
import { getSessionId } from "./state.ts";

export async function tryAutoAttach(): Promise<void> {
  const ccPid = process.ppid;
  // Resolves the same way the hook does — PARALLEL_DISCUSSION_HOME wins,
  // else default. CC inherits the env, so when the user overrides it the
  // hook and this lookup stay in sync.
  const homeDir =
    process.env.PARALLEL_DISCUSSION_HOME ??
    path.join(os.homedir(), ".parallel-discussion");
  const file = path.join(homeDir, "cc-sessions", `${ccPid}.json`);
  // The SessionStart hook and this MCP server are both spawned by Claude
  // Code at startup, in parallel — if main() reaches here before the hook
  // finishes writing, a single existsSync would miss the file and we'd
  // skip the bind for the entire CC session. Poll briefly so the bind
  // catches the file as soon as it lands.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(file)) return;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { cc_session_id?: string };
    const ccId = parsed.cc_session_id;
    if (!ccId) return;
    await brokerFetch("/attach-cc-session", {
      session_id: getSessionId(),
      cc_session_id: ccId,
    });
    log(`Auto-attached to CC session ${ccId} via hook hint`);
    fs.unlinkSync(file);
  } catch (e) {
    log(
      `Auto-attach skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
