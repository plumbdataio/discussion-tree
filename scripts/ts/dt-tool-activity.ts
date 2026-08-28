#!/usr/bin/env bun
// discussion-tree PreToolUse hook — Windows/Bun port of
// scripts/tool-activity-hook.sh (no jq/curl needed).
//
// Pings the broker on every tool invocation so the UI can show a "working"
// activity badge automatically. Best-effort — any failure (broker down, etc.)
// is swallowed so it never blocks tool use. Short timeout keeps tool latency low.
import { brokerBaseUrl } from "../broker-url.ts";

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
const tool = input.tool_name ?? "";
// A SUBAGENT (Task worker) tool call fires THIS SAME hook under the parent's
// session_id, but its stdin carries an agent_id the parent's own tool calls
// never do. Detection is the PRESENCE of agent_id. agent_type is ALSO forwarded:
// a real subagent's is a non-empty string (e.g. "general-purpose") while
// transient harness "helper" subagents send an empty agent_type; the broker uses
// that to register only real subagents (empty-type helpers never get a
// SubagentStop and would leak).
const agentId = input.agent_id ?? "";
const agentType = input.agent_type ?? "";

async function post(path: string, body: unknown): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1000);
  await fetch(`${brokerBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).catch(() => {});
  clearTimeout(t);
}

if (sid && agentId) {
  // Subagent branch: DON'T ping /heartbeat-tool (that would spin the PARENT's
  // working badge for the subagent's work). Record a per-subagent heartbeat so
  // the UI shows a distinct "subagent running" indicator instead.
  await post("/heartbeat-subagent", {
    cc_session_id: sid,
    agent_id: agentId,
    agent_type: agentType,
  });
} else if (sid) {
  await post("/heartbeat-tool", { cc_session_id: sid, tool });
}

process.exit(0);
