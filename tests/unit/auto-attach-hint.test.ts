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
const nowSec = () => Math.floor(Date.now() / 1000);

afterEach(() => {
  try {
    fs.rmSync(hintFilePath());
  } catch {
    /* not every test writes one */
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

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
