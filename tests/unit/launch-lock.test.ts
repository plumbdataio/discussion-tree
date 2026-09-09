import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAcquireLock,
  lockAgeMs,
  isLockStale,
  releaseLock,
} from "../../server/launch-lock.ts";

// The broker auto-spawn path (ensureBroker) uses this lock to serialize spawns
// so a broker-down window can't trigger a thundering herd of respawns. These
// lock the three behaviors ensureBroker depends on: a free lock is acquired, a
// held lock blocks a second acquire, and an abandoned (stale) lock can be
// detected + stolen after a threshold.

describe("launch-lock", () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dt-launch-lock-"));
    lock = join(dir, ".broker-launch.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquire succeeds when the lock is free", () => {
    const r = tryAcquireLock(lock);
    expect(r.status).toBe("acquired");
    expect(existsSync(lock)).toBe(true);
  });

  test("a second acquire is blocked while the lock is held", () => {
    expect(tryAcquireLock(lock).status).toBe("acquired");
    // Second attempt (another launcher) must see it as held, not acquired.
    expect(tryAcquireLock(lock).status).toBe("held");
  });

  test("releaseLock frees the lock so it can be re-acquired", () => {
    expect(tryAcquireLock(lock).status).toBe("acquired");
    releaseLock(lock);
    expect(existsSync(lock)).toBe(false);
    expect(tryAcquireLock(lock).status).toBe("acquired");
  });

  test("releaseLock on a lock that isn't held is a no-op (no throw)", () => {
    expect(existsSync(lock)).toBe(false);
    expect(() => releaseLock(lock)).not.toThrow();
  });

  test("lockAgeMs is null when the lock does not exist", () => {
    expect(lockAgeMs(lock)).toBeNull();
  });

  test("a freshly taken lock is not stale", () => {
    expect(tryAcquireLock(lock).status).toBe("acquired");
    const age = lockAgeMs(lock);
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(15_000);
    expect(isLockStale(lock, 15_000)).toBe(false);
  });

  test("a lock older than the threshold is detected as stale and can be stolen", () => {
    expect(tryAcquireLock(lock).status).toBe("acquired");

    // Backdate the lock dir's mtime 20s into the past so it reads as abandoned
    // by a crashed launcher (matches ensureBroker's 15s staleness threshold).
    const past = (statSync(lock).mtimeMs - 20_000) / 1000;
    utimesSync(lock, past, past);

    expect(isLockStale(lock, 15_000)).toBe(true);

    // Steal-and-retry: remove the stale lock, then acquire cleanly.
    releaseLock(lock);
    expect(tryAcquireLock(lock).status).toBe("acquired");
    // The re-acquired lock is fresh again — no longer stale.
    expect(isLockStale(lock, 15_000)).toBe(false);
  });

  test("isLockStale honors an injected clock (deterministic staleness)", () => {
    expect(tryAcquireLock(lock).status).toBe("acquired");
    const created = statSync(lock).mtimeMs;
    // Just under the threshold: not yet stale. Just over: stale.
    expect(isLockStale(lock, 15_000, created + 14_999)).toBe(false);
    expect(isLockStale(lock, 15_000, created + 15_000)).toBe(true);
  });
});
