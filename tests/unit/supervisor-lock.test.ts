import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSupervisorRunning,
  supervisorPidfile,
  SUPERVISOR_PIDFILE_NAME,
} from "../../server/supervisor-lock.ts";
import { PIDFILE_NAME, DEFAULTS } from "../../scripts/broker-supervisor.ts";
import { ensureBrokerRunning } from "../../scripts/ensure-broker-running.ts";

// Both on-demand spawn paths (SessionStart hook, MCP ensureBroker) must leave
// the (re)start to a live broker supervisor instead of putting an unsupervised
// broker on the port. These lock the shared liveness rule and that BOTH paths
// honour it — and still spawn when the supervisor's pidfile is dead or stale.

const BROKER_CLIENT = new URL("../../server/broker-client.ts", import.meta.url).pathname;
const FAKE = new URL("../harness/fake-broker.ts", import.meta.url).pathname;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dt-suplock-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("isSupervisorRunning", () => {
  test("same pidfile name and stale window as the supervisor itself", () => {
    expect(PIDFILE_NAME).toBe(SUPERVISOR_PIDFILE_NAME);
    expect(supervisorPidfile(home)).toBe(join(home, "broker-supervisor.pid"));
    expect(DEFAULTS.lockStaleMs).toBe(10 * 60_000);
  });

  test("absent / garbage / dead pid / stale mtime -> false; fresh live pid -> true", () => {
    const f = supervisorPidfile(home);
    expect(isSupervisorRunning(home)).toBe(false);
    writeFileSync(f, "garbage");
    expect(isSupervisorRunning(home)).toBe(false);
    writeFileSync(f, "999999\n");
    expect(isSupervisorRunning(home, { alive: () => false })).toBe(false);
    writeFileSync(f, `${process.pid}\n`);
    expect(isSupervisorRunning(home)).toBe(true);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(f, old, old);
    expect(isSupervisorRunning(home)).toBe(false); // pid reuse guard
  });

  test("never throws, even for a nonexistent home", () => {
    expect(isSupervisorRunning(join(home, "nope", "deeper"))).toBe(false);
  });
});

describe("SessionStart hook (ensureBrokerRunning)", () => {
  test("broker down + live supervisor -> 'supervised', no spawn, no launch lock taken", async () => {
    writeFileSync(supervisorPidfile(home), `${process.pid}\n`);
    let launches = 0;
    const r = await ensureBrokerRunning(
      { DISCUSSION_TREE_HOME: home },
      { healthy: async () => false, launch: () => void launches++ },
    );
    expect(r).toBe("supervised");
    expect(launches).toBe(0);
    expect(existsSync(join(home, ".broker-launch.lock"))).toBe(false);
  });

  test("broker down + DEAD supervisor pidfile -> spawns as before", async () => {
    writeFileSync(supervisorPidfile(home), "999999\n");
    let launches = 0;
    const r = await ensureBrokerRunning(
      { DISCUSSION_TREE_HOME: home },
      {
        healthy: async () => false,
        supervised: (h) => isSupervisorRunning(h, { alive: () => false }),
        launch: () => void launches++,
        pollTries: 1,
        pollIntervalMs: 1,
      },
    );
    expect(r).toBe("spawned");
    expect(launches).toBe(1);
  });

  test("healthy broker short-circuits before the supervisor check", async () => {
    let checked = 0;
    const r = await ensureBrokerRunning(
      { DISCUSSION_TREE_HOME: home },
      { healthy: async () => true, supervised: () => (checked++, true) },
    );
    expect(r).toBe("healthy");
    expect(checked).toBe(0);
  });
});

// server/config.ts resolves HOME/PORT at import time, so ensureBroker runs in a
// child bun with its own env. It prints "ok" or "err:<message>".
function runEnsureBroker(port: number, waitMs: number) {
  const src = join(home, "run-ensure.ts");
  writeFileSync(
    src,
    `import { ensureBroker } from ${JSON.stringify(BROKER_CLIENT)};\n` +
      `try { await ensureBroker({ supervisedWaitMs: ${waitMs} }); console.log("ok"); }\n` +
      `catch (e) { console.log("err:" + (e instanceof Error ? e.message : String(e))); }\n` +
      `process.exit(0);\n`,
  );
  // Drop any BROKER_URL from the outer env: server/config.ts reads it with
  // `??`, so even an empty value would count as a (remote) override.
  const { DISCUSSION_TREE_BROKER_URL: _drop, ...base } = process.env;
  return Bun.spawn([process.execPath, src], {
    env: {
      ...base,
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}

describe("MCP ensureBroker", () => {
  test("live supervisor, broker never comes back -> waits, then throws WITHOUT spawning", async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    writeFileSync(supervisorPidfile(home), `${process.pid}\n`);
    const p = runEnsureBroker(port, 600);
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    expect(out).toStartWith("err:");
    expect(out).toContain("broker supervisor did not bring it back");
    expect(await listening(port)).toBe(false); // nobody spawned a broker
    expect(existsSync(join(home, ".broker-launch.lock"))).toBe(false);
  }, 20_000);

  test("live supervisor, broker comes back during the wait -> resolves", async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    writeFileSync(supervisorPidfile(home), `${process.pid}\n`);
    const p = runEnsureBroker(port, 10_000);
    // Play the supervisor: bring a "broker" up a moment later.
    await Bun.sleep(400);
    const fake = Bun.spawn([process.execPath, FAKE], {
      env: { ...process.env, DISCUSSION_TREE_PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const out = (await new Response(p.stdout).text()).trim();
      await p.exited;
      expect(out).toBe("ok");
    } finally {
      fake.kill("SIGKILL");
      await fake.exited;
    }
  }, 20_000);
});
