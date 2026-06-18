#!/bin/bash
# discussion-tree Stop hook — prevent the turn from ending if the user has
# UI submissions that weren't mirrored via post_to_node, and feed Claude a
# message telling it to finish the replies (or to call reset_unanswered_posts
# if the count is desynced).
#
# Mechanism: emit JSON {"decision":"block","reason":"..."} on stdout to block
# the Stop event and inject the reason as Claude's next input. We block on EVERY
# stop while a post is unanswered (count>0); the broker caps consecutive nags on
# the same count (MAX_NAG_STREAK) and returns block=false past that, so a stuck
# CC can't infinite-loop the turn.
#
# Wire as a Stop hook (no matcher). Failures swallowed.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
stop_hook_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false')
port="${DISCUSSION_TREE_PORT:-7898}"

[ -z "$sid" ] && exit 0

# We deliberately do NOT bail on stop_hook_active. The hook blocks on EVERY stop
# while there's an unanswered post (count>0 = the user's latest message is still
# unmirrored, no matter how many round-trips happened in the turn). Loop
# protection lives BROKER-side: /get-unanswered returns block=false once the same
# count has been nagged MAX_NAG_STREAK times in a row, so a CC that genuinely
# can't post still eventually yields and the user can intervene.
: "${stop_hook_active:=false}"

body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
resp=$(curl -sS --max-time 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$body" \
  "http://127.0.0.1:${port}/get-unanswered" 2>/dev/null || echo '{}')

count=$(printf '%s' "$resp" | jq -r '.count // 0')
# Broker's verdict: block while count>0, but false once the streak cap is hit.
block=$(printf '%s' "$resp" | jq -r '.block // false')

if ! [[ "$count" =~ ^[0-9]+$ ]]; then
  exit 0
fi

if [ "$count" -gt 0 ] && [ "$block" = "true" ]; then
  # Stop is about to block-and-resume the turn. Re-arm the "working" badge
  # for THIS cc_session_id so the UI keeps spinning while the LLM silently
  # thinks between the block decision and its next tool call. Without
  # this, the badge clears at Stop and only comes back at the next
  # PreToolUse — the resulting "no badge for a few seconds" gap reads as
  # "the assistant stalled" to anyone watching the dt UI.
  #
  # /heartbeat-tool guards against overwriting an explicit non-"working"
  # state (e.g. a manually-set "blocked"), so this is safe to always send.
  hb_body=$(jq -n --arg s "$sid" --arg t "stop-hook-continuation" '{cc_session_id:$s, tool:$t}')
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$hb_body" \
    "http://127.0.0.1:${port}/heartbeat-tool" \
    >/dev/null 2>&1 || true

  if [ "$count" -eq 1 ]; then
    msg="discussion-tree: there is 1 UI submission from the user that you haven't acknowledged with post_to_node yet. Please send the corresponding reply (or, if you already bundled it into another post and the count is desynced, call reset_unanswered_posts) before yielding the turn."
  else
    msg="discussion-tree: there are ${count} UI submissions from the user that you haven't acknowledged with post_to_node yet. Please send the corresponding replies (or, if you already bundled them into other posts and the count is desynced, call reset_unanswered_posts) before yielding the turn."
  fi
  jq -n --arg reason "$msg" '{decision:"block", reason:$reason}'
fi

exit 0
