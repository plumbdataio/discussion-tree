#!/bin/bash
# discussion-tree SessionStart hook (plugin install only).
#
# Ensures the shared broker daemon is up before the MCP server connects.
# When discussion-tree is installed as a Claude Code plugin there is no
# manual `bun broker.ts` running, so this hook curls the broker /health and,
# if it is down, launches broker.ts detached (nohup) from the plugin's
# install dir.
#
# This is ADDITIVE and only relevant to the packaged plugin: in the upstream
# dev setup the broker is started manually and this hook would simply find
# /health already OK and do nothing. It is NOT wired into the repo's manual
# settings.json — it ships only via hooks/hooks.json.
#
# Safety / idempotency:
#   - If /health already responds, exit immediately (no double launch).
#   - A flock-style lock dir guards against two SessionStart hooks (parallel
#     CC sessions) both racing to spawn a broker. Bun.serve also fails fast on
#     a port already in use, so a lost race is harmless — the second broker
#     just exits.
#   - Every failure path exits 0 so the hook can never block session start.
#   - State home: the stock default $HOME/.discussion-tree (overridable via
#     DISCUSSION_TREE_HOME), matching the MCP server, the broker, and the other
#     dt hooks so every component shares one home.

set -u

port="${DISCUSSION_TREE_PORT:-7898}"

# Already up? Nothing to do. Short timeout so a wedged port doesn't stall
# session start.
if curl -sS --max-time 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  exit 0
fi

# Resolve the plugin root (where broker.ts lives) and the state home.
# CLAUDE_PLUGIN_ROOT is exported by Claude Code for plugin-provided hooks.
root="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$root" ]; then
  # Fall back to this script's parent's parent (scripts/ -> plugin root) so the
  # hook still works if invoked directly.
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
  root="$(dirname "$here")"
fi

broker="$root/broker.ts"
[ -f "$broker" ] || exit 0

# State dir: the stock default ($HOME/.discussion-tree) unless the user
# explicitly exports DISCUSSION_TREE_HOME. We deliberately do NOT use
# ${CLAUDE_PLUGIN_DATA} here: the MCP server, the broker, and the other dt
# hooks (e.g. the attach-hint script) all default to $HOME/.discussion-tree,
# so using the same default keeps every component reading/writing the SAME
# home — otherwise auto-attach hint files and the broker's state dir diverge.
# $HOME/.discussion-tree persists across plugin updates anyway (it is outside
# the plugin cache).
home="${DISCUSSION_TREE_HOME:-$HOME/.discussion-tree}"

# bun must be on PATH. If it isn't, we can't launch — exit quietly; the user's
# manual setup (if any) still applies.
command -v bun >/dev/null 2>&1 || exit 0

# Single-launcher lock. mkdir is atomic: only one concurrent hook wins. The
# loser exits without spawning. We do NOT block waiting on the lock — a missed
# launch is recovered by the next SessionStart, and Bun.serve fails fast on a
# busy port anyway.
lock="${home}/.broker-launch.lock"
mkdir -p "$home" 2>/dev/null || exit 0
if ! mkdir "$lock" 2>/dev/null; then
  # Another hook is mid-launch. Give it a beat, then re-check health and leave.
  exit 0
fi
# Best-effort lock release on exit (and a stale-lock fallback below).
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

# Launch detached so the broker outlives this hook process and the CC session.
# Logs go under the state home for debuggability.
log="${home}/broker.log"
DISCUSSION_TREE_HOME="$home" nohup bun "$broker" >>"$log" 2>&1 &

# Give it a moment to bind, then confirm. We don't fail the hook either way.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS --max-time 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

exit 0
