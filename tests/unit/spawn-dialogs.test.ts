import { describe, test, expect } from "bun:test";
import {
  classifyStartupScreen,
  createDialogWatcher,
  parseMenuLine,
  type DialogKey,
  type DialogWatchTiming,
} from "../../broker/spawn-dialogs.ts";

// The startup-dialog answerer: the pure screen classifier, and the polling
// state machine driven by a fake clock + canned capture-pane screens.

const trustScreen = (cursorOnYes = false, eol = "\n") =>
  [
    "────────────────────────────────────────────────────────────────────────",
    " Accessing workspace:",
    "",
    " C:\\Users\\mtaka\\Codes\\plumbdata\\discussion-tree",
    "",
    " Quick safety check: Is this a project you created or one you trust? (Like your",
    " own code, a well-known open source project, or work from your team). If not,",
    " take a moment to review what's in this folder first.",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " Security guide",
    "",
    cursorOnYes ? "   No, exit" : " ❯ No, exit",
    cursorOnYes ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
    "",
  ].join(eol);

const devChannelsScreen = (cursor: 1 | 2 = 1, eol = "\n") =>
  [
    "╭──────────────────────────────────────────────────────────────────────╮",
    "│ WARNING: Loading development channels                                │",
    "│                                                                      │",
    "│ --dangerously-load-development-channels is for local channel         │",
    "│ development only. Do not use this option to run channels you have    │",
    "│ downloaded off the internet.                                         │",
    "│                                                                      │",
    "│ Please use --channels to run a list of approved channels.            │",
    "│                                                                      │",
    "│ Channels: server:plugin:discussion-tree:discussion-tree              │",
    "│                                                                      │",
    `│ ${cursor === 1 ? "❯" : " "} 1. I am using this for local development                        │`,
    `│ ${cursor === 2 ? "❯" : " "} 2. Exit                                                          │`,
    "╰──────────────────────────────────────────────────────────────────────╯",
    "   Enter to confirm · Esc to cancel",
  ].join(eol);

const bypassScreen = (cursorOnYes = false, eol = "\n") =>
  [
    "╭──────────────────────────────────────────────────────────────────────╮",
    "│ WARNING: Claude Code running in Bypass Permissions mode              │",
    "│                                                                      │",
    "│ In Bypass Permissions mode, Claude Code will not ask for your        │",
    "│ approval before running potentially dangerous commands.              │",
    "│ This mode should only be used in a sandboxed container/VM that has   │",
    "│ restricted internet access and can easily be restored if damaged.    │",
    "│                                                                      │",
    "│ By proceeding, you accept all responsibility for actions taken while │",
    "│ running in Bypass Permissions mode.                                  │",
    "│                                                                      │",
    "│ https://code.claude.com/docs/en/security                             │",
    "│                                                                      │",
    `│ ${cursorOnYes ? " " : "❯"} No, exit                                                          │`,
    `│ ${cursorOnYes ? "❯" : " "} Yes, I accept                                                     │`,
    "╰──────────────────────────────────────────────────────────────────────╯",
    "   Enter to confirm · Esc to cancel",
  ].join(eol);

const readyScreen = [
  " ▐▛███▜▌   Claude Code",
  "▝▜█████▛▘  Opus · Claude Max",
  "",
  "────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

describe("parseMenuLine", () => {
  test("strips box borders, cursor, numbering and a trailing check mark", () => {
    expect(parseMenuLine("│ ❯ 1. I am using this for local development   │")).toEqual({
      pointer: true,
      label: "I am using this for local development",
    });
    expect(parseMenuLine("│   2. Exit    │")).toEqual({ pointer: false, label: "Exit" });
    expect(parseMenuLine(" ❯ No, exit")).toEqual({ pointer: true, label: "No, exit" });
    expect(parseMenuLine("  > Yes, I accept")).toEqual({ pointer: true, label: "Yes, I accept" });
    expect(parseMenuLine(" › 2) Yes, I accept ✔")).toEqual({
      pointer: true,
      label: "Yes, I accept",
    });
    expect(parseMenuLine("❯ ")).toEqual({ pointer: true, label: "" });
  });
});

describe("classifyStartupScreen: folder trust", () => {
  test("cursor on the default 'No, exit' -> Down only (Enter waits for a re-read)", () => {
    expect(classifyStartupScreen(trustScreen(false))).toEqual({
      type: "keys",
      dialog: "trust",
      keys: ["Down"],
    });
  });

  test("cursor on 'Yes, I trust this folder' -> Enter", () => {
    expect(classifyStartupScreen(trustScreen(true))).toEqual({
      type: "keys",
      dialog: "trust",
      keys: ["Enter"],
    });
  });

  test("CRLF and numbered options read the same", () => {
    expect(classifyStartupScreen(trustScreen(false, "\r\n"))).toMatchObject({
      keys: ["Down"],
    });
    const numbered = trustScreen(true)
      .replace("   No, exit", "   1. No, exit")
      .replace("❯ Yes, I trust this folder", "❯ 2. Yes, I trust this folder");
    expect(classifyStartupScreen(numbered)).toMatchObject({ keys: ["Enter"] });
  });

  test("the 'continue without these permissions' variant still picks Yes", () => {
    const screen = trustScreen(false).replace(
      " ❯ No, exit",
      " ❯ No, continue without these permissions",
    );
    expect(classifyStartupScreen(screen)).toMatchObject({ dialog: "trust", keys: ["Down"] });
  });

  test("Yes listed first with the cursor below it -> Up", () => {
    const screen = [
      " Accessing workspace:",
      "   Yes, I trust this folder",
      " ❯ No, exit",
    ].join("\n");
    expect(classifyStartupScreen(screen)).toEqual({
      type: "keys",
      dialog: "trust",
      keys: ["Up"],
    });
  });

  test("half-rendered (no cursor yet / Yes not drawn yet) -> wait", () => {
    expect(
      classifyStartupScreen(trustScreen(false).replace(" ❯ No, exit", "   No, exit")),
    ).toMatchObject({ type: "wait", dialog: "trust" });
    expect(
      classifyStartupScreen(
        trustScreen(false).replace("   Yes, I trust this folder", ""),
      ),
    ).toMatchObject({ type: "wait", dialog: "trust" });
  });

  test("ANSI escapes in the capture are ignored", () => {
    const colored = trustScreen(true).replace(
      " ❯ Yes, I trust this folder",
      " \x1b[36m❯ Yes, I trust this folder\x1b[39m",
    );
    expect(classifyStartupScreen(colored)).toMatchObject({ keys: ["Enter"] });
  });
});

describe("classifyStartupScreen: development channels", () => {
  test("default cursor on option 1 -> Enter", () => {
    expect(classifyStartupScreen(devChannelsScreen(1))).toEqual({
      type: "keys",
      dialog: "dev_channels",
      keys: ["Enter"],
    });
  });

  test("cursor on '2. Exit' -> Up (never Enter)", () => {
    expect(classifyStartupScreen(devChannelsScreen(2, "\r\n"))).toEqual({
      type: "keys",
      dialog: "dev_channels",
      keys: ["Up"],
    });
  });

  test("unnumbered options work too", () => {
    const screen = devChannelsScreen(1).replace("1. ", "").replace("2. ", "");
    expect(classifyStartupScreen(screen)).toMatchObject({ keys: ["Enter"] });
  });
});

describe("classifyStartupScreen: bypass permissions", () => {
  test("default cursor on 'No, exit' -> Down", () => {
    expect(classifyStartupScreen(bypassScreen(false))).toEqual({
      type: "keys",
      dialog: "bypass",
      keys: ["Down"],
    });
  });

  test("cursor on 'Yes, I accept' -> Enter (CRLF)", () => {
    expect(classifyStartupScreen(bypassScreen(true, "\r\n"))).toEqual({
      type: "keys",
      dialog: "bypass",
      keys: ["Enter"],
    });
  });

  test("a stale trust dialog above it doesn't confuse the menu", () => {
    const screen = trustScreen(true) + "\n" + bypassScreen(false);
    expect(classifyStartupScreen(screen)).toMatchObject({
      dialog: "bypass",
      keys: ["Down"],
    });
  });
});

describe("classifyStartupScreen: everything else", () => {
  test("claude's input prompt -> ready", () => {
    expect(classifyStartupScreen(readyScreen)).toEqual({ type: "ready" });
    expect(classifyStartupScreen("❯ \n  ? for shortcuts")).toEqual({ type: "ready" });
  });

  test("blank / shell noise -> none", () => {
    expect(classifyStartupScreen("")).toEqual({ type: "none" });
    expect(classifyStartupScreen("PowerShell 7.5.0\r\nLoading personal profile...")).toEqual({
      type: "none",
    });
  });

  test("an unrecognised menu dialog -> unknown_dialog, never keys", () => {
    const screen = [
      " New MCP server found in .mcp.json: foo",
      "",
      " ❯ 1. Use this and all future MCP servers in this project",
      "   2. Use this MCP server",
      "   3. Continue without using this MCP server",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    const r = classifyStartupScreen(screen);
    expect(r.type).toBe("unknown_dialog");
    expect((r as any).excerpt).toContain("New MCP server");
  });

  test("an empty input line plus a hint is not a dialog", () => {
    expect(classifyStartupScreen("❯ \n Esc to cancel")).toEqual({ type: "none" });
  });
});

// --- the watcher -------------------------------------------------------------

const timing: DialogWatchTiming = {
  pollMs: 1000,
  timeoutMs: 60_000,
  settleMs: 15_000,
  retryMs: 5_000,
  maxCaptureFailures: 3,
};

// A fake pane: each key changes the screen the way claude would.
function fakePane(initial: string | null, react: (screen: string | null, key: DialogKey) => string | null) {
  let screen = initial;
  const sent: DialogKey[] = [];
  const logs: string[] = [];
  return {
    io: {
      capture: () => screen,
      sendKey: (k: DialogKey) => {
        sent.push(k);
        screen = react(screen, k);
      },
      log: (m: string) => logs.push(m),
    },
    sent,
    logs,
    set: (s: string | null) => {
      screen = s;
    },
  };
}

function runUntilDone(w: ReturnType<typeof createDialogWatcher>, maxSteps = 200) {
  for (let i = 1; i <= maxSteps; i++) {
    const r = w.step(i * timing.pollMs);
    if (r) return { r, steps: i };
  }
  throw new Error("watcher never finished");
}

describe("createDialogWatcher", () => {
  test("trust -> bypass -> dev channels -> prompt, answering each correctly", () => {
    const pane = fakePane(trustScreen(false), (s, k) => {
      if (s === trustScreen(false) && k === "Down") return trustScreen(true);
      if (s === trustScreen(true) && k === "Enter") return bypassScreen(false);
      if (s === bypassScreen(false) && k === "Down") return bypassScreen(true);
      if (s === bypassScreen(true) && k === "Enter") return devChannelsScreen(1);
      if (s === devChannelsScreen(1) && k === "Enter") return readyScreen;
      throw new Error(`unexpected ${k} on screen`);
    });
    const { r } = runUntilDone(createDialogWatcher(pane.io, timing, 0));
    expect(r).toEqual({ outcome: "ready", answered: ["trust", "bypass", "dev_channels"] });
    expect(pane.sent).toEqual(["Down", "Enter", "Down", "Enter", "Enter"]);
  });

  test("an unchanged screen after keys is not re-keyed until retryMs, then retried", () => {
    // The pane ignores keys (they got lost).
    const pane = fakePane(devChannelsScreen(1), (s) => s);
    const w = createDialogWatcher(pane.io, timing, 0);
    w.step(1000);
    expect(pane.sent).toEqual(["Enter"]);
    for (let t = 2000; t < 6000; t += 1000) w.step(t);
    expect(pane.sent).toEqual(["Enter"]);
    w.step(6000);
    expect(pane.sent).toEqual(["Enter", "Enter"]);
  });

  test("an unknown dialog is logged once and never answered; times out", () => {
    const unknown = " Something new\n ❯ 1. Maybe\n   2. Perhaps\n Enter to confirm · Esc to cancel";
    const pane = fakePane(unknown, () => {
      throw new Error("must not send keys");
    });
    const { r } = runUntilDone(createDialogWatcher(pane.io, timing, 0));
    expect(r).toEqual({ outcome: "timeout", answered: [] });
    expect(pane.sent).toEqual([]);
    expect(pane.logs.filter((l) => l.startsWith("unrecognised dialog")).length).toBe(1);
  });

  test("a blank screen keeps waiting (claude still starting), then times out", () => {
    const pane = fakePane("", (s) => s);
    const { r, steps } = runUntilDone(createDialogWatcher(pane.io, timing, 0));
    expect(r.outcome).toBe("timeout");
    expect(steps).toBe(60);
  });

  test("a non-blank screen with no dialog settles after settleMs", () => {
    const pane = fakePane("some output\nstill no recognised prompt", (s) => s);
    const { r, steps } = runUntilDone(createDialogWatcher(pane.io, timing, 0));
    expect(r.outcome).toBe("settled");
    // First quiet poll at t=1000; settled at t=16000.
    expect(steps).toBe(16);
  });

  test("a dialog showing up mid-settle resets the settle timer", () => {
    const pane = fakePane("loading...", (s, k) =>
      k === "Enter" ? readyScreen : s,
    );
    const w = createDialogWatcher(pane.io, timing, 0);
    for (let t = 1000; t <= 10_000; t += 1000) expect(w.step(t)).toBeNull();
    pane.set(devChannelsScreen(1));
    expect(w.step(11_000)).toBeNull();
    expect(w.step(12_000)).toEqual({ outcome: "ready", answered: ["dev_channels"] });
  });

  test("repeated capture failures end the watch as gone", () => {
    const pane = fakePane(null, (s) => s);
    const { r, steps } = runUntilDone(createDialogWatcher(pane.io, timing, 0));
    expect(r.outcome).toBe("gone");
    expect(steps).toBe(3);
  });

  test("the prompt already up on the first poll -> ready with nothing sent", () => {
    const pane = fakePane(readyScreen, () => {
      throw new Error("must not send keys");
    });
    expect(runUntilDone(createDialogWatcher(pane.io, timing, 0)).r).toEqual({
      outcome: "ready",
      answered: [],
    });
  });
});
