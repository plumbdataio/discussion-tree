#!/bin/sh
# Point this repo's git hooks at the committed .githooks/ dir — automatically,
# from package.json's "prepare" (so it runs on `bun install`, like husky).
#
# git's core.hooksPath is all-or-nothing: setting it makes git use ONLY that
# dir, ignoring any global core.hooksPath the developer has. So before we
# override it we record what we're superseding into dt.parentHooksPath, and the
# .githooks/* stubs delegate back to it — that way a developer's global
# post-checkout / pre-push / etc. still run for this repo instead of silently
# disappearing.
set -e

prev=$(git config core.hooksPath 2>/dev/null || true)
case "$prev" in
  .githooks | "") ;;                       # already ours, or nothing to preserve
  *) git config dt.parentHooksPath "$prev" ;;
esac

git config core.hooksPath .githooks
