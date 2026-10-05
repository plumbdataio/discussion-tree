import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { SpawnConfig } from "../../broker/spawn.ts";

// The spawner's platform-dependent parts: the claude launch argv (POSIX login
// shell vs Windows PowerShell), new-mode cwd validation, and the actual tmux
// calls handleSpawnSession makes. The platform is injected, so the win32 path
// (psmux + PowerShell) is exercised on any host. The tmux binary is a fake
// script that records its argv, so no real tmux session is ever created.

// spawn.ts opens the broker DB at import time; point it at a throwaway file
// BEFORE importing, and refuse to touch the DB at all if some earlier import
// already bound it elsewhere (the integration tests below write rows).
const scratch = fs.mkdtempSync(path.join(tmpdir(), "dt-spawn-launch-"));
const dbPath = path.join(scratch, "db.sqlite");
const prevDb = process.env.DISCUSSION_TREE_DB;
const prevHome = process.env.DISCUSSION_TREE_HOME;
process.env.DISCUSSION_TREE_DB = dbPath;
process.env.DISCUSSION_TREE_HOME = scratch;
const config = await import("../../broker/config.ts");
const { db } = await import("../../broker/db.ts");
const spawn = await import("../../broker/spawn.ts");
const { defaultSessionName } = await import("../../broker/spawn-names.ts");
if (prevDb === undefined) delete process.env.DISCUSSION_TREE_DB;
else process.env.DISCUSSION_TREE_DB = prevDb;
if (prevHome === undefined) delete process.env.DISCUSSION_TREE_HOME;
else process.env.DISCUSSION_TREE_HOME = prevHome;
const dbIsScratch = config.DB_PATH === dbPath;

const {
  buildLaunchArgv,
  buildPowerShellScript,
  quotePowerShellArg,
  encodePowerShellCommand,
  resolveNewCwd,
  handleSpawnSession,
} = spawn;

const cfg = (over: Partial<SpawnConfig> = {}): SpawnConfig => ({
  base_args: [
    "--dangerously-skip-permissions",
    "--dangerously-load-development-channels",
    "server:plugin:discussion-tree:discussion-tree",
  ],
  shell: "",
  tmux_bin: "tmux",
  enter_count: 0,
  enter_interval_ms: 5000,
  ...over,
});

const decodeEncoded = (b64: string) =>
  Buffer.from(b64, "base64").toString("utf16le");

describe("buildLaunchArgv: darwin (unchanged POSIX form)", () => {
  test("exactly <shell> -ic 'claude \"$@\"' <shell> <flags...> <extra...>", () => {
    const argv = buildLaunchArgv("darwin", cfg(), ["-r", "abc-123"], {
      env: { SHELL: "/bin/zsh" },
    });
    expect(argv).toEqual([
      "/bin/zsh",
      "-ic",
      'claude "$@"',
      "/bin/zsh",
      "--dangerously-skip-permissions",
      "--dangerously-load-development-channels",
      "server:plugin:discussion-tree:discussion-tree",
      "-r",
      "abc-123",
    ]);
  });

  test("$SHELL default, /bin/zsh fallback, configured shell wins", () => {
    const c = cfg({ base_args: ["--x"] });
    expect(buildLaunchArgv("darwin", c, [], { env: { SHELL: "/opt/fish" } })).toEqual(
      ["/opt/fish", "-ic", 'claude "$@"', "/opt/fish", "--x"],
    );
    expect(buildLaunchArgv("darwin", c, [], { env: {} })).toEqual([
      "/bin/zsh",
      "-ic",
      'claude "$@"',
      "/bin/zsh",
      "--x",
    ]);
    expect(
      buildLaunchArgv("darwin", cfg({ base_args: ["--x"], shell: " /bin/bash " }), [], {
        env: { SHELL: "/bin/zsh" },
      }),
    ).toEqual(["/bin/bash", "-ic", 'claude "$@"', "/bin/bash", "--x"]);
  });

  test("hostile flags stay verbatim positional params (never shell code)", () => {
    const evil = ["a b", "it's", "$(rm -rf ~)", "x; y", '"q"'];
    const argv = buildLaunchArgv("darwin", cfg({ base_args: evil }), [], {
      env: { SHELL: "/bin/zsh" },
    });
    expect(argv.slice(4)).toEqual(evil);
    expect(argv[2]).toBe('claude "$@"');
  });
});

describe("buildLaunchArgv: win32 (PowerShell)", () => {
  const which =
    (found: Record<string, string>) => (cmd: string) => found[cmd] ?? null;

  test("pwsh -NoLogo -EncodedCommand <b64 of & claude 'flag' ...>", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const argv = buildLaunchArgv("win32", cfg(), ["-r", "abc-123"], {
      which: which({ pwsh, powershell: "C:\\Windows\\powershell.exe" }),
    });
    expect(argv.length).toBe(4);
    // The bare name, not the found path: a space in "C:\\Program Files\\..."
    // is what an argv join on the way to CreateProcess could mangle.
    expect(argv.slice(0, 3)).toEqual(["pwsh", "-NoLogo", "-EncodedCommand"]);
    // Base64 only: nothing a Windows command-line join / cmd.exe could mangle.
    expect(argv[3]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeEncoded(argv[3]!)).toBe(
      "& claude '--dangerously-skip-permissions' " +
        "'--dangerously-load-development-channels' " +
        "'server:plugin:discussion-tree:discussion-tree' '-r' 'abc-123'",
    );
    // No -NoProfile: the user's profile (PATH tweaks, a claude wrapper) applies.
    expect(argv).not.toContain("-NoProfile");
  });

  test("falls back to Windows PowerShell, then to powershell.exe by name", () => {
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(
      buildLaunchArgv("win32", cfg(), [], { which: which({ powershell: ps }) })[0],
    ).toBe("powershell");
    expect(buildLaunchArgv("win32", cfg(), [], { which: which({}) })[0]).toBe(
      "powershell.exe",
    );
  });

  test("a configured shell overrides the lookup; $SHELL is ignored", () => {
    const argv = buildLaunchArgv("win32", cfg({ shell: "D:\\tools\\pwsh.exe" }), [], {
      which: which({ pwsh: "C:\\pwsh.exe" }),
      env: { SHELL: "/usr/bin/bash" },
    });
    expect(argv[0]).toBe("D:\\tools\\pwsh.exe");
    expect(argv[1]).toBe("-NoLogo");
  });

  test("no flags at all still yields a valid script", () => {
    const argv = buildLaunchArgv("win32", cfg({ base_args: [] }), [], {
      which: which({ pwsh: "pwsh.exe" }),
    });
    expect(decodeEncoded(argv[3]!)).toBe("& claude");
  });

  test("hostile flags become inert single-quoted literals", () => {
    const flags = [
      "--append-system-prompt",
      "say \"hi\" to $env:USERNAME; Remove-Item C:\\ -Recurse",
      "it's",
      "`n$(whoami)",
      "a & b | c",
      "\u2019smart\u2018",
    ];
    const argv = buildLaunchArgv("win32", cfg({ base_args: flags }), [], {
      which: which({ pwsh: "pwsh.exe" }),
    });
    expect(decodeEncoded(argv[3]!)).toBe(
      "& claude '--append-system-prompt' " +
        "'say \"hi\" to $env:USERNAME; Remove-Item C:\\ -Recurse' " +
        "'it''s' " +
        "'`n$(whoami)' " +
        "'a & b | c' " +
        "'\u2019\u2019smart\u2018\u2018'",
    );
  });
});

describe("PowerShell quoting helpers", () => {
  test("quotePowerShellArg doubles every single-quote form and nothing else", () => {
    expect(quotePowerShellArg("plain")).toBe("'plain'");
    expect(quotePowerShellArg("")).toBe("''");
    expect(quotePowerShellArg("a b")).toBe("'a b'");
    expect(quotePowerShellArg("it's")).toBe("'it''s'");
    expect(quotePowerShellArg("''")).toBe("''''''");
    expect(quotePowerShellArg('"$x;`y"')).toBe("'\"$x;`y\"'");
    for (const q of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
      expect(quotePowerShellArg(`a${q}b`)).toBe(`'a${q}${q}b'`);
    }
  });

  test("buildPowerShellScript + encodePowerShellCommand round-trip", () => {
    const script = buildPowerShellScript(["-r", "x y"]);
    expect(script).toBe("& claude '-r' 'x y'");
    expect(decodeEncoded(encodePowerShellCommand(script))).toBe(script);
    // Known vector: "dir" in UTF-16LE base64.
    expect(encodePowerShellCommand("dir")).toBe("ZABpAHIA");
  });
});

describe("resolveNewCwd", () => {
  test("darwin: absolute only, ~ expands, error text unchanged", () => {
    expect(resolveNewCwd("/tmp/x", "darwin")).toEqual({ ok: true, cwd: "/tmp/x" });
    expect(resolveNewCwd("  /tmp/x  ", "darwin")).toEqual({ ok: true, cwd: "/tmp/x" });
    const home = resolveNewCwd("~/proj", "darwin");
    expect(home.ok && home.cwd.endsWith("/proj") && home.cwd.startsWith("/")).toBe(
      true,
    );
    expect(resolveNewCwd("", "darwin")).toEqual({ ok: false, error: "cwd required" });
    expect(resolveNewCwd("relative/path", "darwin")).toEqual({
      ok: false,
      error: "cwd must be an absolute path",
    });
    // Windows forms are not absolute on POSIX.
    expect(resolveNewCwd("C:\\Users\\x", "darwin").ok).toBe(false);
  });

  test("win32: drive-letter and UNC paths accepted and normalized", () => {
    expect(resolveNewCwd("C:\\Users\\mtaka\\Codes\\x", "win32")).toEqual({
      ok: true,
      cwd: "C:\\Users\\mtaka\\Codes\\x",
    });
    expect(resolveNewCwd("c:/Users/mtaka/Codes/x", "win32")).toEqual({
      ok: true,
      cwd: "c:\\Users\\mtaka\\Codes\\x",
    });
    expect(resolveNewCwd("D:\\", "win32")).toEqual({ ok: true, cwd: "D:\\" });
    expect(resolveNewCwd("\\\\server\\share\\proj", "win32")).toEqual({
      ok: true,
      cwd: "\\\\server\\share\\proj",
    });
    const home = "C:\\Users\\mtaka";
    expect(resolveNewCwd("~\\proj", "win32", home)).toEqual({
      ok: true,
      cwd: "C:\\Users\\mtaka\\proj",
    });
    expect(resolveNewCwd("~/proj", "win32", home)).toEqual({
      ok: true,
      cwd: "C:\\Users\\mtaka\\proj",
    });
    expect(resolveNewCwd("~", "win32", home)).toEqual({ ok: true, cwd: home });
  });

  test("win32: relative, drive-relative, root-relative and POSIX paths refused", () => {
    for (const bad of ["relative\\x", "C:x", "\\x", "/Users/x", "\\\\server"]) {
      const r = resolveNewCwd(bad, "win32");
      expect(r.ok).toBe(false);
    }
    expect(resolveNewCwd("", "win32")).toEqual({ ok: false, error: "cwd required" });
  });
});

describe("defaultSessionName per platform", () => {
  test("win32 splits on backslash; darwin does not", () => {
    expect(defaultSessionName(null, "C:\\Users\\mtaka\\Codes\\zumenta", "win32")).toBe(
      "zumenta",
    );
    expect(defaultSessionName(null, "C:/a/b/", "win32")).toBe("b");
    expect(defaultSessionName(null, "\\\\srv\\share\\proj\\", "win32")).toBe("proj");
    expect(defaultSessionName(null, "/Users/x/Code/foo", "darwin")).toBe("foo");
    expect(defaultSessionName(null, "/Users/x/a\\b", "darwin")).toBe("a-b");
  });
});

// --- handleSpawnSession against a fake tmux ---------------------------------

const fakeDir = path.join(scratch, "bin");
const logFile = path.join(fakeDir, "tmux.log");
const fakeTmux = path.join(fakeDir, "tmux");

// One record per invocation: args separated by \037, records by \036. It
// answers list-sessions with one taken name (CRLF, as psmux may print) and
// new-session with a window id.
function installFakeTmux() {
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(
    fakeTmux,
    `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a" >> '${logFile}'; done
printf '\\036' >> '${logFile}'
case "$1" in
  list-sessions) printf 'taken\\r\\n'; exit 0 ;;
  new-session) printf '@7\\r\\n'; exit 0 ;;
esac
exit 0
`,
  );
  fs.chmodSync(fakeTmux, 0o755);
}

function calls(): string[][] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\x1e")
    .filter((r) => r.length > 0)
    .map((r) => r.split("\x1f").slice(0, -1));
}

describe.skipIf(!dbIsScratch || process.platform === "win32")(
  "handleSpawnSession with a fake tmux",
  () => {
    beforeAll(() => installFakeTmux());
    afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const reset = () => fs.rmSync(logFile, { force: true });

    test("darwin new: list-sessions, then new-session with the POSIX launch", async () => {
      reset();
      const cwd = path.join(scratch, "work", "proj");
      const r: any = await handleSpawnSession(
        {
          mode: "new",
          cwd,
          tmux_session_name: "taken",
          config: { base_args: ["--a", "b c"], tmux_bin: fakeTmux, enter_count: 0 },
        },
        { platform: "darwin", env: { SHELL: "/bin/zsh" } },
      );
      expect(r).toMatchObject({
        ok: true,
        mode: "new",
        tmux_session: "taken-2",
        session_renamed: true,
        window: "@7",
        cwd,
      });
      expect(fs.statSync(cwd).isDirectory()).toBe(true);
      expect(calls()).toEqual([
        ["list-sessions", "-F", "#{session_name}"],
        [
          "new-session",
          "-d",
          "-s",
          "taken-2",
          "-c",
          cwd,
          "-P",
          "-F",
          "#{window_id}",
          "/bin/zsh",
          "-ic",
          'claude "$@"',
          "/bin/zsh",
          "--a",
          "b c",
        ],
      ]);
    });

    test("win32 new: Windows cwd, PowerShell launch, name from the cwd", async () => {
      reset();
      const ensured: string[] = [];
      const r: any = await handleSpawnSession(
        {
          mode: "new",
          cwd: "C:/Users/mtaka/Codes/zumenta",
          config: {
            base_args: ["--x", "it's $y"],
            tmux_bin: fakeTmux,
            enter_count: 0,
          },
        },
        {
          platform: "win32",
          which: (c) => (c === "pwsh" ? "C:\\pwsh\\pwsh.exe" : null),
          ensureDir: (d) => {
            ensured.push(d);
            return null;
          },
        },
      );
      expect(r).toMatchObject({
        ok: true,
        tmux_session: "zumenta",
        session_renamed: false,
        window: "@7",
        cwd: "C:\\Users\\mtaka\\Codes\\zumenta",
      });
      expect(ensured).toEqual(["C:\\Users\\mtaka\\Codes\\zumenta"]);
      const [list, create] = calls();
      expect(list).toEqual(["list-sessions", "-F", "#{session_name}"]);
      expect(create!.slice(0, 12)).toEqual([
        "new-session",
        "-d",
        "-s",
        "zumenta",
        "-c",
        "C:\\Users\\mtaka\\Codes\\zumenta",
        "-P",
        "-F",
        "#{window_id}",
        "pwsh",
        "-NoLogo",
        "-EncodedCommand",
      ]);
      expect(create!.length).toBe(13);
      expect(decodeEncoded(create![12]!)).toBe("& claude '--x' 'it''s $y'");
    });

    test("win32 new: an ensureDir failure stops before tmux", async () => {
      reset();
      const r: any = await handleSpawnSession(
        {
          mode: "new",
          cwd: "C:\\nope",
          config: { base_args: [], tmux_bin: fakeTmux, enter_count: 0 },
        },
        { platform: "win32", which: () => null, ensureDir: () => "boom" },
      );
      expect(r).toEqual({ ok: false, error: "boom" });
      expect(calls()).toEqual([]);
    });

    test("win32 refuses a POSIX cwd before tmux", async () => {
      reset();
      const r: any = await handleSpawnSession(
        {
          mode: "new",
          cwd: "/Users/x",
          config: { base_args: [], tmux_bin: fakeTmux, enter_count: 0 },
        },
        { platform: "win32", which: () => null, ensureDir: () => null },
      );
      expect(r.ok).toBe(false);
      expect(calls()).toEqual([]);
    });

    test("win32 resume: recorded Windows cwd, -r <id> appended, Enter by window id", async () => {
      reset();
      db.prepare(
        "INSERT INTO sessions (id, pid, cwd, registered_at, last_seen, alive, cc_session_id, name) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      ).run(
        "s-win-1",
        1,
        "C:\\Users\\mtaka\\Codes\\zumenta",
        new Date().toISOString(),
        new Date().toISOString(),
        "cc-win-1",
        "Zumenta work",
      );
      const r: any = await handleSpawnSession(
        {
          mode: "resume",
          resume_cc_session_id: "cc-win-1",
          config: {
            base_args: ["--z"],
            tmux_bin: fakeTmux,
            enter_count: 1,
            enter_interval_ms: 500,
          },
        },
        { platform: "win32", which: () => null },
      );
      expect(r).toMatchObject({
        ok: true,
        mode: "resume",
        tmux_session: "Zumenta-work",
        window: "@7",
        cwd: "C:\\Users\\mtaka\\Codes\\zumenta",
      });
      const create = calls()[1]!;
      expect(create.slice(0, 10)).toEqual([
        "new-session",
        "-d",
        "-s",
        "Zumenta-work",
        "-c",
        "C:\\Users\\mtaka\\Codes\\zumenta",
        "-P",
        "-F",
        "#{window_id}",
        "powershell.exe",
      ]);
      expect(decodeEncoded(create[12]!)).toBe("& claude '--z' '-r' 'cc-win-1'");
      // The startup-dialog Enter goes to the window id new-session printed.
      await Bun.sleep(900);
      expect(calls()[2]).toEqual(["send-keys", "-t", "@7", "Enter"]);
    });
  },
);
