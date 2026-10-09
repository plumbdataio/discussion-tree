import { describe, test, expect } from "bun:test";
import {
  evaluateBackupHealth,
  BACKUP_STALE_AFTER_HOURS,
} from "../../broker/backup-health.ts";

// evaluateBackupHealth turns <home>/backup-status.json (written by
// scripts/backup-db.ts after every run) into the verdict the UI banner shows.
// These lock each state, the 36h staleness boundary, and that a missing file
// means "not configured" (no banner) rather than an error.

const FINISHED = "2026-10-09T02:30:00.702Z";
const finishedMs = Date.parse(FINISHED);
const H = 3_600_000;

function status(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    started_at: "2026-10-09T02:30:00.680Z",
    finished_at: FINISHED,
    dest: "G:\backups\discussion-tree-20261009.sqlite",
    size_bytes: 48328704,
    skipped_existing: true,
    pruned: 0,
    prune_errors: 0,
    error: null,
    ...over,
  });
}
const at = (ms: number) => new Date(ms);

describe("evaluateBackupHealth", () => {
  test("missing file → none (backup not set up: no UI)", () => {
    const h = evaluateBackupHealth(null, at(finishedMs));
    expect(h.state).toBe("none");
    expect(h.finished_at).toBeNull();
  });

  test("recent success → ok", () => {
    const h = evaluateBackupHealth(status(), at(finishedMs + H));
    expect(h.state).toBe("ok");
    expect(h.finished_at).toBe(FINISHED);
    expect(h.dest).toContain("discussion-tree-20261009.sqlite");
    expect(h.prune_errors).toBe(0);
    expect(h.error).toBeNull();
    expect(h.stale_after_hours).toBe(BACKUP_STALE_AFTER_HOURS);
  });

  test("threshold is 36h", () => {
    expect(BACKUP_STALE_AFTER_HOURS).toBe(36);
  });

  test("exactly at the threshold is still ok; one ms past is stale", () => {
    const limit = finishedMs + BACKUP_STALE_AFTER_HOURS * H;
    expect(evaluateBackupHealth(status(), at(limit)).state).toBe("ok");
    const h = evaluateBackupHealth(status(), at(limit + 1));
    expect(h.state).toBe("stale");
    // finished_at = the last success, which the banner names.
    expect(h.finished_at).toBe(FINISHED);
  });

  test("finished_at in the future (clock skew) → ok, not stale", () => {
    expect(evaluateBackupHealth(status(), at(finishedMs - H)).state).toBe("ok");
  });

  test("ok:false → failed with the error message", () => {
    const h = evaluateBackupHealth(
      status({ ok: false, dest: null, error: "source DB not found: X" }),
      at(finishedMs + H),
    );
    expect(h.state).toBe("failed");
    expect(h.error).toBe("source DB not found: X");
    expect(h.finished_at).toBe(FINISHED);
  });

  test("an old failure stays failed (never downgraded to stale)", () => {
    const h = evaluateBackupHealth(
      status({ ok: false, error: "boom" }),
      at(finishedMs + 100 * H),
    );
    expect(h.state).toBe("failed");
  });

  test("failed with an empty error → error null", () => {
    const h = evaluateBackupHealth(status({ ok: false, error: "" }), at(finishedMs));
    expect(h.state).toBe("failed");
    expect(h.error).toBeNull();
  });

  test("prune errors on a success → ok + prune_errors exposed", () => {
    const h = evaluateBackupHealth(status({ prune_errors: 2 }), at(finishedMs + H));
    expect(h.state).toBe("ok");
    expect(h.prune_errors).toBe(2);
  });

  test("prune errors on a stale success → stale wins, count still exposed", () => {
    const h = evaluateBackupHealth(
      status({ prune_errors: 1 }),
      at(finishedMs + 40 * H),
    );
    expect(h.state).toBe("stale");
    expect(h.prune_errors).toBe(1);
  });

  test("non-numeric / negative prune_errors → 0", () => {
    expect(
      evaluateBackupHealth(status({ prune_errors: "3" }), at(finishedMs)).prune_errors,
    ).toBe(0);
    expect(
      evaluateBackupHealth(status({ prune_errors: -1 }), at(finishedMs)).prune_errors,
    ).toBe(0);
  });

  test("invalid JSON → unreadable", () => {
    const h = evaluateBackupHealth('{"ok": tru', at(finishedMs));
    expect(h.state).toBe("unreadable");
    expect(h.error).toBeTruthy();
  });

  test("empty file (torn write) → unreadable", () => {
    expect(evaluateBackupHealth("", at(finishedMs)).state).toBe("unreadable");
  });

  test("JSON that is not a status object → unreadable", () => {
    for (const text of ["null", "42", '"x"', "[]", '{"ok":"yes"}', "{}"]) {
      expect(evaluateBackupHealth(text, at(finishedMs)).state).toBe("unreadable");
    }
  });

  test("ok:true without a parseable finished_at → unreadable", () => {
    expect(
      evaluateBackupHealth(status({ finished_at: "" }), at(finishedMs)).state,
    ).toBe("unreadable");
    expect(
      evaluateBackupHealth(status({ finished_at: "garbage" }), at(finishedMs)).state,
    ).toBe("unreadable");
  });

  test("failed without finished_at → failed, finished_at null", () => {
    const h = evaluateBackupHealth(
      status({ ok: false, finished_at: "", error: "x" }),
      at(finishedMs),
    );
    expect(h.state).toBe("failed");
    expect(h.finished_at).toBeNull();
  });

  test("the pure function never sets log_path", () => {
    expect(evaluateBackupHealth(status(), at(finishedMs)).log_path).toBeNull();
  });
});
