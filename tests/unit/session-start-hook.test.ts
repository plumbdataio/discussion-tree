import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The SessionStart hook writes a PID-keyed hint file that the MCP server
// reads to auto-attach. The hook's default state dir MUST match
// broker/config.ts HOME_DIR ($HOME/.parallel-discussion) — a rebrand once
// drifted it to .discussion-tree, which silently broke auto-attach because
// the hook wrote hint files somewhere the broker never looked. These tests
// lock the path resolution.

const HOOK = new URL(
  "../../scripts/session-start-hook.sh",
  import.meta.url,
).pathname;

async function runHook(
  env: Record<string, string>,
  payload: object,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bash", HOOK], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("session-start-hook.sh", () => {
  test("default state dir is $HOME/.parallel-discussion (matches broker HOME_DIR)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-hook-home-"));
    try {
      const r = await runHook(
        { HOME: home, PARALLEL_DISCUSSION_HOME: "" },
        { session_id: "uuid-default", cwd: "/tmp/proj" },
      );
      expect(r.code).toBe(0);
      const dir = join(home, ".parallel-discussion", "cc-sessions");
      const files = readdirSync(dir);
      expect(files.length).toBe(1);
      const hint = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      expect(hint.cc_session_id).toBe("uuid-default");
      expect(hint.cwd).toBe("/tmp/proj");
      // Regression guard: the old bug wrote to .discussion-tree instead.
      expect(existsSync(join(home, ".discussion-tree"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PARALLEL_DISCUSSION_HOME override is honored", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-hook-home-"));
    const custom = mkdtempSync(join(tmpdir(), "pd-hook-custom-"));
    try {
      const r = await runHook(
        { HOME: home, PARALLEL_DISCUSSION_HOME: custom },
        { session_id: "uuid-override", cwd: "/tmp/p2" },
      );
      expect(r.code).toBe(0);
      const files = readdirSync(join(custom, "cc-sessions"));
      expect(files.length).toBe(1);
      // Nothing under the default location when the override is set.
      expect(
        existsSync(join(home, ".parallel-discussion", "cc-sessions")),
      ).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(custom, { recursive: true, force: true });
    }
  });

  test("emits SessionStart additionalContext carrying the session_id", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-hook-home-"));
    try {
      const r = await runHook(
        { HOME: home, PARALLEL_DISCUSSION_HOME: "" },
        { session_id: "uuid-ctx", cwd: "/tmp/p3" },
      );
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput.additionalContext).toContain("uuid-ctx");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
