// Shared tmux command-injection primitives, used by BOTH:
//   - the broker (LOCAL cli-send: the CC's tmux is on the broker's machine), and
//   - the per-CC MCP server (REMOTE cli-send: the broker can't reach the CC's
//     tmux on another machine, so it enqueues and the MCP runs send-keys on its
//     OWN pane).
// Extracted so the proven probe -> C-u -> load-buffer -> paste -> Enter sequence
// has a single home. No shell anywhere: argv only, so the buffer text can never
// be interpreted as a command.

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
async function runTmux(
  argv: string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: input != null ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (input != null && proc.stdin) {
      proc.stdin.write(input);
      await proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout };
  } catch {
    // tmux not installed / spawn failed -- treat as "command unavailable" so the
    // caller reports pane_gone rather than 500-ing.
    return { code: 127, stdout: "" };
  }
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
]);

// Look up the pane: "missing" if the pane id is gone, "shell" if a shell now
// owns it (Claude exited), else "ok". One list-panes call carries both the id
// and its foreground command.
export async function probePane(
  base: string[],
  pane: string,
): Promise<"ok" | "missing" | "shell"> {
  const { code, stdout } = await runTmux([
    ...base,
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{pane_current_command}",
  ]);
  if (code !== 0) return "missing";
  for (const line of stdout.split("\n")) {
    const [id, cmd] = line.split("\t");
    if (id?.trim() === pane) {
      return PANE_SHELLS.has((cmd ?? "").trim()) ? "shell" : "ok";
    }
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
export async function sendToPane(
  base: string[],
  pane: string,
  text: string,
): Promise<void> {
  // Clear whatever is already on the prompt line first (a leftover mouse-report
  // escape tail once turned a paste into a non-slash line). C-u (kill to start
  // of line) rather than C-c: interrupting is not a text operation, and on a
  // busy prompt C-c would cancel the turn. C-u touches only the edited line.
  await runTmux([...base, "send-keys", "-t", pane, "C-u"]);
  const buf = `dt-cli-send-${++cliSendSeq}`;
  await runTmux([...base, "load-buffer", "-b", buf, "-"], text);
  await runTmux([...base, "paste-buffer", "-t", pane, "-b", buf, "-p", "-d"]);
  await new Promise((r) => setTimeout(r, CLI_SEND_ENTER_DELAY_MS));
  await runTmux([...base, "send-keys", "-t", pane, "Enter"]);
}

// Build the tmux `base` argv (socket-aware).
export function tmuxBase(socket: string | null | undefined): string[] {
  return socket ? ["tmux", "-S", socket] : ["tmux"];
}

// High-level: validate -> probe -> paste. Returns { ok } or { ok:false, error }
// where error is one of "invalid_command" | "pane_gone" | "pane_not_claude".
// The one place both the local (broker) and remote (MCP) paths funnel through.
export async function injectIntoPane(
  socket: string | null | undefined,
  pane: string,
  command: string,
  args: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isValidCliCommand(command)) {
    return { ok: false, error: "invalid_command" };
  }
  const base = tmuxBase(socket);
  const probe = await probePane(base, pane);
  if (probe === "missing") return { ok: false, error: "pane_gone" };
  if (probe === "shell") return { ok: false, error: "pane_not_claude" };
  const text = args.trim() ? `${command} ${args}` : command;
  await sendToPane(base, pane, text);
  return { ok: true };
}

// Read THIS process's own tmux pane + socket from env ($TMUX_PANE / the first
// field of $TMUX). The MCP server runs inside CC's pane, so this describes CC's
// pane -- the remote-inject path uses it so the broker NEVER supplies the pane
// (a compromised broker still can't target another pane). Null pane when the CC
// wasn't launched inside tmux.
export function ownTmuxPaneFromEnv(): {
  pane: string | null;
  socket: string | null;
} {
  const pane = process.env.TMUX_PANE || null;
  const socket = process.env.TMUX
    ? process.env.TMUX.split(",")[0] || null
    : null;
  return { pane, socket };
}
