#!/usr/bin/env bun
// Restart the shared broker SAFELY — cross-platform port of restart-broker.sh.
//
// Same three guarantees as the .sh:
//   1. Build gate: `bun build server.ts broker.ts` (the check-build.sh check,
//      run directly so it needs no sh). If it fails we abort and the OLD broker
//      keeps running rather than being replaced by one that will not load.
//   2. Targeted kill: only the process LISTENing on the port (never pkill).
//   3. EADDRINUSE ordering: wait (up to ~5s) for the port to actually free
//      before anything rebinds it.
//
// NEW: supervisor awareness. If scripts/broker-supervisor.ts is running for
// this home (its pidfile names a live pid), we do NOT spawn — the supervisor
// sees its child exit and restarts it within ~1s; spawning here would race it
// and leave an unsupervised broker. Otherwise we spawn detached exactly like
// ensure-broker-running.ts.
//
// Finding the listener:
//   macOS/Linux: lsof -ti tcp:<port> -sTCP:LISTEN
//   Windows:     PowerShell Get-NetTCPConnection -State Listen, falling back to
//                `netstat -ano -p TCP` (listening rows recognised by the
//                foreign address 0.0.0.0:0 / [::]:0, NOT by the state word,
//                which netstat localises).
//
// Usage: bun scripts/restart-broker.ts [--port N] [--home DIR] [--skip-build-check]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isHealthy, launchDetached, resolveHome } from "./ensure-broker-running.ts";
import { readSupervisorLock, supervisorPaths } from "./broker-supervisor.ts";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------- pure parsers

function uniquePids(nums: number[]): number[] {
  // pid 0 = System Idle, 4 = System on Windows: never ours to kill.
  return [...new Set(nums.filter((n) => Number.isInteger(n) && n > 4))];
}

// `lsof -ti ...` prints one pid per line.
export function parseLsofPids(out: string): number[] {
  return uniquePids(
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
      .map(Number),
  );
}

// `Get-NetTCPConnection ... | Select-Object -ExpandProperty OwningProcess`
// prints one pid per line (IPv4 and IPv6 listeners can repeat the same pid).
export function parseGetNetTcpPids(out: string): number[] {
  return parseLsofPids(out);
}

// `netstat -ano -p TCP` rows:
//   TCP    127.0.0.1:7898     0.0.0.0:0      LISTENING     12345
//   TCP    [::1]:7898         [::]:0         LISTENING     12345
// The state column is localised on non-English Windows, so a listener is
// identified by its foreign address being the wildcard (:0) instead.
export function parseNetstatListenPids(out: string, port: number | string): number[] {
  const pids: number[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4 || cols[0].toUpperCase() !== "TCP") continue;
    const local = cols[1];
    const foreign = cols[2];
    const pid = Number(cols[cols.length - 1]);
    const localPort = local.slice(local.lastIndexOf(":") + 1);
    const foreignPort = foreign.slice(foreign.lastIndexOf(":") + 1);
    if (localPort === String(port) && foreignPort === "0") pids.push(pid);
  }
  return uniquePids(pids);
}

export type AfterKillAction = "wait-for-supervisor" | "spawn";

// What to do once the port is free.
export function decideAfterKill(supervisorRunning: boolean): AfterKillAction {
  return supervisorRunning ? "wait-for-supervisor" : "spawn";
}

// --------------------------------------------------------------- system calls

export function findListenerPids(
  port: number | string,
  platform: NodeJS.Platform = process.platform,
): number[] {
  if (platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    if (ps.status === 0) return parseGetNetTcpPids(ps.stdout ?? "");
    const ns = spawnSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    return parseNetstatListenPids(ns.stdout ?? "", port);
  }
  const r = spawnSync("lsof", ["-ti", `tcp:${Number(port)}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return parseLsofPids(r.stdout ?? "");
}

export function runBuildCheck(repoRoot: string): { ok: boolean; log: string } {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "dt-check-build-"));
  try {
    const r = spawnSync(
      process.execPath,
      ["build", "server.ts", "broker.ts", "--target=bun", "--outdir", out],
      { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 300_000 },
    );
    return { ok: r.status === 0, log: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await Bun.sleep(stepMs);
  }
  return await cond();
}

// ----------------------------------------------------------------------- run

export async function restartBroker(argv: string[], env: Env = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      home: { type: "string" },
      "skip-build-check": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const say = (m: string) => console.log(`restart-broker: ${m}`);
  const fail = (m: string) => {
    console.error(`restart-broker: ${m}`);
    return 1;
  };
  const repoRoot = path.dirname(import.meta.dir);
  const port = values.port || env.DISCUSSION_TREE_PORT || "7898";
  const home = values.home || resolveHome(env);
  const health = `http://127.0.0.1:${port}/health`;

  // 1. Refuse to restart into a broken build.
  if (!values["skip-build-check"]) {
    const b = runBuildCheck(repoRoot);
    if (!b.ok) {
      console.error(b.log);
      return fail("build check failed - keeping the current broker.");
    }
    say("build check ok");
  }

  // 2. Kill the listener(s).
  const pids = findListenerPids(port);
  if (pids.length === 0) say(`nothing is listening on :${port}`);
  for (const pid of pids) {
    say(`stopping broker (pid ${pid}) on :${port}`);
    try {
      process.kill(pid, "SIGTERM"); // Windows: TerminateProcess
    } catch (e) {
      say(`kill ${pid} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. Wait for the port to be released.
  if (pids.length > 0) {
    const freed = await waitFor(() => findListenerPids(port).length === 0, 5_000);
    if (!freed) return fail(`port :${port} still busy after wait - aborting to avoid a half-dead state.`);
  }

  // 4. Supervisor restarts it, or we spawn.
  const sup = readSupervisorLock(supervisorPaths(home).pidfile);
  const action = decideAfterKill(sup.held);
  if (action === "wait-for-supervisor") {
    say(`supervisor (pid ${(sup as { pid: number }).pid}) is running; letting it restart the broker`);
  } else {
    if (!fs.existsSync(path.join(repoRoot, "broker.ts"))) return fail(`broker.ts not found in ${repoRoot}`);
    fs.mkdirSync(home, { recursive: true });
    launchDetached(process.execPath, ["--smol", path.join(repoRoot, "broker.ts")], {
      cwd: repoRoot,
      env: { ...env, DISCUSSION_TREE_HOME: home, DISCUSSION_TREE_PORT: port },
      logPath: path.join(home, "broker.log"),
    });
    say("spawned a detached broker");
  }

  // 5. Confirm it bound. The supervisor path allows for its 1s backoff plus
  // broker startup (web prebuild on a cold cache).
  const up = await waitFor(() => isHealthy(health), action === "spawn" ? 10_000 : 30_000, 200);
  if (up) {
    say(`broker up on :${port}`);
    return 0;
  }
  return fail(`broker did not report healthy in time - check ${path.join(home, "broker.log")}`);
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await restartBroker(process.argv.slice(2));
  } catch (e) {
    console.error(`restart-broker: fatal: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(code);
}
