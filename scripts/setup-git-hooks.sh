#!/bin/sh
# Point this repo's git hooks at the committed .githooks/ dir — automatically,
# from package.json's "prepare" (so it runs on `bun install`, like husky).
#
# git's core.hooksPath is all-or-nothing: setting it makes git use ONLY that
# dir, ignoring any global / other core.hooksPath the developer had. So we:
#   1. record the dir we're superseding into dt.parentHooksPath, then
#   2. (re)generate a tiny delegating stub in .githooks/ for EVERY hook that dir
#      provides, so all of the developer's hooks (commit-msg, pre-push, …) still
#      run for this repo instead of silently disappearing.
# Only the guard (pre-commit), the delegate helper, and .gitignore are tracked;
# the per-developer delegate stubs are generated here and gitignored.
set -e

HOOKS_DIR=.githooks
MARK="dt-generated-delegate"

# 1. Record the superseded dir (unless it's already ours / empty), then override.
prev=$(git config core.hooksPath 2>/dev/null || true)
case "$prev" in
  "$HOOKS_DIR" | "") ;;
  *) git config dt.parentHooksPath "$prev" ;;
esac
git config core.hooksPath "$HOOKS_DIR"

# 2. Drop previously-generated stubs (a parent hook may have been removed since).
for f in "$HOOKS_DIR"/*; do
  [ -f "$f" ] || continue
  if head -n 3 "$f" 2>/dev/null | grep -q "$MARK"; then rm -f "$f"; fi
done

# Expand a leading ~ in the recorded path WITHOUT eval (config value, untrusted).
parent=$(git config dt.parentHooksPath 2>/dev/null || true)
case "$parent" in
  "~/"*) parent="$HOME/${parent#"~/"}" ;;
  "~") parent="$HOME" ;;
esac
if [ -z "$parent" ] || [ ! -d "$parent" ]; then exit 0; fi

# Generate a delegate per executable hook in the parent dir (pre-commit is the
# committed guard, which already chains to the parent itself).
for h in "$parent"/*; do
  [ -f "$h" ] && [ -x "$h" ] || continue
  name=$(basename "$h")
  [ "$name" = "pre-commit" ] && continue
  stub="$HOOKS_DIR/$name"
  printf '%s\n' \
    '#!/bin/sh' \
    "# $MARK (scripts/setup-git-hooks.sh) — forwards this event to the hooks dir" \
    '# our core.hooksPath superseded. Regenerated on install; do not edit.' \
    'exec "$(dirname "$0")/_delegate.sh" '"$name"' "$@"' > "$stub"
  chmod +x "$stub"
done
