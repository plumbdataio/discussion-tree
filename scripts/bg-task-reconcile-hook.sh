#!/bin/bash
# discussion-tree Stop hook — auto-clear stale background-task markers.
#
# The PROBLEM this solves: when CC launches a Bash run_in_background task, a
# PreToolUse hook registers it with the broker (the "BG" marker). The broker
# has no way to learn the task finished — the <task-notification
# status=completed> only lands in CC's MESSAGE stream, never in the
# Notification hook. So clearing relied on CC remembering to call
# report_bg_task_done. That was unreliable AND subtly broken: the notification
# carries TWO ids,
#     <task-id>biyvamak5</task-id>            (short background-shell id)
#     <tool-use-id>toolu_…</tool-use-id>      (the launching Bash tool_use_id)
# and the broker registered the tool_use_id, so a CC that dutifully passed the
# (prominently labelled) <task-id> never matched and the marker stuck forever.
#
# This hook makes clearing MECHANICAL and CC-independent: at every turn end it
# reads the session transcript — where the completion notifications DO land —
# extracts the <tool-use-id> of every completed background task, and tells the
# broker to clear them. Matching the tool_use_id (NOT the short <task-id>) is
# what the broker registered. Idempotent: re-sending already-cleared ids is a
# no-op, so re-scanning the whole transcript each turn is harmless.
#
# Wire as a Stop hook (no matcher). Best-effort: any failure (no session_id /
# transcript / jq / curl, broker down) exits 0 and never blocks the turn. It
# does NOT emit a decision, so it can't loop the way check-unanswered-posts can.
set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)
port="${DISCUSSION_TREE_PORT:-7898}"

[ -z "${sid:-}" ] && exit 0
[ -z "${transcript:-}" ] && exit 0
[ -f "$transcript" ] || exit 0

# Each <task-notification> block is a single jsonl line (its newlines are
# JSON-escaped), so a per-line match that carries BOTH the completed status and
# the tool-use-id is safe. Pull the tool_use_id (toolu_…) — never the short
# <task-id> — because that's the token the broker holds.
ids=$(grep -aE 'task-notification' "$transcript" 2>/dev/null \
  | grep -aE 'status>completed<|status=\\?"completed' \
  | grep -aoE 'tool-use-id>(toolu_[A-Za-z0-9_-]+)' \
  | sed -E 's#.*tool-use-id>##' \
  | sort -u || true)

[ -z "${ids:-}" ] && exit 0

# Build a JSON array of ids and clear them in one round-trip.
arr=$(printf '%s\n' "$ids" | jq -R . | jq -s . 2>/dev/null || true)
[ -z "${arr:-}" ] && exit 0
body=$(jq -n --arg s "$sid" --argjson t "$arr" \
  '{cc_session_id:$s, task_ids:$t}' 2>/dev/null || true)
[ -z "${body:-}" ] && exit 0

curl -sS --max-time 1 -X POST -H "Content-Type: application/json" \
  -d "$body" "http://127.0.0.1:${port}/bg-task-done" >/dev/null 2>&1 || true

exit 0
