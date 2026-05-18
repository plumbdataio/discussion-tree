#!/bin/bash
# discussion-tree PreToolUse/PostToolUse hook for AskUserQuestion + ExitPlanMode.
#
# Wire this up with matcher: "AskUserQuestion|ExitPlanMode" on both
# PreToolUse (arg: start) and PostToolUse (arg: clear). When fired, it pings
# the broker so the UI sidebar shows a "blocked: waiting for user" badge —
# without this the user can miss that CC is paused waiting for their input.
#
# Stdin: the standard hook JSON payload (session_id, tool_name, tool_input, ...).
# Best-effort: any failure (broker down, etc.) is swallowed so it never blocks
# the user-facing prompt.

set -e

mode="${1:-start}"
input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
port="${DISCUSSION_TREE_PORT:-7898}"

if [ -z "$sid" ]; then
  exit 0
fi

if [ "$mode" = "start" ]; then
  # AskUserQuestion has tool_input.question; ExitPlanMode has tool_input.plan.
  # Either works as a short tooltip — fall through to the first non-empty one.
  question=$(printf '%s' "$input" | jq -r '.tool_input.question // .tool_input.plan // ""')
  body=$(jq -n --arg s "$sid" --arg q "$question" '{cc_session_id:$s, question:$q}')
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "http://127.0.0.1:${port}/blocked-on-user-start" \
    >/dev/null 2>&1 || true
else
  body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "http://127.0.0.1:${port}/blocked-on-user-clear" \
    >/dev/null 2>&1 || true
fi

exit 0
