#!/bin/sh
# Run the same-named hook from the hooks dir this repo's core.hooksPath
# superseded (recorded in dt.parentHooksPath by scripts/setup-git-hooks.sh), so
# a repo-local hooksPath doesn't silently disable a developer's global / other
# hooks. No-op when there's nothing to delegate to. Called as:
#   _delegate.sh <hook-name> "$@"
name="$1"
shift
parent=$(git config dt.parentHooksPath 2>/dev/null || true)
[ -n "$parent" ] || exit 0
hook="$(eval echo "$parent")/$name"
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
