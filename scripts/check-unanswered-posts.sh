#!/bin/bash
# discussion-tree Stop hook — warn when the user has UI submissions that
# this session ack'd in the CLI only (forgot to mirror via post_to_node).
#
# Reads the broker's per-session unanswered counter for this cc_session_id.
# If > 0 at turn end, fires a macOS notification telling the user how many
# are outstanding AND how to clear the counter manually if it's actually
# wrong (combined replies, etc).
#
# Wire as a Stop hook (no matcher). Best-effort — failures swallowed.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
port="${DISCUSSION_TREE_PORT:-7898}"

[ -z "$sid" ] && exit 0

body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
resp=$(curl -sS --max-time 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$body" \
  "http://127.0.0.1:${port}/get-unanswered" 2>/dev/null || echo '{}')

count=$(printf '%s' "$resp" | jq -r '.count // 0')

# bash arithmetic — guards against non-numeric "0" parses.
if ! [[ "$count" =~ ^[0-9]+$ ]]; then
  exit 0
fi

if [ "$count" -gt 0 ]; then
  title="discussion-tree"
  if [ "$count" -eq 1 ]; then
    msg="1 unanswered UI post. If you already replied (e.g. bundled), tell Claude to call reset_unanswered_posts."
  else
    msg="${count} unanswered UI posts. If wrong (bundled replies, etc), tell Claude to call reset_unanswered_posts."
  fi

  alerter -title "$title" -message "$msg" -sound "Tink" >/dev/null 2>&1 &
fi

exit 0
