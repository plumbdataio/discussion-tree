#!/bin/bash
# discussion-tree PreToolUse hook.
#
# Pings the broker on every tool invocation so the UI can show a "working"
# activity badge automatically — the user no longer has to rely on the LLM
# remembering to call set_activity. The broker times the badge out a few
# seconds after the last ping so it disappears when CC goes idle.
#
# Wire this up as a PreToolUse hook (no matcher / matcher: "*"). Best-effort —
# any failure (broker down, etc.) is swallowed so it never blocks tool use.
#
# Install: see README.md "Auto activity badge" section.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
# A SUBAGENT (Task worker) tool call fires THIS SAME hook, under the parent's
# session_id — but its stdin carries an agent_id that the parent's own tool
# calls never do. Detection is purely the PRESENCE of agent_id. agent_type is
# ALSO forwarded: a real subagent's is a non-empty string (e.g. "general-purpose")
# while transient harness "helper" subagents send an empty agent_type; the broker
# uses that to register only real subagents (empty-type helpers never get a
# SubagentStop and would leak).
agent_id=$(printf '%s' "$input" | jq -r '.agent_id // empty')
agent_type=$(printf '%s' "$input" | jq -r '.agent_type // empty')
# Resolve DT_BROKER_BASE (honors DISCUSSION_TREE_BROKER_URL for remote sessions).
. "$(dirname "${BASH_SOURCE[0]:-$0}")/broker-url.sh"

# Subagent branch: DON'T ping /heartbeat-tool (that would spin the PARENT's
# working badge for the subagent's work). Instead record a per-subagent
# heartbeat so the UI shows a distinct "subagent running" indicator, then stop —
# the BG-task tracking below is a parent-only concern.
if [ -n "$sid" ] && [ -n "$agent_id" ]; then
  sub_body=$(jq -n --arg s "$sid" --arg a "$agent_id" --arg t "$agent_type" \
    '{cc_session_id:$s, agent_id:$a, agent_type:$t}')
  curl -sS --max-time 1 -X POST \
    -H "Content-Type: application/json" \
    -d "$sub_body" \
    "${DT_BROKER_BASE}/heartbeat-subagent" \
    >/dev/null 2>&1 || true
  exit 0
fi

if [ -n "$sid" ]; then
  body=$(jq -n --arg s "$sid" --arg t "$tool" '{cc_session_id:$s, tool:$t}')
  # Short timeout: we don't want the broker hiccup to delay every tool call.
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${DT_BROKER_BASE}/heartbeat-tool" \
    >/dev/null 2>&1 || true

  # Track Bash run_in_background launches so the UI can show a BG marker
  # next to the working spinner. The broker holds a per-session set of
  # in-flight BG task tokens; CC clears them via the report_bg_task_done
  # MCP tool after seeing the matching <task-notification>.
  if [ "$tool" = "Bash" ]; then
    bg=$(printf '%s' "$input" | jq -r '.tool_input.run_in_background // false')
    if [ "$bg" = "true" ]; then
      tu=$(printf '%s' "$input" | jq -r '.tool_use_id // empty')
      if [ -n "$tu" ]; then
        bg_body=$(jq -n --arg s "$sid" --arg id "$tu" \
          '{cc_session_id:$s, task_id:$id}')
        curl -sS --max-time 1 -X POST \
          -H "Content-Type: application/json" \
          -d "$bg_body" \
          "${DT_BROKER_BASE}/bg-task-start" \
          >/dev/null 2>&1 || true
      fi
    fi
  fi
fi

exit 0
