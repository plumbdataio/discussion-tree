import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  planPrune,
  dayIndex,
  snapshotName,
  localDateStamp,
  sqlQuote,
  resolveConfig,
  runBackup,
  type BackupStatus,
} from "../../scripts/backup-db.ts";

// backup-db.ts replaces backup-db.sh on Windows. These lock: a consistent
// snapshot while a writer is active, the never-overwrite same-day rule, the
// two-tier retention (identical to the .sh — checked against the .sh itself on
// macOS), and that backup-status.json is written on success AND on every
// failure (the dt UI will surface failures from it).

const SCRIPT = new URL("../../scripts/backup-db.ts", import.meta.url).pathname;
const SH = new URL("../../scripts/backup-db.sh", import.meta.url).pathname;

function days(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8)));
  const end = Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8));
  while (d.getTime() <= end) {
    const p = (n: number) => String(n).padStart(2, "0");
    out.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const name = (s: string) => `discussion-tree-${s}.sqlite`;

describe("pure helpers", () => {
  test("dayIndex: real dates only, DST-free consecutive days", () => {
    expect(dayIndex("19700101")).toBe(0);
    expect(dayIndex("20261004")! - dayIndex("20261003")!).toBe(1);
    expect(dayIndex("20260301")! - dayIndex("20260228")!).toBe(1);
    expect(dayIndex("20240301")! - dayIndex("20240228")!).toBe(2); // leap year
    expect(dayIndex("20261332")).toBeNull();
    expect(dayIndex("20260230")).toBeNull();
    expect(dayIndex("2026101")).toBeNull();
  });

  test("snapshot name uses the LOCAL date", () => {
    const d = new Date(2026, 0, 5, 23, 59); // local 2026-01-05 23:59
    expect(localDateStamp(d)).toBe("20260105");
    expect(snapshotName(d)).toBe("discussion-tree-20260105.sqlite");
  });

  test("sqlQuote escapes single quotes (Windows paths with apostrophes)", () => {
    expect(sqlQuote("C:\\Users\\o'neil\\t.sqlite")).toBe("'C:\\Users\\o''neil\\t.sqlite'");
  });

  test("config: flags win over env, BACKUP_DIR required, bad numbers rejected", () => {
    const c = resolveConfig(["--backup-dir", "/b", "--keep", "3"], {
      BACKUP_DIR: "/env",
      DISCUSSION_TREE_HOME: "/h",
      KEEP_GENERATIONS: "9",
    });
    expect(c).toEqual({ backupDir: "/b", home: "/h", db: join("/h", "db.sqlite"), keep: 3, archiveEveryDays: 14 });
    const e = resolveConfig([], { BACKUP_DIR: "/env", DISCUSSION_TREE_DB: "/d.sqlite", KEEP_GENERATIONS: "" });
    expect(e.backupDir).toBe("/env");
    expect(e.db).toBe("/d.sqlite");
    expect(e.keep).toBe(14);
    expect(() => resolveConfig([], {})).toThrow(/BACKUP_DIR/);
    expect(() => resolveConfig(["--backup-dir", "/b", "--keep", "x"], {})).toThrow(/KEEP_GENERATIONS/);
  });
});

describe("retention (planPrune)", () => {
  test("keeps the newest 14 plus biweekly anchors phased from the OLDEST snapshot, across months", () => {
    const all = days("20260901", "20261031"); // 61 dailies
    const noise = [
      "discussion-tree-latest.sqlite",
      "discussion-tree-20261301.sqlite", // invalid date: never touched, not the origin
      "discussion-tree-20260905.sqlite.partial",
      "discussion-tree-20260906.sqlite-wal",
      "notes.txt",
    ];
    const del = new Set(planPrune([...all.map(name), ...noise].reverse(), 14, 14));
    const kept = all.filter((d) => !del.has(name(d)));
    expect(kept).toEqual([
      "20260901", "20260915", "20260929", "20261013", // anchors (origin 0901)
      ...days("20261018", "20261031"), // newest 14 (1027 is also an anchor)
    ]);
    for (const n of noise) expect(del.has(n)).toBe(false);
  });

  test("ordering is by the date in the NAME, and sparse dates keep their anchor phase", () => {
    const stamps = ["20251230", "20260105", "20260113", "20260127", "20260203", "20260210", "20260211"];
    // origin 20251230: anchors are +14k days -> 20260113, 20260127, 20260210
    expect(planPrune(stamps.map(name), 2, 14).sort()).toEqual([name("20260105"), name("20260203")]);
    // keep 0 -> only anchors survive (and the origin itself)
    expect(planPrune(stamps.map(name), 0, 14).sort()).toEqual(
      [name("20260105"), name("20260203"), name("20260211")].sort(),
    );
    expect(planPrune([], 14, 14)).toEqual([]);
  });

  test("matches backup-db.sh exactly (macOS only: the .sh needs BSD date)", () => {
    if (process.platform !== "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "dt-bk-parity-"));
    try {
      const fixture = [
        ...days("20260801", "20261020").filter((_, i) => i % 3 !== 1), // gappy, 3 months
        "20251231", // oldest -> origin
      ];
      for (const s of fixture) writeFileSync(join(dir, name(s)), "");
      // Run ONLY the .sh's prune section, printing instead of deleting (its real
      // delete goes through Finder/osascript).
      const sh = readFileSync(SH, "utf8");
      const start = sh.indexOf("_oldest=");
      const body = sh
        .slice(start)
        .replace(/osascript -e [^\n]*\\\n[^\n]*\n/, 'echo "$(basename "$f")"\n');
      expect(body).toContain('echo "$(basename "$f")"');
      const r = spawnSync("bash", ["-c", `set -uo pipefail\nBACKUP_DIR='${dir}'\nKEEP=14\nARCHIVE_EVERY_DAYS=14\n${body}`], {
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const shDeletes = r.stdout.split("\n").filter(Boolean).sort();
      const tsDeletes = planPrune(readdirSync(dir), 14, 14).sort();
      expect(shDeletes.length).toBeGreaterThan(10);
      expect(tsDeletes).toEqual(shDeletes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runBackup", () => {
  let root: string;
  let home: string;
  let bdir: string;
  let db: string;
  const fixedNow = () => new Date(2026, 9, 4, 11, 30); // local 2026-10-04
  const statusOf = (): BackupStatus => JSON.parse(readFileSync(join(home, "backup-status.json"), "utf8"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dt-bk-"));
    home = join(root, "home");
    bdir = join(root, "backups");
    mkdirSync(home);
    db = join(home, "db.sqlite");
  });
  afterEach(() => {
    try {
      chmodSync(bdir, 0o755);
    } catch {
      /* not created */
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("snapshot is consistent and valid while another process writes in WAL mode", async () => {
    const init = new Database(db);
    init.exec("PRAGMA journal_mode=WAL; CREATE TABLE a(n INTEGER); CREATE TABLE b(n INTEGER);");
    init.close();
    // Writer: each transaction adds one row to BOTH tables, so any consistent
    // snapshot has count(a) == count(b).
    const writerSrc = join(root, "writer.ts");
    writeFileSync(
      writerSrc,
      `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(db)});
db.exec("PRAGMA busy_timeout=5000");
const ins = db.transaction((i) => { db.run("INSERT INTO a VALUES (?)", [i]); db.run("INSERT INTO b VALUES (?)", [i]); });
let i = 0;
const end = Date.now() + 4000;
while (Date.now() < end) { ins(i++); if (i % 50 === 0) await Bun.sleep(1); }
`,
    );
    const writer = Bun.spawn([process.execPath, writerSrc], { stdout: "ignore", stderr: "pipe" });
    await Bun.sleep(400);
    const st = await runBackup(["--backup-dir", bdir, "--home", home], {}, fixedNow);
    expect(st.ok).toBe(true);
    expect(st.error).toBeNull();
    expect(st.skipped_existing).toBe(false);
    const dest = join(bdir, "discussion-tree-20261004.sqlite");
    expect(st.dest).toBe(dest);
    expect(st.size_bytes).toBeGreaterThan(0);
    const snap = new Database(dest, { readonly: true });
    const a = (snap.query("SELECT count(*) c FROM a").get() as { c: number }).c;
    const b = (snap.query("SELECT count(*) c FROM b").get() as { c: number }).c;
    expect((snap.query("PRAGMA integrity_check").get() as Record<string, string>).integrity_check).toBe("ok");
    expect((snap.query("PRAGMA journal_mode").get() as Record<string, string>).journal_mode).toBe("delete");
    snap.close();
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(b);
    expect(await writer.exited).toBe(0); // the writer was never broken by the reader
    expect(statusOf()).toEqual(st);
    expect(readdirSync(bdir)).toEqual(["discussion-tree-20261004.sqlite"]); // no .partial left
    expect(readFileSync(join(home, "backup.log"), "utf8")).toContain("ok backed up to");
  }, 30_000);

  test("WAL-mode DB with no -wal/-shm (broker stopped cleanly) still backs up", async () => {
    const init = new Database(db);
    init.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (42);");
    init.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    init.close();
    // macOS's system SQLite keeps the -wal/-shm files on close; remove them to
    // reproduce the "copied/cleanly stopped DB without its WAL files" state.
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
    const st = await runBackup(["--backup-dir", bdir, "--home", home], {}, fixedNow);
    expect(st.ok).toBe(true);
    const snap = new Database(st.dest!, { readonly: true });
    expect((snap.query("SELECT x FROM t").get() as { x: number }).x).toBe(42);
    snap.close();
  });

  test("today's file already exists -> kept untouched, run still ok and prunes", async () => {
    new Database(db).close();
    mkdirSync(bdir);
    const today = join(bdir, "discussion-tree-20261004.sqlite");
    writeFileSync(today, "KEEP-ME");
    // 20 older dailies; with origin 20260901 the anchors are 0901/0915/0929.
    for (const s of days("20260901", "20260920")) writeFileSync(join(bdir, name(s)), "");
    const st = await runBackup(["--backup-dir", bdir, "--home", home, "--keep", "5"], {}, fixedNow);
    expect(st.ok).toBe(true);
    expect(st.skipped_existing).toBe(true);
    expect(readFileSync(today, "utf8")).toBe("KEEP-ME");
    expect(st.size_bytes).toBe(7);
    expect(readdirSync(bdir).sort()).toEqual(
      ["20260901", "20260915", "20260917", "20260918", "20260919", "20260920", "20261004"].map(name),
    );
    expect(st.pruned).toBe(21 - 7);
    expect(st.prune_errors).toBe(0);
  });

  test("missing source DB -> failure status written, CLI exits non-zero", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--backup-dir", bdir, "--home", home], {
      encoding: "utf8",
      env: { ...process.env, DISCUSSION_TREE_DB: "" },
    });
    expect(r.status).not.toBe(0);
    const st = statusOf();
    expect(st.ok).toBe(false);
    expect(st.error).toContain("source DB not found");
    expect(st.started_at).toBeTruthy();
    expect(st.finished_at).toBeTruthy();
    expect(readFileSync(join(home, "backup.log"), "utf8")).toContain("ERROR source DB not found");
  });

  test("missing BACKUP_DIR config -> failure status in --home", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--home", home], {
      encoding: "utf8",
      env: { ...process.env, BACKUP_DIR: "" },
    });
    expect(r.status).not.toBe(0);
    expect(statusOf().ok).toBe(false);
    expect(statusOf().error).toContain("BACKUP_DIR");
  });

  test("unwritable BACKUP_DIR -> failure status, nothing half-written", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const init = new Database(db);
    init.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    init.close();
    mkdirSync(bdir);
    chmodSync(bdir, 0o500);
    const st = await runBackup(["--backup-dir", bdir, "--home", home], {}, fixedNow);
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/EACCES|permission/i);
    expect(statusOf().ok).toBe(false);
    chmodSync(bdir, 0o755);
    expect(readdirSync(bdir)).toEqual([]);
  });
});
