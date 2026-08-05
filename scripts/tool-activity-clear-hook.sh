#!/bin/bash
# discussion-tree Stop hook.
#
# Fires when CC finishes a turn. Clears the auto "working" badge immediately
# instead of waiting for the broker's idle-timeout watchdog. The watchdog is
# still kept around as a safety net (in case CC crashes and Stop never fires).

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
# Resolve DT_BROKER_BASE (honors DISCUSSION_TREE_BROKER_URL for remote sessions).
. "$(dirname "${BASH_SOURCE[0]:-$0}")/broker-url.sh"

if [ -n "$sid" ]; then
  body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${DT_BROKER_BASE}/clear-tool-activity" \
    >/dev/null 2>&1 || true
fi

exit 0
