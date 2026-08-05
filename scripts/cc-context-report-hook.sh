#!/bin/bash
# PostToolUse hook — report this CC session's current context-free %
# to the discussion-tree broker so the sidebar can show a per-session
# meter.
#
# The CC statusline (separate user setup) already writes the live free
# % to /tmp/claude-sl-<session_id>-pct on every PostToolUse. We just
# read that file and POST the number to the broker. Best-effort: every
# failure (broker down, file missing, malformed value) is swallowed so
# the hook can never block tool use.

set -e

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty')
# Resolve DT_BROKER_BASE (honors DISCUSSION_TREE_BROKER_URL for remote sessions).
. "$(dirname "${BASH_SOURCE[0]:-$0}")/broker-url.sh"

[ -z "$sid" ] && exit 0

pct_file="/tmp/claude-sl-${sid}-pct"
[ -f "$pct_file" ] || exit 0

pct=$(cat "$pct_file" 2>/dev/null)
# Sanity-check: must be a non-empty number in [0, 100]. The CC
# statusline writes floats like "27.0"; jq parses those fine.
case "$pct" in
  ''|*[!0-9.]*) exit 0 ;;
esac

body=$(jq -n --arg s "$sid" --argjson p "$pct" '{cc_session_id:$s, remaining_pct:$p}')
curl -sS --max-time 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$body" \
  "${DT_BROKER_BASE}/report-context-usage" \
  >/dev/null 2>&1 || true

exit 0
