#!/bin/bash
# parallel-discussion PreToolUse hook.
#
# Pings the broker on every tool invocation so the UI can show a "working"
# activity badge automatically — the user no longer has to rely on the LLM
# remembering to call set_activity. The broker times the badge out a few
# seconds after the last ping so it disappears when CC goes idle.
#
# Wire this up as a PreToolUse hook (no matcher / matcher: "*"). Best-effort —
# any failure (broker down, etc.) is swallowed so it never blocks tool use.
#
# Install: see README.md "Auto activity badge" section.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
port="${PARALLEL_DISCUSSION_PORT:-7898}"

if [ -n "$sid" ]; then
  body=$(jq -n --arg s "$sid" --arg t "$tool" '{cc_session_id:$s, tool:$t}')
  # Short timeout: we don't want the broker hiccup to delay every tool call.
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "http://127.0.0.1:${port}/heartbeat-tool" \
    >/dev/null 2>&1 || true
fi

exit 0
