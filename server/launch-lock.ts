// Cross-process single-launcher lock for the broker auto-spawn path.
//
// WHY: the broker is a per-machine singleton on one port. During a broker-down
// window (a deploy restart) MANY Claude Code sessions' MCP servers each notice
// the broker is down at the same instant and each try to spawn one — a
// thundering herd. The port bind is atomic (Bun rejects a 2nd bind, so at most
// ONE broker ever LISTENs), but the losers that got past the health check and
// spawned still open the DB / start timers before their bind throws, and that
// throw is uncaught — so they linger as stuck processes and pile up. This lock
// serializes the spawn itself so only ONE launcher runs at a time.
//
// The lock is a DIRECTORY created with mkdir, which is atomic on POSIX and
// Windows: exactly one caller wins the create; everyone else gets EEXIST. The
// shell SessionStart hook (scripts/ensure-broker-running.sh) already uses the
// SAME lock path, so the two spawn paths coordinate through it.
//
// These are pure-ish fs helpers with no config / network dependency so they can
// be unit-tested directly.

import * as fs from "node:fs";

export type AcquireResult =
  | { status: "acquired" }
  | { status: "held" }
  | { status: "error"; error: unknown };

// Try to take the lock by atomically creating the lock directory. Returns
// "acquired" for the single winner, "held" when another launcher already owns
// it (EEXIST), and "error" for any other failure (permission, missing parent,
// read-only fs) — the caller treats "error" as "could not lock" and falls back
// to an unlocked spawn rather than letting a filesystem hiccup throw.
export function tryAcquireLock(lockDir: string): AcquireResult {
  try {
    fs.mkdirSync(lockDir);
    return { status: "acquired" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return { status: "held" };
    return { status: "error", error: e };
  }
}

// Age of the lock directory in ms (now - its mtime), or null if it does not
// exist (never held / just released). mkdir stamps the mtime at creation and it
// is never touched afterwards, so this is effectively "how long ago the current
// holder took the lock". `now` is injectable for tests. Re-reading the mtime
// here (rather than trusting a value captured earlier) means a lock that was
// released and freshly re-acquired by a NEW holder reads as young — so a slow
// but legitimately-held lock is not mistaken for a crashed one.
export function lockAgeMs(
  lockDir: string,
  now: number = Date.now(),
): number | null {
  try {
    return now - fs.statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

// A lock older than staleMs is presumed abandoned by a launcher that crashed
// mid-spawn (otherwise every future launch would deadlock on it forever).
export function isLockStale(
  lockDir: string,
  staleMs: number,
  now: number = Date.now(),
): boolean {
  const age = lockAgeMs(lockDir, now);
  return age !== null && age >= staleMs;
}

// Best-effort removal. Used both to RELEASE a lock we hold (in a finally) and to
// STEAL a stale one — the operation is the same rmdir either way, and a failure
// (already gone, someone else removed it) is fine to swallow.
export function releaseLock(lockDir: string): void {
  try {
    fs.rmdirSync(lockDir);
  } catch {
    /* already gone / never held — nothing to do */
  }
}
