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
EOF
