// Orphan detection for this MCP server's own lifecycle.
//
// Claude Code spawns this server as a stdio child, so its parent is CC. We want
// to self-terminate when that parent CC exits — otherwise we linger as a zombie:
// reparented to pid 1 (launchd/init), never sent SIGINT/SIGTERM, heartbeating
// forever and holding a stale broker session row alive=1. Repeated CC restarts
// pile these up.
//
// The obvious check — "process.ppid === 1 means we were reparented to init" —
// DOES NOT WORK under Bun: process.ppid is cached on first access and is NEVER
// refreshed after the process is reparented (VERIFIED on-device: a child that
// read process.ppid while its parent was alive kept returning the ORIGINAL
// parent pid after the parent died and it was reparented to pid 1 — it never
// became 1). This server reads process.ppid at startup (hintFilePath, /register
// cc_pid), so its value is frozen at the CC pid for the whole run. That is why a
// ppid===1 guard silently never fired and zombies accumulated for two months.
//
// So instead we capture the parent pid ONCE at startup (when process.ppid is
// still correct) and, each heartbeat tick, ask the OS whether that pid is still
// alive. process.kill(pid, 0) is NOT cached — it re-queries the OS on every call
// — so it actually observes the parent's death.

// Pure decision: the parent is gone iff the liveness probe says it is not alive.
// isAlive is injected so this is unit-testable without a real dying parent.
export function parentGone(
  parentPid: number,
  isAlive: (pid: number) => boolean,
): boolean {
  return !isAlive(parentPid);
}

// Production liveness probe. process.kill(pid, 0) sends no signal; it only asks
// the OS whether the pid exists (and is signalable). It throws (ESRCH when the
// pid is gone) — any throw means "not alive". Unlike process.ppid, this hits the
// OS on every call, so it sees a reparent/death.
//
// Windows note: if process.ppid was a wrapper pid rather than CC itself, this
// probes the wrapper's liveness (best-effort). The stdin-close path is the
// primary orphan trigger regardless, so that gap is acceptable.
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
