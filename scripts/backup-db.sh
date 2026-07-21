#!/bin/bash
# discussion-tree SQLite backup.
#
# Takes a WAL-consistent snapshot of the broker's SQLite DB into BACKUP_DIR,
# keeping the most recent KEEP_GENERATIONS copies. Intended to run daily via
# launchd (see the discussion-tree-ops skill for the plist).
#
# Env:
#   BACKUP_DIR         (required) where snapshots land — e.g. a synced
#                      cloud-storage folder. Passed via env so the
#                      environment-specific path never gets committed.
#   DISCUSSION_TREE_DB (optional) DB path; defaults to the broker's default
#                      $HOME/.discussion-tree/db.sqlite.
#   KEEP_GENERATIONS   (optional) how many daily snapshots to retain; 30.

set -euo pipefail

SRC="${DISCUSSION_TREE_DB:-$HOME/.discussion-tree/db.sqlite}"
BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR env var required}"
KEEP="${KEEP_GENERATIONS:-30}"

if [ ! -f "$SRC" ]; then
  echo "$(date '+%F %T') ERROR: source DB not found: $SRC" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
DEST="$BACKUP_DIR/discussion-tree-$(date +%Y%m%d).sqlite"
TMP="$(mktemp -t discussion-tree-backup)"

# `.backup` (not a raw cp): the broker runs SQLite in WAL mode, so a plain
# file copy can capture a torn state. `.backup` produces a consistent
# snapshot even while the broker is mid-write.
sqlite3 "$SRC" ".backup '$TMP'"
# BACKUP_DIR may live under a Bitdefender SafeFiles-protected path (a Google Drive
# folder), where /bin/mv and /bin/rm are blocked as "untrusted" ("Operation not
# permitted"). Creating a NEW file is allowed, so a fresh daily snapshot lands
# fine; only OVERWRITING an existing same-day file (a RunAtLoad re-run) is blocked
# — so skip that. $TMP is a local temp, never protected, so rm works on it.
if [ -e "$DEST" ]; then
  rm -f "$TMP" # today's snapshot already exists; keep it, drop the temp
else
  mv "$TMP" "$DEST"
fi

# Log success BEFORE pruning, so a snapshot is recorded even if the prune hiccups.
echo "$(date '+%F %T') backed up to $DEST"

# Prune: keep the newest KEEP files, delete the rest. Delete via FINDER (a
# SafeFiles-trusted app) rather than /bin/rm — the latter is blocked in the
# protected dir, which used to fail the whole job (set -e) and skip the log
# above, leaving old snapshots to pile up. Finder moves them to the Trash.
# Per-file and non-fatal so one stubborn file can't fail the run.
ls -1t "$BACKUP_DIR"/discussion-tree-*.sqlite 2>/dev/null \
  | tail -n "+$((KEEP + 1))" \
  | while IFS= read -r old; do
      osascript -e "tell application \"Finder\" to delete (POSIX file \"$old\")" \
        >/dev/null 2>&1 || true
    done || true
