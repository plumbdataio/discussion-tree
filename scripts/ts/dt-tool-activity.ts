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

if (sid) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1000);
  await fetch(`${brokerBaseUrl()}/heartbeat-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cc_session_id: sid, tool }),
    signal: ctrl.signal,
  }).catch(() => {});
  clearTimeout(t);
}

process.exit(0);
