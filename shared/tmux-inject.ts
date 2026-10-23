// Shared tmux command-injection primitives, used by BOTH:
//   - the broker (LOCAL cli-send: the CC's tmux is on the broker's machine), and
//   - the per-CC MCP server (REMOTE cli-send: the broker can't reach the CC's
//     tmux on another machine, so it enqueues and the MCP runs send-keys on its
//     OWN pane).
// Extracted so the proven probe -> C-u -> load-buffer -> paste -> Enter sequence
// has a single home. No shell anywhere: argv only, so the buffer text can never
// be interpreted as a command.

import { spawn } from "node:child_process";

// A CLI command must be a single slash-token (args ride a separate field). The
// command is pasted into the user's OWN CC pane (argv, no shell), so any
// well-formed slash command grants nothing the user couldn't type themselves.
export const CLI_COMMAND_RE = /^\/[A-Za-z0-9][A-Za-z0-9:_-]*$/;
export function isValidCliCommand(command: string): boolean {
  return CLI_COMMAND_RE.test(command);
}

// Run a tmux subprocess (argv -- no shell, so the buffer text can't inject).
// Optionally pipe `input` to stdin (used by load-buffer to carry arbitrary,
// possibly multiline, text without ARG_MAX limits).
//
// node:child_process rather than Bun.spawn: this module is shared by the broker
// (Bun) and the per-CC MCP server, which may run under Node to keep its memory
// floor low. Bun implements node:child_process natively, so the broker's
// behaviour is unchanged.
async function runTmux(
  argv: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number, stdout: string, stderr = "") => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    try {
      const [cmd, ...args] = argv;
      const proc = spawn(cmd!, args, {
        stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr?.on("data", (c: Buffer) => errChunks.push(c));
      // tmux not installed / spawn failed -- treat as "command unavailable" so
      // the caller reports pane_gone rather than 500-ing.
      proc.on("error", (e) => done(127, "", String(e?.message ?? e)));
      proc.on("close", (code) =>
        done(
          code ?? 1,
          Buffer.concat(chunks).toString("utf8"),
          Buffer.concat(errChunks).toString("utf8").trim(),
        ),
      );
      if (input != null && proc.stdin) {
        proc.stdin.on("error", () => {
          /* reported via close/error above */
        });
        proc.stdin.end(input);
      }
    } catch {
      done(127, "");
    }
  });
}

// Shells we must NOT paste a command into -- if the pane's foreground process is
// one of these, Claude has exited and a shell took over (the session row can
// still be alive=1 for up to one watchdog sweep). Pasting "/compact ...\n" there
// would run it as shell input. Allowlisting "claude" is too brittle (the binary
// can present as node etc.), so we denylist shells.
const PANE_SHELLS = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "tcsh",
  "csh",
  "ksh",
  // Windows (psmux): the pane falls back to PowerShell / cmd when Claude exits.
  "pwsh",
  "powershell",
  "cmd",
]);

// psmux (Windows) runs one server per session and numbers panes per server, so
// several sessions can each own a "%2" -- a bare "-t %2" is then rejected as
// "ambiguous pane id" (exit 1, nothing sent). `tmux -S <socket>` does not help:
// psmux ignores it and sees every session. Qualifying the target as
// "<session>:.<pane>" is unique. On real tmux pane ids are server-global and
// `session` is null, so the bare id is kept.
export function paneTarget(pane: string, session?: string | null): string {
  return session ? `${session}:.${pane}` : pane;
}

// Look up the pane: "missing" if the pane id is gone, "shell" if a shell now
// owns it (Claude exited), else "ok". One list-panes call carries both the id
// and its foreground command.
// `session` (psmux only): match the pane id within that session, since the same
// id can exist in several sessions there.
export async function probePane(
  base: string[],
  pane: string,
  session?: string | null,
): Promise<"ok" | "missing" | "shell"> {
  const { code, stdout } = await runTmux([
    ...base,
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{pane_current_command}\t#{session_name}",
  ]);
  if (code !== 0) return "missing";
  for (const line of stdout.split("\n")) {
    const [id, cmd, sess] = line.split("\t");
    if (id?.trim() !== pane) continue;
    if (session && (sess ?? "").trim() !== session) continue;
    const exe = (cmd ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.exe$/, "");
    return PANE_SHELLS.has(exe) ? "shell" : "ok";
  }
  return "missing";
}

// Monotonic buffer-name counter so concurrent injections never share a tmux
// buffer (a shared name + `-d` lets one request paste another's args). Per
// process; broker and MCP each have their own instance, which is all that's
// needed.
let cliSendSeq = 0;

// Delay between the paste and the submit Enter. The CC TUI ingests a bracketed
// paste asynchronously; if Enter arrives before it has settled, the keystroke
// lands inside/before the paste and is dropped -- the text appears but never
// submits. Wait a beat so Enter is a clean, separate submit. Tunable via env.
const CLI_SEND_ENTER_DELAY_MS =
  Number(process.env.DT_CLI_SEND_ENTER_DELAY_MS) || 250;

// Paste the text into the pane as ONE bracketed paste (so a multiline prompt
// arrives intact -- newlines stay input, not submit), then press Enter. Mirrors
// exactly what a human does: paste the /compact block, hit Enter.
// Each tmux step's exit code is checked: a failing step (e.g. psmux's
// "ambiguous pane id") used to be ignored and the inject reported ok.
export type SendFailure = {
  step: string;
  argv: string[];
  code: number;
  stderr: string;
};
export async function sendToPane(
  base: string[],
  pane: string,
  text: string,
): Promise<SendFailure | null> {
  const step = async (
    name: string,
    argv: string[],
    input?: string,
  ): Promise<SendFailure | null> => {
    const r = await runTmux(argv, input);
    return r.code === 0
      ? null
      : { step: name, argv, code: r.code, stderr: r.stderr };
  };
  // Clear whatever is already on the prompt line first (a leftover mouse-report
  // escape tail once turned a paste into a non-slash line). C-u (kill to start
  // of line) rather than C-c: interrupting is not a text operation, and on a
  // busy prompt C-c would cancel the turn. C-u touches only the edited line.
  const clear = await step("send-keys C-u", [
    ...base,
    "send-keys",
    "-t",
    pane,
    "C-u",
  ]);
  if (clear) return clear;
  const buf = `dt-cli-send-${++cliSendSeq}`;
  const load = await step(
    "load-buffer",
    [...base, "load-buffer", "-b", buf, "-"],
    text,
  );
  if (load) return load;
  const paste = await step("paste-buffer", [
    ...base,
    "paste-buffer",
    "-t",
    pane,
    "-b",
    buf,
    "-p",
    "-d",
  ]);
  if (paste) return paste;
  await new Promise((r) => setTimeout(r, CLI_SEND_ENTER_DELAY_MS));
  return step("send-keys Enter", [...base, "send-keys", "-t", pane, "Enter"]);
}

// Build the tmux `base` argv (socket-aware).
// `bin` is the tmux argv prefix; tests pass a fake so no real pane is touched.
export function tmuxBase(
  socket: string | null | undefined,
  bin: string[] = ["tmux"],
): string[] {
  return socket ? [...bin, "-S", socket] : [...bin];
}

// High-level: validate -> probe -> paste. Returns { ok } or { ok:false, error }
// where error is one of "invalid_command" | "pane_gone" | "pane_not_claude" |
// "tmux_failed" (a send step exited non-zero; `failure` says which and why).
// The one place both the local (broker) and remote (MCP) paths funnel through.
// `session` is the psmux session name (see paneTarget); null on real tmux.
export async function injectIntoPane(
  socket: string | null | undefined,
  pane: string,
  command: string,
  args: string,
  session?: string | null,
  tmuxBin?: string[],
): Promise<{ ok: boolean; error?: string; failure?: SendFailure }> {
  if (!isValidCliCommand(command)) {
    return { ok: false, error: "invalid_command" };
  }
  const base = tmuxBase(socket, tmuxBin);
  const probe = await probePane(base, pane, session);
  if (probe === "missing") return { ok: false, error: "pane_gone" };
  if (probe === "shell") return { ok: false, error: "pane_not_claude" };
  const text = args.trim() ? `${command} ${args}` : command;
  const failure = await sendToPane(base, paneTarget(pane, session), text);
  if (failure) return { ok: false, error: "tmux_failed", failure };
  return { ok: true };
}

// Read THIS process's own tmux pane + socket from env ($TMUX_PANE / the first
// field of $TMUX). The MCP server runs inside CC's pane, so this describes CC's
// pane -- the remote-inject path uses it so the broker NEVER supplies the pane
// (a compromised broker still can't target another pane). Null pane when the CC
// wasn't launched inside tmux.
// `session` = psmux's $PSMUX_SESSION (set in every psmux pane; absent on real
// tmux), used to make the pane target unique (see paneTarget).
export function ownTmuxPaneFromEnv(env: NodeJS.ProcessEnv = process.env): {
  pane: string | null;
  socket: string | null;
  session: string | null;
} {
  const pane = env.TMUX_PANE || null;
  const socket = env.TMUX ? env.TMUX.split(",")[0] || null : null;
  const session = env.PSMUX_SESSION || null;
  return { pane, socket, session };
}
