#!/usr/bin/env bun
// discussion-tree Stop hook — Windows/Bun port of
// scripts/tool-activity-clear-hook.sh (no jq/curl needed).
//
// Fires when CC finishes a turn. Clears the auto "working" badge immediately
// instead of waiting for the broker's idle-timeout watchdog (still kept as a
// safety net in case CC crashes and Stop never fires). Best-effort.
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
const port = process.env.DISCUSSION_TREE_PORT ?? "7898";

if (sid) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1000);
  await fetch(`http://127.0.0.1:${port}/clear-tool-activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cc_session_id: sid }),
    signal: ctrl.signal,
  }).catch(() => {});
  clearTimeout(t);
}

process.exit(0);
