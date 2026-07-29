import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The hint file is the ONLY place this process can learn its cc_session_id, and
// it used to be deleted on first use. That assumed one MCP start per CC start —
// but `/mcp` restarts the server while CC keeps running, SessionStart does not
// fire, and the reconnected server was left unable to attach at all. Observed
// twice on 2026-07-28; the only recovery was restarting CC.
//
// So the file is kept, and these pin the guards that make keeping it safe.

const home = mkdtempSync(path.join(tmpdir(), "pd-hint-"));
process.env.DISCUSSION_TREE_HOME = home;
const { readHintCcId, hintFilePath } = await import("../../server/auto-attach.ts");

const writeHint = (h: Record<string, unknown>) => {
  const f = hintFilePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(h));
  return f;
};
// Write a hint under an ARBITRARY filename, not <ppid>.json — stands for the
// Windows case where the hook ran through a wrapper and named the file after the
// wrapper's PID (or 1), not Claude Code's.
const writeHintNamed = (name: string, h: Record<string, unknown>) => {
  const dir = path.dirname(hintFilePath());
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(h));
  return f;
};
const nowSec = () => Math.floor(Date.now() / 1000);

afterEach(() => {
  // Clear the whole cc-sessions dir: tests now write hints under several names,
  // and a leftover would leak into the next test's cwd-fallback scan.
  try {
    fs.rmSync(path.dirname(hintFilePath()), { recursive: true, force: true });
  } catch {
    /* nothing written */
  }
});

describe("auto-attach hint", () => {
  test("is readable more than once, so a reconnect can still attach", () => {
    const f = writeHint({
      cc_session_id: "cc-1",
      cwd: process.cwd(),
      written_at: nowSec(),
    });
    expect(readHintCcId()).toBe("cc-1");
    // The second read is the one that matters: it stands for the MCP server
    // restarting under a CC that is still running.
    expect(readHintCcId()).toBe("cc-1");
    expect(fs.existsSync(f)).toBe(true);
  });

  test("a card left by a different CC on a recycled pid is ignored", () => {
    writeHint({
      cc_session_id: "cc-someone-else",
      cwd: "/somewhere/else",
      written_at: nowSec(),
    });
    expect(readHintCcId()).toBeNull();
  });

  test("a stale card is ignored even if the cwd matches", () => {
    writeHint({
      cc_session_id: "cc-ancient",
      cwd: process.cwd(),
      written_at: nowSec() - 60 * 24 * 60 * 60,
    });
    expect(readHintCcId()).toBeNull();
  });

  test("a card without the guard fields is still accepted", () => {
    // Written by an older hook: better to attach than to strand the session.
    writeHint({ cc_session_id: "cc-legacy" });
    expect(readHintCcId()).toBe("cc-legacy");
  });

  test("no file means no hint", () => {
    expect(readHintCcId()).toBeNull();
  });
});

// Windows: Claude Code runs the SessionStart hook through a wrapper, so the
// hook's PID is that wrapper — it writes <wrapper>.json (or 1.json), NEVER
// <CC-pid>.json. Only this MCP server is CC's direct child, so the by-PID lookup
// finds nothing and the session never binds. Observed on pd-002 2026-07-30. The
// fix: fall back to the most-recent hint written for OUR cwd.
describe("auto-attach hint — cwd fallback (hook PID != server PID)", () => {
  test("binds by cwd when no file is named for our PID", () => {
    writeHintNamed("hook-wrapper.json", {
      cc_session_id: "cc-win",
      cwd: process.cwd(),
      written_at: nowSec(),
    });
    expect(fs.existsSync(hintFilePath())).toBe(false);
    expect(readHintCcId()).toBe("cc-win");
  });

  test("picks the most recent hint for this cwd", () => {
    writeHintNamed("old-hook.json", {
      cc_session_id: "cc-old",
      cwd: process.cwd(),
      written_at: nowSec() - 100,
    });
    writeHintNamed("new-hook.json", {
      cc_session_id: "cc-new",
      cwd: process.cwd(),
      written_at: nowSec(),
    });
    expect(readHintCcId()).toBe("cc-new");
  });

  test("never binds to a hint written for a different cwd", () => {
    writeHintNamed("other-cwd.json", {
      cc_session_id: "cc-elsewhere",
      cwd: "/some/other/dir",
      written_at: nowSec(),
    });
    expect(readHintCcId()).toBeNull();
  });

  test("the PID-named file still wins when it is valid", () => {
    writeHint({
      cc_session_id: "cc-direct",
      cwd: process.cwd(),
      written_at: nowSec(),
    });
    writeHintNamed("some-wrapper.json", {
      cc_session_id: "cc-fallback",
      cwd: process.cwd(),
      written_at: nowSec(),
    });
    expect(readHintCcId()).toBe("cc-direct");
  });
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
