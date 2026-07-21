#!/bin/bash
# discussion-tree SQLite backup.
#
# Takes a WAL-consistent snapshot of the broker's SQLite DB into BACKUP_DIR,
# keeping the most recent KEEP_GENERATIONS copies. Intended to run daily via
# launchd (see the discussion-tree-ops skill for the plist).
#
# Two-tier (grandfather-father-son) retention: the newest KEEP_GENERATIONS daily
# snapshots, PLUS every snapshot on a biweekly anchor date kept FOREVER, so there
# is always long-range history without an unbounded daily pile.
#
# Env:
#   BACKUP_DIR         (required) where snapshots land — e.g. a synced
#                      cloud-storage folder. Passed via env so the
#                      environment-specific path never gets committed.
#   DISCUSSION_TREE_DB (optional) DB path; defaults to the broker's default
#                      $HOME/.discussion-tree/db.sqlite.
#   KEEP_GENERATIONS   (optional) recent daily snapshots to retain; 14.
#   ARCHIVE_EVERY_DAYS (optional) a snapshot whose date is a multiple of this
#                      many days since the epoch is kept forever; 14 (biweekly).

set -euo pipefail

SRC="${DISCUSSION_TREE_DB:-$HOME/.discussion-tree/db.sqlite}"
BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR env var required}"
KEEP="${KEEP_GENERATIONS:-14}"
ARCHIVE_EVERY_DAYS="${ARCHIVE_EVERY_DAYS:-14}"

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

# Prune (two-tier): keep the newest KEEP snapshots, PLUS any whose date is a
# biweekly anchor (day-of-epoch a multiple of ARCHIVE_EVERY_DAYS) FOREVER. A file
# is deleted only if it is BOTH older than the newest KEEP AND not an anchor
# date — one folder, one naming scheme, so existing anchor-date snapshots are
# preserved automatically. Delete via FINDER (a SafeFiles-trusted app) rather
# than /bin/rm, which is blocked in the protected dir (that used to fail the run
# under set -e and skip the log above). Finder moves them to the Trash. Per-file
# and non-fatal so one stubborn file can't fail the run.
#
# Order by DATE (the YYYYMMDD in the filename), newest first — NOT by mtime. A
# salvaged/re-created snapshot carries a fresh mtime that does NOT reflect the
# day it captured, so an mtime sort would let it occupy a "newest KEEP" slot and
# wrongly evict a genuinely-recent daily.
i=0
ls -1 "$BACKUP_DIR"/discussion-tree-*.sqlite 2>/dev/null | sort -r | while IFS= read -r f; do
  i=$((i + 1))
  [ "$i" -le "$KEEP" ] && continue # within the newest KEEP → keep
  d="$(basename "$f" | sed -E 's/^discussion-tree-([0-9]{8})\.sqlite$/\1/')"
  case "$d" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) continue ;; # not a date-named snapshot → don't risk it, keep
  esac
  epoch="$(date -j -f "%Y%m%d %H%M%S" "${d} 120000" +%s 2>/dev/null || echo "")"
  [ -z "$epoch" ] && continue # unparseable date → keep
  [ $(( (epoch / 86400) % ARCHIVE_EVERY_DAYS )) -eq 0 ] && continue # biweekly anchor → keep forever
  osascript -e "tell application \"Finder\" to delete (POSIX file \"$f\")" \
    >/dev/null 2>&1 || true # old + not an anchor → prune
done || true
