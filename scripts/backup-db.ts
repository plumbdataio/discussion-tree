#!/usr/bin/env bun
// discussion-tree SQLite backup — cross-platform port of backup-db.sh.
//
// Takes a consistent snapshot of the broker's SQLite DB into BACKUP_DIR as
// discussion-tree-YYYYMMDD.sqlite (local date) and prunes old snapshots with
// the same two-tier retention as the .sh. Runs daily from Task Scheduler on
// Windows (scripts/windows/dt-tasks.ps1) or by hand anywhere.
//
// WHY A PORT. The .sh needs bash + the sqlite3 CLI + BSD `date -j` + osascript,
// none of which exist on stock Windows. bun:sqlite ships with Bun, so this has
// no external dependency.
//
// Snapshot: `VACUUM INTO` on a READ-ONLY connection with a busy timeout. It
// reads inside one read transaction, so the result is a consistent snapshot
// even while the broker writes in WAL mode, and a reader never blocks the
// broker's writer. The snapshot goes to a LOCAL temp file first, is checked
// with PRAGMA integrity_check, and only then copied into BACKUP_DIR (which is
// typically a cloud-synced drive: we never let a half-written file appear
// under the final name, and never write SQLite pages directly onto it).
//
// Same-day rule (from the .sh): if today's file already exists it is kept and
// the run skips the snapshot — never overwrite. On the Mac this mattered for
// Bitdefender SafeFiles; here it also means a re-run cannot replace a good
// snapshot with a worse one.
//
// Status: every run (success OR failure, including bad config) writes
// <home>/backup-status.json atomically, so the dt UI can surface failures from
// that one file. Also appends one line per run to <home>/backup.log, because a
// scheduled task's stdout goes nowhere.
//
// Config (CLI flag wins over env):
//   --backup-dir / BACKUP_DIR                 (required) destination folder
//   --db / DISCUSSION_TREE_DB                 (optional) default <home>/db.sqlite
//   --home / DISCUSSION_TREE_HOME             (optional) default ~/.discussion-tree
//   --keep / KEEP_GENERATIONS                 (optional) newest N kept; 14
//   --archive-every-days / ARCHIVE_EVERY_DAYS (optional) anchor period; 14

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";

type Env = Record<string, string | undefined>;

export const SNAPSHOT_RE = /^discussion-tree-(\d{8})\.sqlite$/;

export type BackupStatus = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  dest: string | null;
  size_bytes: number | null;
  skipped_existing: boolean;
  pruned: number;
  prune_errors: number;
  error: string | null;
};

export type BackupConfig = {
  backupDir: string;
  db: string;
  home: string;
  keep: number;
  archiveEveryDays: number;
};

// ---------------------------------------------------------------- pure helpers

export function localDateStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function snapshotName(d: Date = new Date()): string {
  return `discussion-tree-${localDateStamp(d)}.sqlite`;
}

// Calendar day index of a YYYYMMDD string (days since 1970-01-01, computed in
// UTC so DST can never shift it), or null if it is not a real date. Matches the
// .sh, which used local noon's epoch/86400: for any UTC offset under 12h that
// is the same calendar day, and retention only ever uses DIFFERENCES anyway.
export function dayIndex(yyyymmdd: string): number | null {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null; // 20261332 etc: unparseable -> not a snapshot, never touched
  }
  return Math.round(t / 86_400_000);
}

// Two-tier retention, identical to backup-db.sh:
//   - keep the newest `keep` snapshots, ordered by the DATE IN THE NAME (not
//     mtime: a salvaged copy has a fresh mtime that says nothing about the day
//     it captured);
//   - keep FOREVER every snapshot whose date is a multiple of `archiveEvery`
//     days after the OLDEST snapshot's date (the first backup anchors the
//     series, and being phase 0 it is itself kept, so the phase is stable);
//   - only names matching exactly discussion-tree-YYYYMMDD.sqlite with a real
//     date are considered; everything else in the folder is left alone.
// Returns the file NAMES to delete.
export function planPrune(
  names: string[],
  keep: number,
  archiveEvery: number,
): string[] {
  const snaps: { name: string; stamp: string; day: number }[] = [];
  for (const name of names) {
    const m = SNAPSHOT_RE.exec(name);
    if (!m) continue;
    const day = dayIndex(m[1]);
    if (day === null) continue;
    snaps.push({ name, stamp: m[1], day });
  }
  if (snaps.length === 0) return [];
  snaps.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0)); // newest first
  const origin = snaps[snaps.length - 1].day;
  const period = archiveEvery > 0 ? archiveEvery : 0;
  const out: string[] = [];
  snaps.forEach((s, i) => {
    if (i < keep) return; // within the newest `keep`
    if (period && (s.day - origin) % period === 0) return; // anchor: forever
    out.push(s.name);
  });
  return out;
}

// SQL string literal for a file path (only `'` needs escaping).
export function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function posInt(v: string | undefined, d: number, name: string): number {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${v}")`);
  return n;
}

// Resolve config from flags + env. `||` (not `??`) so an EMPTY env var means
// unset, like the .sh's ${VAR:-default}. Throws on missing/invalid input; the
// caller still writes a failure status in that case.
export function resolveConfig(argv: string[], env: Env = process.env): BackupConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      "backup-dir": { type: "string" },
      db: { type: "string" },
      home: { type: "string" },
      keep: { type: "string" },
      "archive-every-days": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const home = values.home || env.DISCUSSION_TREE_HOME || path.join(os.homedir(), ".discussion-tree");
  const backupDir = values["backup-dir"] || env.BACKUP_DIR || "";
  if (!backupDir) throw new Error("BACKUP_DIR (env) or --backup-dir is required");
  return {
    backupDir,
    home,
    db: values.db || env.DISCUSSION_TREE_DB || path.join(home, "db.sqlite"),
    keep: posInt(values.keep ?? env.KEEP_GENERATIONS, 14, "KEEP_GENERATIONS"),
    archiveEveryDays: posInt(
      values["archive-every-days"] ?? env.ARCHIVE_EVERY_DAYS,
      14,
      "ARCHIVE_EVERY_DAYS",
    ),
  };
}

// Home for the status file even when full config resolution failed (so a
// missing BACKUP_DIR still lands in backup-status.json).
export function resolveStatusHome(argv: string[], env: Env = process.env): string {
  const i = argv.indexOf("--home");
  const flag = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--home="))?.slice(7);
  return flag || env.DISCUSSION_TREE_HOME || path.join(os.homedir(), ".discussion-tree");
}

// ------------------------------------------------------------------ file I/O

// write-then-rename. On Windows a rename onto a file someone has open can fail
// transiently (EPERM/EBUSY), so retry briefly, then fall back to a direct write
// (a torn status file is better than a missing one).
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(file, data);
}

// Snapshot `src` into `out` (must not exist) and verify it. Read-only source
// connection: never takes a write lock, never checkpoints or deletes the
// broker's WAL. busy_timeout covers the brief moments a checkpoint holds the
// WAL index lock.
//
// Fallback: a read-only connection CANNOT open a WAL-mode DB whose -wal/-shm
// files are absent (it may not create them) — exactly the state after the
// broker shut down cleanly. Then we retry read-write (never create). With no
// broker running nobody is disturbed, and if the broker came up meanwhile a
// read-write connection that only reads is still harmless.
export function snapshotDb(src: string, out: string, busyTimeoutMs = 15_000): void {
  const attempt = (opts: { readonly: true } | { readwrite: true; create: false }) => {
    const db = new Database(src, opts);
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.floor(busyTimeoutMs)}`);
      db.exec(`VACUUM INTO ${sqlQuote(out)}`);
    } finally {
      db.close();
    }
  };
  try {
    attempt({ readonly: true });
  } catch {
    try {
      fs.unlinkSync(out);
    } catch {
      /* not created */
    }
    attempt({ readwrite: true, create: false });
  }
  verifySnapshot(out);
}

export function verifySnapshot(file: string): void {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[];
    const vals = rows.map((r) => String(Object.values(r)[0]));
    if (vals.length !== 1 || vals[0] !== "ok") {
      throw new Error(`snapshot integrity_check failed: ${vals.slice(0, 5).join("; ")}`);
    }
  } finally {
    db.close();
  }
}

// Copy into the backup dir under a temporary name, then rename to the final
// name, so an interrupted copy never leaves a truncated file that the
// same-day rule would then keep forever. If the destination filesystem refuses
// the rename (some sync/AV layers allow create but not rename), fall back to an
// exclusive direct copy (COPYFILE_EXCL: never overwrite).
export function publishSnapshot(tmp: string, dest: string): void {
  const partial = `${dest}.partial`;
  try {
    fs.copyFileSync(tmp, partial);
    fs.renameSync(partial, dest);
  } catch (e) {
    try {
      fs.unlinkSync(partial);
    } catch {
      /* none */
    }
    if (fs.existsSync(dest)) throw e;
    fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
  }
  const want = fs.statSync(tmp).size;
  const got = fs.statSync(dest).size;
  if (want !== got) throw new Error(`copied size mismatch: ${got} != ${want} bytes (${dest})`);
}

export function prune(
  dir: string,
  keep: number,
  archiveEvery: number,
): { pruned: number; errors: number } {
  let pruned = 0;
  let errors = 0;
  for (const name of planPrune(fs.readdirSync(dir), keep, archiveEvery)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      pruned++;
    } catch {
      errors++; // non-fatal: one stubborn file must not fail the run
    }
  }
  return { pruned, errors };
}

// --------------------------------------------------------------------- run

export async function runBackup(
  argv: string[],
  env: Env = process.env,
  now: () => Date = () => new Date(),
): Promise<BackupStatus> {
  const status: BackupStatus = {
    ok: false,
    started_at: now().toISOString(),
    finished_at: "",
    dest: null,
    size_bytes: null,
    skipped_existing: false,
    pruned: 0,
    prune_errors: 0,
    error: null,
  };
  let statusHome = resolveStatusHome(argv, env);
  let tmp: string | null = null;
  try {
    const cfg = resolveConfig(argv, env);
    statusHome = cfg.home;
    if (!fs.existsSync(cfg.db)) throw new Error(`source DB not found: ${cfg.db}`);
    fs.mkdirSync(cfg.backupDir, { recursive: true });
    const dest = path.join(cfg.backupDir, snapshotName(now()));
    status.dest = dest;
    if (fs.existsSync(dest)) {
      status.skipped_existing = true;
    } else {
      tmp = path.join(os.tmpdir(), `dt-backup-${process.pid}-${Date.now()}.sqlite`);
      snapshotDb(cfg.db, tmp);
      publishSnapshot(tmp, dest);
    }
    status.size_bytes = fs.statSync(dest).size;
    // Prune only after today's snapshot is safely in place.
    const pr = prune(cfg.backupDir, cfg.keep, cfg.archiveEveryDays);
    status.pruned = pr.pruned;
    status.prune_errors = pr.errors;
    status.ok = true;
  } catch (e) {
    status.ok = false;
    status.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* never created */
      }
    }
  }
  status.finished_at = now().toISOString();
  try {
    writeJsonAtomic(path.join(statusHome, "backup-status.json"), status);
  } catch (e) {
    // Status is the one channel the UI reads; losing it is itself a failure.
    status.ok = false;
    status.error = `${status.error ? status.error + "; " : ""}status write failed: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
  const line = status.ok
    ? `${status.finished_at} ok ${status.skipped_existing ? "kept existing" : "backed up to"} ${status.dest} (${status.size_bytes} bytes, pruned ${status.pruned}, prune errors ${status.prune_errors})`
    : `${status.finished_at} ERROR ${status.error}`;
  try {
    fs.appendFileSync(path.join(statusHome, "backup.log"), line + "\n");
  } catch {
    /* best-effort */
  }
  (status.ok ? console.log : console.error)(line);
  return status;
}

if (import.meta.main) {
  let ok = false;
  try {
    ok = (await runBackup(process.argv.slice(2))).ok;
  } catch (e) {
    console.error(`backup-db: fatal: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(ok ? 0 : 1);
}
