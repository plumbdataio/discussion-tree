#!/bin/bash
# discussion-tree StopFailure hook.
#
# Fires when a turn ends with an API error (rate limit, "retry also failed",
# auth failure, ...) — i.e. Claude Code has STOPPED, not finished normally.
# (StopFailure fires INSTEAD of Stop in that case.) Marks the owning session
# "stalled" in the broker so the UI shows a prominent warning in the sidebar +
# header, instead of the user having to watch the CLI to notice the stall.
#
# Message-agnostic by design: ANY error-stop raises the SAME warning (the
# broker doesn't look at which error it was). The stall clears automatically
# the moment the session shows life again — the next tool use (PreToolUse
# heartbeat), a clean turn end (Stop), or the next SessionStart re-attach.
#
# Wire this up as a StopFailure hook (no matcher). Best-effort — any failure
# (broker down, etc.) is swallowed so it never affects the session. Always
# exits 0 (observation-only).

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
# transcript_path lets the broker classify WHY the turn stopped (rate-limit /
# login-expired / transient) from the tail, so it only auto-continues transient
# errors instead of hammering "continue" at a usage cap or a login expiry.
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
port="${DISCUSSION_TREE_PORT:-7898}"

if [ -n "$sid" ]; then
  body=$(jq -n --arg s "$sid" --arg tp "$transcript" \
    '{cc_session_id:$s, transcript_path:$tp}')
  curl -sS --max-time 1 -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "http://127.0.0.1:${port}/session-stalled" \
    >/dev/null 2>&1 || true
fi

exit 0
