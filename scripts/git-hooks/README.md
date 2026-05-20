# Git hooks

Repo-local git hooks. Not auto-installed (git doesn't auto-pick anything
outside `.git/hooks/`), so each clone has to wire them up explicitly.

## post-commit (public-repo reminder)

discussion-tree is published on GitHub. Commit messages are part of the
public history and easy to overlook while iterating in private. The
post-commit hook prints a loud Japanese reminder after every commit so
the author pauses before `git push`.

Install once per clone:

```sh
ln -sf ../../scripts/git-hooks/post-commit .git/hooks/post-commit
chmod +x scripts/git-hooks/post-commit
```

The symlink target is relative so it survives the repo moving on disk.

Verify it's wired up:

```sh
git commit --allow-empty -m "test"
# Expect the red/yellow banner on the terminal.
```
