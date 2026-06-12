#!/usr/bin/env bash
# SessionStart hook (matcher: "compact"). Fires right after Claude Code
# resumes from a context compaction. Emits a prompt-style reminder so
# the model treats subsequent discussion-tree channel pushes as
# potentially-unfamiliar boards rather than continuations of whatever
# board happened to dominate the pre-compact conversation.
#
# Plain stdout is appended to the next assistant turn's context by
# Claude Code, so the cheapest correct path here is just to cat the
# message. We deliberately don't include any specific board summaries
# — those rot fast and risk being mistaken for "the whole truth" of
# each board. Instead we tell the model what to DO when it gets a push
# it doesn't fully remember.
set -eu

# Capture the SessionStart payload (carries .session_id) BEFORE the heredoc.
# The static block below uses <<'EOF' so it never consumes stdin; we read it
# here so the optional checklist-count section can scope to this CC session.
input=$(cat || true)

cat <<'EOF'
[discussion-tree post-compact notice]
You just resumed from a compacted conversation, so your memory of each
discussion-tree board's full thread history is likely faded.

From here on, whenever a <channel source="discussion-tree" ...>
message arrives for a board / node you do NOT clearly remember (or
about which you feel uncertain):

1. Before answering, refresh your context on that specific board by
   calling get_board(board_id=<that id>) and reading the thread items
   on the target node.
2. If relevant, also look at the node's parent concern and at sibling
   concerns / nodes on the same board to understand the surrounding
   discussion.
3. Only then post your reply.

Do NOT respond based on assumptions, pattern-matching to other boards,
or the topic that dominated the conversation right before the compact.
Different boards usually discuss completely different things — mixing
them up confuses the user badly.

The same applies to MAPS (the divergence-graph view): your mental
picture of a map's nodes / edges / positions is stale after a compact,
AND the user's structural edits (drags, new/removed edges, deleted
nodes) are silent by design. So when a <channel ... kind="map_chat">
message arrives, ALWAYS call get_map(map_id=<that id>) to reload the
current graph before you add nodes, draw edges, or reply — never act on
a remembered shape of the map.
EOF

# Count-only unfinished-checklist nudge. A compact wipes the working memory of
# which boards carry a decision checklist that still has open items, so they
# get silently abandoned. We emit JUST the count (no titles, no per-item
# detail, no nag) — enough to know "there's something parked" without becoming
# noise for a list the user is content to leave. Entirely best-effort: any
# failure (no session_id, broker down, jq/curl missing, count 0) prints
# nothing and never aborts the hook.
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
port="${DISCUSSION_TREE_PORT:-7898}"
if [ -n "${sid:-}" ]; then
  body=$(jq -n --arg s "$sid" '{cc_session_id:$s}' 2>/dev/null || true)
  # Compaction finished and the session resumed — clear the "compacting" badge
  # the PreCompact hook set. Best-effort; the broker also self-heals on the next
  # tool heartbeat / re-attach if this doesn't land.
  curl -sS --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$body" "http://127.0.0.1:${port}/session-compacting-done" \
    >/dev/null 2>&1 || true
  resp=$(curl -sS --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$body" "http://127.0.0.1:${port}/get-incomplete-checklists" \
    2>/dev/null || echo '{}')
  count=$(printf '%s' "$resp" | jq -r '.count // 0' 2>/dev/null || echo 0)
  if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -gt 0 ]; then
    printf '\n[discussion-tree unfinished-checklist notice]\nYou own %s board(s) with a decision checklist that still has open items (status pending / in-progress). This is a COUNT-ONLY reminder so the checklist is not forgotten across the compact — no action is required right now. If you want to act on them, call list_boards and get_board on the relevant board(s); otherwise carry on.\n' "$count"
  fi
fi
