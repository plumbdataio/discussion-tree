#!/bin/bash
# discussion-tree SessionStart hook.
#
# Writes a per-PID hint file so the discussion-tree MCP server can auto-attach
# to this Claude Code session at startup, surviving restarts without orphaning
# the user's UI submissions. Inside this hook, $PPID equals Claude Code's PID;
# the MCP server reads process.ppid (also CC's PID) and looks up the file.
#
# This hook also forwards the standard SessionStart additionalContext that
# exposes the session_id to the LLM.
#
# Install: see README.md "SessionStart hook" section.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id')
cwd=$(printf '%s' "$input" | jq -r '.cwd')

# Match broker / MCP server: PARALLEL_DISCUSSION_HOME is the umbrella state
# dir (default $HOME/.discussion-tree). All three components resolve it
# identically so a shell-level env override stays consistent.
home="${PARALLEL_DISCUSSION_HOME:-$HOME/.discussion-tree}"
dir="$home/cc-sessions"
mkdir -p "$dir"

ts=$(date +%s)
jq -n \
  --arg s "$sid" \
  --arg c "$cwd" \
  --argjson t "$ts" \
  '{cc_session_id:$s, cwd:$c, written_at:$t}' \
  > "$dir/$PPID.json"

jq -n --arg s "$sid" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:("Your session_id is: " + $s)}}'
