#!/bin/bash
# discussion-tree SubagentStop hook.
#
# Fires when a Task-worker subagent finishes. Tells the broker to drop that
# subagent from the per-session "subagent running" indicator so it stops
# showing without waiting for the timeout backstop.
#
# It is UNKNOWN whether SubagentStop stdin carries an agent_id. If it does, we
# forward it so the broker drops exactly that subagent; if it doesn't, the
# broker drops all still-running subagents for the session (a genuinely-live
# sibling re-registers on its next tool call). Either way correctness never
# depends on agent_id being present. Best-effort — any failure is swallowed.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
agent_id=$(printf '%s' "$input" | jq -r '.agent_id // empty')
# Resolve DT_BROKER_BASE (honors DISCUSSION_TREE_BROKER_URL for remote sessions).
. "$(dirname "${BASH_SOURCE[0]:-$0}")/broker-url.sh"

if [ -n "$sid" ]; then
  if [ -n "$agent_id" ]; then
    body=$(jq -n --arg s "$sid" --arg a "$agent_id" \
      '{cc_session_id:$s, agent_id:$a}')
  else
    body=$(jq -n --arg s "$sid" '{cc_session_id:$s}')
  fi
  curl -sS \
    --max-time 1 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${DT_BROKER_BASE}/subagent-stop" \
    >/dev/null 2>&1 || true
fi

exit 0
