# discussion-tree broker base-URL resolver — sourced by the shell hook scripts.
#
# Not executable on its own: each hook sources it (`. "$(dirname ...)/broker-url.sh"`)
# to get DT_BROKER_BASE, then builds its endpoint URLs as "${DT_BROKER_BASE}/path".
#
# Resolution mirrors server/config.ts's BROKER_URL:
#   - DISCUSSION_TREE_BROKER_URL (scheme+host+port) when set — points a CC on
#     ANOTHER machine at a broker running elsewhere (e.g. over Tailscale), so its
#     hook reports reach the right broker instead of a dead localhost.
#   - Otherwise loopback on DISCUSSION_TREE_PORT (default 7898) — identical to the
#     hooks' prior hard-coded "http://127.0.0.1:${port}", so local sessions are
#     unchanged when the env var is unset.
#
# When DISCUSSION_TREE_BROKER_URL is set, DISCUSSION_TREE_PORT is irrelevant (the
# URL already carries the port).
DT_BROKER_BASE="${DISCUSSION_TREE_BROKER_URL:-http://127.0.0.1:${DISCUSSION_TREE_PORT:-7898}}"

# Strip any trailing slashes so "${DT_BROKER_BASE}/endpoint" never doubles the
# separator, matching server/config.ts's trailing-slash normalization.
while [ "${DT_BROKER_BASE%/}" != "$DT_BROKER_BASE" ]; do
  DT_BROKER_BASE="${DT_BROKER_BASE%/}"
done

export DT_BROKER_BASE
