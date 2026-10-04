import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextBackoff,
  backoffAfterExit,
  readSupervisorLock,
  acquireSupervisorLock,
  releaseSupervisorLock,
  rotateIfLarge,
  parseSupervisorArgs,
  childCommand,
  isPidAlive,
  supervisorPaths,
  DEFAULTS,
} from "../../scripts/broker-supervisor.ts";

// The supervisor keeps the broker alive on an always-on host (pd-002). These
// lock: the backoff schedule (no hot spin, reset after a stable run), the
// single-instance pidfile lock (incl. stale takeover), and — end to end with a
// fake broker — restart-after-exit, standby while another process serves the
// port, and clean shutdown by signal and by stop file.

const SUPERVISOR = new URL("../../scripts/broker-supervisor.ts", import.meta.url).pathname;
const FAKE = new URL("../harness/fake-broker.ts", import.meta.url).pathname;

describe("backoff", () => {
  test("doubles and caps", () => {
    expect(nextBackoff(1000, 60_000)).toBe(2000);
    expect(nextBackoff(32_000, 60_000)).toBe(60_000);
    expect(nextBackoff(60_000, 60_000)).toBe(60_000);
    let b = 1000;
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) {
      seq.push(b);
      b = nextBackoff(b, 60_000);
    }
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  test("a stable run resets to the initial delay; a quick exit keeps the current one", () => {
    const opts = { initialMs: 1000, stableMs: 300_000 };
    expect(backoffAfterExit(300_000, 60_000, opts)).toBe(1000);
    expect(backoffAfterExit(10 * 3600_000, 16_000, opts)).toBe(1000);
    expect(backoffAfterExit(500, 16_000, opts)).toBe(16_000);
  });

  test("defaults match the documented schedule", () => {
    expect(DEFAULTS.backoffInitialMs).toBe(1000);
    expect(DEFAULTS.backoffMaxMs).toBe(60_000);
    expect(DEFAULTS.stableMs).toBe(300_000);
  });
});

describe("supervisor lock", () => {
  let dir: string;
  let pidfile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dt-sup-lock-"));
    pidfile = join(dir, "broker-supervisor.pid");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("absent -> acquired, then held by us", () => {
    expect(readSupervisorLock(pidfile)).toEqual({ held: false, reason: "absent" });
    expect(acquireSupervisorLock(pidfile)).toEqual({ acquired: true });
    expect(readFileSync(pidfile, "utf8").trim()).toBe(String(process.pid));
    expect(readSupervisorLock(pidfile)).toEqual({ held: true, pid: process.pid });
  });

  test("a live holder blocks a second acquire", () => {
    acquireSupervisorLock(pidfile);
    const r = acquireSupervisorLock(pidfile, { pid: 999_999 });
    expect(r).toEqual({ acquired: false, heldBy: process.pid });
  });

  test("a dead pid is taken over", () => {
    writeFileSync(pidfile, "999999\n");
    const r = acquireSupervisorLock(pidfile, { alive: () => false });
    expect(r).toEqual({ acquired: true, tookOver: "dead-pid" });
    expect(readFileSync(pidfile, "utf8").trim()).toBe(String(process.pid));
  });

  test("a live pid with an old mtime (pid reuse) is stale and taken over", () => {
    writeFileSync(pidfile, "12345\n");
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(pidfile, old, old);
    expect(readSupervisorLock(pidfile, { alive: () => true })).toEqual({
      held: false,
      reason: "stale",
    });
    const r = acquireSupervisorLock(pidfile, { alive: () => true });
    expect(r).toEqual({ acquired: true, tookOver: "stale" });
  });

  test("garbage content is unreadable, not held", () => {
    writeFileSync(pidfile, "not-a-pid");
    expect(readSupervisorLock(pidfile)).toEqual({ held: false, reason: "unreadable" });
  });

  test("release removes only our own pidfile", () => {
    writeFileSync(pidfile, "424242\n");
    releaseSupervisorLock(pidfile);
    expect(existsSync(pidfile)).toBe(true);
    releaseSupervisorLock(pidfile, 424242);
    expect(existsSync(pidfile)).toBe(false);
  });

  test("isPidAlive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

describe("helpers", () => {
  test("rotateIfLarge keeps one old generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "dt-sup-rot-"));
    try {
      const f = join(dir, "broker.log");
      writeFileSync(f, "x".repeat(100));
      expect(rotateIfLarge(f, 1000)).toBe(false);
      expect(rotateIfLarge(f, 50)).toBe(true);
      expect(existsSync(f)).toBe(false);
      expect(statSync(`${f}.1`).size).toBe(100);
      writeFileSync(f, "y".repeat(60));
      expect(rotateIfLarge(f, 50)).toBe(true);
      expect(readFileSync(`${f}.1`, "utf8")).toBe("y".repeat(60));
      expect(rotateIfLarge(join(dir, "missing.log"), 1)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("args: flags override env; empty env home falls back to the default", () => {
    const a = parseSupervisorArgs(["--home", "/x/h", "--port", "1234", "--poll-ms", "50"], {
      DISCUSSION_TREE_PORT: "9999",
    });
    expect(a.opts.home).toBe("/x/h");
    expect(a.opts.port).toBe("1234");
    expect(a.opts.pollMs).toBe(50);
    expect(a.stop).toBe(false);
    const b = parseSupervisorArgs(["--stop"], { DISCUSSION_TREE_HOME: "", DISCUSSION_TREE_PORT: "9999" });
    expect(b.stop).toBe(true);
    expect(b.opts.port).toBe("9999");
    expect(b.opts.home.endsWith(".discussion-tree")).toBe(true);
    expect(() => parseSupervisorArgs(["--bogus"])).toThrow();
  });

  test("childCommand runs the real broker with --smol unless a script is injected", () => {
    expect(childCommand({ bun: "/b/bun", repoRoot: "/r" })).toEqual(["/b/bun", "--smol", join("/r", "broker.ts")]);
    expect(childCommand({ bun: "/b/bun", repoRoot: "/r", childScript: "/f.ts" })).toEqual(["/b/bun", "/f.ts"]);
  });
});

// ------------------------------------------------------------ integration

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

async function get(port: number, p: string): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(500) });
    return await r.text();
  } catch {
    return null;
  }
}

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(50);
  }
  return false;
}

function startSupervisor(home: string, port: number) {
  return Bun.spawn(
    [
      process.execPath,
      SUPERVISOR,
      "--home", home,
      "--port", String(port),
      "--child-script", FAKE,
      "--backoff-initial-ms", "100",
      "--backoff-max-ms", "400",
      "--poll-ms", "150",
      "--stop-grace-ms", "1000",
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, DISCUSSION_TREE_HOME: "" } },
  );
}

describe("supervisor (integration, fake broker)", () => {
  let home: string;
  let port: number;
  const procs: Array<ReturnType<typeof Bun.spawn>> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dt-sup-int-"));
    port = randomPort();
  });
  afterEach(async () => {
    for (const p of procs.splice(0)) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    // Any fake child left over (only if a test failed midway).
    const pid = Number(await get(port, "/pid"));
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("restarts the broker after it exits, and SIGTERM stops both", async () => {
    const sup = startSupervisor(home, port);
    procs.push(sup);
    expect(await waitUntil(async () => (await get(port, "/health")) !== null)).toBe(true);
    const pid1 = Number(await get(port, "/pid"));
    expect(pid1).toBeGreaterThan(0);
    expect(readSupervisorLock(supervisorPaths(home).pidfile)).toEqual({ held: true, pid: sup.pid });

    await get(port, "/exit?code=3");
    expect(
      await waitUntil(async () => {
        const p = Number(await get(port, "/pid"));
        return p > 0 && p !== pid1;
      }),
    ).toBe(true);
    const pid2 = Number(await get(port, "/pid"));

    sup.kill("SIGTERM");
    expect(await sup.exited).toBe(0);
    expect(await get(port, "/health")).toBeNull();
    expect(isPidAlive(pid2)).toBe(false);
    expect(existsSync(supervisorPaths(home).pidfile)).toBe(false);

    const log = readFileSync(supervisorPaths(home).supervisorLog, "utf8");
    expect(log).toContain("broker exited (code=3");
    expect(log).toContain("restarting in 100ms");
    expect(log).toContain("stopped (SIGTERM)");
    expect(readFileSync(supervisorPaths(home).brokerLog, "utf8")).toContain("[fake-broker");
  }, 30_000);

  test("a second supervisor for the same home exits 0 without spawning", async () => {
    const sup = startSupervisor(home, port);
    procs.push(sup);
    expect(await waitUntil(async () => (await get(port, "/health")) !== null)).toBe(true);
    const pid1 = Number(await get(port, "/pid"));
    const second = startSupervisor(home, port);
    procs.push(second);
    expect(await second.exited).toBe(0);
    expect(Number(await get(port, "/pid"))).toBe(pid1);
    const log = readFileSync(supervisorPaths(home).supervisorLog, "utf8");
    expect(log).toContain(`another supervisor (pid ${sup.pid})`);
    sup.kill("SIGTERM");
    expect(await sup.exited).toBe(0);
  }, 30_000);

  test("stands by while another process serves the port, takes over when it stops, and --stop shuts down", async () => {
    // An unsupervised "broker" already owns the port.
    const outsider = Bun.spawn([process.execPath, FAKE], {
      env: { ...process.env, DISCUSSION_TREE_PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(outsider);
    expect(await waitUntil(async () => (await get(port, "/health")) !== null)).toBe(true);

    const sup = startSupervisor(home, port);
    procs.push(sup);
    expect(
      await waitUntil(() => {
        try {
          return readFileSync(supervisorPaths(home).supervisorLog, "utf8").includes("standing by");
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    await Bun.sleep(500);
    // Never spawned a child while standing by (no hot spin).
    expect(readFileSync(supervisorPaths(home).supervisorLog, "utf8")).not.toContain("spawned broker");
    expect(Number(await get(port, "/pid"))).toBe(outsider.pid);

    outsider.kill("SIGKILL");
    await outsider.exited;
    expect(
      await waitUntil(async () => {
        const p = Number(await get(port, "/pid"));
        return p > 0 && p !== outsider.pid;
      }),
    ).toBe(true);
    const childPid = Number(await get(port, "/pid"));

    // Cross-platform stop path (what dt-tasks.ps1 -Uninstall uses).
    const stopper = Bun.spawn(
      [process.execPath, SUPERVISOR, "--stop", "--home", home],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await stopper.exited).toBe(0);
    expect(await sup.exited).toBe(0);
    expect(await get(port, "/health")).toBeNull();
    expect(isPidAlive(childPid)).toBe(false);
    expect(existsSync(supervisorPaths(home).stopfile)).toBe(false);
    const log = readFileSync(supervisorPaths(home).supervisorLog, "utf8");
    expect(log).toContain("taking over");
    expect(log).toContain("stopped (stop file)");
  }, 30_000);

  test("--stop with no supervisor running is a no-op success", async () => {
    const stopper = Bun.spawn([process.execPath, SUPERVISOR, "--stop", "--home", home], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await stopper.exited).toBe(0);
    expect(existsSync(supervisorPaths(home).stopfile)).toBe(false);
  });
});
