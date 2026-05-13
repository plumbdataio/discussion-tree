// Sleep-prevention manager. Spawns a long-running platform-specific
// "keep awake" process (macOS: caffeinate -i, Linux: systemd-inhibit,
// Windows: PowerShell wakelock loop) while the user's preference says we
// should, and tears it down otherwise. The pref is persisted in
// `$HOME_DIR/config.json` so it survives broker restarts.

import * as fs from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.ts";
import { db } from "./db.ts";

export type PowerPref = "off" | "while-broker" | "while-mcp-active";

const CONFIG_FILE = join(HOME_DIR, "config.json");
let currentPref: PowerPref = "off";
let proc: ReturnType<typeof Bun.spawn> | null = null;

function loadConfig(): { powerPref?: PowerPref } {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch: Record<string, unknown>) {
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch {
    /* ignore parse error, treat as empty */
  }
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error(
      `[power] failed to persist config: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function aliveSessionCount(): number {
  const r = db
    .prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE alive = 1")
    .get() as { cnt: number } | null;
  return r?.cnt ?? 0;
}

function shouldKeepAwake(): boolean {
  switch (currentPref) {
    case "off":
      return false;
    case "while-broker":
      return true;
    case "while-mcp-active":
      return aliveSessionCount() > 0;
  }
}

function startWakeLock() {
  if (proc) return;
  let cmd: string[] | null = null;
  if (process.platform === "darwin") {
    // -i = prevent idle sleep. We don't pass -w because macOS will keep the
    // child running independently; we manage lifetime ourselves via kill.
    cmd = ["caffeinate", "-i"];
  } else if (process.platform === "linux") {
    // systemd-inhibit holds an inhibit lock until the wrapped process exits.
    // `sleep infinity` keeps the lock alive until WE kill it.
    cmd = [
      "systemd-inhibit",
      "--what=idle",
      "--who=discussion-tree",
      "--why=discussion-tree MCP active",
      "sleep",
      "infinity",
    ];
  } else if (process.platform === "win32") {
    // PowerShell loop sending a harmless F15 every minute. Hacky but the only
    // approach that works without a native binary. Acceptable as best-effort.
    cmd = [
      "powershell",
      "-NoProfile",
      "-Command",
      "$s = New-Object -ComObject WScript.Shell; while($true) { $s.SendKeys('{F15}'); Start-Sleep -Seconds 60 }",
    ];
  }
  if (!cmd) {
    console.error(`[power] platform ${process.platform} not supported`);
    return;
  }
  try {
    proc = Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
    console.error(`[power] wake-lock started (pref=${currentPref})`);
  } catch (e) {
    console.error(
      `[power] failed to start: ${e instanceof Error ? e.message : String(e)}`,
    );
    proc = null;
  }
}

function stopWakeLock() {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  proc = null;
  console.error(`[power] wake-lock stopped`);
}

function applyState() {
  if (shouldKeepAwake()) startWakeLock();
  else stopWakeLock();
}

export function initPower() {
  const cfg = loadConfig();
  currentPref = cfg.powerPref ?? "off";
  applyState();
  // Tear down on broker exit so we don't leak a caffeinate / systemd-inhibit
  // child after manual broker shutdown.
  process.on("exit", stopWakeLock);
  process.on("SIGINT", () => {
    stopWakeLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopWakeLock();
    process.exit(0);
  });
}

export function getPowerPref(): PowerPref {
  return currentPref;
}

export function setPowerPref(next: PowerPref) {
  currentPref = next;
  saveConfig({ powerPref: next });
  applyState();
}

// Called from session register/unregister hooks so "while-mcp-active" can
// toggle the wake-lock in real time.
export function onSessionsChanged() {
  if (currentPref === "while-mcp-active") applyState();
}

// HTTP routes — exposed via the standard broker route map.
export const routes = {
  "/get-power-config": () => ({
    pref: currentPref,
    platform: process.platform,
  }),
  "/set-power-config": (body: any) => {
    const next = body?.pref as PowerPref | undefined;
    if (next !== "off" && next !== "while-broker" && next !== "while-mcp-active") {
      return { ok: false, error: "errors.invalid_status", params: { status: String(next) } };
    }
    setPowerPref(next);
    return { ok: true, pref: currentPref };
  },
};
