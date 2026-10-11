// Answers Claude Code's startup dialogs in a freshly spawned tmux/psmux pane by
// READING the screen, instead of pressing Enter blindly.
//
// Blind Enter is wrong because Enter confirms whatever option is highlighted,
// and two of the dialogs highlight the destructive choice by default:
//
//   folder trust      "Accessing workspace: ... Quick safety check ..."
//                     ❯ No, exit  /  Yes, I trust this folder      -> want Yes
//   bypass mode       "WARNING: Claude Code running in Bypass Permissions mode"
//                     ❯ No, exit  /  Yes, I accept                 -> want Yes
//   dev channels      "WARNING: Loading development channels"
//                     ❯ 1. I am using this for local development / 2. Exit
//                                                                   -> want 1
//
// (Wording taken from the Claude Code binary: the trust and bypass menus are
// rendered cancel-first with the focus on cancel and no indexes; the dev-channels
// menu is confirm-first with indexes. The trust menu's cancel label becomes
// "No, continue without these permissions" in one variant.)
//
// The flow: poll `capture-pane -p` about once a second, classify the screen with
// the pure classifyStartupScreen(), and for a recognised dialog move the "❯"
// cursor onto the wanted option with Down/Up — then, on a LATER poll that shows
// the cursor really sits on the wanted line, press Enter. An unrecognised dialog
// is logged and left alone (never guessed at). Escape is never sent: it cancels
// these dialogs, i.e. exits claude.

export type StartupDialogKind = "trust" | "bypass" | "dev_channels";
export type DialogKey = "Down" | "Up" | "Enter";

export type ScreenAction =
  // A known dialog is up; send these keys (each as its own send-keys call).
  | { type: "keys"; dialog: StartupDialogKind; keys: DialogKey[] }
  // A known dialog is up but its menu can't be read yet (half-rendered, no
  // cursor found, or the wanted option is missing): wait for the next poll.
  | { type: "wait"; dialog: StartupDialogKind; reason: string }
  // Something that looks like a selection dialog, but not one we know.
  | { type: "unknown_dialog"; excerpt: string }
  // claude's normal input prompt is up.
  | { type: "ready" }
  // Nothing recognisable (blank screen, shell still starting, ...).
  | { type: "none" };

interface DialogSpec {
  kind: StartupDialogKind;
  // The dialog is present when a line matches one of these; its menu is looked
  // for at/after the first such line.
  markers: RegExp[];
  // Every option label the menu may show (exact text after stripping the
  // cursor, numbering and box borders).
  options: string[];
  want: string;
}

const DIALOGS: DialogSpec[] = [
  {
    kind: "trust",
    markers: [/Accessing workspace/i, /Quick safety check/i, /Yes, I trust this folder/],
    options: [
      "No, exit",
      "No, continue without these permissions",
      "Yes, I trust this folder",
    ],
    want: "Yes, I trust this folder",
  },
  {
    kind: "bypass",
    markers: [/Bypass Permissions mode/i],
    options: ["No, exit", "Yes, I accept"],
    want: "Yes, I accept",
  },
  {
    kind: "dev_channels",
    markers: [/Loading development channels/i, /--dangerously-load-development-channels is for/],
    options: ["I am using this for local development", "Exit"],
    want: "I am using this for local development",
  },
];

// Footer text of claude's normal input prompt.
const READY_MARKERS = [/\? for shortcuts/, /bypass permissions on/i, /shift\+tab to cycle/i];
// Footer / hint text of a selection dialog in general.
const GENERIC_DIALOG_MARKERS = [
  /Enter to confirm/i,
  /Esc to cancel/i,
  /Esc to exit/i,
  /Enter to select/i,
  /Do you want to proceed\?/i,
];

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

export function splitScreen(screen: string): string[] {
  return screen.replace(ANSI, "").split(/\r\n|\r|\n/);
}

interface ParsedLine {
  pointer: boolean;
  label: string;
}

// "│ ❯ 1. I am using this for local development   │" -> pointer + label.
export function parseMenuLine(line: string): ParsedLine {
  let s = line.replace(/^[\s│┃|]+/, "").replace(/[\s│┃|]+$/, "");
  let pointer = false;
  // Cursor glyph: "❯" is what claude draws; "›" / ">" are the usual fallbacks
  // when a terminal font lacks it.
  const m = s.match(/^([❯›>])\s*/);
  if (m) {
    pointer = true;
    s = s.slice(m[0].length);
  }
  s = s.replace(/^\d+[.)]\s+/, "");
  // A trailing check mark marks the currently-saved choice in some menus.
  s = s.replace(/\s+[✔✓]$/, "").trim();
  return { pointer, label: s };
}

function classifyDialog(
  lines: string[],
  spec: DialogSpec,
): { start: number; action: ScreenAction } | null {
  const start = lines.findIndex((l) => spec.markers.some((re) => re.test(l)));
  if (start < 0) return null;
  // Option lines at/after the marker, in screen order. Exact label match, so
  // "Exit" never matches "No, exit" and prose mentioning an option doesn't count.
  const menu: { line: number; label: string; pointer: boolean }[] = [];
  for (let i = start; i < lines.length; i++) {
    const p = parseMenuLine(lines[i]!);
    if (spec.options.includes(p.label)) menu.push({ line: i, ...p });
  }
  const wantIdx = menu.findIndex((o) => o.label === spec.want);
  if (wantIdx < 0) {
    return {
      start,
      action: { type: "wait", dialog: spec.kind, reason: `option "${spec.want}" not visible` },
    };
  }
  const cursors = menu.flatMap((o, i) => (o.pointer ? [i] : []));
  if (cursors.length !== 1) {
    return {
      start,
      action: {
        type: "wait",
        dialog: spec.kind,
        reason: cursors.length ? "more than one cursor line" : "no cursor line",
      },
    };
  }
  const delta = wantIdx - cursors[0]!;
  const keys: DialogKey[] =
    delta === 0
      ? ["Enter"]
      : Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"));
  return { start, action: { type: "keys", dialog: spec.kind, keys } };
}

// Pure: screen text (as printed by `capture-pane -p`) -> what to do about it.
//
// When the cursor is not on the wanted option, only the Down/Up moves are
// returned — Enter comes from a later call that sees the cursor on the wanted
// line. That way Enter is only ever sent after the screen has confirmed the
// highlight, never on a prediction of where it will land.
export function classifyStartupScreen(screen: string): ScreenAction {
  const lines = splitScreen(screen);
  // Several known dialogs on one screen (a stale one not yet erased above the
  // current one) -> the lowest, i.e. most recently drawn, wins.
  let best: { start: number; action: ScreenAction } | null = null;
  for (const spec of DIALOGS) {
    const r = classifyDialog(lines, spec);
    if (r && (!best || r.start > best.start)) best = r;
  }
  if (best) return best.action;
  const text = lines.join("\n");
  if (GENERIC_DIALOG_MARKERS.some((re) => re.test(text))) {
    // Only a menu (a cursor on a non-empty option) makes it a dialog; an empty
    // "❯ " is claude's own input line.
    const hasMenu = lines.some((l) => {
      const p = parseMenuLine(l);
      return p.pointer && p.label !== "";
    });
    if (hasMenu) {
      return { type: "unknown_dialog", excerpt: excerpt(lines) };
    }
  }
  if (READY_MARKERS.some((re) => re.test(text))) return { type: "ready" };
  return { type: "none" };
}

function excerpt(lines: string[]): string {
  return lines
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-12)
    .join(" | ")
    .slice(0, 600);
}

// --- the polling loop --------------------------------------------------------

export interface DialogWatchTiming {
  // Poll interval.
  pollMs: number;
  // Give up after this long in total.
  timeoutMs: number;
  // Stop once a non-blank screen has shown no dialog for this long (claude is
  // up, but its prompt footer wasn't recognised).
  settleMs: number;
  // After sending keys, don't act again on an identical screen for this long
  // (the keys may still be in flight); then assume they were lost and retry.
  retryMs: number;
  // Stop after this many consecutive capture failures (the pane is gone).
  maxCaptureFailures: number;
}

export const DEFAULT_DIALOG_TIMING: DialogWatchTiming = {
  pollMs: 1000,
  timeoutMs: 60_000,
  settleMs: 15_000,
  retryMs: 5_000,
  maxCaptureFailures: 5,
};

export type DialogWatchOutcome = "ready" | "settled" | "timeout" | "gone";

export interface DialogWatchResult {
  outcome: DialogWatchOutcome;
  // Dialogs that got an Enter, in order.
  answered: StartupDialogKind[];
}

export interface DialogWatchIO {
  // `capture-pane -p` output, or null when the capture failed.
  capture: () => string | null;
  sendKey: (key: DialogKey) => void;
  log: (msg: string) => void;
}

// One poll at a time, driven by the caller's clock, so tests can step it
// without timers. step() returns the result once the watch is over.
export function createDialogWatcher(
  io: DialogWatchIO,
  timing: DialogWatchTiming,
  startedAt: number,
) {
  const answered: StartupDialogKind[] = [];
  let failures = 0;
  let quietSince: number | null = null;
  let lastActed: { screen: string; at: number } | null = null;
  let lastUnknown: string | null = null;
  let done: DialogWatchResult | null = null;

  const finish = (outcome: DialogWatchOutcome) => {
    done = { outcome, answered: [...answered] };
    return done;
  };

  function step(now: number): DialogWatchResult | null {
    if (done) return done;
    if (now - startedAt >= timing.timeoutMs) {
      io.log(`gave up after ${timing.timeoutMs}ms`);
      return finish("timeout");
    }
    const screen = io.capture();
    if (screen === null) {
      failures++;
      if (failures >= timing.maxCaptureFailures) {
        io.log("pane capture keeps failing; the session is probably gone");
        return finish("gone");
      }
      return null;
    }
    failures = 0;
    const action = classifyStartupScreen(screen);

    if (action.type === "keys") {
      quietSince = null;
      if (lastActed && lastActed.screen === screen && now - lastActed.at < timing.retryMs) {
        return null; // our previous keys haven't shown up yet
      }
      for (const k of action.keys) io.sendKey(k);
      lastActed = { screen, at: now };
      if (action.keys.includes("Enter")) {
        answered.push(action.dialog);
        io.log(`answered the ${action.dialog} dialog`);
      }
      return null;
    }
    if (action.type === "wait") {
      quietSince = null;
      return null;
    }
    if (action.type === "unknown_dialog") {
      quietSince = null;
      if (action.excerpt !== lastUnknown) {
        lastUnknown = action.excerpt;
        io.log(`unrecognised dialog, leaving it alone: ${action.excerpt}`);
      }
      return null;
    }
    if (action.type === "ready") return finish("ready");
    // "none": a blank screen means claude hasn't drawn yet; anything else
    // counts toward settling.
    if (screen.trim() === "") {
      quietSince = null;
      return null;
    }
    if (quietSince === null) quietSince = now;
    if (now - quietSince >= timing.settleMs) return finish("settled");
    return null;
  }

  return { step };
}

// Run a watcher on timers in the background. Never throws; resolves with the
// result (the caller doesn't have to wait for it).
export function runDialogWatcher(
  io: DialogWatchIO,
  timing: DialogWatchTiming = DEFAULT_DIALOG_TIMING,
): Promise<DialogWatchResult> {
  const watcher = createDialogWatcher(io, timing, Date.now());
  return new Promise((resolve) => {
    const tick = () => {
      let r: DialogWatchResult | null;
      try {
        r = watcher.step(Date.now());
      } catch (e) {
        io.log(`watcher error: ${e instanceof Error ? e.message : String(e)}`);
        r = { outcome: "gone", answered: [] };
      }
      if (r) resolve(r);
      else setTimeout(tick, timing.pollMs);
    };
    setTimeout(tick, timing.pollMs);
  });
}
