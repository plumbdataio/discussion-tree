// tmux-backed session spawner. Launches a fresh Claude Code session (or
// resumes a dt-known one) inside its OWN detached tmux session, so the user
// can create + drive CC sessions entirely from the discussion-tree UI without
// touching a terminal. Each spawn gets an independent tmux session (named in the
// modal, or auto-derived from the folder), rather than all spawns sharing one.
//
// claude is launched through the user's own login shell:
//
//   tmux new-session -d -s <name> -c <cwd> -- <shell> -ic 'claude "$@"' <shell> <flags...>
//
// Running through `<shell> -ic` sources the user's rc, so their normal claude
// environment applies (PATH, and e.g. a cwd -> CLAUDE_CONFIG_DIR wrapper) — dt
// stays generic and hardcodes nothing machine-specific. Flags are passed as
// positional params via "$@", so there is no shell-injection surface from them.
// The only persisted config is the flag list (authored once in the modal,
// stored in SQLite); cwd and the tmux session name are chosen per spawn, and
// resume re-uses the session's recorded cwd (so the shell re-derives the same
// config dir).
//
// On Windows (where `tmux` is psmux) there is no POSIX shell, so claude is
// launched through PowerShell instead (pwsh, else Windows PowerShell):
//
//   tmux new-session -d -s <name> -c <cwd> -P -F #{window_id} <pwsh> -NoLogo -EncodedCommand <b64>
//
// where <b64> encodes `& claude '<flag>' '<flag>' ...`. Going through PowerShell
// (with the user's profile, i.e. no -NoProfile) gives the normal interactive
// environment, and lets `claude` resolve whether it is an .exe, a .cmd/.ps1 npm
// shim, or a profile function. Each flag is a single-quoted PowerShell literal
// (no expansion inside), and the whole script travels base64-encoded, so no
// character in a flag can reach any parser as syntax — not PowerShell's, and not
// whatever command-line join psmux / CreateProcess / cmd.exe applies to argv on
// the way. See buildLaunchArgv.
//
// SECURITY: this can launch an arbitrary executable — the shell, the tmux
// binary, and claude's flags all come from the persisted config that the modal
// authors, so a same-origin POST is effectively an RCE primitive. The only thing
// protecting it is the same-origin check broker.ts applies to the spawn routes
// (a cross-site CSRF carries a foreign Origin and is rejected) — NOT any
// restriction on what gets run. Keep that guard.

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { db } from "./db.ts";
import { defaultSessionName, sanitizeSessionName } from "./spawn-names.ts";

db.run(
  `CREATE TABLE IF NOT EXISTS spawn_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
);

const DEFAULT_ENTER_COUNT = 2;
const DEFAULT_ENTER_INTERVAL_MS = 5000;

// First-run defaults for the modal. Only dt's OWN flags are defaulted; personal
// additions (e.g. a private peers MCP) are left for the user to append.
const APP_DEFAULTS: SpawnConfig = {
  base_args: [
    "--dangerously-skip-permissions",
    "--dangerously-load-development-channels",
    "server:plugin:discussion-tree:discussion-tree",
  ],
  shell: "",
  tmux_bin: "tmux",
  enter_count: DEFAULT_ENTER_COUNT,
  enter_interval_ms: DEFAULT_ENTER_INTERVAL_MS,
};

export interface SpawnConfig {
  base_args: string[];
  // Login shell to launch claude through. Empty = $SHELL (resolved at spawn).
  // On win32 this names a PowerShell executable instead; empty = pwsh, falling
  // back to Windows PowerShell.
  shell: string;
  tmux_bin: string;
  enter_count: number;
  enter_interval_ms: number;
}

// Injection points for the platform-dependent parts, so tests can drive the
// win32 path on any host. Everything defaults to the real process.
export interface SpawnDeps {
  platform?: NodeJS.Platform;
  // Environment used for the POSIX $SHELL default.
  env?: Record<string, string | undefined>;
  // PATH lookup used to pick pwsh vs powershell on win32.
  which?: (cmd: string) => string | null;
  // Make sure a new-mode cwd exists as a directory; returns an error message,
  // or null when the directory is ready.
  ensureDir?: (cwd: string) => string | null;
}

function expandHome(
  p: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) {
    const join = platform === "win32" ? path.win32.join : path.join;
    return join(home, p.slice(2));
  }
  if (platform === "win32" && p.startsWith("~\\")) {
    return path.win32.join(home, p.slice(2));
  }
  return p;
}

// Quote one argument as a PowerShell single-quoted string literal. Inside one,
// nothing is expanded ($, `, ;, &, double quotes are all literal) and the only
// special character is the single quote itself, escaped by doubling. PowerShell
// also treats the typographic single quotes U+2018..U+201B as quote delimiters,
// so those are doubled too.
export function quotePowerShellArg(arg: string): string {
  return "'" + arg.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&") + "'";
}

// The PowerShell script that runs claude with `args`. `&` invokes `claude` as a
// command name, so PowerShell resolves it the same way an interactive prompt
// would (profile function/alias, .ps1 or .cmd shim, or .exe on PATH).
export function buildPowerShellScript(args: string[]): string {
  return ["& claude", ...args.map(quotePowerShellArg)].join(" ");
}

// -EncodedCommand takes base64 of the script's UTF-16LE bytes.
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function resolveShell(
  cfg: SpawnConfig,
  platform: NodeJS.Platform,
  deps: SpawnDeps,
): string {
  if (cfg.shell.trim()) return expandHome(cfg.shell.trim(), platform);
  if (platform === "win32") {
    // Return the bare NAME (resolved on PATH by the child), not which()'s full
    // path: pwsh usually lives under "C:\Program Files\...", and a space in
    // the program path is exactly what a tmux-style argv join on the way to
    // CreateProcess can mangle.
    const which = deps.which ?? ((cmd: string) => Bun.which(cmd));
    if (which("pwsh")) return "pwsh";
    if (which("powershell")) return "powershell";
    return "powershell.exe";
  }
  const env = deps.env ?? process.env;
  return env.SHELL || "/bin/zsh";
}

// The argv (after tmux's own options) that launches claude with the configured
// flags plus `extraArgs` (e.g. `-r <id>`). Pure apart from the shell lookup,
// which `deps` can pin.
//
//   POSIX: <shell> -ic 'claude "$@"' <shell> <flags...>
//     Flags ride in as positional params via "$@" — never parsed as shell code.
//   win32: <pwsh> -NoLogo -EncodedCommand <base64 of: & claude '<flag>' ...>
//     PowerShell's -Command joins the rest of its argv into ONE script string,
//     so there is no "$@" equivalent; instead each flag becomes a quoted
//     literal, and the script is base64-encoded so that the Windows command-line
//     layer between psmux and pwsh (argv join + re-split, possibly via cmd.exe)
//     only ever sees [A-Za-z0-9+/=].
export function buildLaunchArgv(
  platform: NodeJS.Platform,
  cfg: SpawnConfig,
  extraArgs: string[],
  deps: SpawnDeps = {},
): string[] {
  const shell = resolveShell(cfg, platform, deps);
  const args = [...cfg.base_args, ...extraArgs];
  if (platform === "win32") {
    return [
      shell,
      "-NoLogo",
      "-EncodedCommand",
      encodePowerShellCommand(buildPowerShellScript(args)),
    ];
  }
  return [shell, "-ic", 'claude "$@"', shell, ...args];
}

// Validate + normalize a new-mode cwd. POSIX: must start with "/" ("~" expands).
// win32: a drive-letter path (C:\x, C:/x) or a UNC path (\\server\share\x);
// drive-relative ("C:x") and root-relative ("\x") forms are refused, since they
// depend on a current directory the broker doesn't control.
export function resolveNewCwd(
  raw: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): { ok: true; cwd: string } | { ok: false; error: string } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "cwd required" };
  const cwd = expandHome(trimmed, platform, home);
  if (platform === "win32") {
    const drive = /^[A-Za-z]:[\\/]/.test(cwd);
    const unc = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(cwd);
    if (!drive && !unc) {
      return {
        ok: false,
        error:
          "cwd must be an absolute path (a drive path like C:\\work or a UNC path like \\\\server\\share)",
      };
    }
    return { ok: true, cwd: path.win32.normalize(cwd) };
  }
  if (!cwd.startsWith("/")) {
    return { ok: false, error: "cwd must be an absolute path" };
  }
  return { ok: true, cwd };
}

function defaultEnsureDir(cwd: string): string | null {
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) return "cwd exists but is not a directory";
  } catch {
    // Not there yet — create it (spawning into a not-yet-existing directory
    // should make it, rather than erroring out).
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (e) {
      return `could not create cwd: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

// Coerce an untrusted object (from the modal or an old DB row) into a complete,
// well-typed SpawnConfig, filling any missing field from APP_DEFAULTS.
function normalize(raw: any): SpawnConfig {
  const base_args: string[] = Array.isArray(raw?.base_args)
    ? raw.base_args.filter((a: any) => typeof a === "string" && a.length > 0)
    : APP_DEFAULTS.base_args;
  return {
    base_args,
    shell: typeof raw?.shell === "string" ? raw.shell.trim() : "",
    tmux_bin:
      typeof raw?.tmux_bin === "string" && raw.tmux_bin.trim()
        ? raw.tmux_bin.trim()
        : APP_DEFAULTS.tmux_bin,
    enter_count:
      Number.isFinite(raw?.enter_count) && raw.enter_count >= 0
        ? Math.floor(raw.enter_count)
        : APP_DEFAULTS.enter_count,
    enter_interval_ms:
      Number.isFinite(raw?.enter_interval_ms) && raw.enter_interval_ms >= 500
        ? Math.floor(raw.enter_interval_ms)
        : APP_DEFAULTS.enter_interval_ms,
  };
}

function loadStoredConfig(): SpawnConfig | null {
  const row = db
    .prepare("SELECT config FROM spawn_config WHERE id = 1")
    .get() as { config: string } | undefined;
  if (!row) return null;
  try {
    return normalize(JSON.parse(row.config));
  } catch {
    return null;
  }
}

function saveStoredConfig(cfg: SpawnConfig): void {
  db.prepare(
    `INSERT INTO spawn_config (id, config, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(cfg), new Date().toISOString());
}

// The broker may run with a minimal PATH (launchd/auto-spawn), so a bare "tmux"
// can fail to resolve. Probe the usual install locations when the config didn't
// pin an explicit path. On win32 (psmux) there are no conventional locations to
// probe, so a bare "tmux" is left to PATH resolution.
function resolveTmuxBin(
  cfg: SpawnConfig,
  platform: NodeJS.Platform = process.platform,
): string {
  if (cfg.tmux_bin && cfg.tmux_bin !== "tmux") {
    return expandHome(cfg.tmux_bin, platform);
  }
  if (platform === "win32") return "tmux";
  for (const p of [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return "tmux";
}

function tmux(
  cfg: SpawnConfig,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync([resolveTmuxBin(cfg, platform), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout ? new TextDecoder().decode(r.stdout).trim() : "",
    stderr: r.stderr ? new TextDecoder().decode(r.stderr).trim() : "",
  };
}

// Names of tmux sessions the server currently knows (empty when tmux isn't
// running / has no server yet, which is fine — every name is then free).
function existingSessions(
  cfg: SpawnConfig,
  platform: NodeJS.Platform,
): Set<string> {
  const r = tmux(cfg, ["list-sessions", "-F", "#{session_name}"], platform);
  if (!r.ok) return new Set();
  return new Set(
    r.stdout
      // psmux on Windows may emit CRLF line endings.
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Ensure each spawn lands in its OWN session: if the requested name is taken,
// suffix it (name-2, name-3, …) rather than colliding into the existing one.
function uniqueSessionName(
  cfg: SpawnConfig,
  base: string,
  platform: NodeJS.Platform,
): string {
  const taken = existingSessions(cfg, platform);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function knownCwds(): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != '' ORDER BY last_seen DESC",
    )
    .all() as { cwd: string }[];
  return rows.map((r) => r.cwd);
}

function resumableSessions(): {
  name: string | null;
  cc_session_id: string;
  cwd: string | null;
  alive: number;
}[] {
  return db
    .prepare(
      "SELECT name, cc_session_id, cwd, alive FROM sessions WHERE cc_session_id IS NOT NULL AND cc_session_id != '' ORDER BY last_seen DESC",
    )
    .all() as {
    name: string | null;
    cc_session_id: string;
    cwd: string | null;
    alive: number;
  }[];
}

// Modal bootstrap: the saved config (null on first run), the app defaults to
// seed first-run, the dynamic pick-lists (known cwds + resumable sessions), and
// the broker's platform (the modal's path / shell hints depend on it).
export function handleSpawnConfig() {
  return {
    platform: process.platform,
    settings: loadStoredConfig(),
    defaults: APP_DEFAULTS,
    known_cwds: knownCwds(),
    resumable: resumableSessions(),
  };
}

export async function handleSpawnSession(body: any, deps: SpawnDeps = {}) {
  const platform = deps.platform ?? process.platform;
  // Resolve the effective config from the request (or fall back to stored), but
  // do NOT persist yet — only save after a successful spawn so a malformed
  // request can't overwrite good stored settings.
  const cfg = body?.config ? normalize(body.config) : loadStoredConfig();
  if (!cfg) return { ok: false, error: "spawning is not configured yet" };

  const mode = body?.mode === "resume" ? "resume" : "new";
  let cwd: string;
  // A blank tmux-session-name field falls back to a default derived from this
  // hint (the dt session name on resume) or the cwd basename.
  let nameHint: string | null = null;
  const extraArgs: string[] = [];

  if (mode === "resume") {
    const ccId = String(body?.resume_cc_session_id ?? "").trim();
    if (!ccId) return { ok: false, error: "resume_cc_session_id required" };
    const row = db
      .prepare(
        "SELECT name, cwd, alive FROM sessions WHERE cc_session_id = ? ORDER BY last_seen DESC LIMIT 1",
      )
      .get(ccId) as
      | { name: string | null; cwd: string | null; alive: number }
      | undefined;
    if (!row) return { ok: false, error: "no dt session with that cc_session_id" };
    if (row.alive === 1) {
      return {
        ok: false,
        error: "that session is still alive — close it before resuming",
      };
    }
    if (!row.cwd) return { ok: false, error: "that session has no recorded cwd" };
    cwd = row.cwd;
    nameHint = row.name;
    extraArgs.push("-r", ccId);
  } else {
    const resolved = resolveNewCwd(String(body?.cwd ?? ""), platform);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    cwd = resolved.cwd;
    const dirError = (deps.ensureDir ?? defaultEnsureDir)(cwd);
    if (dirError) return { ok: false, error: dirError };
  }

  // Launch claude through the user's login shell (PowerShell on win32) so their
  // rc / profile (PATH, any cwd -> CLAUDE_CONFIG_DIR wrapper) applies. Flags are
  // passed as data, never as shell code (see buildLaunchArgv). claude exits ->
  // shell exits -> window closes.
  const launch = buildLaunchArgv(platform, cfg, extraArgs, deps);
  // Resolve the tmux session name: the explicit field, else a default from the
  // dt name / cwd. Suffix on collision so each spawn is its own session.
  const requestedName = String(body?.tmux_session_name ?? "").trim();
  const baseName = requestedName
    ? sanitizeSessionName(requestedName)
    : defaultSessionName(nameHint, cwd, platform);
  const sessionName = uniqueSessionName(cfg, baseName, platform);
  const spawnArgs = [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{window_id}",
    ...launch,
  ];
  const res = tmux(cfg, spawnArgs, platform);
  if (!res.ok) {
    return { ok: false, error: `tmux failed: ${res.stderr || "unknown error"}` };
  }
  const windowId = res.stdout;

  // The spawn took — NOW persist the config the user authored (so it pre-fills
  // next time). Saving only on success keeps a failed/partial attempt from
  // wiping good stored settings.
  if (body?.config) saveStoredConfig(cfg);

  // Clear claude's startup dialogs (folder-trust + the
  // --dangerously-skip-permissions acceptance) by sending Enter a few times,
  // spaced out. An extra Enter past the dialogs is a harmless empty submit at
  // claude's prompt, so over-sending is safe.
  if (windowId) {
    for (let i = 1; i <= cfg.enter_count; i++) {
      setTimeout(() => {
        tmux(cfg, ["send-keys", "-t", windowId, "Enter"], platform);
      }, i * cfg.enter_interval_ms);
    }
  }

  return {
    ok: true,
    mode,
    tmux_session: sessionName,
    // True when the requested/derived name was taken and we suffixed it, so the
    // UI can tell the user the session landed under a slightly different name.
    session_renamed: sessionName !== baseName,
    window: windowId,
    cwd,
  };
}

export const routes = {
  "/spawn-config": () => handleSpawnConfig(),
  "/spawn-session": (body: any) => handleSpawnSession(body),
};
