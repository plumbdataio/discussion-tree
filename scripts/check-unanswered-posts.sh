#!/bin/bash
# discussion-tree Stop hook — prevent the turn from ending while the user has
# UI submissions that weren't replied to via post_to_node, and feed Claude a
# message naming the unreplied nodes (or telling it to call reset_unanswered_posts
# if the omission is intentional).
#
# Per-node: the broker tracks WHICH (board, node) have an unreplied submission
# (unanswered_nodes). A post_to_node carrying a non-empty message clears that
# node; a status-only post or a reply on a different node does NOT. So the nag
# names the exact nodes instead of just a count.
#
# Mechanism: emit JSON {"decision":"block","reason":"..."} on stdout to block
# the Stop event and inject the reason as Claude's next input. We block on EVERY
# stop while any node is unanswered (count>0); the broker caps consecutive nags
# on the same count (MAX_NAG_STREAK) and returns block=false past that, so a
# stuck CC can't infinite-loop the turn.
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

  # Per-node: name the exact nodes whose user submission is still unreplied so
  # the CC can act precisely. Soft framing — replying on a different node, or the
  # user simply not wanting a reply, are legitimate, so the escape hatch
  # (reset_unanswered_posts) is offered as a first-class option, not a "desync"
  # afterthought.
  nodes=$(printf '%s' "$resp" | jq -r '.nodes[]?.node_path | "  - " + .')
  msg="discussion-tree: these node(s) have a user submission you have not replied to with a post_to_node message yet:
${nodes}
Is that intentional? If you already handled it (you replied on a different node, or the user doesn't want a reply), call reset_unanswered_posts to yield. Otherwise post_to_node an actual reply message to the node(s) above — a status-only post does NOT count."
  jq -n --arg reason "$msg" '{decision:"block", reason:$reason}'
fi

exit 0
