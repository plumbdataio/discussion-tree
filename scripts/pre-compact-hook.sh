#!/bin/bash
# discussion-tree PreCompact hook.
#
# Fires right before Claude Code compacts its context — both manual (/compact,
# including a /compact the user injected from the WebUI via /cli-send) and auto
# compaction. Marks the owning session "compacting" in the broker so the UI
# shows a distinct badge in the sidebar + header for the duration. Compaction
# runs no tools, so the normal "working" spinner would time out and read as
# idle; this dedicated flag tells the user the session is busy, not stuck.
#
# Cleared on resume by the post-compact SessionStart hook
# (post-compact-board-reminder.sh POSTs /session-compacting-done), or — as a
# self-heal if that never lands — by the next tool heartbeat / re-attach.
#
# Wire this up as a PreCompact hook (no matcher). Best-effort — any failure
# (broker down, etc.) is swallowed so it never blocks or delays compaction.
# Always exits 0 (observation-only).

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
port="${DISCUSSION_TREE_PORT:-7898}"

if [ -n "$sid" ]; then
  body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
  curl -sS --max-time 1 -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "http://127.0.0.1:${port}/session-compacting" \
    >/dev/null 2>&1 || true
fi

exit 0
