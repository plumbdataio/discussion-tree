#!/usr/bin/env bun
// discussion-tree SessionStart hook (plugin install only) — Bun port of
// ensure-broker-running.sh.
//
// Ensures the shared broker daemon is up before the MCP server connects. When
// discussion-tree is installed as a Claude Code plugin there is no manual
// `bun broker.ts` running, so this hook checks the broker's /health and, if it
// is down, launches broker.ts detached from the plugin's install dir.
//
// In the dev setup the broker is started manually; this hook then finds /health
// already OK and does nothing.
//
// Safety / idempotency (same as the .sh):
//   - /health already answers -> exit immediately (no double launch).
//   - An atomic mkdir lock (${home}/.broker-launch.lock, the SAME path the MCP
//     server's auto-spawn uses — see server/launch-lock.ts) guards against two
//     SessionStart hooks racing to spawn; the loser exits without spawning.
//     Bun.serve also fails fast on a busy port, so a lost race is harmless.
//   - Every failure path exits 0 so the hook can never block session start.
//
// NEW vs the .sh (intentional): when DISCUSSION_TREE_BROKER_URL points at a
// NON-loopback host, this machine's sessions talk to a broker on another
// machine, so a local broker would never be used. The .sh spawned one anyway
// whenever the local port was down — that is how pd-002 ended up running a
// vestigial empty broker on its own 127.0.0.1:7898. Now we do nothing there.
// (The MCP server's ensureBroker refuses to spawn for a remote URL for the same
// reason; see server/config.ts BROKER_IS_REMOTE.)
//
// WHY A PORT. The .sh needs bash + curl + nohup and cannot exec on Windows.
// node:child_process spawn with detached + an opened log fd + unref is the
// cross-platform equivalent of `nohup ... >>log 2>&1 &` under Bun.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { releaseLock, tryAcquireLock } from "../server/launch-lock.ts";
import { isSupervisorRunning } from "../server/supervisor-lock.ts";

type Env = Record<string, string | undefined>;

// Same test as server/config.ts BROKER_IS_REMOTE, applied to the raw env var:
// loopback = 127.0.0.1 / localhost / [::1], any port.
const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

// False when DISCUSSION_TREE_BROKER_URL names a remote broker (so a local spawn
// would only create an unused stray broker). An unset or EMPTY var means the
// default loopback broker, exactly like the .sh hooks' `${VAR:-...}`.
export function shouldSpawn(env: Env = process.env): boolean {
  const url = env.DISCUSSION_TREE_BROKER_URL;
  if (!url) return true;
  return LOOPBACK_URL.test(url.trim());
}

// State home. `||`, not `??`: an EMPTY DISCUSSION_TREE_HOME must mean "unset"
// (the .sh's `${DISCUSSION_TREE_HOME:-...}`) — `??` would keep "" and put the
// lock and broker.log in whatever cwd CC happens to have. os.homedir(), not
// $HOME, because HOME is unset on stock Windows shells.
export function resolveHome(env: Env = process.env): string {
  return env.DISCUSSION_TREE_HOME || path.join(os.homedir(), ".discussion-tree");
}

// Plugin root (where broker.ts lives): CLAUDE_PLUGIN_ROOT, which Claude Code
// exports for plugin hooks, else this script's parent dir (scripts/ -> root) so
// the hook still works when invoked directly.
export function resolveRoot(env: Env = process.env): string {
  return env.CLAUDE_PLUGIN_ROOT || path.dirname(import.meta.dir);
}

export function healthUrl(env: Env = process.env): string {
  return `http://127.0.0.1:${env.DISCUSSION_TREE_PORT || "7898"}/health`;
}

// `curl -sS --max-time 1 <url>` without -f: ANY HTTP response counts as up.
export async function isHealthy(url: string, timeoutMs = 1000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Launch `cmd args` fully detached so it outlives this hook process and the CC
// session (new process group/session on POSIX, no console window on Windows),
// with stdout+stderr appended to logPath. Returns once spawned; never waits.
export function launchDetached(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Env; logPath: string },
): void {
  const fd = fs.openSync(opts.logPath, "a");
  try {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", () => {
      /* spawn failure is best-effort: nothing to report to */
    });
    child.unref();
  } finally {
    // The child holds its own dup of the fd; ours is no longer needed.
    fs.closeSync(fd);
  }
}

export type EnsureResult =
  | "remote"
  | "healthy"
  | "supervised"
  | "no-broker-script"
  | "locked"
  | "spawned";

export async function ensureBrokerRunning(
  env: Env = process.env,
  deps: {
    launch?: typeof launchDetached;
    healthy?: (url: string) => Promise<boolean>;
    supervised?: (home: string) => boolean;
    pollTries?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<EnsureResult> {
  const launch = deps.launch ?? launchDetached;
  const healthy = deps.healthy ?? ((u: string) => isHealthy(u));
  if (!shouldSpawn(env)) return "remote";

  // Already up? Nothing to do. Short timeout so a wedged port doesn't stall
  // session start.
  const health = healthUrl(env);
  if (await healthy(health)) return "healthy";

  // Down, but a broker supervisor (scripts/broker-supervisor.ts) owns this
  // home: it restarts the broker itself (within ~1s, at most its 60s backoff).
  // Spawning here would put an UNSUPERVISED broker on the port, which the
  // supervisor would then merely stand by for. Leave it to the supervisor.
  const home = resolveHome(env);
  if ((deps.supervised ?? isSupervisorRunning)(home)) return "supervised";

  const root = resolveRoot(env);
  const broker = path.join(root, "broker.ts");
  if (!fs.existsSync(broker)) return "no-broker-script";

  fs.mkdirSync(home, { recursive: true });
  // Single-launcher lock. We do NOT wait on it: a missed launch is recovered
  // by the next SessionStart (or the MCP server's ensureBroker, which also
  // steals a stale lock).
  const lock = path.join(home, ".broker-launch.lock");
  if (tryAcquireLock(lock).status !== "acquired") return "locked";
  try {
    // cwd = plugin root: Bun.serve resolves web asset URLs against the process
    // cwd, and this hook inherits the cwd of whatever CC session triggered it.
    // Launching from another project's dir served broken chunk paths -> blank
    // page (observed 2026-08-06). --smol: keep the long-lived broker's JSC heap
    // small (see restart-broker.sh). process.execPath is the bun running us, so
    // this needs no `bun` on PATH (on Windows it is bun.exe).
    launch(process.execPath, ["--smol", broker], {
      cwd: root,
      env: { ...env, DISCUSSION_TREE_HOME: home },
      logPath: path.join(home, "broker.log"),
    });

    // Give it a moment to bind, then confirm. We don't fail the hook either way.
    const tries = deps.pollTries ?? 10;
    const interval = deps.pollIntervalMs ?? 300;
    for (let i = 0; i < tries; i++) {
      if (await healthy(health)) break;
      await Bun.sleep(interval);
    }
  } finally {
    releaseLock(lock);
  }
  return "spawned";
}

if (import.meta.main) {
  try {
    await ensureBrokerRunning();
  } catch {
    /* best-effort: never block session start */
  }
  process.exit(0);
}
