#!/usr/bin/env bun
// discussion-tree SubagentStop hook — Windows/Bun port of
// scripts/subagent-stop-hook.sh (no jq/curl needed).
//
// Fires when a Task-worker subagent finishes. Tells the broker to drop that
// subagent from the per-session "subagent running" indicator so it stops
// showing without waiting for the timeout backstop. It is UNKNOWN whether the
// SubagentStop stdin carries an agent_id: if present, forward it so exactly that
// subagent is dropped; if absent, the broker drops all still-running subagents
// for the session (a genuinely-live sibling re-registers on its next tool call).
// Best-effort — any failure is swallowed so it never blocks.
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
const agentId = input.agent_id ?? "";

if (sid) {
  const body: Record<string, string> = { cc_session_id: sid };
  if (agentId) body.agent_id = agentId;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1000);
  await fetch(`${brokerBaseUrl()}/subagent-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).catch(() => {});
  clearTimeout(t);
}

process.exit(0);
