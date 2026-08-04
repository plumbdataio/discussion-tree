import { describe, test, expect } from "bun:test";
import { parentGone, processIsAlive } from "../../server/orphan.ts";

// process.ppid is cached by Bun and never turns into 1 after a reparent, so the
// orphan check can't rely on it. Instead it probes whether the parent pid
// captured at startup is still alive. parentGone is that pure decision, with the
// liveness probe injected so both outcomes are testable without a real dying
// parent.
describe("parentGone", () => {
  test("parent still alive → keep running", () => {
    expect(parentGone(1234, () => true)).toBe(false);
  });

  test("parent gone (probe reports not alive) → self-exit", () => {
    expect(parentGone(1234, () => false)).toBe(true);
  });

  test("passes the captured parent pid through to the probe", () => {
    let seen = -1;
    parentGone(4242, (pid) => {
      seen = pid;
      return true;
    });
    expect(seen).toBe(4242);
  });
});

// The production probe. Signal 0 sends nothing; it only asks the OS whether the
// pid exists, so an existing pid reads alive and a throw (ESRCH/EINVAL) reads
// not-alive.
describe("processIsAlive", () => {
  test("our own pid is alive", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  test("a non-existent pid is not alive", () => {
    // 2^31-1: not a live process; process.kill throws, which the probe maps to
    // false.
    expect(processIsAlive(2147483647)).toBe(false);
  });
});
