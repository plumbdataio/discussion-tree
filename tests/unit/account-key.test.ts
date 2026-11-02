import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  accountKey,
  globalConfigFile,
  oauthAccountKey,
} from "../../scripts/cc-context-report-hook.ts";

// The usage-limit account key groups 5h / 7d reports by subscription. It comes
// from the logged-in account recorded in Claude Code's global config file, so
// two config dirs on the same login share one key, and falls back to the config
// dir when no login is recorded there.

const dirs: string[] = [];
function configDirWith(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-acct-"));
  dirs.push(dir);
  if (content !== null) fs.writeFileSync(path.join(dir, ".claude.json"), content);
  return dir;
}

function login(org: unknown, acct: unknown): string {
  return JSON.stringify({
    projects: {},
    oauthAccount: { organizationUuid: org, accountUuid: acct, emailAddress: "a@b" },
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("globalConfigFile", () => {
  test("inside CLAUDE_CONFIG_DIR when set", () => {
    expect(globalConfigFile({ CLAUDE_CONFIG_DIR: "/x/.claude-pd" })).toBe(
      path.join("/x/.claude-pd", ".claude.json"),
    );
  });

  test("~/.claude.json when unset or empty", () => {
    const home = path.join(os.homedir(), ".claude.json");
    expect(globalConfigFile({})).toBe(home);
    expect(globalConfigFile({ CLAUDE_CONFIG_DIR: "" })).toBe(home);
  });
});

describe("accountKey", () => {
  test("uses organizationUuid + accountUuid when recorded", () => {
    const dir = configDirWith(login("org-1", "acct-1"));
    expect(accountKey({ CLAUDE_CONFIG_DIR: dir })).toBe("oauth:org-1:acct-1");
  });

  test("two config dirs on the same login share one key", () => {
    const a = configDirWith(login("org-1", "acct-1"));
    const b = configDirWith(login("org-1", "acct-1"));
    expect(accountKey({ CLAUDE_CONFIG_DIR: a })).toBe(
      accountKey({ CLAUDE_CONFIG_DIR: b }),
    );
  });

  test("same account in another organization is a different key", () => {
    const a = configDirWith(login("org-1", "acct-1"));
    const b = configDirWith(login("org-2", "acct-1"));
    expect(accountKey({ CLAUDE_CONFIG_DIR: a })).not.toBe(
      accountKey({ CLAUDE_CONFIG_DIR: b }),
    );
  });

  test("key carries only the two ids, nothing else from the file", () => {
    const dir = configDirWith(login("org-1", "acct-1"));
    expect(accountKey({ CLAUDE_CONFIG_DIR: dir })).not.toContain("a@b");
  });

  test("falls back to the config dir when the file is missing", () => {
    const dir = configDirWith(null);
    expect(accountKey({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
  });

  test("falls back when the file is malformed", () => {
    const dir = configDirWith("{not json");
    expect(accountKey({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
  });

  test("falls back when no login is recorded (e.g. API-key use)", () => {
    const dir = configDirWith(JSON.stringify({ projects: {} }));
    expect(accountKey({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
  });

  test("falls back when either id is missing, empty or not a string", () => {
    for (const [org, acct] of [
      ["org-1", undefined],
      [undefined, "acct-1"],
      ["", "acct-1"],
      ["org-1", 42],
    ]) {
      const dir = configDirWith(login(org, acct));
      expect(accountKey({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
    }
  });
});

describe("oauthAccountKey", () => {
  test("null for a path that does not exist", () => {
    expect(oauthAccountKey(path.join(os.tmpdir(), "dt-acct-none", ".claude.json"))).toBeNull();
  });
});
