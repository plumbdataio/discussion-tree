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
// SECURITY: this can launch an arbitrary executable — the shell, the tmux
// binary, and claude's flags all come from the persisted config that the modal
// authors, so a same-origin POST is effectively an RCE primitive. The only thing
// protecting it is the same-origin check broker.ts applies to the spawn routes
// (a cross-site CSRF carries a foreign Origin and is rejected) — NOT any
// restriction on what gets run. Keep that guard.

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

interface SpawnConfig {
  base_args: string[];
  // Login shell to launch claude through. Empty = $SHELL (resolved at spawn).
  shell: string;
  tmux_bin: string;
  enter_count: number;
  enter_interval_ms: number;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveShell(cfg: SpawnConfig): string {
  if (cfg.shell.trim()) return expandHome(cfg.shell.trim());
  return process.env.SHELL || "/bin/zsh";
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
// pin an explicit path.
function resolveTmuxBin(cfg: SpawnConfig): string {
  if (cfg.tmux_bin && cfg.tmux_bin !== "tmux") return expandHome(cfg.tmux_bin);
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
): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync([resolveTmuxBin(cfg), ...args], {
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
function existingSessions(cfg: SpawnConfig): Set<string> {
  const r = tmux(cfg, ["list-sessions", "-F", "#{session_name}"]);
  if (!r.ok) return new Set();
  return new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Ensure each spawn lands in its OWN session: if the requested name is taken,
// suffix it (name-2, name-3, …) rather than colliding into the existing one.
function uniqueSessionName(cfg: SpawnConfig, base: string): string {
  const taken = existingSessions(cfg);
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
// seed first-run, and the dynamic pick-lists (known cwds + resumable sessions).
export function handleSpawnConfig() {
  return {
    settings: loadStoredConfig(),
    defaults: APP_DEFAULTS,
    known_cwds: knownCwds(),
    resumable: resumableSessions(),
  };
}

export async function handleSpawnSession(body: any) {
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
    const rawCwd = String(body?.cwd ?? "").trim();
    if (!rawCwd) return { ok: false, error: "cwd required" };
    cwd = expandHome(rawCwd);
    if (!cwd.startsWith("/")) {
      return { ok: false, error: "cwd must be an absolute path" };
    }
    try {
      const st = fs.statSync(cwd);
      if (!st.isDirectory()) {
        return { ok: false, error: "cwd exists but is not a directory" };
      }
    } catch {
      // Not there yet — create it (spawning into a not-yet-existing directory
      // should make it, rather than erroring out).
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch (e) {
        return {
          ok: false,
          error: `could not create cwd: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
  }

  // Launch claude through the user's login shell so their rc (PATH, any cwd ->
  // CLAUDE_CONFIG_DIR wrapper) applies. Flags ride in as positional params via
  // "$@" — no shell-injection surface. claude exits -> shell exits -> window
  // closes.
  const shell = resolveShell(cfg);
  const launch = [
    shell,
    "-ic",
    'claude "$@"',
    shell,
    ...cfg.base_args,
    ...extraArgs,
  ];
  // Resolve the tmux session name: the explicit field, else a default from the
  // dt name / cwd. Suffix on collision so each spawn is its own session.
  const requestedName = String(body?.tmux_session_name ?? "").trim();
  const baseName = requestedName
    ? sanitizeSessionName(requestedName)
    : defaultSessionName(nameHint, cwd);
  const sessionName = uniqueSessionName(cfg, baseName);
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
  const res = tmux(cfg, spawnArgs);
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
        tmux(cfg, ["send-keys", "-t", windowId, "Enter"]);
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
