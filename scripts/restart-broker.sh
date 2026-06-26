#!/bin/bash
# Restart the shared broker daemon SAFELY.
#
# WHY THIS EXISTS:
#  1. Build gate — a broker that won't parse must never be (re)started. We run
#     check-build.sh first; if the working tree doesn't build, we abort and the
#     OLD broker keeps running rather than being replaced by a broken one.
#  2. EADDRINUSE ordering — killing the broker and immediately relaunching races
#     the old process's port release: the new broker fails to bind (EADDRINUSE)
#     and exits, leaving NOTHING running. So we kill, then WAIT for the port to
#     actually free, then start. (A "kill twice in a row" / "kill + instant
#     start" is exactly what once left every session's MCP channel dead.)
#
# Usage: scripts/restart-broker.sh   (run from anywhere)
set -u

cd "$(dirname "$0")/.."

port="${DISCUSSION_TREE_PORT:-7898}"
# Used only to place the broker log. The broker's STATE home is left to its own
# default (os.homedir()/.discussion-tree) unless DISCUSSION_TREE_HOME is already
# set in the environment — which we pass through untouched (see the start line).
# This way a manual restart never points the broker at a different DB than the
# auto-spawned one. (broker/config.ts deliberately avoids $HOME, which can be
# unset under launchd.)
home="${DISCUSSION_TREE_HOME:-$HOME/.discussion-tree}"
log="${home}/broker.log"

# 1. Refuse to restart into a broken build.
sh scripts/check-build.sh || {
  echo "restart-broker: build check failed — keeping the current broker." >&2
  exit 1
}

# 2. Kill the process LISTENing on the port (single, targeted — not pkill).
pid="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$pid" ]; then
  echo "restart-broker: stopping broker (pid ${pid}) on :${port}"
  kill "$pid" 2>/dev/null || true
fi

# 3. WAIT for the port to be released before rebinding (up to ~5s).
freed=""
i=0
while [ "$i" -lt 50 ]; do
  if [ -z "$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)" ]; then
    freed=1
    break
  fi
  sleep 0.1
  i=$((i + 1))
done
if [ -z "$freed" ]; then
  echo "restart-broker: port :${port} still busy after wait — aborting to avoid a half-dead state." >&2
  exit 1
fi

# 4. Start detached.
command -v bun >/dev/null 2>&1 || { echo "restart-broker: bun not on PATH." >&2; exit 1; }
mkdir -p "$home" 2>/dev/null || true
# DISCUSSION_TREE_HOME passes through from the environment if it was set; if not,
# the broker resolves its own os.homedir() default (matching ensureBroker).
nohup bun broker.ts >>"$log" 2>&1 &

# 5. Confirm it bound.
i=0
while [ "$i" -lt 50 ]; do
  if curl -sS --max-time 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "restart-broker: broker up on :${port}"
    exit 0
  fi
  sleep 0.1
  i=$((i + 1))
done
echo "restart-broker: broker did not report healthy in time — check ${log}" >&2
exit 1
