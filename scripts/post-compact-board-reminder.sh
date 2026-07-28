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
  done_resp=$(curl -sS --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$body" "http://127.0.0.1:${port}/session-compacting-done" \
    2>/dev/null || echo '{}')
  # The boundary BEFORE this one — the start of the window that was just
  # compacted, and so the start of what needs reviewing below. The broker hands
  # it back because stamping this compaction overwrites it.
  prev=$(printf '%s' "$done_resp" | jq -r '.previous_compact_at // empty' 2>/dev/null || true)
  resp=$(curl -sS --max-time 1 -X POST -H "Content-Type: application/json" \
    -d "$body" "http://127.0.0.1:${port}/get-incomplete-checklists" \
    2>/dev/null || echo '{}')
  count=$(printf '%s' "$resp" | jq -r '.count // 0' 2>/dev/null || echo 0)
  if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -gt 0 ]; then
    printf '\n[discussion-tree unfinished-checklist notice]\nYou own %s board(s) with a decision checklist that still has open items (status pending / in-progress). This is a COUNT-ONLY reminder so the checklist is not forgotten across the compact — no action is required right now. If you want to act on them, call list_boards and get_board on the relevant board(s); otherwise carry on.\n' "$count"
  fi
  # Issue-link review. The window that just got compacted is the one CC can no
  # longer see, so this is the last chance to attach its messages to an issue —
  # and the reason the review API takes a `to` as well as a `from`. Deliberately
  # placed AFTER the compaction rather than before it: anything emitted by the
  # PreCompact hook lands in the context that is about to be discarded, so there
  # is no turn in which to act on it.
  #
  # Silent unless there is something to decide, same posture as the checklist
  # count above: a reminder that fires every time regardless stops being read.
  # Always send `from` explicitly. Leaving it out makes the broker default to
  # last_compact_at — which the call above has just overwritten with THIS
  # compaction, collapsing the window to nothing. With no previous boundary
  # (first compaction after upgrading) fall back to the last day rather than all
  # of history, which would be far too much to hand a fresh context.
  fallback=$(date -u -v-1d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -d '1 day ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)
  rbody=$(jq -n --arg s "$sid" --arg f "${prev:-$fallback}" \
    '{cc_session_id:$s, unlinked_only:true, head_chars:60} + (if $f == "" then {} else {from:$f} end)' \
    2>/dev/null || true)
  rresp=$(curl -sS --max-time 2 -X POST -H "Content-Type: application/json" \
    -d "$rbody" "http://127.0.0.1:${port}/review-message-links" 2>/dev/null || echo '{}')
  rcount=$(printf '%s' "$rresp" | jq -r '.total // 0' 2>/dev/null || echo 0)
  if [[ "$rcount" =~ ^[0-9]+$ ]] && [ "$rcount" -gt 0 ]; then
    printf '\n[discussion-tree issue-link review]\n%s message(s) from the window you just compacted are not attached to any issue. That window is the part you can no longer read, so linking it now is what makes the conversation for an issue followable later.\n\nCall review_message_links (defaults to exactly this window) and, for each message that belongs to an issue, link_message_to_issues. Messages that genuinely belong to none need no action — this is a nudge, not a block, so use your judgement and carry on.\n' "$rcount"
  fi
fi
