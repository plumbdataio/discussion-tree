// Liveness check for the broker supervisor (scripts/broker-supervisor.ts),
// shared by every broker-spawn path.
//
// WHY: on an always-on host the broker is owned by a supervisor that restarts
// it within ~1s (backoff up to 60s). The on-demand spawn paths — the
// SessionStart hook (scripts/ensure-broker-running.ts) and the MCP server's
// ensureBroker (server/broker-client.ts) — must not start their own broker in
// that gap: it would win the port, the supervisor would then only stand by, and
// the broker serving the UI would be one nobody restarts if it dies. So they
// ask this module "is a supervisor alive for this home?" and, if so, leave the
// (re)start to it.
//
// The supervisor holds <home>/broker-supervisor.pid (created with O_EXCL) and
// touches it every 30s. It counts as running when the recorded pid is alive
// AND the file was refreshed within the stale window — the mtime rule covers
// Windows pid reuse, where a dead supervisor's pid can belong to an unrelated
// process.
//
// Cheap on purpose (one read, one stat, one kill(pid, 0)) and dependency-free:
// the SessionStart hook runs it at every session start.

import * as fs from "node:fs";
import * as path from "node:path";

export const SUPERVISOR_PIDFILE_NAME = "broker-supervisor.pid";
// Ten missed 30s heartbeats; generous so a long GC pause or a machine waking
// from sleep does not make a live supervisor look dead.
export const SUPERVISOR_LOCK_STALE_MS = 10 * 60_000;

export function supervisorPidfile(home: string): string {
  return path.join(home, SUPERVISOR_PIDFILE_NAME);
}

// process.kill(pid, 0) probes existence without signalling (POSIX and Windows
// under Bun/libuv). EPERM means it exists but belongs to someone else.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export type LockState =
  | { held: true; pid: number }
  | { held: false; reason: "absent" | "unreadable" | "dead-pid" | "stale" };

// Inspect a supervisor pidfile without modifying it.
export function readSupervisorLock(
  pidfile: string,
  opts: {
    staleMs?: number;
    now?: number;
    alive?: (pid: number) => boolean;
  } = {},
): LockState {
  const staleMs = opts.staleMs ?? SUPERVISOR_LOCK_STALE_MS;
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? isPidAlive;
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(pidfile, "utf8");
    mtimeMs = fs.statSync(pidfile).mtimeMs;
  } catch (e) {
    return {
      held: false,
      reason:
        (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable",
    };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { held: false, reason: "unreadable" };
  if (!alive(pid)) return { held: false, reason: "dead-pid" };
  if (now - mtimeMs >= staleMs) return { held: false, reason: "stale" };
  return { held: true, pid };
}

// The question every spawn path asks: will a supervisor (re)start the broker
// for this home? Never throws.
export function isSupervisorRunning(
  home: string,
  opts: { alive?: (pid: number) => boolean; now?: number } = {},
): boolean {
  try {
    return readSupervisorLock(supervisorPidfile(home), opts).held;
  } catch {
    return false;
  }
}
