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
mv "$TMP" "$DEST"

# Prune: keep the newest KEEP files, delete the rest.
ls -1t "$BACKUP_DIR"/discussion-tree-*.sqlite 2>/dev/null \
  | tail -n "+$((KEEP + 1))" \
  | xargs -r rm -f

echo "$(date '+%F %T') backed up to $DEST"
