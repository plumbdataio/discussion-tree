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

# --- Context free % (existing behavior) --------------------------------------
pct_file="/tmp/claude-sl-${sid}-pct"
if [ -f "$pct_file" ]; then
  pct=$(cat "$pct_file" 2>/dev/null)
  # Sanity-check: must be a non-empty number in [0, 100]. The CC
  # statusline writes floats like "27.0"; jq parses those fine. A malformed
  # value just skips this POST (the limits POST below still runs).
  case "$pct" in
    ''|*[!0-9.]*) ;;
    *)
      body=$(jq -n --arg s "$sid" --argjson p "$pct" '{cc_session_id:$s, remaining_pct:$p}')
      curl -sS --max-time 1 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$body" \
        "${DT_BROKER_BASE}/report-context-usage" \
        >/dev/null 2>&1 || true
      ;;
  esac
fi

# --- Native 5h / 7d subscription-usage limits --------------------------------
# The CC statusline ALSO writes the account-global rate-limit windows (see
# statusline-command.sh) to this file when Claude Code provides them (after the
# first API response, on Pro/Max plans; each field can be absent). Forward them
# to the broker so the UI can show one global usage chip. Best-effort: a missing
# or malformed file is skipped. cc_session_id is added so the broker can bind the
# report to the right session (the limits themselves are account-global).
limits_file="/tmp/claude-sl-${sid}-limits.json"
if [ -f "$limits_file" ]; then
  limits=$(cat "$limits_file" 2>/dev/null)
  if printf '%s' "$limits" | jq -e 'type == "object" and (length > 0)' >/dev/null 2>&1; then
    ulbody=$(printf '%s' "$limits" | jq -c --arg s "$sid" '. + {cc_session_id: $s}')
    curl -sS --max-time 1 \
      -X POST \
      -H "Content-Type: application/json" \
      -d "$ulbody" \
      "${DT_BROKER_BASE}/report-usage-limits" \
      >/dev/null 2>&1 || true
  fi
fi

exit 0
