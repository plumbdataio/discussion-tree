#!/usr/bin/env bun
// Long-running broker supervisor: keeps exactly one broker serving the port on
// a machine that runs dt 24/7 (pd-002, Windows; also works on macOS/Linux).
//
// WHY: the broker is otherwise launched on demand (SessionStart hook / MCP
// ensureBroker) and nothing brings it back if it crashes while no Claude Code
// session is starting. On an always-on host the UI must stay reachable even
// with zero sessions, so a supervisor owns the broker's lifetime instead. On
// Windows it is started by a Task Scheduler logon task (scripts/windows/
// dt-tasks.ps1); the task's own restart-on-failure is only a second net.
//
// Behavior:
//   - Spawns `<bun> --smol broker.ts` with cwd = repo root (Bun.serve resolves
//     web asset paths against the cwd) and DISCUSSION_TREE_HOME/PORT set.
//     Child stdout+stderr are appended to <home>/broker.log; the supervisor's
//     own timestamped lines go to <home>/supervisor.log.
//   - When the child exits it is restarted after a backoff (1s doubling to 60s).
//     The backoff resets once a child has stayed up STABLE_MS (5 min), so a
//     one-off crash after days of uptime restarts in 1s again.
//   - Port already served by someone else (an orphan broker, a hook-spawned one,
//     a manual `bun broker.ts`): the broker's own singleton guard / bind catch
//     makes our child exit 0 almost immediately. We never spin on that: before
//     every spawn we check /health and, while it answers, simply wait ("standby")
//     and re-check every POLL_MS. Whoever serves the port is fine; we take over
//     only once it stops answering.
//   - Single instance: an exclusive pidfile <home>/broker-supervisor.pid. A
//     second supervisor exits 0 (so Task Scheduler does not count it as a
//     failure and retry). Stale detection: the recorded pid is dead, OR the
//     pidfile has not been refreshed for LOCK_STALE_MS (the live supervisor
//     touches it every LOCK_HEARTBEAT_MS). The mtime rule covers Windows pid
//     reuse, where a dead supervisor's pid can belong to an unrelated process.
//   - Stop: SIGINT/SIGTERM (and SIGHUP/SIGBREAK, which Bun maps from Windows
//     console close / Ctrl+Break) stop the child and exit 0. Because Windows has
//     no way to deliver SIGTERM to a hidden process from outside, there is also
//     a cross-platform STOP FILE: `bun broker-supervisor.ts --stop` creates
//     <home>/broker-supervisor.stop and waits for the supervisor to exit; the
//     supervisor polls for it every second. dt-tasks.ps1 -Uninstall uses this
//     so the broker is shut down cleanly instead of being orphaned.
//
// Test hooks: --child-script runs `<bun> <script>` instead of the broker (so the
// tests never start a real broker), and the timing knobs are flags too.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { isHealthy, resolveHome } from "./ensure-broker-running.ts";
import {
  readSupervisorLock,
  SUPERVISOR_LOCK_STALE_MS,
  SUPERVISOR_PIDFILE_NAME,
} from "../server/supervisor-lock.ts";

type Env = Record<string, string | undefined>;

export const DEFAULTS = {
  backoffInitialMs: 1_000,
  backoffMaxMs: 60_000,
  stableMs: 5 * 60_000,
  pollMs: 5_000,
  stopGraceMs: 5_000,
  lockHeartbeatMs: 30_000,
  lockStaleMs: SUPERVISOR_LOCK_STALE_MS,
  logMaxBytes: 10 * 1024 * 1024,
};

export const PIDFILE_NAME = SUPERVISOR_PIDFILE_NAME;
export const STOPFILE_NAME = "broker-supervisor.stop";

// ---------------------------------------------------------------- pure helpers

// Next backoff after a child that exited quickly: double, capped.
export function nextBackoff(
  currentMs: number,
  maxMs: number = DEFAULTS.backoffMaxMs,
): number {
  return Math.min(Math.max(currentMs, 1) * 2, maxMs);
}

// The backoff to WAIT before the next spawn, given how long the child that
// just exited had been up. A child that stayed up >= stableMs is treated as a
// healthy run: start over at the initial delay. Otherwise wait the current
// backoff (the caller then advances it with nextBackoff).
export function backoffAfterExit(
  uptimeMs: number,
  currentMs: number,
  opts: { initialMs: number; stableMs: number },
): number {
  return uptimeMs >= opts.stableMs ? opts.initialMs : currentMs;
}

export function supervisorPaths(home: string) {
  return {
    pidfile: path.join(home, PIDFILE_NAME),
    stopfile: path.join(home, STOPFILE_NAME),
    supervisorLog: path.join(home, "supervisor.log"),
    brokerLog: path.join(home, "broker.log"),
  };
}

export function formatLogLine(msg: string, now: Date = new Date()): string {
  return `${localTimestamp(now)} [supervisor ${process.pid}] ${msg}\n`;
}

// "2026-10-04 11:30:05" in local time (what a human tailing the log expects).
export function localTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// ------------------------------------------------------- liveness (shared)

// The pidfile format and the "is a supervisor alive" rule live in
// server/supervisor-lock.ts so the on-demand spawn paths (SessionStart hook,
// MCP ensureBroker) apply exactly the same check. Re-exported for callers and
// tests of this module.
export {
  isPidAlive,
  readSupervisorLock,
  type LockState,
} from "../server/supervisor-lock.ts";

export type AcquireOutcome =
  | { acquired: true; tookOver?: string }
  | { acquired: false; heldBy: number };

// Take the pidfile exclusively ("wx" = O_CREAT|O_EXCL, atomic on POSIX and
// Windows). If it exists but is stale/dead, take it over — under a short-lived
// mkdir mutex so two supervisors starting at once cannot both "remove the stale
// file" and then delete each other's fresh one.
export function acquireSupervisorLock(
  pidfile: string,
  opts: { pid?: number; staleMs?: number; alive?: (pid: number) => boolean } = {},
): AcquireOutcome {
  const pid = opts.pid ?? process.pid;
  const write = () => {
    const fd = fs.openSync(pidfile, "wx");
    try {
      fs.writeSync(fd, `${pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    write();
    return { acquired: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
  }
  const mutex = `${pidfile}.takeover`;
  try {
    fs.mkdirSync(mutex);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    // Someone else is mid-takeover. A takeover mutex older than a minute was
    // left by a crash between mkdir and rmdir: clear it so the next start works.
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs > 60_000) fs.rmdirSync(mutex);
    } catch {
      /* gone already */
    }
    const s = readSupervisorLock(pidfile, opts);
    return { acquired: false, heldBy: s.held ? s.pid : -1 };
  }
  try {
    const s = readSupervisorLock(pidfile, opts);
    if (s.held) return { acquired: false, heldBy: s.pid };
    try {
      fs.unlinkSync(pidfile);
    } catch {
      /* already gone */
    }
    write();
    return { acquired: true, tookOver: s.reason };
  } finally {
    try {
      fs.rmdirSync(mutex);
    } catch {
      /* ignore */
    }
  }
}

// Remove the pidfile only if it is still ours (never delete a successor's).
export function releaseSupervisorLock(pidfile: string, pid: number = process.pid): void {
  try {
    if (parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10) === pid) {
      fs.unlinkSync(pidfile);
    }
  } catch {
    /* gone / unreadable */
  }
}

// ---------------------------------------------------------------- log helpers

// Size-capped logs: on a 24/7 host broker.log would otherwise grow forever.
// Rotation happens only between child runs (no writer has it open); one old
// generation is kept. Best-effort: on Windows a file another process still has
// open cannot be renamed, which just means "rotate next time".
export function rotateIfLarge(file: string, maxBytes: number): boolean {
  try {
    if (fs.statSync(file).size < maxBytes) return false;
    const old = `${file}.1`;
    try {
      fs.unlinkSync(old);
    } catch {
      /* none yet */
    }
    fs.renameSync(file, old);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- the runner

export type SupervisorOptions = {
  home: string;
  port: string;
  repoRoot: string;
  bun: string;
  /** Replace `--smol broker.ts` with `<script>` (tests). */
  childScript?: string;
  env: Env;
  backoffInitialMs: number;
  backoffMaxMs: number;
  stableMs: number;
  pollMs: number;
  stopGraceMs: number;
  lockHeartbeatMs: number;
  lockStaleMs: number;
  logMaxBytes: number;
};

export function childCommand(o: Pick<SupervisorOptions, "bun" | "repoRoot" | "childScript">): string[] {
  return o.childScript
    ? [o.bun, o.childScript]
    : [o.bun, "--smol", path.join(o.repoRoot, "broker.ts")];
}

export async function runSupervisor(o: SupervisorOptions): Promise<number> {
  fs.mkdirSync(o.home, { recursive: true });
  const p = supervisorPaths(o.home);
  rotateIfLarge(p.supervisorLog, o.logMaxBytes);
  const log = (msg: string) => {
    const line = formatLogLine(msg);
    try {
      fs.appendFileSync(p.supervisorLog, line);
    } catch {
      /* log dir vanished: still echo below */
    }
    process.stderr.write(line);
  };

  const lock = acquireSupervisorLock(p.pidfile, { staleMs: o.lockStaleMs });
  if (!lock.acquired) {
    log(`another supervisor (pid ${lock.heldBy}) holds ${p.pidfile}; exiting`);
    return 0;
  }
  if (lock.tookOver) log(`took over a ${lock.tookOver} supervisor lock`);
  // A stop request left over from a previous run must not stop THIS one.
  try {
    fs.unlinkSync(p.stopfile);
  } catch {
    /* none */
  }

  const healthUrl = `http://127.0.0.1:${o.port}/health`;
  const cmd = childCommand(o);
  log(`started (home=${o.home} port=${o.port} cmd=${cmd.join(" ")})`);

  let stopping = false;
  let stopReason = "";
  let child: ChildProcess | null = null;
  let wake: (() => void) | null = null;

  // Sets the flag, ends any backoff/standby sleep, and kills a running child
  // (the loop is blocked awaiting that child's exit).
  const requestStop = (why: string) => {
    if (stopping) return;
    stopping = true;
    stopReason = why;
    wake?.();
    if (child) void stopChild(child, o.stopGraceMs);
  };

  // Interruptible sleep: a stop request ends it early.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK" as NodeJS.Signals];
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const sig of signals) {
    const h = () => requestStop(sig);
    try {
      process.on(sig, h);
      handlers.push([sig, h]);
    } catch {
      /* signal not supported on this platform */
    }
  }

  // Lock heartbeat + stop-file poll. If the pidfile no longer names us (an
  // operator deleted it, or a successor took over after a long sleep made it
  // look stale) step down rather than run two supervisors.
  const heartbeat = setInterval(() => {
    try {
      const pidNow = parseInt(fs.readFileSync(p.pidfile, "utf8").trim(), 10);
      if (pidNow !== process.pid) {
        requestStop(`lost the lock to pid ${pidNow}`);
        return;
      }
      const t = new Date();
      fs.utimesSync(p.pidfile, t, t);
    } catch {
      requestStop("pidfile disappeared");
    }
  }, o.lockHeartbeatMs);
  const stopPoll = setInterval(() => {
    if (fs.existsSync(p.stopfile)) requestStop("stop file");
  }, 1_000);

  let backoff = o.backoffInitialMs;
  let standbyLogged = false;
  try {
    while (!stopping) {
      if (await isHealthy(healthUrl)) {
        if (!standbyLogged) {
          log(`port ${o.port} is already served by another process; standing by`);
          standbyLogged = true;
        }
        await sleep(o.pollMs);
        continue;
      }
      if (standbyLogged) {
        log(`port ${o.port} stopped answering; taking over`);
        standbyLogged = false;
      }
      if (stopping) break;

      rotateIfLarge(p.brokerLog, o.logMaxBytes);
      const started = Date.now();
      const fd = fs.openSync(p.brokerLog, "a");
      let exitInfo: { code: number | null; signal: string | null; error?: string };
      try {
        const c = spawn(cmd[0], cmd.slice(1), {
          cwd: o.repoRoot,
          env: {
            ...o.env,
            DISCUSSION_TREE_HOME: o.home,
            DISCUSSION_TREE_PORT: o.port,
          } as NodeJS.ProcessEnv,
          // NOT detached: on POSIX the child stays in our process group, so a
          // terminal Ctrl+C reaches both; on Windows it shares our (hidden)
          // console, so no window appears.
          windowsHide: true,
          stdio: ["ignore", fd, fd],
        });
        child = c;
        log(`spawned broker pid ${c.pid ?? "?"}`);
        exitInfo = await new Promise((resolve) => {
          c.once("exit", (code, signal) => resolve({ code, signal }));
          c.once("error", (err) => resolve({ code: null, signal: null, error: String(err) }));
        });
      } finally {
        child = null;
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      const uptime = Date.now() - started;
      log(
        `broker exited (code=${exitInfo.code} signal=${exitInfo.signal}` +
          `${exitInfo.error ? ` error=${exitInfo.error}` : ""}) after ${Math.round(uptime / 1000)}s`,
      );
      if (stopping) break;

      const wait = backoffAfterExit(uptime, backoff, {
        initialMs: o.backoffInitialMs,
        stableMs: o.stableMs,
      });
      backoff = nextBackoff(wait, o.backoffMaxMs);
      log(`restarting in ${wait}ms`);
      await sleep(wait);
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(stopPoll);
    if (child) await stopChild(child, o.stopGraceMs);
    for (const [sig, h] of handlers) process.off(sig, h);
    releaseSupervisorLock(p.pidfile);
    try {
      fs.unlinkSync(p.stopfile);
    } catch {
      /* none */
    }
    log(`stopped (${stopReason || "loop ended"})`);
  }
  return 0;
}

// Terminate a child and wait for it: SIGTERM, then SIGKILL after graceMs.
// Idempotent (a second call just waits for the same exit).
export async function stopChild(c: ChildProcess, graceMs: number): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise<void>((r) => c.once("exit", () => r()));
  try {
    c.kill("SIGTERM"); // Windows: TerminateProcess (no graceful signal exists)
  } catch {
    /* already gone */
  }
  const t = setTimeout(() => {
    try {
      c.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }, graceMs);
  await exited;
  clearTimeout(t);
}

// ---------------------------------------------------------------- --stop mode

// Ask a running supervisor (in this home) to stop, and wait for it to exit.
// Returns true when no supervisor is left running.
export async function requestSupervisorStop(
  home: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const p = supervisorPaths(home);
  const s = readSupervisorLock(p.pidfile);
  if (!s.held) return true;
  fs.writeFileSync(p.stopfile, `${new Date().toISOString()}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!readSupervisorLock(p.pidfile).held) return true;
    await Bun.sleep(200);
  }
  return false;
}

// ------------------------------------------------------------------------ CLI

export function parseSupervisorArgs(
  argv: string[],
  env: Env = process.env,
): { stop: boolean; opts: SupervisorOptions } {
  const { values } = parseArgs({
    args: argv,
    options: {
      home: { type: "string" },
      port: { type: "string" },
      "repo-root": { type: "string" },
      "child-script": { type: "string" },
      stop: { type: "boolean" },
      "backoff-initial-ms": { type: "string" },
      "backoff-max-ms": { type: "string" },
      "stable-ms": { type: "string" },
      "poll-ms": { type: "string" },
      "stop-grace-ms": { type: "string" },
      "lock-heartbeat-ms": { type: "string" },
      "lock-stale-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const num = (v: string | undefined, d: number) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const home = values.home || resolveHome(env);
  const port = values.port || env.DISCUSSION_TREE_PORT || "7898";
  return {
    stop: !!values.stop,
    opts: {
      home,
      port,
      repoRoot: values["repo-root"] || path.dirname(import.meta.dir),
      bun: process.execPath,
      childScript: values["child-script"],
      env,
      backoffInitialMs: num(values["backoff-initial-ms"], DEFAULTS.backoffInitialMs),
      backoffMaxMs: num(values["backoff-max-ms"], DEFAULTS.backoffMaxMs),
      stableMs: num(values["stable-ms"], DEFAULTS.stableMs),
      pollMs: num(values["poll-ms"], DEFAULTS.pollMs),
      stopGraceMs: num(values["stop-grace-ms"], DEFAULTS.stopGraceMs),
      lockHeartbeatMs: num(values["lock-heartbeat-ms"], DEFAULTS.lockHeartbeatMs),
      lockStaleMs: num(values["lock-stale-ms"], DEFAULTS.lockStaleMs),
      logMaxBytes: DEFAULTS.logMaxBytes,
    },
  };
}

if (import.meta.main) {
  let code = 1;
  try {
    const { stop, opts } = parseSupervisorArgs(process.argv.slice(2));
    if (stop) {
      const ok = await requestSupervisorStop(opts.home);
      console.error(ok ? "broker-supervisor: stopped" : "broker-supervisor: still running after timeout");
      code = ok ? 0 : 1;
    } else {
      code = await runSupervisor(opts);
    }
  } catch (e) {
    console.error(`broker-supervisor: fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    code = 1;
  }
  process.exit(code);
}
