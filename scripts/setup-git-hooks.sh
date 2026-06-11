#!/bin/sh
# Point this repo's git hooks at the committed .githooks/ dir — automatically,
# from package.json's "prepare" (so it runs on `bun install`, like husky).
#
# git's core.hooksPath is all-or-nothing: setting it makes git use ONLY that
# dir, ignoring any global / other core.hooksPath the developer had. So we:
#   1. record the dir we're superseding into dt.parentHooksPath, then
#   2. (re)generate a tiny delegating stub in .githooks/ for every RECOGNISED
#      git hook that dir provides, so all of the developer's hooks (commit-msg,
#      pre-push, …) still run for this repo instead of silently disappearing.
# Only the guard hooks (pre-commit, commit-msg), the delegate helper, and
# .gitignore are tracked; the per-developer delegate stubs are generated here
# and gitignored.
set -e

HOOKS_DIR=.githooks
MARK="dt-generated-delegate"

# Recognised client-side git hook names we delegate, EXCLUDING the ones we own
# as committed hooks (pre-commit, commit-msg — they self-delegate). Using a
# whitelist means we never generate over a tracked helper like _delegate.sh.
HOOK_NAMES="applypatch-msg pre-applypatch post-applypatch pre-merge-commit \
prepare-commit-msg post-commit pre-rebase post-checkout post-merge pre-push \
pre-receive update proc-receive post-receive post-update reference-transaction \
push-to-checkout pre-auto-gc post-rewrite sendemail-validate \
fsmonitor-watchman post-index-change p4-changelist p4-prepare-changelist \
p4-post-changelist p4-pre-submit"

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

# `--path` lets git expand ~ / ~user in the recorded value (no eval).
parent=$(git config --path dt.parentHooksPath 2>/dev/null || true)
if [ -z "$parent" ] || [ ! -d "$parent" ]; then exit 0; fi

# Generate a delegate for each recognised hook the parent dir actually provides.
for name in $HOOK_NAMES; do
  [ -f "$parent/$name" ] && [ -x "$parent/$name" ] || continue
  stub="$HOOKS_DIR/$name"
  printf '%s\n' \
    '#!/bin/sh' \
    "# $MARK (scripts/setup-git-hooks.sh) — forwards this event to the hooks dir" \
    '# our core.hooksPath superseded. Regenerated on install; do not edit.' \
    'exec "$(dirname "$0")/_delegate.sh" '"$name"' "$@"' > "$stub"
  chmod +x "$stub"
done
