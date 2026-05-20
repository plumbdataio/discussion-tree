#!/bin/bash
# discussion-tree Stop hook — prevent the turn from ending if the user has
# UI submissions that weren't mirrored via post_to_node, and feed Claude a
# message telling it to finish the replies (or to call reset_unanswered_posts
# if the count is desynced).
#
# Mechanism: emit JSON {"decision":"block","reason":"..."} on stdout to block
# the Stop event and inject the reason as Claude's next input. Use the
# stop_hook_active flag on stdin to avoid an infinite loop — if the previous
# Stop hook already blocked, don't block again.
#
# Wire as a Stop hook (no matcher). Failures swallowed.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
stop_hook_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false')
port="${DISCUSSION_TREE_PORT:-7898}"

# Temporary debug instrumentation — confirm whether this hook actually fires
# from each CC session, and what it decided. Remove once we've diagnosed the
# "hook didn't fire" report.
DEBUG_LOG="/tmp/discussion-tree-stop-hook.log"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$DEBUG_LOG" 2>/dev/null || true; }

log "FIRED sid=${sid:-MISSING} stop_hook_active=$stop_hook_active"

[ -z "$sid" ] && exit 0

# Already blocked once this stop chain — don't block again. Claude has had its
# chance to react; if the counter is still non-zero it's probably desynced and
# Claude should be allowed to actually finish so the user can intervene.
if [ "$stop_hook_active" = "true" ]; then
  log "  → skip (stop_hook_active=true)"
  exit 0
fi

body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
resp=$(curl -sS --max-time 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$body" \
  "http://127.0.0.1:${port}/get-unanswered" 2>/dev/null || echo '{}')

count=$(printf '%s' "$resp" | jq -r '.count // 0')
log "  broker resp=${resp} count=${count}"

if ! [[ "$count" =~ ^[0-9]+$ ]]; then
  log "  → skip (non-numeric count)"
  exit 0
fi

if [ "$count" -gt 0 ]; then
  if [ "$count" -eq 1 ]; then
    msg="discussion-tree: there is 1 UI submission from the user that you haven't acknowledged with post_to_node yet. Please send the corresponding reply (or, if you already bundled it into another post and the count is desynced, call reset_unanswered_posts) before yielding the turn."
  else
    msg="discussion-tree: there are ${count} UI submissions from the user that you haven't acknowledged with post_to_node yet. Please send the corresponding replies (or, if you already bundled them into other posts and the count is desynced, call reset_unanswered_posts) before yielding the turn."
  fi
  log "  → BLOCK emitted (count=$count)"
  jq -n --arg reason "$msg" '{decision:"block", reason:$reason}'
else
  log "  → no block (count=0)"
fi

exit 0
