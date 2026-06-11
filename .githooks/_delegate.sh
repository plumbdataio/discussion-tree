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
# Expand a leading ~ WITHOUT eval (the value is config-supplied, not trusted as
# shell). Everything else is used verbatim and quoted, so spaces / globs / shell
# metacharacters in the path can neither break nor execute.
case "$parent" in
  "~/"*) parent="$HOME/${parent#"~/"}" ;;
  "~") parent="$HOME" ;;
esac
hook="$parent/$name"
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
